import { BrowserSession } from '../driver/browser-session.js';
import type { ActionBlockedReason, BrowserSessionOptions, MotionInspectResult, NavigateWaitUntil, NavigationDiagnostic, Point2D, ScrollDiagnostic, VirtualCursorStyleConfig } from '../driver/types.js';
import { AtomicBrowserToolset } from '../tools/atomic-tools.js';
import { HostFactsTracker, type HostFactsData } from './host-facts.js';
import { SlidingWindowHistory, type SlidingContextStats } from './sliding-context.js';
import { FindingsLedger, MAX_FINDINGS_ENTRIES, MAX_FINDING_NOTE_CHARS, MAX_FINDINGS_TOTAL_CHARS, RECENT_FINDINGS_WINDOW, type SubagentFinding } from './findings.js';
import { type PageObservation } from '../sampler/page-snapshot.js';
export { FindingsLedger, MAX_FINDINGS_ENTRIES, MAX_FINDING_NOTE_CHARS, MAX_FINDINGS_TOTAL_CHARS, RECENT_FINDINGS_WINDOW, type SubagentFinding, };
import { type DshApprovalCardPayload, type GateReason } from '../guardrails/takeover.js';
export type SubagentActionDecision = {
    type: 'navigate';
    url: string;
    waitUntil?: NavigateWaitUntil;
    timeoutMs?: number;
    reason: string;
    note?: string;
} | {
    type: 'move_mouse';
    points: Point2D | Point2D[];
    label?: string;
    reason: string;
    note?: string;
} | {
    type: 'hover';
    target: string | Point2D;
    reason: string;
    note?: string;
} | {
    type: 'click';
    target: string | Point2D;
    if_present?: boolean;
    reason: string;
    note?: string;
} | {
    type: 'drag';
    from: string | Point2D;
    to: string | Point2D;
    steps?: number;
    keepSelection?: boolean;
    reason: string;
    note?: string;
} | {
    type: 'type_text';
    target: string;
    text: string;
    pressEnter?: boolean;
    reason: string;
    note?: string;
} | {
    type: 'scroll';
    deltaY: number;
    reason: string;
    note?: string;
} | {
    type: 'inspect_motion';
    target: string | Point2D;
    reason: string;
    note?: string;
} | {
    type: 'set_cursor_style';
    style: VirtualCursorStyleConfig;
    reason: string;
    note?: string;
} | {
    type: 'complete';
    report: string;
    note?: string;
} | {
    type: 'pause_for_takeover';
    blockReason: GateReason | 'ORIGIN_BLOCKED';
    message: string;
    note?: string;
};
export interface SubagentPlannerContext {
    stepIndex: number;
    maxSteps: number;
    taskPrompt: string;
    latestObservation: PageObservation;
    history: SlidingWindowHistory;
    hostFacts: HostFactsTracker;
    findings?: readonly SubagentFinding[];
    findingsBlock?: string;
    signal?: AbortSignal;
}
export type SubagentPlanner = (ctx: SubagentPlannerContext) => Promise<SubagentActionDecision>;
export type TakeoverPauseSource = 'f8' | 'button' | 'gate';
export type TakeoverResumeSource = 'button' | 'tool';
export interface SubagentDiagnosticsUpdate {
    phase: 'paused' | 'resuming' | 'finished';
    status: SubagentRunResult['status'] | 'RUNNING';
    subagentId: string;
    pausedAt?: string;
    pausedBy?: TakeoverPauseSource;
    resumedAt?: string;
    resumedBy?: TakeoverResumeSource;
    result?: SubagentRunResult;
    hostFacts?: HostFactsData;
    contextStats?: SlidingContextStats;
    findings?: SubagentFinding[];
    navigation?: NavigationDiagnostic;
}
export interface SubagentTaskRequest {
    subagentId?: string;
    role: string;
    taskPrompt: string;
    startUrl: string;
    waitUntil?: NavigateWaitUntil;
    timeoutMs?: number;
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
        blocked?: ActionBlockedReason;
        skipped?: boolean;
        hit?: string;
        at?: Point2D;
        hint?: string;
        midFrame?: string;
        scroll?: ScrollDiagnostic;
        motion?: MotionInspectResult;
    }) => void;
    /** Optional hook receiving pause/resume/completion diagnostics lifecycle transitions */
    onDiagnosticsUpdate?: (update: SubagentDiagnosticsUpdate) => void | Promise<void>;
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
    findings?: SubagentFinding[];
    approvalCard?: DshApprovalCardPayload;
    navigation?: NavigationDiagnostic;
    pausedAt?: string;
    pausedBy?: TakeoverPauseSource;
    resumedAt?: string;
    resumedBy?: TakeoverResumeSource;
}
interface PausedSubagentState {
    subagentId: string;
    req: SubagentTaskRequest;
    session: BrowserSession;
    tools: AtomicBrowserToolset;
    hostFacts: HostFactsTracker;
    history: SlidingWindowHistory;
    findingsLedger: FindingsLedger;
    planner: SubagentPlanner;
    nextStep: number;
    maxSteps: number;
    latestNavigation?: NavigationDiagnostic;
    pausedAt?: string;
    pausedBy?: TakeoverPauseSource;
}
export declare const SUBAGENT_SYSTEM_PROMPT = "You are an isolated Visual Browser Subagent inside DeepSeek Harness (DSH).\nYou operate a background browser equipped with a physical Bezier virtual cursor.\nAt each step you receive:\n1. A compact archive of earlier steps (images evicted to save context);\n2. The latest 1-3 viewport screenshots with the virtual cursor & trail visible;\n3. The 3-in-1 Observation HUD (scroll metrics, DOM/tech stats, console/network errors, numbered #ref interactive controls, and a ## Design block when available), plus ## Findings so far across prior steps.\n\nRespond ONLY with a single valid JSON object matching one of these actions (any action may include an optional \"note\":\"...\" <=120 chars to record key visual/design/content findings into ## Findings so far):\n- {\"type\":\"move_mouse\",\"points\":[{\"x\":300,\"y\":400},{\"x\":800,\"y\":420}],\"label\":\"SWEEP\",\"reason\":\"...\"}\n- {\"type\":\"hover\",\"target\":\"#3\",\"reason\":\"...\"}\n- {\"type\":\"click\",\"target\":\"#8\",\"reason\":\"...\"}\n- {\"type\":\"click\",\"target\":\"#1\",\"if_present\":true,\"reason\":\"...\"} (optional: skip cleanly without failure if splash/banner already auto-dismissed)\n- {\"type\":\"drag\",\"from\":\"#2\",\"to\":{\"x\":640,\"y\":380},\"steps\":12,\"reason\":\"...\"}\n- {\"type\":\"type_text\",\"target\":\"#5\",\"text\":\"hello\",\"pressEnter\":true,\"reason\":\"...\"}\n- {\"type\":\"scroll\",\"deltaY\":800,\"reason\":\"...\"}\n- {\"type\":\"inspect_motion\",\"target\":\"#3\",\"reason\":\"...\"} or {\"type\":\"inspect_motion\",\"target\":{\"x\":640,\"y\":380},\"reason\":\"...\"} (read-only pointer-driven hover/transform/canvas-pixel probe without clicking; use {x,y} on <canvas> areas)\n- {\"type\":\"navigate\",\"url\":\"https://...\",\"reason\":\"...\"}\n- {\"type\":\"pause_for_takeover\",\"blockReason\":\"LOGIN_REQUIRED\",\"message\":\"...\"}\n- {\"type\":\"complete\",\"report\":\"COMPLETED / TASK_COMPLETED\\n\\nDetailed markdown report...\"}\n\nJSON \u8F93\u51FA\u683C\u5F0F\u7EA2\u7EBF\uFF08\u53CD\u4F8B\u8B66\u793A\uFF09\uFF1A\n- \u4E25\u7981\u5305\u88F9 ```json ... ``` \u4EE3\u7801\u5757\uFF0C\u4E25\u7981\u5728 JSON \u524D\u540E\u5199\u4EFB\u4F55\u89E3\u91CA\u3001\u601D\u8003\u6216\u5BD2\u6684\uFF08\u4F8B\u5982\u53CD\u4F8B\uFF1A`\u597D\u7684\uFF0C\u63A5\u4E0B\u6765\u70B9\u51FB #2\uFF1A{\"type\":\"click\",...}` \u4E3A\u975E\u6CD5\u8F93\u51FA\uFF09\uFF1B\u6BCF\u6B21\u56DE\u590D\u6709\u4E14\u4EC5\u6709\u4E00\u4E2A\u88F8 JSON \u5BF9\u8C61\u672C\u8EAB\u3002\n\n\u4E8B\u5B9E\u7EAA\u5F8B\uFF08\u8FDD\u53CD\u5373\u4E3A\u62A5\u544A\u5931\u8D25\uFF09\uFF1A\n1. \u53EA\u80FD\u62A5\u544A HUD / \u5DE5\u5177\u8FD4\u56DE\u503C\u91CC**\u5B9E\u9645\u51FA\u73B0**\u7684\u5B57\u6BB5\u3002HUD \u6CA1\u6709\u66B4\u9732\u7684\u5B57\u6BB5\uFF08\u4F8B\u5982\u672A\u66B4\u9732 href \u6216 value\uFF09\uFF0C\u5FC5\u987B\u660E\u786E\u5199\u300CHUD \u672A\u66B4\u9732\u8BE5\u5B57\u6BB5\u300D\uFF0C\u7981\u6B62\u7528\u4F60\u5BF9\u7AD9\u70B9\u7684\u5148\u9A8C\u77E5\u8BC6\u6216\u8BAD\u7EC3\u8BB0\u5FC6\u8865\u5168\uFF0C\u4E5F\u7981\u6B62\u5199\"\u4F9D\u636E\u6807\u51C6\u7ED3\u6784\u63A8\u65AD\"\u3002\n2. \u62A5\u544A\u91CC\u6BCF\u4E2A\u5173\u952E\u4E8B\u5B9E\u540E\u9762\u5FC5\u987B\u6807\u6CE8\u6765\u6E90\uFF0C\u4F8B\u5982 `href=... (\u6765\u6E90: #1 HUD)` \u6216 `\u6807\u9898=... (\u6765\u6E90: page title)`\u3002\n3. \u4E0D\u786E\u5B9A\u5C31\u660E\u8BF4\u4E0D\u786E\u5B9A\uFF0C\u7EDD\u4E0D\u4E3A\u4E86\u5B8C\u6210\u62A5\u544A\u800C\u7F16\u9020\u6216\u731C\u6D4B\u672A\u89C2\u6D4B\u5230\u7684\u5185\u5BB9\u3002\n4. \u8C03\u7814/\u590D\u523B\u7F51\u7AD9\u52A8\u6548\u65F6\uFF0C\u7EFC\u5408 `## Design`\u3001`DOM & Tech`\u3001`Scroll Result` \u4E0E `inspect_motion`\uFF0C\u6309\u300C\u6EDA\u52A8\u9A71\u52A8 / \u6307\u9488\u9A71\u52A8 / \u65F6\u95F4\u9A71\u52A8\u300D\u4E09\u7C7B\u7ED9\u51FA\u5E76\u9644\u5177\u4F53\u6D4B\u91CF\u503C\uFF08\u5982 `effective_dom_delta`\u3001`transform` \u53D8\u5316\u6216 `transition` \u6570\u91CF\uFF09\u3002\n\n\u52A8\u4F5C\u6548\u7387\u4E0E\u6B65\u6570\u9884\u7B97\u89C4\u5219\uFF1A\n1. `move_mouse` \u7684\u88C5\u9970\u6027\u8F68\u8FF9\u52A8\u4F5C\uFF08\u5982 jiggle\u3001slow approach\u3001probe\uFF09**\u4EC5\u5728\u7528\u6237\u660E\u786E\u8981\u6C42\u6F14\u793A\u9F20\u6807\u8F68\u8FF9\u65F6\u4F7F\u7528**\uFF1B\u5426\u5219\u76F4\u63A5\u4F7F\u7528 `hover` / `click` / `scroll` / `type_text` / `navigate` \u7B49\u8BED\u4E49\u52A8\u4F5C\uFF0C\u6216\u76F4\u63A5\u6C47\u603B\u7ED3\u679C\u3002\n2. \u5F53\u73B0\u6709 HUD \u5DF2\u5305\u542B\u4EFB\u52A1\u6240\u9700\u7684\u5168\u90E8\u4E8B\u5B9E\u65F6\uFF0C\u7ACB\u5373\u8FD4\u56DE `complete`\uFF0C\u4E0D\u8981\"\u518D\u6478\u4E00\u4E0B\u786E\u8BA4\"\u3002\n3. \u82E5\u52A8\u4F5C\u8FD4\u56DE `[ACTION_REFUSED] {\"ok\":false,\"blocked\":\"PLUGIN_UI_LAYER\",...}`\uFF0C\u8BF4\u660E\u76EE\u6807\u5750\u6807\u88AB\u5DE5\u5177\u81EA\u8EAB\u9876\u5C42 UI \u906E\u6321\uFF08\u771F\u5B9E\u70B9\u51FB\u672A\u53D1\u9001\uFF09\uFF0C\u8BF7\u5148 `scroll` \u8C03\u6574\u4F4D\u7F6E\u6216\u6539\u7528\u672A\u88AB\u906E\u6321\u7684 `#ref`\uFF0C\u7981\u6B62\u53CD\u590D\u70B9\u51FB\u540C\u4E00\u88AB\u906E\u6321\u5750\u6807\u3002\n4. \u65F6\u523B\u5173\u6CE8\u5269\u4F59\u6B65\u6570\u9884\u7B97\uFF08`stepIndex / maxSteps`\uFF09\uFF1A\u82E5\u5269\u4F59\u6B65\u6570 <= 1\uFF0C\u5FC5\u987B\u5728\u672C\u6B65\u76F4\u63A5\u8FD4\u56DE `complete` \u6536\u5C3E\u3002";
export type DecisionParseFailureReason = 'TRUNCATED_JSON' | 'NOT_JSON' | 'SCHEMA_MISMATCH';
export interface DecisionParseResult {
    decision: SubagentActionDecision | null;
    reason?: DecisionParseFailureReason;
}
export interface DecisionParseDiagnostic {
    ok: boolean;
    retried: boolean;
    reason?: DecisionParseFailureReason;
    initial_reason?: DecisionParseFailureReason;
}
export interface StreamUsageStats {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    output_tokens_est?: number;
}
export interface PlannerStepDiagnostic {
    step: number;
    backend: 'host-ctx-llm' | 'external-vision-api';
    chunk_count: number;
    chunk_types: Record<string, number>;
    sample_unrecognized_keys?: string[];
    text_length: number;
    text_preview?: string;
    retried_text_only?: boolean;
    retried_json_schema?: boolean;
    decision_parse?: DecisionParseDiagnostic;
    max_tokens?: number | null;
    usage?: StreamUsageStats;
    finish_reason?: string;
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
 * String-aware JSON classification for subagent decisions:
 * distinguishes `TRUNCATED_JSON`, `NOT_JSON`, and `SCHEMA_MISMATCH`,
 * and normalizes flat `{ type: 'inspect_motion', x, y }` coordinates.
 */
export declare function classifyJsonDecision(rawText: string): DecisionParseResult;
/**
 * Extracts and structurally validates the first JSON decision object from a model text response.
 * Returns `null` (never throws) on empty strings, prose, malformed JSON, or invalid action shapes.
 */
export declare function parseJsonDecision(rawText: string): SubagentActionDecision | null;
/**
 * Normalizes diverse host `ctx.llm.stream()` chunk shapes and records unknown schemas & token usage for diagnostics.
 */
export declare function extractHostStreamChunk(chunk: unknown): {
    kind: string;
    text: string;
    error?: string;
    usage?: StreamUsageStats;
    finishReason?: string;
    unrecognizedKeys?: string[];
};
/**
 * Creates a planner backed by DSH 0.2's native `ctx.llm` runtime service when available.
 * Automatically retries text-only when an image attachment causes failure, retries strict JSON once
 * when parsing fails (including `TRUNCATED_JSON`), records per-step diagnostics, and degrades cleanly.
 */
export declare function createDshHostLlmPlanner(opts: {
    llm: any;
    attachments?: any;
    provider: string;
    model: string;
    sessionId?: string;
    maxTokens?: number;
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
    private activeSessions;
    private resumeWatchers;
    private inFlightResumes;
    private completedButtonResumes;
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
    getActiveResumeWatcherCount(): number;
    isResumingOrCompleted(subagentId: string): boolean;
    private stopResumeWatcher;
    private stopAllResumeWatchers;
    private startResumeWatcher;
    private handleResumeSignal;
    private emitDiagnosticsUpdate;
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
    resumeTask(subagentId: string, userFollowupNote?: string, signal?: AbortSignal, opts?: {
        trigger?: TakeoverResumeSource;
    }): Promise<SubagentRunResult>;
    private executeLoop;
}
