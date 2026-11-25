export type NavigateWaitUntil = 'domcontentloaded' | 'load' | 'networkidle';

export interface NavigationDiagnostic {
  wait_until: NavigateWaitUntil;
  timed_out: boolean;
  elapsed_ms: number;
  final_url: string;
  retries?: number;
  recovered_from?: string;
  blocked?: 'EXTERNAL_PROTOCOL' | 'JS_URL';
  protocol?: string;
  href?: string;
}

export type ActionBlockedReason =
  | 'PLUGIN_UI_LAYER'
  | 'REF_STALE'
  | 'ELEMENT_NOT_FOUND'
  | 'ACTION_TIMEOUT'
  | 'EXTERNAL_PROTOCOL'
  | 'JS_URL'
  | 'RESERVED_HOTKEY'
  | 'PROMPT_REQUIRES_HUMAN';

export interface ScrollDiagnostic {
  attempted: number;
  effective_dom_delta: number;
  dom_scrollable: boolean;
  visual_changed: boolean;
  at_boundary: boolean;
  locked: boolean;
  driver?: 'wheel' | 'programmatic';
  programmatic_blocked_hint?: string;
}

export interface MotionProbeState {
  transform: string;
  opacity: string;
  filter: string;
  color: string;
  backgroundColor: string;
  borderColor: string;
  boxShadow: string;
  scrollTop: number;
  rect: { x: number; y: number; width: number; height: number };
  animations: number;
  subtreeAnimations: number;
  transitionDuration: string;
  animationName: string;
  childTransform?: string;
}

export interface MotionInspectResult {
  target: string;
  ok: boolean;
  blocked?: ActionBlockedReason;
  at?: Point2D;
  topElement?: string;
  pixelChanged?: boolean;
  pixelDiffMean?: number;
  cssChanged?: string[];
  changed: string[];
  delta: Record<string, { before: string | number; after: string | number }>;
  animations: number;
  triggers: string[];
  before?: MotionProbeState;
  after?: MotionProbeState;
  hint?: string;
}

export type BrowserRuntimeMode =
  | 'auto'
  | 'dsh-electron-webview'
  | 'local-background'
  | 'cdp-attach';

export type BrowserWindowMode = 'visible-background' | 'minimized' | 'headless';

