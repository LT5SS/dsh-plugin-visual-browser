import { BrowserSession } from '../driver/browser-session.js';
import type { BrowserSessionOptions, Point2D, VirtualCursorStyleConfig } from '../driver/types.js';
import { AtomicBrowserToolset } from '../tools/atomic-tools.js';
import { HostFactsTracker, type HostFactsData } from './host-facts.js';
import { SlidingWindowHistory, type SlidingContextStats } from './sliding-context.js';
import { type PageObservation } from '../sampler/page-snapshot.js';
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
    type: 'drag';
    from: string | Point2D;
    to: string | Point2D;
    steps?: number;
    keepSelection?: boolean;
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
    /** Optional hook receiving per-step action outcomes (e.g. PLUGIN_UI_LAYER refusals) for diagnostics */
    onActionResult?: (info: {
        stepIndex: number;
        decision: SubagentActionDecision;
        ok: boolean;
        blocked?: 'PLUGIN_UI_LAYER';
        hit?: string;
        at?: Point2D;
        hint?: string;
        midFrame?: string;
    }) => void;
    planner?: SubagentPlanner;
}
export interface SubagentRunResult {
    subagentId: string;
    role: string;
    status: 'COMPLETED' | 'BLOCKED' | 'PAUSED_FOR_TAKEOVER' | 'MAX_STEPS_REACHED' | 'SESSION_LOST' | 'SESSION_NOT_FOUND';
    reason?: string;
    hint?: string;
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
export declare const SUBAGENT_SYSTEM_PROMPT = "You are an isolated Visual Browser Subagent inside DeepSeek Harness (DSH).\nYou operate a background browser equipped with a physical Bezier virtual cursor.\nAt each step you receive:\n1. A compact archive of earlier steps (images evicted to save context);\n2. The latest 1-3 viewport screenshots with the virtual cursor & trail visible;\n3. The 3-in-1 Observation HUD (scroll metrics, DOM/tech stats, console/network errors, and numbered #ref interactive controls).\n\nRespond ONLY with a single valid JSON object matching one of these actions:\n- {\"type\":\"move_mouse\",\"points\":[{\"x\":300,\"y\":400},{\"x\":800,\"y\":420}],\"label\":\"SWEEP\",\"reason\":\"...\"}\n- {\"type\":\"hover\",\"target\":\"#3\",\"reason\":\"...\"}\n- {\"type\":\"click\",\"target\":\"#8\",\"reason\":\"...\"}\n- {\"type\":\"drag\",\"from\":\"#2\",\"to\":{\"x\":640,\"y\":380},\"steps\":12,\"reason\":\"...\"}\n- {\"type\":\"type_text\",\"target\":\"#5\",\"text\":\"hello\",\"pressEnter\":true,\"reason\":\"...\"}\n- {\"type\":\"scroll\",\"deltaY\":800,\"reason\":\"...\"}\n- {\"type\":\"navigate\",\"url\":\"https://...\",\"reason\":\"...\"}\n- {\"type\":\"pause_for_takeover\",\"blockReason\":\"LOGIN_REQUIRED\",\"message\":\"...\"}\n- {\"type\":\"complete\",\"report\":\"COMPLETED / TASK_COMPLETED\\n\\nDetailed markdown report...\"}\n\n\u4E8B\u5B9E\u7EAA\u5F8B\uFF08\u8FDD\u53CD\u5373\u4E3A\u62A5\u544A\u5931\u8D25\uFF09\uFF1A\n1. \u53EA\u80FD\u62A5\u544A HUD / \u5DE5\u5177\u8FD4\u56DE\u503C\u91CC**\u5B9E\u9645\u51FA\u73B0**\u7684\u5B57\u6BB5\u3002HUD \u6CA1\u6709\u66B4\u9732\u7684\u5B57\u6BB5\uFF08\u4F8B\u5982\u672A\u66B4\u9732 href \u6216 value\uFF09\uFF0C\u5FC5\u987B\u660E\u786E\u5199\u300CHUD \u672A\u66B4\u9732\u8BE5\u5B57\u6BB5\u300D\uFF0C\u7981\u6B62\u7528\u4F60\u5BF9\u7AD9\u70B9\u7684\u5148\u9A8C\u77E5\u8BC6\u6216\u8BAD\u7EC3\u8BB0\u5FC6\u8865\u5168\uFF0C\u4E5F\u7981\u6B62\u5199\"\u4F9D\u636E\u6807\u51C6\u7ED3\u6784\u63A8\u65AD\"\u3002\n2. \u62A5\u544A\u91CC\u6BCF\u4E2A\u5173\u952E\u4E8B\u5B9E\u540E\u9762\u5FC5\u987B\u6807\u6CE8\u6765\u6E90\uFF0C\u4F8B\u5982 `href=... (\u6765\u6E90: #1 HUD)` \u6216 `\u6807\u9898=... (\u6765\u6E90: page title)`\u3002\n3. \u4E0D\u786E\u5B9A\u5C31\u660E\u8BF4\u4E0D\u786E\u5B9A\uFF0C\u7EDD\u4E0D\u4E3A\u4E86\u5B8C\u6210\u62A5\u544A\u800C\u7F16\u9020\u6216\u731C\u6D4B\u672A\u89C2\u6D4B\u5230\u7684\u5185\u5BB9\u3002\n\n\u52A8\u4F5C\u6548\u7387\u4E0E\u6B65\u6570\u9884\u7B97\u89C4\u5219\uFF1A\n1. `move_mouse` \u7684\u88C5\u9970\u6027\u8F68\u8FF9\u52A8\u4F5C\uFF08\u5982 jiggle\u3001slow approach\u3001probe\uFF09**\u4EC5\u5728\u7528\u6237\u660E\u786E\u8981\u6C42\u6F14\u793A\u9F20\u6807\u8F68\u8FF9\u65F6\u4F7F\u7528**\uFF1B\u5426\u5219\u76F4\u63A5\u4F7F\u7528 `hover` / `click` / `scroll` / `type_text` / `navigate` \u7B49\u8BED\u4E49\u52A8\u4F5C\uFF0C\u6216\u76F4\u63A5\u6C47\u603B\u7ED3\u679C\u3002\n2. \u5F53\u73B0\u6709 HUD \u5DF2\u5305\u542B\u4EFB\u52A1\u6240\u9700\u7684\u5168\u90E8\u4E8B\u5B9E\u65F6\uFF0C\u7ACB\u5373\u8FD4\u56DE `complete`\uFF0C\u4E0D\u8981\"\u518D\u6478\u4E00\u4E0B\u786E\u8BA4\"\u3002\n3. \u82E5\u52A8\u4F5C\u8FD4\u56DE `[ACTION_REFUSED] {\"ok\":false,\"blocked\":\"PLUGIN_UI_LAYER\",...}`\uFF0C\u8BF4\u660E\u76EE\u6807\u5750\u6807\u88AB\u5DE5\u5177\u81EA\u8EAB\u9876\u5C42 UI \u906E\u6321\uFF08\u771F\u5B9E\u70B9\u51FB\u672A\u53D1\u9001\uFF09\uFF0C\u8BF7\u5148 `scroll` \u8C03\u6574\u4F4D\u7F6E\u6216\u6539\u7528\u672A\u88AB\u906E\u6321\u7684 `#ref`\uFF0C\u7981\u6B62\u53CD\u590D\u70B9\u51FB\u540C\u4E00\u88AB\u906E\u6321\u5750\u6807\u3002\n4. \u65F6\u523B\u5173\u6CE8\u5269\u4F59\u6B65\u6570\u9884\u7B97\uFF08`stepIndex / maxSteps`\uFF09\uFF1A\u82E5\u5269\u4F59\u6B65\u6570 <= 1\uFF0C\u5FC5\u987B\u5728\u672C\u6B65\u76F4\u63A5\u8FD4\u56DE `complete` \u6536\u5C3E\u3002";
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
export declare function summarizeDecisionAction(decision: SubagentActionDecision): Record<string, unknown>;
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
    private lostSessions;
    private watchedSessions;
    private sharedSession;
    private sharedSessionBusy;
    private buildFallbackHostFacts;
    private safeReadHostFacts;
    private safeReadContextStats;
    private writeSessionLostDiagnostics;
    watchSessionDisconnect(session: BrowserSession): void;
    handleSessionDisconnected(session: BrowserSession): void;
    private recordLostSession;
    private buildSessionLostResult;
    isOriginPermitted(targetUrl: string, allowedOrigins?: string[], blockedOrigins?: string[]): boolean;
    getPausedSession(subagentId: string): PausedSubagentState | undefined;
    getPausedSessionCount(): number;
    getSharedSession(): BrowserSession | null;
    getAllActiveSessions(): BrowserSession[];
    isSharedSessionBusy(): boolean;
    acquireReusableSession(opts: BrowserSessionOptions, allowReuse: boolean): Promise<{
        session: BrowserSession;
        isShared: boolean;
        reused: boolean;
    }>;
    releaseReusableSession(session: BrowserSession, keepAlive: boolean): Promise<void>;
    detachSharedSessionForTakeover(session: BrowserSession): void;
    closeAllSessions(): Promise<void>;
    closeAllPausedSessions(): Promise<void>;
    runTask(req: SubagentTaskRequest): Promise<SubagentRunResult>;
    resumeTask(subagentId: string, userFollowupNote?: string, signal?: AbortSignal): Promise<SubagentRunResult>;
    private executeLoop;
}
export {};
