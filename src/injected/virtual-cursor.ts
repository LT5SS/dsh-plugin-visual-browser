import type {
  VirtualCursorPreset,
  VirtualCursorShape,
  VirtualCursorStyleConfig,
} from '../driver/types.js';

export const POINTER_SHAPE_SVG_PATHS: Record<
  'arrow' | 'crosshair' | 'dot' | 'star' | 'ring',
  string
> = {
  arrow: 'M3 3 L11 24 L14.8 15.2 L23.5 11.5 Z',
  crosshair:
    'M14 2 V9 M14 19 V26 M2 14 H9 M19 14 H26 M14 10 A4 4 0 1 0 14 18 A4 4 0 1 0 14 10 Z',
  dot: 'M14 7 A7 7 0 1 0 14 21 A7 7 0 1 0 14 7 Z',
  star: 'M14 2 L17.2 10.8 L26 14 L17.2 17.2 L14 26 L10.8 17.2 L2 14 L10.8 10.8 Z',
  ring: 'M14 4 A10 10 0 1 0 14 24 A10 10 0 1 0 14 4 Z M14 9 A5 5 0 1 1 14 19 A5 5 0 1 1 14 9 Z',
};

const SAFE_IMAGE_URL_RE =
  /^(?:data:image\/(?:png|jpeg|jpg|gif|webp|svg\+xml|x-icon|vnd\.microsoft\.icon);|https?:\/\/)/i;

export function sanitizeCustomPointerImageUrl(url?: string): string {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed || !SAFE_IMAGE_URL_RE.test(trimmed)) return '';
  return trimmed;
}

export type ResolvedVirtualCursorStyle = Required<Omit<VirtualCursorStyleConfig, 'preset'>> & {
  preset: VirtualCursorPreset;
};

export const CURSOR_STYLE_PRESETS: Record<
  VirtualCursorPreset,
  Required<Omit<VirtualCursorStyleConfig, 'preset'>>
> = {
  'cyber-neon': {
    pointerShape: 'arrow',
    pointerColor: '#ff3b28',
    pointerBorderColor: '#ffffff',
    pointerScale: 1.0,
    customPointerSvgPath: '',
    customPointerImageUrl: '',
    customPointerHotspotX: 3,
    customPointerHotspotY: 3,
    trailVariant: 'dashed',
    trailColorStart: '#ff3b28',
    trailColorEnd: '#00f0ff',
    trailWidth: 2.8,
    trailLength: 24,
    trailGlow: true,
    rippleColor: '#00f0ff',
    showBadge: true,
    badgeTextPrefix: 'DSH',
  },
  'comet-gold': {
    pointerShape: 'arrow',
    pointerColor: '#ffb800',
    pointerBorderColor: '#1a0e00',
    pointerScale: 1.08,
    customPointerSvgPath: '',
    customPointerImageUrl: '',
    customPointerHotspotX: 3,
    customPointerHotspotY: 3,
    trailVariant: 'comet',
    trailColorStart: '#ff3b00',
    trailColorEnd: '#ffe66d',
    trailWidth: 4.5,
    trailLength: 28,
    trailGlow: true,
    rippleColor: '#ffd000',
    showBadge: true,
    badgeTextPrefix: 'DSH',
  },
  'laser-dots': {
    pointerShape: 'dot',
    pointerColor: '#a855f7',
    pointerBorderColor: '#ffffff',
    pointerScale: 1.0,
    customPointerSvgPath: '',
    customPointerImageUrl: '',
    customPointerHotspotX: 14,
    customPointerHotspotY: 14,
    trailVariant: 'dots',
    trailColorStart: '#ec4899',
    trailColorEnd: '#38bdf8',
    trailWidth: 3.6,
    trailLength: 20,
    trailGlow: true,
    rippleColor: '#e879f9',
    showBadge: true,
    badgeTextPrefix: 'DSH',
  },
  'stealth-minimal': {
    pointerShape: 'crosshair',
    pointerColor: '#111827',
    pointerBorderColor: '#ffffff',
    pointerScale: 0.9,
    customPointerSvgPath: '',
    customPointerImageUrl: '',
    customPointerHotspotX: 14,
    customPointerHotspotY: 14,
    trailVariant: 'solid',
    trailColorStart: '#9ca3af',
    trailColorEnd: '#374151',
    trailWidth: 1.6,
    trailLength: 14,
    trailGlow: false,
    rippleColor: '#6b7280',
    showBadge: false,
    badgeTextPrefix: 'DSH',
  },
  'clean-none': {
    pointerShape: 'arrow',
    pointerColor: '#ff3b28',
    pointerBorderColor: '#ffffff',
    pointerScale: 1.0,
    customPointerSvgPath: '',
    customPointerImageUrl: '',
    customPointerHotspotX: 3,
    customPointerHotspotY: 3,
    trailVariant: 'none',
    trailColorStart: 'transparent',
    trailColorEnd: 'transparent',
    trailWidth: 0,
    trailLength: 2,
    trailGlow: false,
    rippleColor: '#ff3b28',
    showBadge: true,
    badgeTextPrefix: 'DSH',
  },
  custom: {
    pointerShape: 'arrow',
    pointerColor: '#ff3b28',
    pointerBorderColor: '#ffffff',
    pointerScale: 1.0,
    customPointerSvgPath: '',
    customPointerImageUrl: '',
    customPointerHotspotX: 3,
    customPointerHotspotY: 3,
    trailVariant: 'dashed',
    trailColorStart: '#ff3b28',
    trailColorEnd: '#00f0ff',
    trailWidth: 2.8,
    trailLength: 24,
    trailGlow: true,
    rippleColor: '#00f0ff',
    showBadge: true,
    badgeTextPrefix: 'DSH',
  },
};

const VALID_SHAPES = new Set<VirtualCursorShape>([
  'arrow',
  'crosshair',
  'dot',
  'star',
  'ring',
  'custom-svg',
  'custom-image',
]);

