import fs from 'node:fs';
import path from 'node:path';
import type { BrowserWindowMode, VirtualCursorStyleConfig } from './driver/types.js';
import { resolveCursorStyle, sanitizeCustomPointerImageUrl } from './injected/virtual-cursor.js';

export interface PersistedVisualBrowserSettings {
  version: 1;
  updatedAt: string;
  cursorStyle?: VirtualCursorStyleConfig;
  windowMode?: BrowserWindowMode;
  keepWindowOpen?: boolean;
  showTakeoverControl?: boolean;
  takeoverHotkey?: string;
}

const VALID_WINDOW_MODES = new Set<BrowserWindowMode>([
  'visible-background',
  'minimized',
  'headless',
]);

function isPlainObject(value: unknown): value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Resolves the plugin-owned settings persistence path (`$DSH_HOME/artifacts/dsh-browser/settings.json`).
 */
export function resolveSettingsFilePath(artifactRoot: string): string {
  return path.join(artifactRoot, 'settings.json');
}

/**
 * Merges a partial cursor style patch onto a base style, respecting preset switches.
 */
export function mergeCursorStyleConfig(
  baseStyle: VirtualCursorStyleConfig = {},
  patch: VirtualCursorStyleConfig = {}
): VirtualCursorStyleConfig {
  const sanitizedPatch: VirtualCursorStyleConfig = { ...patch };
  if (typeof sanitizedPatch.customPointerImageUrl === 'string') {
    if (sanitizedPatch.customPointerImageUrl.length > 200_000) {
      sanitizedPatch.customPointerImageUrl = '';
    } else {
      sanitizedPatch.customPointerImageUrl = sanitizeCustomPointerImageUrl(
        sanitizedPatch.customPointerImageUrl
      );
    }
  }

  // Switching to a named preset (different from current preset) starts from that preset's palette.
  if (
    sanitizedPatch.preset &&
    sanitizedPatch.preset !== 'custom' &&
    sanitizedPatch.preset !== baseStyle.preset
  ) {
    return resolveCursorStyle(sanitizedPatch);
  }

  return resolveCursorStyle({
    ...baseStyle,
    ...sanitizedPatch,
  });
}

/**
 * Validates and normalizes persisted settings from disk or IPC payloads.
 */
export function sanitizePersistedSettings(raw: unknown): PersistedVisualBrowserSettings {
  const obj = isPlainObject(raw) ? raw : {};
  const result: PersistedVisualBrowserSettings = {
    version: 1,
    updatedAt:
      typeof obj.updatedAt === 'string' && obj.updatedAt.trim()
        ? obj.updatedAt
        : new Date().toISOString(),
  };

  if (isPlainObject(obj.cursorStyle)) {
    const rawStyle: VirtualCursorStyleConfig = { ...(obj.cursorStyle as VirtualCursorStyleConfig) };
    if (
      typeof rawStyle.customPointerImageUrl === 'string' &&
      rawStyle.customPointerImageUrl.length > 200_000
    ) {
      rawStyle.customPointerImageUrl = '';
    }
    result.cursorStyle = resolveCursorStyle(rawStyle);
  }

  if (typeof obj.windowMode === 'string' && VALID_WINDOW_MODES.has(obj.windowMode as BrowserWindowMode)) {
    result.windowMode = obj.windowMode as BrowserWindowMode;
  }

  if (typeof obj.keepWindowOpen === 'boolean') {
    result.keepWindowOpen = obj.keepWindowOpen;
  }

  if (typeof obj.showTakeoverControl === 'boolean') {
    result.showTakeoverControl = obj.showTakeoverControl;
  }

  if (typeof obj.takeoverHotkey === 'string') {
    const trimmed = obj.takeoverHotkey.trim().slice(0, 32);
    if (trimmed) {
      result.takeoverHotkey = trimmed;
    }
  }

  return result;
}

/**
 * Loads persisted settings from `settings.json`, returning `null` if missing or invalid.
 */
export function loadPersistedSettings(filePath: string): PersistedVisualBrowserSettings | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const rawText = fs.readFileSync(filePath, 'utf8');
    if (!rawText.trim()) return null;
    const parsed = JSON.parse(rawText);
    if (!isPlainObject(parsed)) return null;
    return sanitizePersistedSettings(parsed);
  } catch {
    return null;
  }
}

/**
 * Merges `patch` over existing persisted settings and atomically writes `settings.json`.
 */
export function savePersistedSettings(
  filePath: string,
  patch: Partial<PersistedVisualBrowserSettings>,
  base?: PersistedVisualBrowserSettings | null
): PersistedVisualBrowserSettings {
  const existing = base ?? loadPersistedSettings(filePath);
  const patchObj = isPlainObject(patch) ? patch : {};

  const mergedCursor = isPlainObject(patchObj.cursorStyle)
    ? mergeCursorStyleConfig(existing?.cursorStyle ?? {}, patchObj.cursorStyle)
    : existing?.cursorStyle;

  const candidate: Record<string, unknown> = {
    ...(existing ?? {}),
    ...patchObj,
    version: 1,
    updatedAt: new Date().toISOString(),
    ...(mergedCursor ? { cursorStyle: mergedCursor } : {}),
  };

  const sanitized = sanitizePersistedSettings(candidate);
  const serialized = JSON.stringify(sanitized, null, 2);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Math.random().toString(16).slice(2, 8)}`;
  try {
    fs.writeFileSync(tmpPath, serialized, 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch {
    try {
      fs.writeFileSync(filePath, serialized, 'utf8');
    } finally {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore temp cleanup failure
      }
    }
  }

  return sanitized;
}
