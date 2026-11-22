import type { Page } from 'playwright-core';
import type { ActionBlockedReason, ClickActionResult, ClickHitTestResult, DragActionResult, MotionOptions, Point2D, VirtualCursorStyleConfig } from './types.js';
export type TakeoverControlMode = 'running' | 'paused' | 'idle' | 'hidden';
export declare class HumanMotionController {
    private page;
    private pos;
    private cursorStyle;
    private showTakeoverControl;
    private takeoverMode;
    private shouldAbort?;
    private takeoverRole;
    private takeoverHotkey;
    private unloadGuardEnabled;
    constructor(page: Page, initialStyle?: VirtualCursorStyleConfig, opts?: {
        showTakeoverControl?: boolean;
        takeoverHotkey?: string;
        unloadGuard?: boolean;
        activeSession?: boolean;
        shouldAbort?: () => boolean;
    });
    getTakeoverMode(): TakeoverControlMode;
    getPosition(): Point2D;
    setPosition(x: number, y: number): void;
    resetPosition(x?: number, y?: number): void;
    syncPositionFromPage(): Promise<Point2D>;
    getCursorStyle(): VirtualCursorStyleConfig;
    updateActiveStyleFromPage(style: VirtualCursorStyleConfig): void;
    isUnloadGuardEnabled(): boolean;
    setUnloadGuard(on: boolean): Promise<void>;
    ensureCursorHUD(syncActiveState?: boolean): Promise<void>;
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
    probeSelector(selector: string, timeoutMs?: number): Promise<{
        ok: true;
        center: Point2D;
        box: {
            x: number;
            y: number;
            width: number;
            height: number;
        };
    } | {
        ok: false;
        blocked: ActionBlockedReason;
        hint: string;
    }>;
    hoverSelector(selector: string, opts?: MotionOptions): Promise<Point2D>;
    /**
     * Performs a Top-Layer-aware hit test at `(x, y)` before dispatching any real mouse click,
     * penetrating open Shadow DOM roots and same-origin iframes.
     */
    hitTestAt(x: number, y: number): Promise<ClickHitTestResult>;
    clickAt(x: number, y: number, opts?: MotionOptions): Promise<ClickActionResult>;
    clickSelector(selector: string, opts?: MotionOptions): Promise<ClickActionResult>;
    resolveTargetPoint(target: string | Point2D, timeoutMs?: number): Promise<{
        ok: true;
        point: Point2D;
    } | {
        ok: false;
        blocked: ActionBlockedReason;
        hit: string;
        hint: string;
    }>;
    resolvePoint(target: string | Point2D): Promise<Point2D>;
    /**
     * Performs a physical mouse drag (`move(from)` -> `down()` -> Bezier interpolation -> `up()`),
     * rendering press-shrink, thickened reversed-gradient drag trail, origin anchor ring, and drop state.
     */
    drag(from: Point2D, to: Point2D, opts?: MotionOptions & {
        signal?: AbortSignal;
        onPhase?: (phase: 'down' | 'dragging' | 'up') => Promise<void> | void;
    }): Promise<DragActionResult>;
    smoothScroll(deltaY: number, frames?: number, durationMs?: number): Promise<void>;
    private syncHUD;
}
