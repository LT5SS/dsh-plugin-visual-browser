import type { Page } from 'playwright-core';
import type { ClickActionResult, ClickHitTestResult, MotionOptions, Point2D, VirtualCursorStyleConfig } from './types.js';
export type TakeoverControlMode = 'running' | 'paused' | 'idle' | 'hidden';
export declare class HumanMotionController {
    private page;
    private pos;
    private cursorStyle;
    private showTakeoverControl;
    private shouldAbort?;
    private takeoverRole;
    private takeoverHotkey;
    constructor(page: Page, initialStyle?: VirtualCursorStyleConfig, opts?: {
        showTakeoverControl?: boolean;
        takeoverHotkey?: string;
        shouldAbort?: () => boolean;
    });
    getPosition(): Point2D;
    getCursorStyle(): VirtualCursorStyleConfig;
    ensureCursorHUD(): Promise<void>;
    setTakeoverHotkey(hotkey: string): Promise<void>;
    setTakeoverState(mode: TakeoverControlMode, roleLabel?: string): Promise<void>;
    resetTakeoverRequest(): Promise<void>;
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
    /**
     * Performs a Top-Layer-aware hit test at `(x, y)` before dispatching any real mouse click,
     * penetrating open Shadow DOM roots and same-origin iframes.
     */
    hitTestAt(x: number, y: number): Promise<ClickHitTestResult>;
    clickAt(x: number, y: number, opts?: MotionOptions): Promise<ClickActionResult>;
    clickSelector(selector: string, opts?: MotionOptions): Promise<ClickActionResult>;
    smoothScroll(deltaY: number, frames?: number, durationMs?: number): Promise<void>;
    private syncHUD;
}
