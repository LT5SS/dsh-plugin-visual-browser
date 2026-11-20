import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserSession } from '../driver/browser-session.js';
import type { BrowserSessionOptions, Point2D, VirtualCursorStyleConfig } from '../driver/types.js';
import type { PageObservation } from '../sampler/page-snapshot.js';
import { AtomicBrowserToolset } from '../tools/atomic-tools.js';
import { HostFactsTracker, type HostFactsData } from './host-facts.js';
import { SlidingWindowHistory, type SlidingContextStats } from './sliding-context.js';
import {
  buildApprovalCard,
  detectPageGate,
  type DshApprovalCardPayload,
  type GateReason,
} from '../guardrails/takeover.js';

export type SubagentActionDecision =
  | { type: 'navigate'; url: string; reason: string }
  | { type: 'move_mouse'; points: Point2D | Point2D[]; label?: string; reason: string }
  | { type: 'hover'; target: string | Point2D; reason: string }
  | { type: 'click'; target: string | Point2D; reason: string }
  | { type: 'type_text'; target: string; text: string; pressEnter?: boolean; reason: string }
  | { type: 'scroll'; deltaY: number; reason: string }
  | { type: 'set_cursor_style'; style: VirtualCursorStyleConfig; reason: string }
  | { type: 'complete'; report: string }
  | {
      type: 'pause_for_takeover';
      blockReason: GateReason | 'ORIGIN_BLOCKED';
      message: string;
    };

export interface SubagentPlannerContext {
  stepIndex: number;
  maxSteps: number;
  taskPrompt: string;
  latestObservation: PageObservation;
  history: SlidingWindowHistory;
  hostFacts: HostFactsTracker;
  signal?: AbortSignal;
}

export type SubagentPlanner = (ctx: SubagentPlannerContext) => Promise<SubagentActionDecision>;

export interface SubagentTaskRequest {
  subagentId?: string;
  role: string;
  taskPrompt: string;
  startUrl: string;
  artifactDir: string;
  maxSteps?: number;
  /** Sliding window size: max recent screenshots kept in VLM context (default: 3) */
  maxRecentImages?: number;
  sessionOptions?: BrowserSessionOptions;
  /** Optional origin allowlist/blocklist for host security policy */
  allowedOrigins?: string[];
  blockedOrigins?: string[];
  /** Automatically pause for human takeover if CAPTCHA, payment, or login gate appears (default: true) */
  pauseOnGate?: boolean;
  /** Keep a persistent visible window open after completion and reuse it across subsequent tasks */
  keepWindowOpen?: boolean;
  /** Cooperative cancellation signal from DSH ToolRunContext (exec.signal) */
  signal?: AbortSignal;
  planner?: SubagentPlanner;
}

export interface SubagentRunResult {
  subagentId: string;
  role: string;
  status: 'COMPLETED' | 'BLOCKED' | 'PAUSED_FOR_TAKEOVER' | 'MAX_STEPS_REACHED';
  subagentReport: string;
  hostFactsBlock: string;
  hostFacts: HostFactsData;
  contextStats: SlidingContextStats;
  approvalCard?: DshApprovalCardPayload;
}

interface PausedSubagentState {
  subagentId: string;
  req: SubagentTaskRequest;
  session: BrowserSession;
  tools: AtomicBrowserToolset;
  hostFacts: HostFactsTracker;
  history: SlidingWindowHistory;
  planner: SubagentPlanner;
  nextStep: number;
  maxSteps: number;
}

export const SUBAGENT_SYSTEM_PROMPT = `You are an isolated Visual Browser Subagent inside DeepSeek Harness (DSH).
You operate a background browser equipped with a physical Bezier virtual cursor.
At each step you receive:
1. A compact archive of earlier steps (images evicted to save context);
2. The latest 1-3 viewport screenshots with the virtual cursor & trail visible;
3. The 3-in-1 Observation HUD (scroll metrics, DOM/tech stats, console/network errors, and numbered #ref interactive controls).

Respond ONLY with a single valid JSON object matching one of these actions:
- {"type":"move_mouse","points":[{"x":300,"y":400},{"x":800,"y":420}],"label":"SWEEP","reason":"..."}
- {"type":"hover","target":"#3","reason":"..."}
- {"type":"click","target":"#8","reason":"..."}
- {"type":"type_text","target":"#5","text":"hello","pressEnter":true,"reason":"..."}
- {"type":"scroll","deltaY":800,"reason":"..."}
- {"type":"navigate","url":"https://...","reason":"..."}
- {"type":"pause_for_takeover","blockReason":"LOGIN_REQUIRED","message":"..."}
- {"type":"complete","report":"COMPLETED / TASK_COMPLETED\\n\\nDetailed markdown report..."}

事实纪律（违反即为报告失败）：
1. 只能报告 HUD / 工具返回值里**实际出现**的字段。HUD 没有暴露的字段（例如未暴露 href 或 value），必须明确写「HUD 未暴露该字段」，禁止用你对站点的先验知识或训练记忆补全，也禁止写"依据标准结构推断"。
2. 报告里每个关键事实后面必须标注来源，例如 \`href=... (来源: #1 HUD)\` 或 \`标题=... (来源: page title)\`。
3. 不确定就明说不确定，绝不为了完成报告而编造或猜测未观测到的内容。

动作效率与步数预算规则：
1. \`move_mouse\` 的装饰性轨迹动作（如 jiggle、slow approach、probe）**仅在用户明确要求演示鼠标轨迹时使用**；否则直接使用 \`hover\` / \`click\` / \`scroll\` / \`type_text\` / \`navigate\` 等语义动作，或直接汇总结果。
2. 当现有 HUD 已包含任务所需的全部事实时，立即返回 \`complete\`，不要"再摸一下确认"。
3. 时刻关注剩余步数预算（\`stepIndex / maxSteps\`）：若剩余步数 <= 1，必须在本步直接返回 \`complete\` 收尾。`;

