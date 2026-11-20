import type { VirtualCursorPreset, VirtualCursorStyleConfig } from '../driver/types.js';
export declare const POINTER_SHAPE_SVG_PATHS: Record<'arrow' | 'crosshair' | 'dot' | 'star' | 'ring', string>;
export declare function sanitizeCustomPointerImageUrl(url?: string): string;
export type ResolvedVirtualCursorStyle = Required<Omit<VirtualCursorStyleConfig, 'preset'>> & {
    preset: VirtualCursorPreset;
};
export declare const CURSOR_STYLE_PRESETS: Record<VirtualCursorPreset, Required<Omit<VirtualCursorStyleConfig, 'preset'>>>;
export declare function resolveCursorStyle(config?: VirtualCursorStyleConfig): ResolvedVirtualCursorStyle;
export declare function buildVirtualCursorInitScript(initialStyle?: VirtualCursorStyleConfig, opts?: {
    showTakeoverControl?: boolean;
    roleLabel?: string;
    takeoverHotkey?: string;
    unloadGuard?: boolean;
}): string;
export declare const VIRTUAL_CURSOR_INIT_SCRIPT: string;
