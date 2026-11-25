import type { Page } from 'playwright-core';
import type { BrowserSession } from '../driver/browser-session.js';
import type { MotionInspectResult, NativeDialogRecord, NavigationDiagnostic, Point2D, ScrollDiagnostic } from '../driver/types.js';
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
export interface DesignSnapshot {
    title: string;
    headings: Array<{
        tag: string;
        text: string;
    }>;
    headingsTotal: number;
    headingsError?: boolean;
    headingsNaReason?: '无 h1-h3' | '被裁切' | '可能在 canvas 内';
    sections: number[];
    sectionsTotal: number;
    sectionsError?: boolean;
    palette: {
        bg: string;
        text: string;
        accent: string;
    } | null;
    visualPalette?: string[];
    canvasCoversViewport?: boolean;
    fonts: Array<{
        family: string;
        weight: string;
        maxPx: number;
    }>;
    fontsError?: boolean;
    cssVarsTotal: number;
    cssVarsSample: Array<{
        name: string;
        value: string;
    }>;
    cssVarsError?: boolean;
    layout: {
        grid: number;
        flex: number;
        fixed: number;
        sticky: number;
    } | null;
    media: {
        img: number;
        video: number;
        canvas: number;
        svg: number;
        largest: {
            kind: string;
            width: number;
            height: number;
            objectFit?: string;
            canvasWidth?: number;
            canvasHeight?: number;
        } | null;
        largestCanvas?: {
            width: number;
            height: number;
        } | null;
    } | null;
    motion: {
        transition: number;
        animation: number;
        willChange: number;
        reducedMotion: '支持' | '未检测到' | '未知';
    } | null;
    bodyText: string | null;
}
export interface ControlsFilterStats {
    hidden: number;
    zeroSize: number;
    clipped: number;
    offscreen: number;
    pluginUi: number;
}
export interface PageObservation {
    stepIndex: number;
    timestamp: string;
    screenshotPath: string;
    cursorPosition: Point2D;
    viewport?: {
        width: number;
        height: number;
        deviceScaleFactor: number;
        emulated?: boolean;
    };
    dialogs?: NativeDialogRecord[];
    scroll: ScrollMetrics;
    domStats: DomTechStats;
    interactiveElements: InteractiveElementNode[];
    controlsFilterStats?: ControlsFilterStats;
    health: TelemetryHealthReport;
    degradedReason?: string;
    navigation?: NavigationDiagnostic;
    scrollDiagnostic?: ScrollDiagnostic;
    motionInspect?: MotionInspectResult;
    snapshotGen?: number;
    design?: DesignSnapshot;
}
export declare const MAX_DESIGN_BLOCK_CHARS = 1200;
/**
 * Normalizes split-character animated text & repeated single-letter marquees while preserving
 * normal multi-character English words (e.g. "collaborate") and CJK prose intact.
 */
export declare function normSplit(raw: string): string;
export declare function formatDesignBlock(design?: DesignSnapshot): string;
export declare class PageSnapshotSampler {
    private session;
    private outputDir;
    private stepCounter;
    private snapshotGen;
    private refBaseOffset;
    private highestRefAssigned;
    constructor(session: BrowserSession, outputDir: string);
    getOutputDir(): string;
    getNextStepNumber(): number;
    getSnapshotGen(): number;
    /**
     * Clears DOM ref attributes (defeating bfcache stale attributes) and advances snapshotGen.
     * When bumpRefOffset is true (e.g. go_back/go_forward/reload), future ref IDs start past
     * all previously issued numbers so stale #ref references strictly trigger REF_STALE.
     */
    invalidateRefs(opts?: {
        bumpRefOffset?: boolean;
    }): Promise<number>;
    captureSnapshot(tag?: string): Promise<PageObservation>;
    formatObservationForLLM(obs: PageObservation): string;
}