export interface PlannerStepDiagnostic {
  step: number;
  backend: 'host-ctx-llm' | 'external-vision-api';
  chunk_count: number;
  chunk_types: Record<string, number>;
  sample_unrecognized_keys?: string[];
  text_length: number;
  text_preview?: string;
  retried_text_only?: boolean;
  stream_error?: string;
  fallback_reason?: string;
  decision_source?: 'llm' | 'inspector';
  action?: Record<string, unknown>;
}

/** Summarizes a SubagentActionDecision into a compact JSON-safe replay object for diagnostics. */
export function summarizeDecisionAction(decision: SubagentActionDecision): Record<string, unknown> {
  switch (decision.type) {
    case 'navigate':
      return { type: 'navigate', url: decision.url };
    case 'move_mouse':
      return {
        type: 'move_mouse',
        points_count: Array.isArray(decision.points) ? decision.points.length : 1,
        ...(decision.label ? { label: decision.label } : {}),
      };
    case 'hover':
    case 'click':
      return {
        type: decision.type,
        target: decision.target,
        ...(typeof decision.target === 'string' && decision.target.startsWith('#')
          ? { ref: decision.target }
          : {}),
      };
    case 'type_text':
      return {
        type: 'type_text',
        target: decision.target,
        text_length: decision.text.length,
        ...(decision.pressEnter ? { pressEnter: true } : {}),
      };
    case 'scroll':
      return { type: 'scroll', deltaY: decision.deltaY };
    case 'set_cursor_style':
      return {
        type: 'set_cursor_style',
        ...(decision.style.preset ? { preset: decision.style.preset } : {}),
      };
    case 'complete':
      return { type: 'complete', report_length: decision.report.length };
    case 'pause_for_takeover':
      return { type: 'pause_for_takeover', blockReason: decision.blockReason };
  }
}

async function runFallbackAndRecord(
  diag: PlannerStepDiagnostic,
  fallback: SubagentPlanner,
  ctx: SubagentPlannerContext,
  onStepDiagnostic?: (diag: PlannerStepDiagnostic) => void
): Promise<SubagentActionDecision> {
  const fallbackDecision = await fallback(ctx);
  diag.decision_source = 'inspector';
  diag.action = summarizeDecisionAction(fallbackDecision);
  onStepDiagnostic?.(diag);
  return fallbackDecision;
}

function isPoint2D(value: unknown): value is Point2D {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as any).x === 'number' &&
    Number.isFinite((value as any).x) &&
    typeof (value as any).y === 'number' &&
    Number.isFinite((value as any).y)
  );
}

/** Validates that a parsed JSON object matches one of the 9 supported SubagentActionDecision variants. */
export function isValidSubagentDecision(value: unknown): value is SubagentActionDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const d = value as Record<string, unknown>;
  switch (d.type) {
    case 'navigate':
      return typeof d.url === 'string' && d.url.trim().length > 0;
    case 'move_mouse':
      return (
        (Array.isArray(d.points) && d.points.length > 0 && d.points.every(isPoint2D)) ||
        isPoint2D(d.points)
      );
    case 'hover':
    case 'click':
      return d.target !== undefined && d.target !== null && (typeof d.target === 'string' ? d.target.length > 0 : isPoint2D(d.target));
    case 'type_text':
      return typeof d.target === 'string' && d.target.length > 0 && typeof d.text === 'string';
    case 'scroll':
      return typeof d.deltaY === 'number' && Number.isFinite(d.deltaY);
    case 'set_cursor_style':
      return d.style !== null && typeof d.style === 'object' && !Array.isArray(d.style);
    case 'complete':
      return typeof d.report === 'string';
    case 'pause_for_takeover':
      return typeof d.blockReason === 'string' && d.blockReason.length > 0 && typeof d.message === 'string';
    default:
      return false;
  }
}

/**
 * Extracts and structurally validates the first JSON decision object from a model text response.
 * Returns `null` (never throws) on empty strings, prose, malformed JSON, or invalid action shapes.
 */
