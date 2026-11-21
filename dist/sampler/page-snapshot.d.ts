import type { Page } from 'playwright-core';
import type { BrowserSession } from '../driver/browser-session.js';
import type { NavigationDiagnostic, Point2D, ScrollDiagnostic } from '../driver/types.js';
import type { TelemetryHealthReport } from './telemetry-collector.js';
/** Returns true when a Playwright error stems from mid-evaluation navigation or frame detachment. */
export declare function isNavigationRaceError(error: unknown): boolean;
export type SafeEvaluatePage = Pick<Page, 'evaluate'> & Partial<Pick<Page, 'waitForLoadState' | 'waitForTimeout'>>;
/**
 * Runs `page.evaluate()` with automatic retries and fallback on navigation-race errors.
 * Non-navigation errors always rethrow immediately so real bugs are never masked.
 */
export declare function safeEvaluate<T>(page: SafeEvaluatePage, fn: () => T, fallbackValue: T, retriesOrOptions?: number | {
    retries?: number;
    onDegraded?: (reason: string) => void;
}): Promise<T>;
export declare function safeEvaluate<T, Arg>(page: SafeEvaluatePage, fn: (arg: Arg) => T, fallbackValue: T, options: {
    arg: Arg;
    retries?: number;
    onDegraded?: (reason: string) => void;
}): Promise<T>;
export interface ScrollMetrics {
    scrollX: number;
    scrollY: number;
    scrollWidth: number;
    scrollHeight: number;
    viewportWidth: number;
    viewportHeight: number;
    scrollProgressPercent: number;
}
export interface InteractiveElementNode {
    ref: string;
    tag: string;
    role: string;
    label: string;
    selectorHint: string;
    center: Point2D;
    rect: {
        x: number;
        y: number;
        width: number;
        height: number;
    };
    href?: string;
    value?: string;
    title?: string;
    ariaLabel?: string;
    alt?: string;
}
export interface DomTechStats {
    title: string;
    url: string;
    htmlClasses: string[];
    htmlDataAttributes: Record<string, string>;
    counts: {
        canvas: number;
        video: number;
        svg: number;
        img: number;
        section: number;
        article: number;
        button: number;
        a: number;
        openDialogs: number;
    };
    detectedTechHints: string[];
}
export interface PageObservation {
    stepIndex: number;
    timestamp: string;
    screenshotPath: string;
    cursorPosition: Point2D;
    scroll: ScrollMetrics;
    domStats: DomTechStats;
    interactiveElements: InteractiveElementNode[];
    health: TelemetryHealthReport;
    degradedReason?: string;
    navigation?: NavigationDiagnostic;
    scrollDiagnostic?: ScrollDiagnostic;
    snapshotGen?: number;
}
export declare class PageSnapshotSampler {
    private session;
    private outputDir;
    private stepCounter;
    private snapshotGen;
    constructor(session: BrowserSession, outputDir: string);
    getOutputDir(): string;
    getNextStepNumber(): number;
    getSnapshotGen(): number;
    captureSnapshot(tag?: string): Promise<PageObservation>;
    formatObservationForLLM(obs: PageObservation): string;
}
