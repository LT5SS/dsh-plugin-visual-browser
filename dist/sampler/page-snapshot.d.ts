import type { BrowserSession } from '../driver/browser-session.js';
import type { Point2D } from '../driver/types.js';
import type { TelemetryHealthReport } from './telemetry-collector.js';
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
}
export declare class PageSnapshotSampler {
    private session;
    private outputDir;
    private stepCounter;
    constructor(session: BrowserSession, outputDir: string);
    captureSnapshot(tag?: string): Promise<PageObservation>;
    formatObservationForLLM(obs: PageObservation): string;
}