export function parseJsonDecision(rawText: string): SubagentActionDecision | null {
  const trimmed = String(rawText ?? '').trim();
  if (!trimmed) return null;

  const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) {
    return null;
  }

  try {
    const parsed = JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    return isValidSubagentDecision(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

const TEXT_DELTA_CHUNK_TYPES = new Set([
  'text-delta',
  'content-delta',
  'output_text_delta',
  'output-text-delta',
]);
const FULL_TEXT_CHUNK_TYPES = new Set(['text', 'output-text', 'output_text']);
const RECOGNIZED_NON_TEXT_CHUNK_TYPES = new Set([
  'reasoning-delta',
  'reasoning',
  'thinking-delta',
  'thinking',
  'start',
  'block-start',
  'block-end',
  'step-start',
  'step-finish',
  'message-start',
  'message-end',
  'done',
  'usage',
  'metadata',
  'source',
  'tool-call',
  'tool-result',
  'response',
]);

function firstStringField(obj: Record<string, any>, keys: string[]): string | undefined {
  for (const key of keys) {
    if (typeof obj[key] === 'string') return obj[key];
  }
  return undefined;
}

/**
 * Normalizes diverse host `ctx.llm.stream()` chunk shapes and records unknown schemas for diagnostics.
 */
export function extractHostStreamChunk(chunk: unknown): {
  kind: string;
  text: string;
  error?: string;
  unrecognizedKeys?: string[];
} {
  if (typeof chunk === 'string') {
    return { kind: 'string', text: chunk };
  }
  if (!chunk || typeof chunk !== 'object') {
    return { kind: typeof chunk, text: '' };
  }

  const obj = chunk as Record<string, any>;
  const kind = typeof obj.type === 'string' ? obj.type : 'unknown';

  if (TEXT_DELTA_CHUNK_TYPES.has(kind)) {
    const text = firstStringField(obj, ['delta', 'text', 'textDelta', 'content']);
    if (text !== undefined) return { kind, text };
    return { kind, text: '', unrecognizedKeys: Object.keys(obj).slice(0, 12) };
  }

  if (FULL_TEXT_CHUNK_TYPES.has(kind)) {
    const text = firstStringField(obj, ['text', 'delta', 'content']);
    if (text !== undefined) return { kind, text };
    return { kind, text: '', unrecognizedKeys: Object.keys(obj).slice(0, 12) };
  }

  if (kind === 'finish') {
    const reason = obj.reason;
    if (reason?.kind === 'error') {
      const failure = reason.failure ?? {};
      const message = String(failure.message ?? reason.message ?? 'unknown finish error').slice(0, 260);
      const code = String(failure.code ?? 'UNKNOWN');
      return { kind, text: '', error: `${code}: ${message}` };
    }
    return { kind, text: '' };
  }

  if (kind === 'error') {
    const rawErr =
      obj.error?.message ??
      obj.message ??
      (typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error ?? 'Unknown stream error'));
    return { kind, text: '', error: String(rawErr).slice(0, 300) };
  }

  if (RECOGNIZED_NON_TEXT_CHUNK_TYPES.has(kind)) {
    return { kind, text: '' };
  }

  return { kind, text: '', unrecognizedKeys: Object.keys(obj).slice(0, 12) };
}

/**
 * Creates a planner backed by DSH 0.2's native `ctx.llm` runtime service when available.
 * Automatically retries text-only when an image attachment causes failure, records chunk
 * diagnostics, and degrades cleanly to `fallbackPlanner` (default: `createBuiltinInspectorPlanner()`)
 * instead of throwing on empty streams or non-JSON responses.
 */
export function createDshHostLlmPlanner(opts: {
  llm: any;
  attachments?: any;
  provider: string;
  model: string;
  sessionId?: string;
  fallbackPlanner?: SubagentPlanner;
  onStepDiagnostic?: (diag: PlannerStepDiagnostic) => void;
}): SubagentPlanner {
  const fallback = opts.fallbackPlanner ?? createBuiltinInspectorPlanner();

  return async (ctx: SubagentPlannerContext): Promise<SubagentActionDecision> => {
    const entries = ctx.history.getEntries();
    const archived = entries.filter((e) => e.imageBase64 === null).map((e) => `- ${e.compactText}`);

    const remainingSteps = Math.max(0, ctx.maxSteps - ctx.stepIndex);
    let promptText =
      `## Task Goal\n${ctx.taskPrompt}\n\n` +
      `## Step Budget\nCurrent decision step: ${ctx.stepIndex} / ${ctx.maxSteps} (remaining after this step: ${remainingSteps})` +
      (remainingSteps <= 1
        ? ' — FINAL STEP BUDGET: return {"type":"complete",...} now with all verified facts.'
        : '') +
      `\n`;
    if (archived.length > 0) {
      promptText += `\n## Archived Earlier Steps\n${archived.join('\n')}\n`;
    }
    for (const entry of entries.filter((e) => e.imageBase64 !== null)) {
      promptText += `\n---\n**Action Executed**: ${entry.actionTaken}\n${entry.fullHudText}\n`;
    }
    const textBlock = { type: 'text', text: promptText };

    // Attach latest screenshot via ctx.attachments if supported by host
    let imageBlock: any | undefined;
    const latestPath = ctx.latestObservation.screenshotPath;
    if (opts.attachments && typeof opts.attachments.saveImage === 'function' && fs.existsSync(latestPath)) {
      try {
        const ref = await opts.attachments.saveImage({
          data: new Uint8Array(fs.readFileSync(latestPath)),
          mediaType: 'image/png',
          name: path.basename(latestPath),
        });
        imageBlock = { type: 'image', attachment: ref };
      } catch {
        // Fallback to text-only HUD if attachment admission fails
      }
    }

    const runStreamAttempt = async (blocks: any[]) => {
      let fullText = '';
      let chunkCount = 0;
      const chunkTypes: Record<string, number> = {};
      let sampleUnrecognizedKeys: string[] | undefined;
      let streamError: string | undefined;
      let threw = false;

      try {
        const stream = await opts.llm.stream({
          provider: opts.provider,
          model: opts.model,
          ...(opts.sessionId ? { sessionId: opts.sessionId as any } : {}),
          system: SUBAGENT_SYSTEM_PROMPT,
          messages: [
            {
              id: `msg-${crypto.randomUUID()}`,
              role: 'user',
              content: blocks,
              source: { kind: 'user' },
            },
          ],
          signal: ctx.signal,
        });

        if (!stream || typeof (stream as any)[Symbol.asyncIterator] !== 'function') {
          streamError = 'Host llm.stream() did not return an async iterable';
          threw = true;
        } else {
          for await (const chunk of stream) {
            chunkCount++;
            const parsedChunk = extractHostStreamChunk(chunk);
            chunkTypes[parsedChunk.kind] = (chunkTypes[parsedChunk.kind] ?? 0) + 1;
            if (parsedChunk.text) fullText += parsedChunk.text;
            if (!sampleUnrecognizedKeys && parsedChunk.unrecognizedKeys?.length) {
              sampleUnrecognizedKeys = parsedChunk.unrecognizedKeys;
            }
            if (!streamError && parsedChunk.error) {
              streamError = parsedChunk.error;
            }
          }
        }
      } catch (err: any) {
        if (ctx.signal?.aborted) throw err;
        streamError = String(err?.message ?? err).slice(0, 300);
        threw = true;
      }

      return { fullText, chunkCount, chunkTypes, sampleUnrecognizedKeys, streamError, threw };
    };

    let attempt = await runStreamAttempt(imageBlock ? [textBlock, imageBlock] : [textBlock]);
    let decision = parseJsonDecision(attempt.fullText);
    let retriedTextOnly = false;
    const isImageRejection = /image|vision|multimodal|attachment/i.test(attempt.streamError ?? '');
    const isConfigError =
      !isImageRejection &&
      /NO_ADAPTER|NO_API_KEY|UNAUTHORIZED|MODEL_NOT_FOUND|INVALID_REQUEST|MissingSessionID/i.test(
        attempt.streamError ?? ''
      );

    if (!decision && imageBlock && !ctx.signal?.aborted && !isConfigError) {
      retriedTextOnly = true;
      attempt = await runStreamAttempt([textBlock]);
      decision = parseJsonDecision(attempt.fullText);
    }

    const diag: PlannerStepDiagnostic = {
      step: ctx.stepIndex,
      backend: 'host-ctx-llm',
      chunk_count: attempt.chunkCount,
      chunk_types: attempt.chunkTypes,
      ...(attempt.sampleUnrecognizedKeys ? { sample_unrecognized_keys: attempt.sampleUnrecognizedKeys } : {}),
      text_length: attempt.fullText.length,
      ...(retriedTextOnly ? { retried_text_only: true } : {}),
      ...(attempt.streamError ? { stream_error: attempt.streamError } : {}),
    };

    if (decision) {
      diag.decision_source = 'llm';
      diag.action = summarizeDecisionAction(decision);
      opts.onStepDiagnostic?.(diag);
      return decision;
    }

    let fallbackReason: string;
    if (attempt.threw) {
      fallbackReason = 'HOST_LLM_STREAM_ERROR';
    } else if (attempt.chunkCount === 0) {
      fallbackReason = 'EMPTY_STREAM';
    } else if (attempt.streamError) {
      fallbackReason = 'HOST_LLM_ERROR_CHUNK';
    } else if (attempt.fullText.trim().length === 0) {
      fallbackReason = 'EMPTY_TEXT_OUTPUT';
    } else {
      fallbackReason = 'INVALID_JSON_DECISION';
      diag.text_preview = attempt.fullText.trim().slice(0, 200);
    }
    diag.fallback_reason = fallbackReason;
    return runFallbackAndRecord(diag, fallback, ctx, opts.onStepDiagnostic);
  };
}

/**
 * Creates a Vision LLM planner talking to any OpenAI-compatible multimodal endpoint.
 * Includes timeout, AbortSignal propagation, gateway compatibility retry, and safe fallback.
 */
export function createOpenAIVisionPlanner(opts: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fallbackPlanner?: SubagentPlanner;
  onStepDiagnostic?: (diag: PlannerStepDiagnostic) => void;
}): SubagentPlanner {
  const baseUrl = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = opts.model || 'gpt-4o-mini';
  const timeoutMs = opts.timeoutMs ?? 45000;
  const fallback = opts.fallbackPlanner ?? createBuiltinInspectorPlanner();

  return async (ctx: SubagentPlannerContext): Promise<SubagentActionDecision> => {
    const messages = ctx.history.buildMultimodalMessages(SUBAGENT_SYSTEM_PROMPT, ctx.taskPrompt);

    const callApi = async (useJsonObjectFormat: boolean) => {
      const timeoutSignal = AbortSignal.timeout(timeoutMs);
      const signal = ctx.signal
        ? AbortSignal.any([ctx.signal, timeoutSignal])
        : timeoutSignal;

      const body: Record<string, unknown> = {
        model,
        messages,
        temperature: 0.2,
      };
      if (useJsonObjectFormat) {
        body.response_format = { type: 'json_object' };
      }

      return fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });
    };

    try {
      let res = await callApi(true);
      if (!res.ok && res.status === 400) {
        // Retry without response_format for OpenAI-compatible gateways that don't support json_object mode with vision
        res = await callApi(false);
      }

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        return runFallbackAndRecord(
          {
            step: ctx.stepIndex,
            backend: 'external-vision-api',
            chunk_count: 0,
            chunk_types: {},
            text_length: 0,
            stream_error: `HTTP ${res.status} ${errBody}`.trim().slice(0, 300),
            fallback_reason: 'VISION_API_HTTP_ERROR',
          },
          fallback,
          ctx,
          opts.onStepDiagnostic
        );
      }

      const data = (await res.json()) as any;
      const rawContent = String(data?.choices?.[0]?.message?.content ?? '');
      const decision = parseJsonDecision(rawContent);
      if (decision) {
        opts.onStepDiagnostic?.({
          step: ctx.stepIndex,
          backend: 'external-vision-api',
          chunk_count: 1,
          chunk_types: { completion: 1 },
          text_length: rawContent.length,
          decision_source: 'llm',
          action: summarizeDecisionAction(decision),
        });
        return decision;
      }

      const empty = rawContent.trim().length === 0;
      return runFallbackAndRecord(
        {
          step: ctx.stepIndex,
          backend: 'external-vision-api',
          chunk_count: 1,
          chunk_types: { completion: 1 },
          text_length: rawContent.length,
          ...(!empty ? { text_preview: rawContent.trim().slice(0, 200) } : {}),
          fallback_reason: empty ? 'EMPTY_TEXT_OUTPUT' : 'INVALID_JSON_DECISION',
        },
        fallback,
        ctx,
        opts.onStepDiagnostic
      );
    } catch (err: any) {
      if (ctx.signal?.aborted) throw err;
      return runFallbackAndRecord(
        {
          step: ctx.stepIndex,
          backend: 'external-vision-api',
          chunk_count: 0,
          chunk_types: {},
          text_length: 0,
          stream_error: String(err?.message ?? err).slice(0, 300),
          fallback_reason: 'VISION_API_REQUEST_ERROR',
        },
        fallback,
        ctx,
        opts.onStepDiagnostic
      );
    }
  };
}