export function resolveCursorStyle(
  config: VirtualCursorStyleConfig = {}
): ResolvedVirtualCursorStyle {
  const presetName: VirtualCursorPreset =
    config.preset && config.preset in CURSOR_STYLE_PRESETS ? config.preset : 'cyber-neon';
  const base = CURSOR_STYLE_PRESETS[presetName] ?? CURSOR_STYLE_PRESETS['cyber-neon'];
  const pointerShape: VirtualCursorShape =
    config.pointerShape && VALID_SHAPES.has(config.pointerShape)
      ? config.pointerShape
      : base.pointerShape;
  const rawScale = config.pointerScale ?? base.pointerScale;
  const rawWidth = config.trailWidth ?? base.trailWidth;
  const rawHotX = config.customPointerHotspotX ?? base.customPointerHotspotX;
  const rawHotY = config.customPointerHotspotY ?? base.customPointerHotspotY;

  return {
    preset: presetName,
    pointerShape,
    pointerColor: config.pointerColor ?? base.pointerColor,
    pointerBorderColor: config.pointerBorderColor ?? base.pointerBorderColor,
    pointerScale: Math.max(0.4, Math.min(3.0, Number.isFinite(rawScale) ? rawScale : 1.0)),
    customPointerSvgPath:
      typeof config.customPointerSvgPath === 'string'
        ? config.customPointerSvgPath.trim().slice(0, 2000)
        : base.customPointerSvgPath,
    customPointerImageUrl: sanitizeCustomPointerImageUrl(
      config.customPointerImageUrl ?? base.customPointerImageUrl
    ),
    customPointerHotspotX: Math.max(0, Math.min(28, Number.isFinite(rawHotX) ? rawHotX : 3)),
    customPointerHotspotY: Math.max(0, Math.min(28, Number.isFinite(rawHotY) ? rawHotY : 3)),
    trailVariant: config.trailVariant ?? base.trailVariant,
    trailColorStart: config.trailColorStart ?? base.trailColorStart,
    trailColorEnd: config.trailColorEnd ?? base.trailColorEnd,
    trailWidth: Math.max(0, Math.min(12, Number.isFinite(rawWidth) ? rawWidth : 2.8)),
    trailLength: Math.max(2, Math.min(60, Math.round(config.trailLength ?? base.trailLength))),
    trailGlow: config.trailGlow ?? base.trailGlow,
    rippleColor: config.rippleColor ?? base.rippleColor,
    showBadge: config.showBadge ?? base.showBadge,
    badgeTextPrefix: (config.badgeTextPrefix ?? base.badgeTextPrefix).trim().slice(0, 24) || 'DSH',
  };
}

