import type { BrowserWindowMode, VirtualCursorStyleConfig } from './driver/types.js';
export interface PersistedVisualBrowserSettings {
    version: 1;
    updatedAt: string;
    cursorStyle?: VirtualCursorStyleConfig;
    windowMode?: BrowserWindowMode;
    keepWindowOpen?: boolean;
    showTakeoverControl?: boolean;
    takeoverHotkey?: string;
}
/**
 * Resolves the plugin-owned settings persistence path (`$DSH_HOME/artifacts/dsh-browser/settings.json`).
 */
export declare function resolveSettingsFilePath(artifactRoot: string): string;
/**
 * Merges a partial cursor style patch onto a base style, respecting preset switches.
 */
export declare function mergeCursorStyleConfig(baseStyle?: VirtualCursorStyleConfig, patch?: VirtualCursorStyleConfig): VirtualCursorStyleConfig;
/**
 * Validates and normalizes persisted settings from disk or IPC payloads.
 */
export declare function sanitizePersistedSettings(raw: unknown): PersistedVisualBrowserSettings;
/**
 * Loads persisted settings from `settings.json`, returning `null` if missing or invalid.
 */
export declare function loadPersistedSettings(filePath: string): PersistedVisualBrowserSettings | null;
/**
 * Merges `patch` over existing persisted settings and atomically writes `settings.json`.
 */
export declare function savePersistedSettings(filePath: string, patch: Partial<PersistedVisualBrowserSettings>, base?: PersistedVisualBrowserSettings | null): PersistedVisualBrowserSettings;