/**
 * Built-in Zero-Config Autonomous Visual Walkthrough Planner.
 * Used when neither a custom planner, DSH host LLM selection, nor DSH_VISION_API_KEY is configured,
 * ensuring `browser_subagent_run` works out-of-the-box without hard-crashing.
 */
export function createBuiltinInspectorPlanner(): SubagentPlanner {
  return async (ctx: SubagentPlannerContext): Promise<SubagentActionDecision> => {
    const { stepIndex, maxSteps, latestObservation, history } = ctx;
    const { scroll, domStats, interactiveElements, health } = latestObservation;

    if (stepIndex === 1 && maxSteps > 1) {
      return {
        type: 'move_mouse',
        points: [
          { x: Math.round(scroll.viewportWidth * 0.25), y: Math.round(scroll.viewportHeight * 0.48) },
          { x: Math.round(scroll.viewportWidth * 0.52), y: Math.round(scroll.viewportHeight * 0.42) },
          { x: Math.round(scroll.viewportWidth * 0.76), y: Math.round(scroll.viewportHeight * 0.5) },
        ],
        label: 'HERO PROBE',
        reason: 'Probe hero section for mouse-reactive animations and hover states',
      };
    }

    if (scroll.scrollProgressPercent < 88 && stepIndex < maxSteps - 1) {
      const stepDelta = Math.max(700, Math.round(scroll.viewportHeight * 0.85));
      return {
        type: 'scroll',
        deltaY: stepDelta,
        reason: `Scroll down (+${stepDelta}px) to inspect next viewport section (current: ${scroll.scrollProgressPercent}%)`,
      };
    }

    const entries = history.getEntries();
    const controlSamples = interactiveElements
      .slice(0, 10)
      .map((el) => `${el.ref} [${el.tag}] "${el.label}"`)
      .join(', ');

    return {
      type: 'complete',
      report: [
        `COMPLETED / TASK_COMPLETED`,
        ``,
        `### Visual Browser Subagent Inspection Report`,
        `- **URL**: ${domStats.url}`,
        `- **Title**: ${domStats.title}`,
        `- **Page Dimensions**: ${scroll.viewportWidth}x${scroll.viewportHeight} viewport, ${scroll.scrollHeight}px total height (scrolled to ${scroll.scrollProgressPercent}%)`,
        `- **Detected Tech Stack**: ${domStats.detectedTechHints.join(', ') || 'Standard HTML/CSS/JS'}`,
        `- **DOM Counts**: canvas=${domStats.counts.canvas}, svg=${domStats.counts.svg}, video=${domStats.counts.video}, img=${domStats.counts.img}, section=${domStats.counts.section}, button=${domStats.counts.button}, a=${domStats.counts.a}`,
        `- **Sampled Interactive Controls**: ${controlSamples || 'none'}`,
        `- **Runtime Health**: ConsoleErrors=${health.consoleErrorsCount}, FailedRequests=${health.failedRequestsCount}/${health.totalRequests}`,
        `- **Steps Captured**: ${entries.length} snapshots (latest: \`${latestObservation.screenshotPath}\`)`,
      ].join('\n'),
    };
  };
}

