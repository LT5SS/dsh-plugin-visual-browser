import type { VirtualCursorPreset, VirtualCursorStyleConfig } from '../driver/types.js';
export declare const CURSOR_STYLE_PRESETS: Record<VirtualCursorPreset, Required<Omit<VirtualCursorStyleConfig, 'preset'>>>;
export declare function resolveCursorStyle(config?: VirtualCursorStyleConfig): Required<Omit<VirtualCursorStyleConfig, 'preset'>> & {
    preset: VirtualCursorPreset;
};
export declare function buildVirtualCursorInitScript(initialStyle?: VirtualCursorStyleConfig, opts?: {
    showTakeoverControl?: boolean;
    roleLabel?: string;
}): string;
export declare const VIRTUAL_CURSOR_INIT_SCRIPT: string;
