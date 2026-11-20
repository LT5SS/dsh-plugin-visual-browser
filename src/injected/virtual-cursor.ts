import type { VirtualCursorPreset, VirtualCursorStyleConfig } from '../driver/types.js';

export const CURSOR_STYLE_PRESETS: Record<VirtualCursorPreset, Required<Omit<VirtualCursorStyleConfig, 'preset'>>> = {
  'cyber-neon': {
    pointerColor: '#ff3b28',
    pointerBorderColor: '#ffffff',
    pointerScale: 1.0,
    trailVariant: 'dashed',
    trailColorStart: '#ff3b28',
    trailColorEnd: '#00f0ff',
    trailWidth: 2.8,
    trailLength: 24,
    trailGlow: true,
    rippleColor: '#00f0ff',
    showBadge: true,
  },
  'comet-gold': {
    pointerColor: '#ffb800',
    pointerBorderColor: '#1a0e00',
    pointerScale: 1.08,
    trailVariant: 'comet',
    trailColorStart: '#ff3b00',
    trailColorEnd: '#ffe66d',
    trailWidth: 4.5,
    trailLength: 28,
    trailGlow: true,
    rippleColor: '#ffd000',
    showBadge: true,
  },
  'laser-dots': {
    pointerColor: '#a855f7',
    pointerBorderColor: '#ffffff',
    pointerScale: 1.0,
    trailVariant: 'dots',
    trailColorStart: '#ec4899',
    trailColorEnd: '#38bdf8',
    trailWidth: 3.6,
    trailLength: 20,
    trailGlow: true,
    rippleColor: '#e879f9',
    showBadge: true,
  },
  'stealth-minimal': {
    pointerColor: '#111827',
    pointerBorderColor: '#ffffff',
    pointerScale: 0.9,
    trailVariant: 'solid',
    trailColorStart: '#9ca3af',
    trailColorEnd: '#374151',
    trailWidth: 1.6,
    trailLength: 14,
    trailGlow: false,
    rippleColor: '#6b7280',
    showBadge: false,
  },
  'clean-none': {
    pointerColor: '#ff3b28',
    pointerBorderColor: '#ffffff',
    pointerScale: 1.0,
    trailVariant: 'none',
    trailColorStart: 'transparent',
    trailColorEnd: 'transparent',
    trailWidth: 0,
    trailLength: 2,
    trailGlow: false,
    rippleColor: '#ff3b28',
    showBadge: true,
  },
};

export function resolveCursorStyle(
  config: VirtualCursorStyleConfig = {}
): Required<Omit<VirtualCursorStyleConfig, 'preset'>> & { preset: VirtualCursorPreset } {
  const presetName = config.preset ?? 'cyber-neon';
  const base = CURSOR_STYLE_PRESETS[presetName] ?? CURSOR_STYLE_PRESETS['cyber-neon'];
  return {
    preset: presetName,
    pointerColor: config.pointerColor ?? base.pointerColor,
    pointerBorderColor: config.pointerBorderColor ?? base.pointerBorderColor,
    pointerScale: config.pointerScale ?? base.pointerScale,
    trailVariant: config.trailVariant ?? base.trailVariant,
    trailColorStart: config.trailColorStart ?? base.trailColorStart,
    trailColorEnd: config.trailColorEnd ?? base.trailColorEnd,
    trailWidth: config.trailWidth ?? base.trailWidth,
    trailLength: Math.max(2, Math.min(60, config.trailLength ?? base.trailLength)),
    trailGlow: config.trailGlow ?? base.trailGlow,
    rippleColor: config.rippleColor ?? base.rippleColor,
    showBadge: config.showBadge ?? base.showBadge,
  };
}

