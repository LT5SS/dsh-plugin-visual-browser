import { BrowserSession } from '../driver/browser-session.js';
import type { BrowserSessionOptions, Point2D, VirtualCursorStyleConfig } from '../driver/types.js';
import type { PageObservation } from '../sampler/page-snapshot.js';
import { AtomicBrowserToolset } from '../tools/atomic-tools.js';
import { HostFactsTracker, type HostFactsData } from './host-facts.js';
import { SlidingWindowHistory, type SlidingContextStats } from './sliding-context.js';
import { type DshApprovalCardPayload, type GateReason } from '../guardrails/takeover.js';
export type SubagentActionDecision = {
    type: 'navigate';
    url: string;
    reason: string;
} | {
    type: 'move_mouse';
    points: Point2D | Point2D[];
    label?: string;
    reason: string;
} | {
    type: 'hover';
    target: string | Point2D;
    reason: string;
} | {
    type: 'click';
    target: string | Point2D;
    reason: string;
} | {
    type: 'type_text';
    target: string;
    text: string;
    pressEnter?: boolean;
    reason: string;
} | {
    type: 'scroll';
    deltaY: number;
    reason: string;
} | {
    type: 'set_cursor_style';
    style: VirtualCursorStyleConfig;
    reason: string;
} | {
    type: 'complete';
    report: string;
} | {
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
export declare const SUBAGENT_SYSTEM_PROMPT = "You are an isolated Visual Browser Subagent inside DeepSeek Harness (DSH).\nYou operate a background browser equipped with a physical Bezier virtual cursor.\nAt each step you receive:\n1. A compact archive of earlier steps (images evicted to save context);\n2. The latest 1-3 viewport screenshots with the virtual cursor & trail visible;\n3. The 3-in-1 Observation HUD (scroll metrics, DOM/tech stats, console/network errors, and numbered #ref interactive controls).\n\nRespond ONLY with a single valid JSON object matching one of these actions:\n- {\"type\":\"move_mouse\",\"points\":[{\"x\":300,\"y\":400},{\"x\":800,\"y\":420}],\"label\":\"SWEEP\",\"reason\":\"...\"}\n- {\"type\":\"hover\",\"target\":\"#3\",\"reason\":\"...\"}\n- {\"type\":\"click\",\"target\":\"#8\",\"reason\":\"...\"}\n- {\"type\":\"type_text\",\"target\":\"#5\",\"text\":\"hello\",\"pressEnter\":true,\"reason\":\"...\"}\n- {\"type\":\"scroll\",\"deltaY\":800,\"reason\":\"...\"}\n- {\"type\":\"navigate\",\"url\":\"https://...\",\"reason\":\"...\"}\n- {\"type\":\"pause_for_takeover\",\"blockReason\":\"LOGIN_REQUIRED\",\"message\":\"...\"}\n- {\"type\":\"complete\",\"report\":\"COMPLETED / TASK_COMPLETED\\n\\nDetailed markdown report...\"}";
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
}
/** Validates that a parsed JSON object matches one of the 9 supported SubagentActionDecision variants. */
export declare function isValidSubagentDecision(value: unknown): value is SubagentActionDecision;
/**
 * Extracts and structurally validates the first JSON decision object from a model text response.
 * Returns `null` (never throws) on empty strings, prose, malformed JSON, or invalid action shapes.
 */
export declare function parseJsonDecision(rawText: string): SubagentActionDecision | null;
/**
 * Normalizes diverse host `ctx.llm.stream()` chunk shapes and records unknown schemas for diagnostics.
 */
export declare function extractHostStreamChunk(chunk: unknown): {
    kind: string;
    text: string;
    error?: string;
    unrecognizedKeys?: string[];
};
/**
 * Creates a planner backed by DSH 0.2's native `ctx.llm` runtime service when available.
 * Automatically retries text-only when an image attachment causes failure, records chunk
 * diagnostics, and degrades cleanly to `fallbackPlanner` (default: `createBuiltinInspectorPlanner()`)
 * instead of throwing on empty streams or non-JSON responses.
 */
export declare function createDshHostLlmPlanner(opts: {
    llm: any;
    attachments?: any;
    provider: string;
    model: string;
    sessionId?: string;
    fallbackPlanner?: SubagentPlanner;
    onStepDiagnostic?: (diag: PlannerStepDiagnostic) => void;
}): SubagentPlanner;
/**
 * Creates a Vision LLM planner talking to any OpenAI-compatible multimodal endpoint.
 * Includes timeout, AbortSignal propagation, gateway compatibility retry, and safe fallback.
 */
export declare function createOpenAIVisionPlanner(opts: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
    timeoutMs?: number;
    fallbackPlanner?: SubagentPlanner;
    onStepDiagnostic?: (diag: PlannerStepDiagnostic) => void;
}): SubagentPlanner;
/**
 * Built-in Zero-Config Autonomous Visual Walkthrough Planner.
 * Used when neither a custom planner, DSH host LLM selection, nor DSH_VISION_API_KEY is configured,
 * ensuring `browser_subagent_run` works out-of-the-box without hard-crashing.
 */
export declare function createBuiltinInspectorPlanner(): SubagentPlanner;
export declare class BrowserSubagentRunner {
    private pausedSessions;
    isOriginPermitted(targetUrl: string, allowedOrigins?: string[], blockedOrigins?: string[]): boolean;
    getPausedSession(subagentId: string): PausedSubagentState | undefined;
    closeAllPausedSessions(): Promise<void>;
    runTask(req: SubagentTaskRequest): Promise<SubagentRunResult>;
    resumeTask(subagentId: string, userFollowupNote?: string, signal?: AbortSignal): Promise<SubagentRunResult>;
    private executeLoop;
}
export {};
