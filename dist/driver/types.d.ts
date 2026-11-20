export type BrowserRuntimeMode = 'auto' | 'dsh-electron-webview' | 'local-background' | 'cdp-attach';
export interface ViewportSize {
    width: number;
    height: number;
}
export type VirtualCursorPreset = 'cyber-neon' | 'comet-gold' | 'laser-dots' | 'stealth-minimal' | 'clean-none';
export type TrailVariant = 'dashed' | 'solid' | 'dots' | 'comet' | 'none';
export interface VirtualCursorStyleConfig {
    /** Named preset (individual properties below can override any preset field) */
    preset?: VirtualCursorPreset;
    /** Cursor arrow fill color (e.g. '#ff3b28') */
    pointerColor?: string;
    /** Cursor arrow border stroke color (e.g. '#ffffff') */
    pointerBorderColor?: string;
    /** Cursor size scale multiplier (default: 1.0) */
    pointerScale?: number;
    /** Trail rendering mode: 'dashed' | 'solid' | 'dots' | 'comet' | 'none' */
    trailVariant?: TrailVariant;
    /** Gradient start (tail end) color */
    trailColorStart?: string;
    /** Gradient end (near cursor tip) color */
    trailColorEnd?: string;
    /** Stroke width of the trail in px (default: 2.8) */
    trailWidth?: number;
    /** Number of historical trail points to retain (default: 22) */
    trailLength?: number;
    /** Whether to render an outer neon glow along the trail */
    trailGlow?: boolean;
    /** Click ripple accent color */
    rippleColor?: string;
    /** Whether to show the floating "(x, y) · ACTION" pill badge next to the cursor */
    showBadge?: boolean;
}
export interface BrowserSessionOptions {
    mode?: BrowserRuntimeMode;
    cdpEndpoint?: string;
    executablePath?: string;
    userDataDir?: string;
    viewport?: ViewportSize;
    /**
     * When true (default), runs 100% silently in the background (--headless=new with full GPU/Canvas pipeline)
     * so no browser window pops up or steals focus from the user's active work.
     */
    backgroundSilent?: boolean;
    /** Initial customizable virtual cursor & trail style */
    cursorStyle?: VirtualCursorStyleConfig;
}
export interface Point2D {
    x: number;
    y: number;
}
export interface MotionOptions {
    durationMs?: number;
    steps?: number;
    arcCurvature?: number;
    label?: string;
}
