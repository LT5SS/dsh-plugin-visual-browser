import type { BrowserSession } from '../driver/browser-session.js';
import type { Point2D, VirtualCursorStyleConfig } from '../driver/types.js';
import { PageSnapshotSampler, type PageObservation } from '../sampler/page-snapshot.js';
export interface AtomicToolResult {
    action: string;
    observation: PageObservation;
    llmSummary: string;
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
    scroll(directionOrDelta?: 'down' | 'up' | number, waitMs?: number): Promise<AtomicToolResult>;
    /**
     * Read-only DOM & computed style inspection query for the agent.
     */
    inspectDom(selector: string): Promise<{
        count: number;
        samples: Array<{
            tag: string;
            text: string;
            classes: string;
            computedStyle: Record<string, string>;
        }>;
    }>;
}
