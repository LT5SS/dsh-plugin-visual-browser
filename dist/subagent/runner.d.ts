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
export declare function createOpenAIVisionPlanner(opts: {
    apiKey: string;
    baseUrl?: string;
    model?: string;
}): SubagentPlanner;
export declare class BrowserSubagentRunner {
    private pausedSessions;
    isOriginPermitted(targetUrl: string, allowedOrigins?: string[], blockedOrigins?: string[]): boolean;
    getPausedSession(subagentId: string): PausedSubagentState | undefined;
    closeAllPausedSessions(): Promise<void>;
    runTask(req: SubagentTaskRequest): Promise<SubagentRunResult>;
    /**
     * Resumes a paused subagent session in the exact same open browser tab after human takeover.
     */
    resumeTask(subagentId: string, userFollowupNote?: string): Promise<SubagentRunResult>;
    private executeLoop;
}
export {};
