import crypto from 'node:crypto';
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
}

export type SubagentPlanner = (ctx: SubagentPlannerContext) => Promise<SubagentActionDecision>;

export interface SubagentTaskRequest {
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

const SUBAGENT_SYSTEM_PROMPT = `You are an isolated Visual Browser Subagent inside DeepSeek Harness (DSH).
You operate a background browser equipped with a physical Bezier virtual cursor.
At each step you receive:
1. A compact archive of earlier steps (images evicted to save context);
2. The latest 1-3 viewport screenshots with the virtual cursor & trail visible;
3. The 3-in-1 Observation HUD (scroll metrics, DOM/tech stats, console/network errors, and numbered #ref interactive controls).

Respond ONLY with a valid JSON object matching one of these actions:
- {"type":"move_mouse","points":[{"x":300,"y":400},{"x":800,"y":420}],"label":"SWEEP","reason":"..."}
- {"type":"hover","target":"#3","reason":"..."}
- {"type":"click","target":"#8","reason":"..."}
- {"type":"type_text","target":"#5","text":"hello","pressEnter":true,"reason":"..."}
- {"type":"scroll","deltaY":800,"reason":"..."}
- {"type":"navigate","url":"https://...","reason":"..."}
- {"type":"pause_for_takeover","blockReason":"LOGIN_REQUIRED","message":"..."}
- {"type":"complete","report":"COMPLETED / TASK_COMPLETED\\n\\nDetailed markdown report..."}`;

export function createOpenAIVisionPlanner(opts: {
  apiKey: string;
  baseUrl?: string;
  model?: string;
}): SubagentPlanner {
  const baseUrl = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = opts.model || 'gpt-4o-mini';

  return async (ctx: SubagentPlannerContext): Promise<SubagentActionDecision> => {
    const messages = ctx.history.buildMultimodalMessages(SUBAGENT_SYSTEM_PROMPT, ctx.taskPrompt);
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${opts.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.2,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) {
      throw new Error(`Vision LLM request failed: HTTP ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as any;
    const rawContent = data.choices?.[0]?.message?.content || '{}';
    return JSON.parse(rawContent) as SubagentActionDecision;
  };
}

export class BrowserSubagentRunner {
  private pausedSessions = new Map<string, PausedSubagentState>();

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

  public async closeAllPausedSessions(): Promise<void> {
    for (const state of this.pausedSessions.values()) {
      await state.session.close();
    }
    this.pausedSessions.clear();
  }

  public async runTask(req: SubagentTaskRequest): Promise<SubagentRunResult> {
    const subagentId = `subagent-${crypto.randomUUID().slice(0, 8)}`;
    const maxSteps = req.maxSteps ?? 10;
    const maxRecentImages = req.maxRecentImages ?? 3;
    const snapshotDir = path.join(req.artifactDir, subagentId);

    const session = await new BrowserSession(req.sessionOptions).start();
    const hostFacts = new HostFactsTracker(subagentId, req.role, session);
    const history = new SlidingWindowHistory(maxRecentImages);
    const tools = new AtomicBrowserToolset(session, snapshotDir);

    const planner =
      req.planner ||
      (process.env.DSH_VISION_API_KEY
        ? createOpenAIVisionPlanner({
            apiKey: process.env.DSH_VISION_API_KEY,
            baseUrl: process.env.DSH_VISION_BASE_URL,
            model: process.env.DSH_VISION_MODEL,
          })
        : undefined);

    if (!planner) {
      await session.close();
      throw new Error('No SubagentPlanner provided and DSH_VISION_API_KEY is not set.');
    }

    if (!this.isOriginPermitted(req.startUrl, req.allowedOrigins, req.blockedOrigins)) {
      hostFacts.recordBlockedOrigin(req.startUrl);
      await session.close();
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
    hostFacts.recordStep(initRes.observation.screenshotPath);
    history.pushObservation(initRes.action, initRes.observation, initRes.llmSummary);

    return this.executeLoop({
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
    });
  }

  /**
   * Resumes a paused subagent session in the exact same open browser tab after human takeover.
   */
  public async resumeTask(
    subagentId: string,
    userFollowupNote = 'Human takeover completed. Continue the task.'
  ): Promise<SubagentRunResult> {
    const paused = this.pausedSessions.get(subagentId);
    if (!paused) {
      throw new Error(`No paused subagent session found for subagentId: ${subagentId}`);
    }
    this.pausedSessions.delete(subagentId);

    const { req, session, tools, hostFacts, history, planner, nextStep, maxSteps } = paused;
    if (userFollowupNote) {
      req.taskPrompt = `${req.taskPrompt}\n\n[User Follow-up Note]: ${userFollowupNote}`;
    }

    const postTakeoverObs = await tools.sampler.captureSnapshot('resumed_after_takeover');
    hostFacts.recordStep(postTakeoverObs.screenshotPath);
    history.pushObservation(
      `Resumed after human takeover (${userFollowupNote})`,
      postTakeoverObs,
      tools.sampler.formatObservationForLLM(postTakeoverObs)
    );

    return this.executeLoop({
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
    });
  }

  private async executeLoop(state: PausedSubagentState & { latestObs: PageObservation }): Promise<SubagentRunResult> {
    const { subagentId, req, session, tools, hostFacts, history, planner, maxSteps } = state;
    let latestObs = state.latestObs;
    let keepSessionAlive = false;

    try {
      for (let step = state.nextStep; step <= maxSteps; step++) {
        // 1. Automatic Host Gate Check (CAPTCHA / Payment / Login Wall)
        if (req.pauseOnGate ?? true) {
          const gate = await detectPageGate(session.page);
          if (gate.detected && gate.reason) {
            keepSessionAlive = true;
            this.pausedSessions.set(subagentId, {
              subagentId,
              req,
              session,
              tools,
              hostFacts,
              history,
              planner,
              nextStep: step,
              maxSteps,
            });
            const card = buildApprovalCard({
              subagentId,
              role: req.role,
              reason: gate.reason,
              url: gate.url,
              screenshotPath: latestObs.screenshotPath,
              details: gate.details,
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
          }
        }

        // 2. Ask Subagent Planner for next action
        const decision = await planner({
          stepIndex: step,
          maxSteps,
          taskPrompt: req.taskPrompt,
          latestObservation: latestObs,
          history,
          hostFacts,
        });

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
          keepSessionAlive = true;
          this.pausedSessions.set(subagentId, {
            subagentId,
            req,
            session,
            tools,
            hostFacts,
            history,
            planner,
            nextStep: step + 1,
            maxSteps,
          });
          const card = buildApprovalCard({
            subagentId,
            role: req.role,
            reason: decision.blockReason,
            url: session.page.url(),
            screenshotPath: latestObs.screenshotPath,
            details: decision.message,
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
          continue;
        }

        if (decision.type === 'set_cursor_style') {
          await tools.setCursorStyle(decision.style);
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
        await session.close();
      }
    }
  }
}
