import type { BrowserSession } from '../driver/browser-session.js';
import type { ActionBlockedReason, MotionInspectResult, NavigateWaitUntil, NavigationDiagnostic, Point2D, ScrollDiagnostic, VirtualCursorStyleConfig } from '../driver/types.js';
import { PageSnapshotSampler, type PageObservation } from '../sampler/page-snapshot.js';
export interface DomInspectSample {
    tag: string;
    text: string;
    classes: string;
    href?: string;
    value?: string;
    title?: string;
    alt?: string;
    computedStyle: Record<string, string>;
}
export interface DomInspectResult {
    count: number;
    samples: DomInspectSample[];
    degraded?: boolean;
    degradedReason?: string;
}
export interface AtomicToolResult {
    action: string;
    observation: PageObservation;
    llmSummary: string;
    ok?: boolean;
    blocked?: ActionBlockedReason;
    ref?: string;
    skipped?: boolean;
    hit?: string;
    at?: Point2D;
    hint?: string;
    midFrame?: string;
    midFramePath?: string;
    navigation?: NavigationDiagnostic;
    scroll?: ScrollDiagnostic;
    motion?: MotionInspectResult;
    extraData?: unknown;
}
/**
 * Normalizes a target string:
 * - "#4" (when matching a sampled ref ID) -> '[data-dsh-ref="4"]'
 * - Otherwise leaves CSS selector as-is
 */
export declare function resolveTargetSelector(target: string): string;
export declare class AtomicBrowserToolset {
    readonly session: BrowserSession;
    readonly sampler: PageSnapshotSampler;
    constructor(session: BrowserSession, snapshotDir: string);
    navigate(url: string, waitMs?: number, opts?: {
        waitUntil?: NavigateWaitUntil;
        timeoutMs?: number;
    }): Promise<AtomicToolResult>;
    setCursorStyle(style: VirtualCursorStyleConfig): Promise<void>;
    moveMouse(target: Point2D | Point2D[], label?: string): Promise<AtomicToolResult>;
    hover(target: string | Point2D): Promise<AtomicToolResult>;
    click(target: string | Point2D, waitMs?: number, opts?: {
        ifPresent?: boolean;
        timeoutMs?: number;
    }): Promise<AtomicToolResult>;
    typeText(target: string, text: string, pressEnter?: boolean): Promise<AtomicToolResult>;
    drag(from: string | Point2D, to: string | Point2D, steps?: number, waitMs?: number, opts?: {
        keepSelection?: boolean;
        signal?: AbortSignal;
        onPhase?: (phase: 'down' | 'dragging' | 'up') => Promise<void> | void;
    }): Promise<AtomicToolResult>;
    scroll(directionOrDelta?: 'down' | 'up' | number, waitMs?: number, opts?: {
        driver?: 'wheel' | 'programmatic';
    }): Promise<AtomicToolResult>;
    /**
     * Read-only pointer-driven motion probe (`inspect_motion`):
     * records target computed styles & rect before moving mouse to center, moves without clicking,
     * waits settleMs (default 120ms), re-reads state, and reports property deltas & active animations.
     */
    inspectMotion(target: string | Point2D, settleMs?: number): Promise<AtomicToolResult>;
    /**
     * Read-only DOM & computed style inspection query for the agent.
     * Uses `safeEvaluate()` to tolerate navigation races and expose link/input attributes.
     */
    inspectDom(selector: string): Promise<DomInspectResult>;
}