export function buildVirtualCursorInitScript(
  initialStyle: VirtualCursorStyleConfig = {},
  opts: { showTakeoverControl?: boolean; roleLabel?: string } = {}
): string {
  const resolved = resolveCursorStyle(initialStyle);
  const presetsJson = JSON.stringify(CURSOR_STYLE_PRESETS);
  const initialJson = JSON.stringify(resolved);
  const optionsJson = JSON.stringify({
    showTakeoverControl: Boolean(opts.showTakeoverControl),
    roleLabel: opts.roleLabel || '',
  });

  return `
(() => {
  const PRESETS = ${presetsJson};
  const INITIAL_STYLE = ${initialJson};
  const INITIAL_OPTS = ${optionsJson};

  if (window.__dshVirtualCursorInstalled) {
    if (window.__dshCursorAPI && INITIAL_STYLE) {
      window.__dshCursorAPI.setStyle(INITIAL_STYLE);
    }
    if (window.__dshCursorAPI && INITIAL_OPTS.showTakeoverControl && window.__dshCursorAPI.setTakeoverState) {
      window.__dshCursorAPI.setTakeoverState('running', INITIAL_OPTS.roleLabel);
    }
    return;
  }
  window.__dshVirtualCursorInstalled = true;

  const state = {
    x: 120,
    y: 120,
    action: 'READY',
    trail: [{ x: 120, y: 120 }],
    style: { ...INITIAL_STYLE },
    takeoverMode: INITIAL_OPTS.showTakeoverControl ? 'running' : 'hidden',
    takeoverLabel: INITIAL_OPTS.roleLabel || '',
    takeoverPending: Boolean(window.__dshTakeoverRequested),
  };

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
      'margin:0',
      'padding:0',
      'border:0',
      'background:transparent',
      'pointer-events:none',
      'z-index:2147483647',
      'overflow:hidden',
      'font-family:ui-monospace,SFMono-Regular,Consolas,monospace'
    ].join(';');

    root.innerHTML = \`
      <svg id="__dsh_vc_svg__" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible">
        <defs>
          <linearGradient id="__dsh_trail_grad__" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop id="__dsh_grad_stop0__" offset="0%" stop-color="#ff3b28" stop-opacity="0.2"/>
            <stop id="__dsh_grad_stop1__" offset="100%" stop-color="#00f0ff" stop-opacity="0.95"/>
          </linearGradient>
        </defs>
        <path id="__dsh_vc_trail_glow__" fill="none" stroke="rgba(0,240,255,0.28)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/>
        <path id="__dsh_vc_trail__" fill="none" stroke="url(#__dsh_trail_grad__)" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>
        <g id="__dsh_vc_dots__"></g>
        <g id="__dsh_vc_ripples__"></g>
      </svg>
      <div id="__dsh_vc_panel__" style="position:fixed;top:14px;right:14px;display:none;align-items:center;gap:10px;padding:7px 12px;border-radius:999px;background:rgba(12,14,20,0.9);border:1.5px solid #00f0ff;color:#f5f8ff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:12px;font-weight:600;box-shadow:0 8px 24px rgba(0,0,0,0.4);pointer-events:auto;backdrop-filter:blur(8px);user-select:none">
        <span id="__dsh_vc_status_dot__" style="width:8px;height:8px;border-radius:50%;background:#00f0ff;box-shadow:0 0 8px #00f0ff;flex-shrink:0"></span>
        <span id="__dsh_vc_status_text__" style="white-space:nowrap">DSH Agent 运行中</span>
        <button id="__dsh_vc_takeover_btn__" type="button" style="border:0;border-radius:999px;padding:4px 11px;background:#ef4444;color:#ffffff;font-size:12px;font-weight:700;cursor:pointer;pointer-events:auto;white-space:nowrap">暂停并接管</button>
      </div>
      <div id="__dsh_vc_pointer__" style="position:absolute;left:0;top:0;transform:translate3d(120px,120px,0);will-change:transform">
        <div id="__dsh_vc_ring__" style="position:absolute;left:-7px;top:-7px;width:14px;height:14px;border-radius:50%;border:2px solid #00f0ff;background:rgba(255,59,40,0.3);box-shadow:0 0 12px rgba(0,240,255,0.8)"></div>
        <svg id="__dsh_vc_arrow_svg__" width="28" height="28" viewBox="0 0 28 28" style="position:absolute;left:-2px;top:-2px;transform-origin:3px 3px;filter:drop-shadow(0 3px 6px rgba(0,0,0,0.65))">
          <path id="__dsh_vc_arrow_path__" d="M3 3 L11 24 L14.8 15.2 L23.5 11.5 Z" fill="#ff3b28" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/>
        </svg>
        <div id="__dsh_vc_badge__" style="position:absolute;left:22px;top:18px;padding:3px 9px;border-radius:999px;background:rgba(12,14,20,0.92);border:1.3px solid #00f0ff;color:#f5f8ff;font-size:10.5px;font-weight:700;letter-spacing:0.06em;white-space:nowrap;box-shadow:0 6px 16px rgba(0,0,0,0.45)">
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
        window.__dshTakeoverRequested = true;
        state.takeoverPending = true;
        renderTakeoverPanel();
        try {
          if (typeof window.__dshRequestTakeover === 'function') {
            window.__dshRequestTakeover();
          }
        } catch {}
      });
    }
    try { if (root.showPopover) root.showPopover(); } catch {}
    return root;
  }

  function renderTakeoverPanel() {
    const panel = document.getElementById('__dsh_vc_panel__');
    const dot = document.getElementById('__dsh_vc_status_dot__');
    const txt = document.getElementById('__dsh_vc_status_text__');
    const btn = document.getElementById('__dsh_vc_takeover_btn__');
    if (!panel || !dot || !txt || !btn) return;

    if (state.takeoverMode === 'hidden') {
      panel.style.display = 'none';
      return;
    }

    panel.style.display = 'flex';
    const roleSuffix = state.takeoverLabel ? ' · ' + state.takeoverLabel : '';

    if (state.takeoverPending && state.takeoverMode === 'running') {
      panel.style.borderColor = '#f59e0b';
      dot.style.background = '#f59e0b';
      dot.style.boxShadow = '0 0 8px #f59e0b';
      txt.textContent = '已请求接管 · 正在暂停...';
      btn.textContent = '正在暂停...';
      btn.disabled = true;
      btn.style.background = '#b45309';
      btn.style.cursor = 'wait';
      return;
    }

    if (state.takeoverMode === 'paused') {
      panel.style.borderColor = '#f59e0b';
      dot.style.background = '#f59e0b';
      dot.style.boxShadow = '0 0 8px #f59e0b';
      txt.textContent = '已暂停 · 人工接管中（可在 DSH 中恢复）';
      btn.style.display = 'none';
      return;
    }

    if (state.takeoverMode === 'idle') {
      panel.style.borderColor = '#10b981';
      dot.style.background = '#10b981';
      dot.style.boxShadow = '0 0 8px #10b981';
      txt.textContent = '已完成 · 窗口保持打开待命' + roleSuffix;
      btn.style.display = 'none';
      return;
    }

    panel.style.borderColor = '#00f0ff';
    dot.style.background = '#00f0ff';
    dot.style.boxShadow = '0 0 8px #00f0ff';
    txt.textContent = 'DSH Agent 运行中' + roleSuffix;
    btn.style.display = 'inline-block';
    btn.disabled = false;
    btn.textContent = '暂停并接管';
    btn.style.background = '#ef4444';
    btn.style.cursor = 'pointer';
  }

  function promoteToTopLayer(root) {
    try {
      if (root && root.showPopover && document.querySelectorAll('dialog[open]').length > 0) {
        root.hidePopover();
        root.showPopover();
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
    const badge = document.getElementById('__dsh_vc_badge__');
    const trail = document.getElementById('__dsh_vc_trail__');
    const trailGlow = document.getElementById('__dsh_vc_trail_glow__');
    const dotsG = document.getElementById('__dsh_vc_dots__');
    const stop0 = document.getElementById('__dsh_grad_stop0__');
    const stop1 = document.getElementById('__dsh_grad_stop1__');

    if (pointer) {
      pointer.style.transform = 'translate3d(' + state.x.toFixed(1) + 'px,' + state.y.toFixed(1) + 'px,0)';
    }
    if (arrowSvg) {
      arrowSvg.style.transform = 'scale(' + (s.pointerScale || 1) + ')';
    }
    if (arrowPath) {
      arrowPath.setAttribute('fill', s.pointerColor);
      arrowPath.setAttribute('stroke', s.pointerBorderColor);
    }
    if (ring) {
      ring.style.borderColor = s.rippleColor;
      ring.style.boxShadow = s.trailGlow ? '0 0 12px ' + s.rippleColor : 'none';
    }
    if (badge) {
      badge.style.display = s.showBadge ? 'block' : 'none';
      badge.style.borderColor = s.rippleColor;
      badge.textContent = 'DSH · (' + Math.round(state.x) + ', ' + Math.round(state.y) + ') · ' + state.action;
    }
    if (stop0) stop0.setAttribute('stop-color', s.trailColorStart);
    if (stop1) stop1.setAttribute('stop-color', s.trailColorEnd);

    if (dotsG) dotsG.innerHTML = '';

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
        dotsG.appendChild(c);
      });
      return;
    }

    const d = buildTrailPath(state.trail);
    if (trail) {
      trail.setAttribute('d', d);
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

    const c2 = document.createElementNS(NS, 'circle');
    c2.setAttribute('cx', String(x));
    c2.setAttribute('cy', String(y));
    c2.setAttribute('r', '34');
    c2.setAttribute('fill', 'none');
    c2.setAttribute('stroke', s.pointerColor);
    c2.setAttribute('stroke-width', '1.5');
    c2.setAttribute('stroke-dasharray', '4 3');

    g.appendChild(c1);
    g.appendChild(c2);
    setTimeout(() => {
      c1.remove();
      c2.remove();
    }, 900);
  }

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
    setStyle(cfg = {}) {
      const base = cfg.preset && PRESETS[cfg.preset] ? PRESETS[cfg.preset] : state.style;
      state.style = {
        ...base,
        ...cfg,
        trailLength: Math.max(2, Math.min(60, cfg.trailLength ?? base.trailLength ?? 22)),
      };
      while (state.trail.length > state.style.trailLength) {
        state.trail.shift();
      }
      render();
      return state.style;
    },
    clearTrail() {
      state.trail = [{ x: state.x, y: state.y }];
      render();
    },
    setTakeoverState(mode = 'running', label = '') {
      state.takeoverMode = mode;
      if (typeof label === 'string') state.takeoverLabel = label;
      if (mode !== 'running') state.takeoverPending = false;
      render();
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
