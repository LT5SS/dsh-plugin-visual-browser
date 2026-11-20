import type { Page } from 'playwright-core';
import type { MotionOptions, Point2D, VirtualCursorStyleConfig } from './types.js';
export declare class HumanMotionController {
    private page;
    private pos;
    private cursorStyle;
    constructor(page: Page, initialStyle?: VirtualCursorStyleConfig);
    getPosition(): Point2D;
    getCursorStyle(): VirtualCursorStyleConfig;
    ensureCursorHUD(): Promise<void>;
    /**
     * Dynamically updates the virtual cursor & trail style (preset or custom colors/width/length/variant).
     */
    setCursorStyle(style: VirtualCursorStyleConfig): Promise<void>;
    clearTrail(): Promise<void>;
    /**
     * Moves the virtual mouse along a cubic Bezier arc with human-like acceleration/deceleration.
     */
    moveTo(targetX: number, targetY: number, opts?: MotionOptions): Promise<Point2D>;
    sweepPath(waypoints: Point2D[], opts?: MotionOptions): Promise<Point2D>;
    hoverSelector(selector: string, opts?: MotionOptions): Promise<Point2D>;
    clickAt(x: number, y: number, opts?: MotionOptions): Promise<Point2D>;
    clickSelector(selector: string, opts?: MotionOptions): Promise<Point2D>;
    smoothScroll(deltaY: number, frames?: number, durationMs?: number): Promise<void>;
    private syncHUD;
}