export function buildVirtualCursorInitScript(
  initialStyle: VirtualCursorStyleConfig = {},
  opts: {
    showTakeoverControl?: boolean;
    roleLabel?: string;
    takeoverHotkey?: string;
    unloadGuard?: boolean;
    activeSession?: boolean;
    takeoverMode?: 'running' | 'paused' | 'idle' | 'hidden';
  } = {}
): string {
  const resolved = resolveCursorStyle(initialStyle);
  const presetsJson = JSON.stringify(CURSOR_STYLE_PRESETS);
  const shapePathsJson = JSON.stringify(POINTER_SHAPE_SVG_PATHS);
  const initialJson = JSON.stringify(resolved);
  const optionsJson = JSON.stringify({
    showTakeoverControl: Boolean(opts.showTakeoverControl),
    roleLabel: opts.roleLabel || '',
    takeoverHotkey: typeof opts.takeoverHotkey === 'string' ? opts.takeoverHotkey : 'F8',
    unloadGuard: Boolean(opts.unloadGuard),
    activeSession: Boolean(opts.activeSession),
    takeoverMode: opts.takeoverMode ?? '',
  });

  return `
(() => {
  const PRESETS = ${presetsJson};
  const SHAPE_PATHS = ${shapePathsJson};
  const INITIAL_STYLE = ${initialJson};
  const INITIAL_OPTS = ${optionsJson};
  const SAFE_IMG_RE = /^(?:data:image\\/(?:png|jpeg|jpg|gif|webp|svg\\+xml|x-icon|vnd\\.microsoft\\.icon);|https?:\\/\\/)/i;

  function sanitizeImgUrl(url) {
    if (typeof url !== 'string') return '';
    const trimmed = url.trim();
    return SAFE_IMG_RE.test(trimmed) ? trimmed : '';
  }

  if (window.__dshVirtualCursorInstalled) {
    if (window.__dshCursorAPI && INITIAL_STYLE) {
      window.__dshCursorAPI.setStyle(INITIAL_STYLE, { fromHost: true });
    }
    if (window.__dshCursorAPI && window.__dshCursorAPI.setTakeoverHotkey) {
      window.__dshCursorAPI.setTakeoverHotkey(INITIAL_OPTS.takeoverHotkey);
    }
    if (window.__dshCursorAPI && window.__dshCursorAPI.setTakeoverState) {
      if (INITIAL_OPTS.takeoverMode) {
        window.__dshCursorAPI.setTakeoverState(INITIAL_OPTS.takeoverMode, INITIAL_OPTS.roleLabel);
      } else if (INITIAL_OPTS.showTakeoverControl) {
        window.__dshCursorAPI.setTakeoverState(
          INITIAL_OPTS.activeSession ? 'running' : 'idle',
          INITIAL_OPTS.roleLabel
        );
      }
    }
    if (window.__dshCursorAPI && window.__dshCursorAPI.setUnloadGuard) {
      window.__dshCursorAPI.setUnloadGuard(Boolean(INITIAL_OPTS.unloadGuard));
    }
    return;
  }
  window.__dshVirtualCursorInstalled = true;

  let unloadGuardOn = false;
  const unloadGuardHandler = (ev) => {
    ev.preventDefault();
    ev.returnValue = '';
  };
  function applyUnloadGuard(on) {
    const next = Boolean(on);
    if (next && !unloadGuardOn) {
      window.addEventListener('beforeunload', unloadGuardHandler);
      unloadGuardOn = true;
    } else if (!next && unloadGuardOn) {
      window.removeEventListener('beforeunload', unloadGuardHandler);
      unloadGuardOn = false;
    }
    return unloadGuardOn;
  }

  const initialTakeoverMode = INITIAL_OPTS.takeoverMode
    || (INITIAL_OPTS.showTakeoverControl
      ? (INITIAL_OPTS.activeSession ? 'running' : 'idle')
      : 'hidden');

  const state = {
    x: 120,
    y: 120,
    action: 'READY',
    trail: [{ x: 120, y: 120 }],
    style: { ...INITIAL_STYLE },
    takeoverMode: initialTakeoverMode,
    takeoverLabel: INITIAL_OPTS.roleLabel || '',
    takeoverHotkey: INITIAL_OPTS.takeoverHotkey || 'F8',
    takeoverPending: Boolean(window.__dshTakeoverRequested),
    dragActive: false,
    dragOrigin: null,
    dragTarget: null,
    scrollActive: false,
    scrollDir: 1,
  };

  let scrollResetTimer = null;
  let anchorFadeTimer = null;
  let badgeMeasurePending = false;
  function placeBadge(x, y) {
    const badge = document.getElementById('__dsh_vc_badge__');
    if (!badge || badge.style.display === 'none') return;
    const MARGIN = 8;
    const GAP_X = 14;
    const GAP_Y = 12;
    const bw = badge.offsetWidth || Math.ceil(badge.getBoundingClientRect().width) || 0;
    const bh = badge.offsetHeight || Math.ceil(badge.getBoundingClientRect().height) || 0;
    if ((bw === 0 || bh === 0) && !badgeMeasurePending && typeof requestAnimationFrame === 'function') {
      badgeMeasurePending = true;
      requestAnimationFrame(() => {
        badgeMeasurePending = false;
        placeBadge(state.x, state.y);
      });
    }
    const vw = window.innerWidth || document.documentElement?.clientWidth || 1440;
    const vh = window.innerHeight || document.documentElement?.clientHeight || 900;

    let left = 22;
    let top = 18;

    if (x + left + bw > vw - MARGIN) left = -(bw + GAP_X);
    if (x + left < MARGIN) left = MARGIN - x;
    if (x + left + bw > vw - MARGIN) {
      left = Math.max(MARGIN - x, vw - MARGIN - bw - x);
    }

    if (y + top + bh > vh - MARGIN) top = -(bh + GAP_Y);
    if (y + top < MARGIN) top = MARGIN - y;
    if (y + top + bh > vh - MARGIN) {
      top = Math.max(MARGIN - y, vh - MARGIN - bh - y);
    }

    badge.style.left = Math.round(left) + 'px';
    badge.style.top = Math.round(top) + 'px';
  }

  if (!window.__dshVcResizeInstalled) {
    window.__dshVcResizeInstalled = true;
    window.addEventListener('resize', () => {
      placeBadge(state.x, state.y);
    });
  }

  function isCenterTestMode() {
    try {
      return new URLSearchParams(window.location.search).get('__dsh_test_center_pill') === '1';
    } catch {
      return false;
    }
  }

  function triggerHumanTakeover() {
    window.__dshTakeoverRequested = true;
    state.takeoverPending = true;
    renderTakeoverPanel();
    try {
      if (typeof window.__dshRequestTakeover === 'function') {
        window.__dshRequestTakeover();
      }
    } catch {}
  }

  if (!window.__dshTakeoverHotkeyInstalled) {
    window.__dshTakeoverHotkeyInstalled = true;
    window.addEventListener(
      'keydown',
      (e) => {
        const targetHotkey = (state.takeoverHotkey || '').trim();
        if (!targetHotkey || state.takeoverMode !== 'running') return;
        if (typeof e.key === 'string' && e.key.toLowerCase() === targetHotkey.toLowerCase()) {
          e.preventDefault();
          e.stopPropagation();
          triggerHumanTakeover();
        }
      },
      true
    );
  }

  function ensureDOM() {
    let root = document.getElementById('__dsh_vc_root__');
    if (root) return root;
    if (!document.documentElement) return null;

    root = document.createElement('div');
    root.id = '__dsh_vc_root__';
    root.setAttribute('aria-hidden', 'true');
    root.setAttribute('popover', 'manual');
    root.style.cssText = [
      'position:fixed',
      'inset:0',
      'width:100vw',
      'height:100vh',
      'min-width:0',
      'max-width:none',
      'min-height:0',
      'max-height:none',
      'margin:0',
      'padding:0',
      'border:0',
      'background:transparent',
      'opacity:1',
      'box-sizing:border-box',
      'pointer-events:none',
      'z-index:2147483647',
      'overflow:hidden',
      'font-family:ui-monospace,SFMono-Regular,Consolas,monospace'
    ].join(';');

    root.innerHTML = \`
      <style id="__dsh_vc_style__">
        #__dsh_vc_root__,
        #__dsh_vc_root__ div,
        #__dsh_vc_root__ span,
        #__dsh_vc_root__ button,
        #__dsh_vc_root__ img {
          margin: 0;
          padding: 0;
          border: 0;
          width: auto;
          height: auto;
          min-width: 0;
          max-width: none;
          min-height: 0;
          max-height: none;
          opacity: 1;
          box-sizing: border-box;
          float: none;
          clear: none;
          vertical-align: baseline;
          line-height: normal;
          text-indent: 0;
          text-transform: none;
          letter-spacing: normal;
        }
        #__dsh_vc_root__ svg {
          margin: 0;
          padding: 0;
          border: 0;
          min-width: 0;
          max-width: none;
          min-height: 0;
          max-height: none;
          opacity: 1;
          box-sizing: border-box;
          float: none;
          clear: none;
          vertical-align: baseline;
          overflow: visible;
        }
      </style>
      <svg id="__dsh_vc_svg__" style="position:absolute;inset:0;width:100%;height:100%;margin:0;padding:0;border:0;display:block;opacity:1;overflow:visible;pointer-events:none">
        <defs>
          <linearGradient id="__dsh_trail_grad__" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop id="__dsh_grad_stop0__" offset="0%" stop-color="#ff3b28" stop-opacity="0.2"/>
            <stop id="__dsh_grad_stop1__" offset="100%" stop-color="#00f0ff" stop-opacity="0.95"/>
          </linearGradient>
          <linearGradient id="__dsh_drag_grad__" gradientUnits="userSpaceOnUse" x1="120" y1="120" x2="120" y2="120">
            <stop id="__dsh_drag_stop0__" offset="0%" stop-color="#00f0ff" stop-opacity="0.98"/>
            <stop id="__dsh_drag_stop1__" offset="100%" stop-color="#ff3b28" stop-opacity="0.45"/>
          </linearGradient>
        </defs>
        <path id="__dsh_vc_trail_glow__" fill="none" stroke="rgba(0,240,255,0.28)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none"/>
        <path id="__dsh_vc_trail__" fill="none" stroke="url(#__dsh_trail_grad__)" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round" style="pointer-events:none"/>
        <g id="__dsh_vc_dots__" style="pointer-events:none"></g>
        <g id="__dsh_vc_scroll_pulse__" style="pointer-events:none"></g>
        <g id="__dsh_vc_ripples__" style="pointer-events:none"></g>
      </svg>
      <div id="__dsh_vc_panel__" style="position:fixed;top:14px;right:14px;width:auto;height:auto;max-width:calc(100vw - 16px);margin:0;box-sizing:border-box;display:none;align-items:center;gap:10px;padding:7px 12px;border-radius:999px;background:rgba(12,14,20,0.9);border:1.5px solid #10b981;color:#f5f8ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,0.4);opacity:1;pointer-events:none;backdrop-filter:blur(8px);user-select:none">
        <span id="__dsh_vc_status_dot__" style="width:8px;height:8px;margin:0;padding:0;border:0;border-radius:50%;background:#10b981;box-shadow:0 0 8px #10b981;flex-shrink:0;opacity:1;pointer-events:none"></span>
        <span id="__dsh_vc_status_text__" style="min-width:0;width:auto;height:auto;margin:0;padding:0;border:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:1;pointer-events:none">DSH 待命 · 窗口保持打开（无任务）</span>
        <button id="__dsh_vc_takeover_btn__" type="button" style="display:none;width:auto;height:auto;margin:0;border:0;border-radius:999px;padding:4px 11px;background:#ef4444;color:#ffffff;font-size:12px;font-weight:700;cursor:default;opacity:1;pointer-events:none;white-space:nowrap;flex-shrink:0"></button>
      </div>
      <div id="__dsh_vc_pointer__" style="position:absolute;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;background:transparent;opacity:1;overflow:visible;box-sizing:border-box;transform:translate3d(120px,120px,0);transform-origin:0 0;will-change:transform;pointer-events:none">
        <div id="__dsh_vc_ring__" style="position:absolute;left:-9px;top:-9px;width:18px;height:18px;margin:0;padding:0;box-sizing:border-box;border-radius:50%;border:2px solid #00f0ff;background:rgba(255,59,40,0.3);box-shadow:0 0 12px rgba(0,240,255,0.8);opacity:1;pointer-events:none"></div>
        <svg id="__dsh_vc_arrow_svg__" width="28" height="28" viewBox="0 0 28 28" style="position:absolute;left:-3px;top:-3px;width:28px;height:28px;margin:0;padding:0;border:0;display:block;opacity:1;overflow:visible;box-sizing:border-box;transform-origin:3px 3px;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.65));pointer-events:none">
          <path id="__dsh_vc_arrow_path__" d="M3 3 L11 24 L14.8 15.2 L23.5 11.5 Z" fill="#ff3b28" stroke="#ffffff" stroke-width="2" stroke-linejoin="round" fill-rule="evenodd" style="pointer-events:none"/>
        </svg>
        <img id="__dsh_vc_custom_img__" alt="" style="position:absolute;left:-3px;top:-3px;width:28px;height:28px;margin:0;padding:0;border:0;object-fit:contain;display:none;opacity:1;box-sizing:border-box;pointer-events:none;transform-origin:top left;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.55))" />
        <div id="__dsh_vc_scroll_ind__" style="position:absolute;left:-26px;top:-13px;width:18px;height:26px;margin:0;padding:0;box-sizing:border-box;display:none;flex-direction:column;align-items:center;justify-content:center;gap:1px;border-radius:6px;background:rgba(12,14,20,0.92);border:1.5px solid #00f0ff;color:#00f0ff;line-height:1;box-shadow:0 0 10px rgba(0,240,255,0.75);opacity:1;pointer-events:none"><span class="up" style="display:flex;align-items:center;justify-content:center;width:12px;height:9px;margin:0;padding:0;border:0;line-height:1;opacity:0.28;transform:scale(1);filter:none;transform-origin:center center;transition:opacity 120ms, transform 120ms;pointer-events:none"><svg width="10" height="7" viewBox="0 0 10 7" style="display:block;width:10px;height:7px;margin:0;padding:0;border:0;opacity:1;overflow:visible;pointer-events:none"><path d="M5 0.6 L9.4 6.4 L0.6 6.4 Z" fill="currentColor" style="pointer-events:none"/></svg></span><span class="down" style="display:flex;align-items:center;justify-content:center;width:12px;height:9px;margin:0;padding:0;border:0;line-height:1;opacity:0.28;transform:scale(1);filter:none;transform-origin:center center;transition:opacity 120ms, transform 120ms;pointer-events:none"><svg width="10" height="7" viewBox="0 0 10 7" style="display:block;width:10px;height:7px;margin:0;padding:0;border:0;opacity:1;overflow:visible;pointer-events:none"><path d="M0.6 0.6 L9.4 0.6 L5 6.4 Z" fill="currentColor" style="pointer-events:none"/></svg></span></div>
        <div id="__dsh_vc_badge__" style="position:absolute;left:22px;top:18px;width:auto;height:auto;margin:0;padding:3px 9px;box-sizing:border-box;border-radius:999px;background:rgba(12,14,20,0.92);border:1.3px solid #00f0ff;color:#f5f8ff;font-size:10.5px;font-weight:700;line-height:1.3;letter-spacing:0.06em;white-space:nowrap;box-shadow:0 6px 16px rgba(0,0,0,0.45);opacity:1;pointer-events:none">
          DSH · (120, 120) · READY
        </div>
      </div>
    \`;

    document.documentElement.appendChild(root);
    const btn = root.querySelector('#__dsh_vc_takeover_btn__');
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        if (state.takeoverMode === 'running') {
          triggerHumanTakeover();
        }
      });
    }
    try { if (root.showPopover) root.showPopover(); } catch {}
    return root;
  }

  function mountDragAnchor(x, y) {
    const root = ensureDOM();
    if (!root) return;
    if (anchorFadeTimer) {
      clearTimeout(anchorFadeTimer);
      anchorFadeTimer = null;
    }
    const prev = document.getElementById('__dsh_vc_anchor__');
    if (prev) prev.remove();
    const anchor = document.createElement('div');
    anchor.id = '__dsh_vc_anchor__';
    const rc = state.style.rippleColor || '#00f0ff';
    anchor.style.cssText = [
      'position:fixed',
      'left:' + Math.round(x - 9) + 'px',
      'top:' + Math.round(y - 9) + 'px',
      'width:18px',
      'height:18px',
      'margin:0',
      'padding:0',
      'box-sizing:border-box',
      'border-radius:50%',
      'border:2px dashed ' + rc,
      'background:rgba(0,240,255,0.16)',
      'box-shadow:0 0 10px ' + rc,
      'opacity:1',
      'transition:opacity 0.35s ease',
      'pointer-events:none'
    ].join(';');
    root.appendChild(anchor);
  }

  function fadeOutDragAnchor() {
    const anchor = document.getElementById('__dsh_vc_anchor__');
    if (!anchor) return;
    anchor.style.opacity = '0';
    if (anchorFadeTimer) clearTimeout(anchorFadeTimer);
    anchorFadeTimer = setTimeout(() => {
      anchorFadeTimer = null;
      const el = document.getElementById('__dsh_vc_anchor__');
      if (el) el.remove();
    }, 420);
  }

  function renderTakeoverPanel() {
    const panel = document.getElementById('__dsh_vc_panel__');
    const dot = document.getElementById('__dsh_vc_status_dot__');
    const txt = document.getElementById('__dsh_vc_status_text__');
    const btn = document.getElementById('__dsh_vc_takeover_btn__');
    if (!panel || !dot || !txt || !btn) return;

    const centerTest = isCenterTestMode();
    if (centerTest) {
      panel.style.top = '50%';
      panel.style.left = '50%';
      panel.style.right = 'auto';
      panel.style.transform = 'translate(-50%, -50%)';
      panel.style.display = 'flex';
      panel.style.pointerEvents = 'auto';
      btn.style.display = 'inline-block';
      btn.style.pointerEvents = 'auto';
      btn.style.cursor = 'pointer';
    } else {
      panel.style.top = '14px';
      panel.style.right = '14px';
      panel.style.left = 'auto';
      panel.style.transform = 'none';
      panel.style.pointerEvents = 'none';
    }

    if (!centerTest && state.takeoverMode === 'hidden') {
      panel.style.display = 'none';
      btn.style.pointerEvents = 'none';
      return;
    }

    panel.style.display = 'flex';
    const roleSuffix = state.takeoverLabel ? ' · ' + state.takeoverLabel : '';
    const hotkey = state.takeoverHotkey ? state.takeoverHotkey : '';
    const hotkeyHint = hotkey ? ' · 按 ' + hotkey + ' 接管' : '';

    if (state.takeoverPending && (state.takeoverMode === 'running' || centerTest)) {
      panel.style.borderColor = '#f59e0b';
      dot.style.background = '#f59e0b';
      dot.style.boxShadow = '0 0 8px #f59e0b';
      txt.textContent = '已请求接管 · 正在暂停...';
      btn.style.display = 'inline-block';
      btn.textContent = '正在暂停...';
      btn.disabled = true;
      btn.style.background = '#b45309';
      btn.style.cursor = 'wait';
      btn.style.pointerEvents = centerTest ? 'auto' : 'none';
      return;
    }

    if (state.takeoverMode === 'paused') {
      panel.style.borderColor = '#f59e0b';
      dot.style.background = '#f59e0b';
      dot.style.boxShadow = '0 0 8px #f59e0b';
      txt.textContent = '已暂停 · 等待人工接管';
      btn.style.display = 'inline-block';
      btn.disabled = false;
      btn.textContent = '继续执行';
      btn.style.background = '#d97706';
      btn.style.cursor = 'pointer';
      btn.style.pointerEvents = 'auto';
      return;
    }

    if (state.takeoverMode === 'idle') {
      panel.style.borderColor = '#10b981';
      dot.style.background = '#10b981';
      dot.style.boxShadow = '0 0 8px #10b981';
      txt.textContent = 'DSH 待命 · 窗口保持打开（无任务）';
      btn.style.display = 'none';
      btn.disabled = true;
      btn.textContent = '';
      btn.style.cursor = 'default';
      btn.style.pointerEvents = 'none';
      return;
    }

    panel.style.borderColor = '#00f0ff';
    dot.style.background = '#00f0ff';
    dot.style.boxShadow = '0 0 8px #00f0ff';
    txt.textContent = 'DSH Agent 运行中' + roleSuffix + hotkeyHint;
    btn.style.display = 'inline-block';
    btn.disabled = false;
    btn.textContent = hotkey ? '按 ' + hotkey + ' 接管' : '暂停并接管';
    btn.style.background = '#ef4444';
    if (centerTest) {
      btn.style.pointerEvents = 'auto';
      btn.style.cursor = 'pointer';
    } else {
      btn.style.pointerEvents = 'none';
      btn.style.cursor = 'default';
    }
  }

  function promoteToTopLayer(root) {
    try {
      if (!root || !root.isConnected || !root.showPopover) return;
      if (!root.matches || !root.matches(':popover-open')) {
        root.showPopover();
        return;
      }
      const topEls = document.querySelectorAll('dialog[open], [popover]:popover-open');
      for (let i = 0; i < topEls.length; i++) {
        if (topEls[i] !== root) {
          if (root.hidePopover) root.hidePopover();
          root.showPopover();
          break;
        }
      }
    } catch {}
  }

  function buildTrailPath(pts) {
    if (!pts || pts.length < 2) return '';
    let d = 'M ' + pts[0].x.toFixed(1) + ' ' + pts[0].y.toFixed(1);
    for (let i = 1; i < pts.length; i++) {
      const p0 = pts[i - 1];
      const p1 = pts[i];
      const mx = ((p0.x + p1.x) * 0.5).toFixed(1);
      const my = ((p0.y + p1.y) * 0.5).toFixed(1);
      d += ' Q ' + p0.x.toFixed(1) + ' ' + p0.y.toFixed(1) + ' ' + mx + ' ' + my;
    }
    const last = pts[pts.length - 1];
    d += ' L ' + last.x.toFixed(1) + ' ' + last.y.toFixed(1);
    return d;
  }

  function render() {
    const root = ensureDOM();
    if (!root) return;
    promoteToTopLayer(root);
    renderTakeoverPanel();
    const s = state.style;

    const pointer = document.getElementById('__dsh_vc_pointer__');
    const ring = document.getElementById('__dsh_vc_ring__');
    const arrowSvg = document.getElementById('__dsh_vc_arrow_svg__');
    const arrowPath = document.getElementById('__dsh_vc_arrow_path__');
    const customImg = document.getElementById('__dsh_vc_custom_img__');
    const scrollInd = document.getElementById('__dsh_vc_scroll_ind__');
    const badge = document.getElementById('__dsh_vc_badge__');
    const trail = document.getElementById('__dsh_vc_trail__');
    const trailGlow = document.getElementById('__dsh_vc_trail_glow__');
    const dotsG = document.getElementById('__dsh_vc_dots__');
    const scrollPulseG = document.getElementById('__dsh_vc_scroll_pulse__');
    const stop0 = document.getElementById('__dsh_grad_stop0__');
    const stop1 = document.getElementById('__dsh_grad_stop1__');
    const dragGrad = document.getElementById('__dsh_drag_grad__');
    const dragStop0 = document.getElementById('__dsh_drag_stop0__');
    const dragStop1 = document.getElementById('__dsh_drag_stop1__');

    const hotX = Number.isFinite(s.customPointerHotspotX) ? s.customPointerHotspotX : 3;
    const hotY = Number.isFinite(s.customPointerHotspotY) ? s.customPointerHotspotY : 3;
    const scale = Number.isFinite(s.pointerScale) ? s.pointerScale : 1;
    const rotDeg = state.scrollActive && !state.dragActive ? (state.scrollDir >= 0 ? 12 : -12) : 0;

    if (pointer) {
      pointer.style.transform =
        'translate3d(' +
        state.x.toFixed(1) +
        'px,' +
        state.y.toFixed(1) +
        'px,0)' +
        (state.dragActive ? ' scale(0.86)' : '');
    }

    const shapeTransform = 'scale(' + scale + ')' + (rotDeg ? ' rotate(' + rotDeg + 'deg)' : '');
    const safeImg = s.pointerShape === 'custom-image' ? sanitizeImgUrl(s.customPointerImageUrl) : '';
    if (safeImg && customImg && arrowSvg) {
      arrowSvg.style.display = 'none';
      customImg.style.display = 'block';
      if (customImg.getAttribute('src') !== safeImg) {
        customImg.setAttribute('src', safeImg);
      }
      customImg.style.left = '-' + hotX + 'px';
      customImg.style.top = '-' + hotY + 'px';
      customImg.style.transformOrigin = hotX + 'px ' + hotY + 'px';
      customImg.style.transform = shapeTransform;
    } else if (arrowSvg && arrowPath) {
      if (customImg) {
        customImg.style.display = 'none';
      }
      arrowSvg.style.display = 'block';
      const svgOriginX = (s.pointerShape === 'crosshair' || s.pointerShape === 'dot' || s.pointerShape === 'star' || s.pointerShape === 'ring') ? 14 : hotX;
      const svgOriginY = (s.pointerShape === 'crosshair' || s.pointerShape === 'dot' || s.pointerShape === 'star' || s.pointerShape === 'ring') ? 14 : hotY;
      arrowSvg.style.left = '-' + svgOriginX + 'px';
      arrowSvg.style.top = '-' + svgOriginY + 'px';
      arrowSvg.style.transformOrigin = svgOriginX + 'px ' + svgOriginY + 'px';
      arrowSvg.style.transform = shapeTransform;
      const customPath = typeof s.customPointerSvgPath === 'string' ? s.customPointerSvgPath.trim() : '';
      const d = s.pointerShape === 'custom-svg' && customPath
        ? customPath
        : (SHAPE_PATHS[s.pointerShape] || SHAPE_PATHS.arrow);
      arrowPath.setAttribute('d', d);
      arrowPath.setAttribute('fill-rule', 'evenodd');
      if (s.pointerShape === 'crosshair') {
        arrowPath.setAttribute('fill', 'none');
        arrowPath.setAttribute('stroke', s.pointerColor);
        arrowPath.setAttribute('stroke-width', state.dragActive ? '3.6' : '2.4');
      } else {
        arrowPath.setAttribute('fill', s.pointerColor);
        arrowPath.setAttribute('stroke', s.pointerBorderColor);
        arrowPath.setAttribute('stroke-width', state.dragActive ? '3.4' : '2');
      }
    }

    if (ring) {
      ring.style.borderColor = s.rippleColor;
      ring.style.borderWidth = state.dragActive ? '3px' : '2px';
      ring.style.boxShadow = s.trailGlow ? '0 0 ' + (state.dragActive ? '16px ' : '12px ') + s.rippleColor : 'none';
    }

    if (scrollInd) {
      const scrollUp = scrollInd.querySelector('.up');
      const scrollDown = scrollInd.querySelector('.down');
      if (state.scrollActive && !state.dragActive) {
        const isDown = state.scrollDir >= 0;
        const activeShadow = 'drop-shadow(0 0 6px ' + s.rippleColor + ')';
        scrollInd.style.display = 'flex';
        scrollInd.style.borderColor = s.rippleColor;
        scrollInd.style.color = s.rippleColor;
        scrollInd.style.boxShadow = s.trailGlow ? '0 0 10px ' + s.rippleColor : 'none';
        if (scrollUp) {
          scrollUp.style.color = s.rippleColor;
          scrollUp.style.opacity = isDown ? '0.28' : '1';
          scrollUp.style.transform = isDown ? 'scale(1)' : 'scale(1.15)';
          scrollUp.style.filter = isDown ? 'none' : activeShadow;
          const upPath = scrollUp.querySelector('path');
          if (upPath) upPath.setAttribute('fill', s.rippleColor);
        }
        if (scrollDown) {
          scrollDown.style.color = s.rippleColor;
          scrollDown.style.opacity = isDown ? '1' : '0.28';
          scrollDown.style.transform = isDown ? 'scale(1.15)' : 'scale(1)';
          scrollDown.style.filter = isDown ? activeShadow : 'none';
          const downPath = scrollDown.querySelector('path');
          if (downPath) downPath.setAttribute('fill', s.rippleColor);
        }
      } else {
        scrollInd.style.display = 'none';
        if (scrollUp) {
          scrollUp.style.opacity = '0.28';
          scrollUp.style.transform = 'scale(1)';
          scrollUp.style.filter = 'none';
        }
        if (scrollDown) {
          scrollDown.style.opacity = '0.28';
          scrollDown.style.transform = 'scale(1)';
          scrollDown.style.filter = 'none';
        }
      }
    }

    if (badge) {
      badge.style.display = s.showBadge ? 'block' : 'none';
      badge.style.borderColor = s.rippleColor;
      const prefix = (typeof s.badgeTextPrefix === 'string' && s.badgeTextPrefix.trim()) ? s.badgeTextPrefix.trim() : 'DSH';
      badge.textContent = prefix + ' · (' + Math.round(state.x) + ', ' + Math.round(state.y) + ') · ' + state.action;
      placeBadge(state.x, state.y);
    }
    if (stop0) stop0.setAttribute('stop-color', s.trailColorStart);
    if (stop1) stop1.setAttribute('stop-color', s.trailColorEnd);

    if (dotsG) dotsG.innerHTML = '';
    if (scrollPulseG) scrollPulseG.innerHTML = '';

    if (state.scrollActive && !state.dragActive && scrollPulseG) {
      if (trail) trail.setAttribute('d', '');
      if (trailGlow) trailGlow.setAttribute('d', '');
      const NS = 'http://www.w3.org/2000/svg';
      const dir = state.scrollDir >= 0 ? 1 : -1;
      const pulseColor = s.trailColorEnd && s.trailColorEnd !== 'transparent' ? s.trailColorEnd : s.rippleColor;
      const segments = [
        { a: 16, b: 27, op: '0.95' },
        { a: 31, b: 40, op: '0.62' },
        { a: 44, b: 51, op: '0.30' },
      ];
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        const line = document.createElementNS(NS, 'line');
        line.setAttribute('x1', state.x.toFixed(1));
        line.setAttribute('x2', state.x.toFixed(1));
        line.setAttribute('y1', (state.y + dir * seg.a).toFixed(1));
        line.setAttribute('y2', (state.y + dir * seg.b).toFixed(1));
        line.setAttribute('stroke', pulseColor);
        line.setAttribute('stroke-width', String(Math.max(2.6, (s.trailWidth || 2.8) * 1.15)));
        line.setAttribute('stroke-linecap', 'round');
        line.setAttribute('stroke-opacity', seg.op);
        line.style.pointerEvents = 'none';
        scrollPulseG.appendChild(line);
      }
      return;
    }

    if (state.dragActive && state.trail.length >= 2) {
      const origin = state.dragOrigin || state.trail[0];
      if (dragGrad) {
        dragGrad.setAttribute('x1', state.x.toFixed(1));
        dragGrad.setAttribute('y1', state.y.toFixed(1));
        dragGrad.setAttribute('x2', origin.x.toFixed(1));
        dragGrad.setAttribute('y2', origin.y.toFixed(1));
      }
      if (dragStop0) dragStop0.setAttribute('stop-color', s.trailColorEnd && s.trailColorEnd !== 'transparent' ? s.trailColorEnd : s.rippleColor);
      if (dragStop1) dragStop1.setAttribute('stop-color', s.trailColorStart && s.trailColorStart !== 'transparent' ? s.trailColorStart : s.pointerColor);
      const dragD = buildTrailPath(state.trail);
      const dragWidth = Math.max(2.4, (s.trailWidth || 2.8) * 1.8);
      if (trail) {
        trail.setAttribute('d', dragD);
        trail.setAttribute('stroke', 'url(#__dsh_drag_grad__)');
        trail.setAttribute('stroke-width', dragWidth.toFixed(2));
        trail.setAttribute('stroke-opacity', '0.96');
        trail.setAttribute('stroke-dasharray', 'none');
      }
      if (trailGlow) {
        trailGlow.setAttribute('d', dragD);
        trailGlow.setAttribute('stroke', s.trailColorEnd && s.trailColorEnd !== 'transparent' ? s.trailColorEnd : s.rippleColor);
        trailGlow.setAttribute('stroke-opacity', '0.52');
        trailGlow.setAttribute('stroke-width', (dragWidth * 2.2).toFixed(2));
      }
      return;
    }

    if (s.trailVariant === 'none' || state.trail.length < 2) {
      if (trail) trail.setAttribute('d', '');
      if (trailGlow) trailGlow.setAttribute('d', '');
      return;
    }

    if (s.trailVariant === 'dots') {
      if (trail) trail.setAttribute('d', '');
      if (trailGlow) trailGlow.setAttribute('d', '');
      const NS = 'http://www.w3.org/2000/svg';
      state.trail.forEach((pt, idx) => {
        const ratio = (idx + 1) / state.trail.length;
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', pt.x.toFixed(1));
        c.setAttribute('cy', pt.y.toFixed(1));
        c.setAttribute('r', (1.4 + ratio * s.trailWidth).toFixed(1));
        c.setAttribute('fill', ratio > 0.5 ? s.trailColorEnd : s.trailColorStart);
        c.setAttribute('fill-opacity', (0.18 + ratio * 0.78).toFixed(2));
        c.style.pointerEvents = 'none';
        dotsG.appendChild(c);
      });
      return;
    }

    const d = buildTrailPath(state.trail);
    if (trail) {
      trail.setAttribute('d', d);
      trail.setAttribute('stroke', 'url(#__dsh_trail_grad__)');
      trail.setAttribute('stroke-opacity', '1');
      trail.setAttribute('stroke-width', String(s.trailVariant === 'comet' ? s.trailWidth * 1.35 : s.trailWidth));
      trail.setAttribute('stroke-dasharray', s.trailVariant === 'dashed' ? '5 3' : 'none');
    }
    if (trailGlow) {
      trailGlow.setAttribute('d', s.trailGlow ? d : '');
      trailGlow.setAttribute('stroke', s.trailColorEnd);
      trailGlow.setAttribute('stroke-opacity', s.trailVariant === 'comet' ? '0.42' : '0.26');
      trailGlow.setAttribute('stroke-width', String((s.trailWidth || 2.8) * 3.1));
    }
  }

  function spawnRipple(x, y) {
    ensureDOM();
    const g = document.getElementById('__dsh_vc_ripples__');
    if (!g) return;
    const s = state.style;
    const NS = 'http://www.w3.org/2000/svg';
    const c1 = document.createElementNS(NS, 'circle');
    c1.setAttribute('cx', String(x));
    c1.setAttribute('cy', String(y));
    c1.setAttribute('r', '18');
    c1.setAttribute('fill', 'rgba(255,59,40,0.2)');
    c1.setAttribute('stroke', s.rippleColor);
    c1.setAttribute('stroke-width', '2.4');
    c1.style.pointerEvents = 'none';

    const c2 = document.createElementNS(NS, 'circle');
    c2.setAttribute('cx', String(x));
    c2.setAttribute('cy', String(y));
    c2.setAttribute('r', '34');
    c2.setAttribute('fill', 'none');
    c2.setAttribute('stroke', s.pointerColor);
    c2.setAttribute('stroke-width', '1.5');
    c2.setAttribute('stroke-dasharray', '4 3');
    c2.style.pointerEvents = 'none';

    g.appendChild(c1);
    g.appendChild(c2);
    setTimeout(() => {
      c1.remove();
      c2.remove();
    }, 900);
  }

  applyUnloadGuard(INITIAL_OPTS.unloadGuard);

  window.__dshCursorAPI = {
    update(x, y, action) {
      state.x = x;
      state.y = y;
      if (action) state.action = action;
      const last = state.trail[state.trail.length - 1];
      const maxLen = state.style.trailLength || 22;
      if (!last || Math.hypot(x - last.x, y - last.y) > 3.5) {
        state.trail.push({ x, y });
        while (state.trail.length > maxLen) state.trail.shift();
      }
      render();
    },
    clickEffect(x, y, label = 'CLICK') {
      this.update(x, y, label);
      spawnRipple(x, y);
    },
    dragStart(x, y, label) {
      state.scrollActive = false;
      state.dragActive = true;
      state.dragOrigin = { x, y };
      state.x = x;
      state.y = y;
      state.trail = [{ x, y }];
      state.action = label || ('DRAG (' + Math.round(x) + ',' + Math.round(y) + ')');
      mountDragAnchor(x, y);
      render();
    },
    dragMove(x, y, toX, toY) {
      state.scrollActive = false;
      state.dragActive = true;
      if (!state.dragOrigin) {
        state.dragOrigin = { x, y };
        mountDragAnchor(x, y);
      }
      state.x = x;
      state.y = y;
      const last = state.trail[state.trail.length - 1];
      const maxLen = Math.max(state.style.trailLength || 22, 24);
      if (!last || Math.hypot(x - last.x, y - last.y) > 2.0) {
        state.trail.push({ x, y });
        while (state.trail.length > maxLen) state.trail.shift();
      }
      const ox = Math.round(state.dragOrigin.x);
      const oy = Math.round(state.dragOrigin.y);
      const tx = Math.round(typeof toX === 'number' ? toX : x);
      const ty = Math.round(typeof toY === 'number' ? toY : y);
      state.action = 'DRAG (' + ox + ',' + oy + ') → (' + tx + ',' + ty + ')';
      render();
    },
    dragEnd(x, y, label) {
      state.dragActive = false;
      state.x = x;
      state.y = y;
      state.action = label || ('DROP (' + Math.round(x) + ',' + Math.round(y) + ')');
      spawnRipple(x, y);
      fadeOutDragAnchor();
      render();
      state.dragOrigin = null;
    },
    scrollEffect(deltaY = 0, label) {
      state.scrollActive = true;
      state.scrollDir = deltaY >= 0 ? 1 : -1;
      if (label) state.action = label;
      if (scrollResetTimer) clearTimeout(scrollResetTimer);
      scrollResetTimer = setTimeout(() => {
        scrollResetTimer = null;
        state.scrollActive = false;
        render();
      }, 400);
      render();
    },
    setUnloadGuard(on) {
      return applyUnloadGuard(on);
    },
    isUnloadGuardActive() {
      return unloadGuardOn;
    },
    setStyle(cfg = {}, opts = {}) {
      const base = cfg.preset && PRESETS[cfg.preset] && cfg.preset !== 'custom' && cfg.preset !== state.style.preset
        ? PRESETS[cfg.preset]
        : state.style;
      const next = {
        ...base,
        ...cfg,
        customPointerImageUrl: sanitizeImgUrl(cfg.customPointerImageUrl !== undefined ? cfg.customPointerImageUrl : base.customPointerImageUrl),
        trailLength: Math.max(2, Math.min(60, cfg.trailLength ?? base.trailLength ?? 22)),
      };
      state.style = next;
      while (state.trail.length > state.style.trailLength) {
        state.trail.shift();
      }
      render();
      if (!opts || !opts.fromHost) {
        window.__dshStyleDirty = true;
        try {
          if (typeof window.__dshSyncCursorStyle === 'function') {
            window.__dshSyncCursorStyle(state.style);
          }
        } catch {}
      } else {
        window.__dshStyleDirty = false;
      }
      return state.style;
    },
    clearTrail() {
      state.trail = [{ x: state.x, y: state.y }];
      render();
    },
    setTakeoverState(mode = 'idle', label = '') {
      state.takeoverMode = mode;
      if (mode === 'idle' || mode === 'hidden') {
        state.takeoverLabel = '';
      } else if (typeof label === 'string') {
        state.takeoverLabel = label;
      }
      if (mode !== 'running') state.takeoverPending = false;
      render();
    },
    setTakeoverHotkey(hotkey = 'F8') {
      state.takeoverHotkey = typeof hotkey === 'string' ? hotkey : 'F8';
      renderTakeoverPanel();
    },
    resetTakeoverRequest() {
      window.__dshTakeoverRequested = false;
      state.takeoverPending = false;
      render();
    },
    getState() {
      return { ...state };
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', render, { once: true });
  } else {
    render();
  }
})();
`;
}

export const VIRTUAL_CURSOR_INIT_SCRIPT = buildVirtualCursorInitScript();