export interface BrowserWindowBounds {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

export interface ViewportSize {
  width: number;
  height: number;
  deviceScaleFactor?: number;
}

export interface ViewportEmulationState {
  active: boolean;
  width: number;
  height: number;
  deviceScaleFactor: number;
  physicalWidth?: number;
  physicalHeight?: number;
}

export interface SetViewportOptions {
  width?: number;
  height?: number;
  deviceScaleFactor?: number;
  reset?: boolean;
}

export interface WaitForOptions {
  selector?: string;
  goneSelector?: string;
  text?: string;
  networkIdle?: boolean;
  animationsSettled?: boolean;
  timeoutMs?: number;
}

export interface WaitForResult {
  ok: boolean;
  timed_out: boolean;
  aborted_by_takeover?: boolean;
  elapsed_ms: number;
  satisfied: string[];
  pending: string[];
}

export interface NativeDialogRecord {
  type: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  message: string;
  defaultValue?: string;
  handled: 'accepted' | 'dismissed';
  timestamp: string;
}

export interface ProtocolInterceptInfo {
  kind: 'EXTERNAL_PROTOCOL' | 'JS_URL';
  protocol: string;
  href: string;
  ts: number;
}

export interface NotTopmostResult {
  checked: boolean;
  clearedTopmost: boolean;
}

export type VirtualCursorShape =
  | 'arrow'
  | 'crosshair'
  | 'dot'
  | 'star'
  | 'ring'
  | 'custom-svg'
  | 'custom-image';

export type VirtualCursorPreset =
  | 'cyber-neon'
  | 'comet-gold'
  | 'laser-dots'
  | 'stealth-minimal'
  | 'clean-none'
  | 'custom';

export type TrailVariant = 'dashed' | 'solid' | 'dots' | 'comet' | 'none';

export interface VirtualCursorStyleConfig {
  /** Named preset (individual properties below can override any preset field) */
  preset?: VirtualCursorPreset;
  /** Pointer visual shape ('arrow' | 'crosshair' | 'dot' | 'star' | 'ring' | 'custom-svg' | 'custom-image') */
  pointerShape?: VirtualCursorShape;
  /** Cursor arrow fill color (e.g. '#ff3b28') */
  pointerColor?: string;
  /** Cursor arrow border stroke color (e.g. '#ffffff') */
  pointerBorderColor?: string;
  /** Cursor size scale multiplier (default: 1.0) */
  pointerScale?: number;
  /** Custom SVG `<path d="...">` string in a 28x28 coordinate box when pointerShape === 'custom-svg' */
  customPointerSvgPath?: string;
  /** Sanitized image URL or data:image/... URI when pointerShape === 'custom-image' */
  customPointerImageUrl?: string;
  /** Pointer click hotspot X offset in px within 28x28 box (default: 3) */
  customPointerHotspotX?: number;
  /** Pointer click hotspot Y offset in px within 28x28 box (default: 3) */
  customPointerHotspotY?: number;
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
  /** Custom prefix text shown inside the HUD badge (default: 'DSH') */
  badgeTextPrefix?: string;
}

export interface BrowserSessionOptions {
  mode?: BrowserRuntimeMode;
  cdpEndpoint?: string;
  executablePath?: string;
  userDataDir?: string;
  viewport?: ViewportSize;
  /** Explicit CDP device metrics override (only applied when set explicitly; never implicitly triggered by default viewport) */
  viewportOverride?: ViewportSize;
  /**
   * Window presentation mode for local Chrome/Edge sessions:
   * - `'visible-background'` (default): visible window placed behind the active foreground window without stealing focus
   * - `'minimized'`: starts minimized in the taskbar without stealing focus
   * - `'headless'`: silent headless background mode (`--headless=new`, used when `backgroundSilent: true`)
   */
  windowMode?: BrowserWindowMode;
  /** Keep a single visible browser window open and reuse it across subsequent runs (default: true for visible modes) */
  keepWindowOpen?: boolean;
  /** Show the floating in-page takeover status pill so users can monitor/take over immediately */
  showTakeoverControl?: boolean;
  /** Keyboard hotkey (e.g. 'F8') that triggers immediate human takeover from anywhere in the page */
  takeoverHotkey?: string;
  /** Optional explicit screen bounds for `'visible-background'` */
  windowBounds?: BrowserWindowBounds;
  /**
   * Legacy flag preserved for backwards compatibility (`backgroundSilent: true` selects `'headless'`).
   * Default when omitted is `'visible-background'`.
   */
  backgroundSilent?: boolean;
  /** Initial customizable virtual cursor & trail style */
  cursorStyle?: VirtualCursorStyleConfig;
  /** Enable page beforeunload confirmation guard while tasks are active (default: false) */
  unloadGuard?: boolean;
  /** Whether an active subagent task is running when the session starts (default: false -> takeover pill starts in 'idle') */
  activeSession?: boolean;
}

export interface Point2D {
  x: number;
  y: number;
}

export interface ClickHitTestResult {
  hitsPluginUi: boolean;
  topElement: string;
  stackTop: string[];
  inShadowRoot?: boolean;
  inIframe?: boolean;
}

export interface ClickActionResult extends Point2D {
  ok: boolean;
  at: Point2D;
  blocked?: ActionBlockedReason;
  ref?: string;
  skipped?: boolean;
  hit?: string;
  element?: string;
  hint?: string;
}

export interface DragActionResult {
  ok: boolean;
  from: Point2D;
  to: Point2D;
  steps: number;
  blocked?: ActionBlockedReason;
  hit?: string;
  at?: Point2D;
  hint?: string;
  midFrame?: string;
}

export interface MotionOptions {
  durationMs?: number;
  steps?: number;
  arcCurvature?: number;
  label?: string;
  keepSelection?: boolean;
  timeoutMs?: number;
}
