import type { BrowserSession } from '../driver/browser-session.js';
import type { Point2D, VirtualCursorStyleConfig } from '../driver/types.js';
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
    blocked?: 'PLUGIN_UI_LAYER';
    hit?: string;
    at?: Point2D;
    hint?: string;
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
    navigate(url: string, waitMs?: number): Promise<AtomicToolResult>;
    setCursorStyle(style: VirtualCursorStyleConfig): Promise<void>;
    moveMouse(target: Point2D | Point2D[], label?: string): Promise<AtomicToolResult>;
    hover(target: string | Point2D): Promise<AtomicToolResult>;
    click(target: string | Point2D, waitMs?: number): Promise<AtomicToolResult>;
    typeText(target: string, text: string, pressEnter?: boolean): Promise<AtomicToolResult>;
    drag(from: string | Point2D, to: string | Point2D, steps?: number, waitMs?: number): Promise<AtomicToolResult>;
    scroll(directionOrDelta?: 'down' | 'up' | number, waitMs?: number): Promise<AtomicToolResult>;
    /**
     * Read-only DOM & computed style inspection query for the agent.
     * Uses `safeEvaluate()` to tolerate navigation races and expose link/input attributes.
     */
    inspectDom(selector: string): Promise<DomInspectResult>;
}