export class BrowserSubagentRunner {
  private pausedSessions = new Map<string, PausedSubagentState>();
  private sharedSession: BrowserSession | null = null;
  private sharedSessionBusy = false;

  public isOriginPermitted(
    targetUrl: string,
    allowedOrigins?: string[],
    blockedOrigins?: string[]
  ): boolean {
    try {
      const origin = new URL(targetUrl).origin;
      if (blockedOrigins && blockedOrigins.includes(origin)) return false;
      if (allowedOrigins && allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  public getPausedSession(subagentId: string): PausedSubagentState | undefined {
    return this.pausedSessions.get(subagentId);
  }

  public getSharedSession(): BrowserSession | null {
    if (this.sharedSession && !this.sharedSession.isAlive()) {
      this.sharedSession = null;
      this.sharedSessionBusy = false;
    }
    return this.sharedSession;
  }

  public isSharedSessionBusy(): boolean {
    return Boolean(this.getSharedSession() && this.sharedSessionBusy);
  }

  public async acquireReusableSession(
    opts: BrowserSessionOptions,
    allowReuse: boolean
  ): Promise<{ session: BrowserSession; isShared: boolean; reused: boolean }> {
    const existing = allowReuse ? this.getSharedSession() : null;
    if (allowReuse && existing && !this.sharedSessionBusy) {
      this.sharedSessionBusy = true;
      if (opts.cursorStyle) {
        await existing.motion.setCursorStyle(opts.cursorStyle).catch(() => {});
      }
      return { session: existing, isShared: true, reused: true };
    }

    const session = await new BrowserSession(opts).start();
    if (allowReuse && !this.getSharedSession()) {
      this.sharedSession = session;
      this.sharedSessionBusy = true;
      return { session, isShared: true, reused: false };
    }
    return { session, isShared: false, reused: false };
  }

  public async releaseReusableSession(session: BrowserSession, keepAlive: boolean): Promise<void> {
    if (session === this.sharedSession) {
      if (keepAlive && session.isAlive()) {
        this.sharedSessionBusy = false;
        await session.motion.setTakeoverState('idle').catch(() => {});
        return;
      }
      this.sharedSession = null;
      this.sharedSessionBusy = false;
      await session.close().catch(() => {});
      return;
    }

    if (!keepAlive) {
      await session.close().catch(() => {});
    }
  }

  public detachSharedSessionForTakeover(session: BrowserSession): void {
    if (session === this.sharedSession) {
      this.sharedSession = null;
      this.sharedSessionBusy = false;
    }
  }

  public async closeAllSessions(): Promise<void> {
    const sessions = [...this.pausedSessions.values()];
    this.pausedSessions.clear();
    for (const state of sessions) {
      try {
        await state.session.close();
      } catch {
        // ignore cleanup error on already-closed browser
      }
    }
    if (this.sharedSession) {
      const shared = this.sharedSession;
      this.sharedSession = null;
      this.sharedSessionBusy = false;
      try {
        await shared.close();
      } catch {
        // ignore cleanup error on already-closed shared browser
      }
    }
  }

  public async closeAllPausedSessions(): Promise<void> {
    await this.closeAllSessions();
  }

  public async runTask(req: SubagentTaskRequest): Promise<SubagentRunResult> {
    req.signal?.throwIfAborted();
    const subagentId = req.subagentId || `subagent-${crypto.randomUUID().slice(0, 8)}`;
    const maxSteps = req.maxSteps ?? 10;
    const maxRecentImages = req.maxRecentImages ?? 3;
    const snapshotDir = path.join(req.artifactDir, subagentId);
    const keepWindowOpen = Boolean(req.keepWindowOpen);

    const { session, isShared } = await this.acquireReusableSession(
      req.sessionOptions ?? {},
      keepWindowOpen
    );

    const onAbort = () => {
      this.detachSharedSessionForTakeover(session);
      void session.close().catch(() => {});
    };
    req.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await session.resetHumanTakeoverRequest();
      if (req.sessionOptions?.showTakeoverControl ?? session.resolvedWindowMode !== 'headless') {
        await session.motion.setTakeoverState('running', req.role).catch(() => {});
      }

      const hostFacts = new HostFactsTracker(subagentId, req.role, session);
      const history = new SlidingWindowHistory(maxRecentImages);
      const tools = new AtomicBrowserToolset(session, snapshotDir);

      const planner: SubagentPlanner =
        req.planner ||
        (process.env.DSH_VISION_API_KEY
          ? createOpenAIVisionPlanner({
              apiKey: process.env.DSH_VISION_API_KEY,
              baseUrl: process.env.DSH_VISION_BASE_URL,
              model: process.env.DSH_VISION_MODEL,
            })
          : createBuiltinInspectorPlanner());

      if (!this.isOriginPermitted(req.startUrl, req.allowedOrigins, req.blockedOrigins)) {
        hostFacts.recordBlockedOrigin(req.startUrl);
        await this.releaseReusableSession(session, Boolean(keepWindowOpen && isShared));
        return {
          subagentId,
          role: req.role,
          status: 'BLOCKED',
          subagentReport: `BLOCKED: Origin of ${req.startUrl} is not permitted by host policy.`,
          hostFactsBlock: hostFacts.formatHostFactsBlock(),
          hostFacts: hostFacts.getFacts(),
          contextStats: history.getStats(),
        };
      }

      const initRes = await tools.navigate(req.startUrl, 1200);
      req.signal?.throwIfAborted();
      hostFacts.recordStep(initRes.observation.screenshotPath);
      history.pushObservation(initRes.action, initRes.observation, initRes.llmSummary);

      return await this.executeLoop({
        subagentId,
        req,
        session,
        tools,
        hostFacts,
        history,
        planner,
        nextStep: 1,
        maxSteps,
        latestObs: initRes.observation,
        isSharedSession: isShared,
      });
    } catch (err) {
      await this.releaseReusableSession(
        session,
        Boolean(keepWindowOpen && isShared && !req.signal?.aborted)
      );
      throw err;
    } finally {
      req.signal?.removeEventListener('abort', onAbort);
    }
  }

  public async resumeTask(
    subagentId: string,
    userFollowupNote = 'Human takeover completed. Continue the task.',
    signal?: AbortSignal
  ): Promise<SubagentRunResult> {
    signal?.throwIfAborted();
    const paused = this.pausedSessions.get(subagentId);
    if (!paused) {
      throw new Error(`No paused subagent session found for subagentId: ${subagentId}`);
    }
    this.pausedSessions.delete(subagentId);

    const { req, session, tools, hostFacts, history, planner, nextStep, maxSteps } = paused;
    req.signal = signal;
    if (userFollowupNote) {
      req.taskPrompt = `${req.taskPrompt}\n\n[User Follow-up Note]: ${userFollowupNote}`;
    }

    const onAbort = () => {
      void session.close().catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await session.resetHumanTakeoverRequest();
      if (req.sessionOptions?.showTakeoverControl ?? session.resolvedWindowMode !== 'headless') {
        await session.motion.setTakeoverState('running', req.role).catch(() => {});
      }

      const postTakeoverObs = await tools.sampler.captureSnapshot('resumed_after_takeover');
      signal?.throwIfAborted();
      hostFacts.recordStep(postTakeoverObs.screenshotPath);
      history.pushObservation(
        `Resumed after human takeover (${userFollowupNote})`,
        postTakeoverObs,
        tools.sampler.formatObservationForLLM(postTakeoverObs)
      );

      return await this.executeLoop({
        subagentId,
        req,
        session,
        tools,
        hostFacts,
        history,
        planner,
        nextStep,
        maxSteps,
        latestObs: postTakeoverObs,
        isSharedSession: false,
      });
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  private async executeLoop(
    state: PausedSubagentState & { latestObs: PageObservation; isSharedSession: boolean }
  ): Promise<SubagentRunResult> {
    const { subagentId, req, session, tools, hostFacts, history, planner, maxSteps, isSharedSession } =
      state;
    let latestObs = state.latestObs;
    let keepSessionAlive = false;

    const pauseNow = async (
      nextStep: number,
      reason: Parameters<typeof buildApprovalCard>[0]['reason'],
      url: string,
      details: string
    ): Promise<SubagentRunResult> => {
      keepSessionAlive = true;
      this.detachSharedSessionForTakeover(session);
      await session.motion.setTakeoverState('paused', req.role).catch(() => {});
      this.pausedSessions.set(subagentId, {
        subagentId,
        req,
        session,
        tools,
        hostFacts,
        history,
        planner,
        nextStep,
        maxSteps,
      });
      const card = buildApprovalCard({
        subagentId,
        role: req.role,
        reason,
        url,
        screenshotPath: latestObs.screenshotPath,
        details,
      });
      return {
        subagentId,
        role: req.role,
        status: 'PAUSED_FOR_TAKEOVER',
        subagentReport: `${card.title}\n${card.instructions}`,
        hostFactsBlock: hostFacts.formatHostFactsBlock(),
        hostFacts: hostFacts.getFacts(),
        contextStats: history.getStats(),
        approvalCard: card,
      };
    };

    try {
      for (let step = state.nextStep; step <= maxSteps; step++) {
        req.signal?.throwIfAborted();

        if (await session.checkHumanTakeoverRequested()) {
          return await pauseNow(
            step,
            'USER_TAKEOVER',
            session.page.url(),
            '用户在浏览器窗口点击了「暂停并接管」。子代理已立即暂停，请完成人工操作后调用 browser_subagent_resume。'
          );
        }

        if (req.pauseOnGate ?? true) {
          const gate = await detectPageGate(session.page);
          if (gate.detected && gate.reason) {
            return await pauseNow(
              step,
              gate.reason,
              gate.url,
              gate.details ?? 'Page gate detected. Waiting for human action.'
            );
          }
        }

        const decision = await planner({
          stepIndex: step,
          maxSteps,
          taskPrompt: req.taskPrompt,
          latestObservation: latestObs,
          history,
          hostFacts,
          signal: req.signal,
        });
        req.signal?.throwIfAborted();

        if (await session.checkHumanTakeoverRequested()) {
          return await pauseNow(
            step,
            'USER_TAKEOVER',
            session.page.url(),
            '用户在子代理决策期间点击了「暂停并接管」。子代理已立即暂停。'
          );
        }

        if (decision.type === 'complete') {
          return {
            subagentId,
            role: req.role,
            status: 'COMPLETED',
            subagentReport: decision.report,
            hostFactsBlock: hostFacts.formatHostFactsBlock(),
            hostFacts: hostFacts.getFacts(),
            contextStats: history.getStats(),
          };
        }

        if (decision.type === 'pause_for_takeover') {
          return await pauseNow(
            step + 1,
            decision.blockReason,
            session.page.url(),
            decision.message
          );
        }

        if (decision.type === 'navigate') {
          if (!this.isOriginPermitted(decision.url, req.allowedOrigins, req.blockedOrigins)) {
            hostFacts.recordBlockedOrigin(decision.url);
            const snap = await tools.sampler.captureSnapshot('origin_blocked');
            hostFacts.recordStep(snap.screenshotPath);
            history.pushObservation(
              `BLOCKED navigation to ${decision.url} (origin policy)`,
              snap,
              tools.sampler.formatObservationForLLM(snap)
            );
            latestObs = snap;
            continue;
          }
          const res = await tools.navigate(decision.url, 900);
          hostFacts.recordStep(res.observation.screenshotPath);
          history.pushObservation(
            `${res.action} (${decision.reason})`,
            res.observation,
            res.llmSummary
          );
          latestObs = res.observation;
          if (await session.checkHumanTakeoverRequested()) {
            return await pauseNow(
              step + 1,
              'USER_TAKEOVER',
              session.page.url(),
              '用户在导航期间点击了「暂停并接管」。'
            );
          }
          continue;
        }

        if (decision.type === 'set_cursor_style') {
          await tools.setCursorStyle(decision.style);
          if (await session.checkHumanTakeoverRequested()) {
            return await pauseNow(
              step + 1,
              'USER_TAKEOVER',
              session.page.url(),
              '用户在更新光标样式后点击了「暂停并接管」。'
            );
          }
          continue;
        }

        let actionResult;
        if (decision.type === 'move_mouse') {
          actionResult = await tools.moveMouse(decision.points, decision.label ?? 'SUBAGENT SWEEP');
        } else if (decision.type === 'hover') {
          actionResult = await tools.hover(decision.target);
        } else if (decision.type === 'click') {
          actionResult = await tools.click(decision.target, 320);
        } else if (decision.type === 'type_text') {
          actionResult = await tools.typeText(
            decision.target,
            decision.text,
            decision.pressEnter ?? false
          );
        } else if (decision.type === 'scroll') {
          actionResult = await tools.scroll(decision.deltaY, 320);
        } else {
          throw new Error(`Unsupported decision: ${JSON.stringify(decision)}`);
        }

        hostFacts.recordStep(actionResult.observation.screenshotPath);
        history.pushObservation(
          `${actionResult.action} — ${decision.reason}`,
          actionResult.observation,
          actionResult.llmSummary
        );
        latestObs = actionResult.observation;

        if (await session.checkHumanTakeoverRequested()) {
          return await pauseNow(
            step + 1,
            'USER_TAKEOVER',
            session.page.url(),
            '用户在执行动作期间点击了「暂停并接管」。请人工接管完成后调用 browser_subagent_resume。'
          );
        }
      }

      return {
        subagentId,
        role: req.role,
        status: 'MAX_STEPS_REACHED',
        subagentReport: `MAX_STEPS_REACHED after ${maxSteps} steps.`,
        hostFactsBlock: hostFacts.formatHostFactsBlock(),
        hostFacts: hostFacts.getFacts(),
        contextStats: history.getStats(),
      };
    } finally {
      if (!keepSessionAlive) {
        await this.releaseReusableSession(
          session,
          Boolean(req.keepWindowOpen && isSharedSession && !req.signal?.aborted)
        );
      }
    }
  }
}
