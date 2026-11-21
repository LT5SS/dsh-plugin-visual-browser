import type { Page } from 'playwright-core';
import type {
  ActionBlockedReason,
  ClickActionResult,
  ClickHitTestResult,
  DragActionResult,
  MotionOptions,
  Point2D,
  VirtualCursorStyleConfig,
} from './types.js';
import { buildVirtualCursorInitScript, resolveCursorStyle } from '../injected/virtual-cursor.js';
import { mergeCursorStyleConfig } from '../settings-store.js';
import { safeEvaluate } from '../sampler/page-snapshot.js';

export type TakeoverControlMode = 'running' | 'paused' | 'idle' | 'hidden';

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function cubicBezier(p0: Point2D, p1: Point2D, p2: Point2D, p3: Point2D, t: number): Point2D {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;

  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

export class HumanMotionController {
  private page: Page;
  private pos: Point2D = { x: 120, y: 120 };
  private cursorStyle: VirtualCursorStyleConfig;
  private showTakeoverControl: boolean;
  private takeoverMode: TakeoverControlMode;
  private shouldAbort?: () => boolean;
  private takeoverRole = '';
  private takeoverHotkey: string;
  private unloadGuardEnabled = false;

  constructor(
    page: Page,
    initialStyle: VirtualCursorStyleConfig = {},
    opts: {
      showTakeoverControl?: boolean;
      takeoverHotkey?: string;
      unloadGuard?: boolean;
      shouldAbort?: () => boolean;
    } = {}
  ) {
    this.page = page;
    this.cursorStyle = resolveCursorStyle(initialStyle);
    this.showTakeoverControl = Boolean(opts.showTakeoverControl);
    this.takeoverMode = this.showTakeoverControl ? 'running' : 'hidden';
    this.takeoverHotkey = typeof opts.takeoverHotkey === 'string' ? opts.takeoverHotkey : 'F8';
    this.unloadGuardEnabled = Boolean(opts.unloadGuard);
    this.shouldAbort = opts.shouldAbort;
  }

  public getPosition(): Point2D {
    return { ...this.pos };
  }

  public setPosition(x: number, y: number): void {
    if (Number.isFinite(x) && Number.isFinite(y)) {
      this.pos = { x, y };
    }
  }

  public resetPosition(x = 120, y = 120): void {
    this.pos = { x, y };
  }

  public async syncPositionFromPage(): Promise<Point2D> {
    const pagePos = await safeEvaluate<Point2D | null>(
      this.page,
      () => {
        const st = (window as any).__dshCursorAPI?.getState?.();
        if (st && Number.isFinite(st.x) && Number.isFinite(st.y)) {
          return { x: Math.round(st.x), y: Math.round(st.y) };
        }
        return null;
      },
      null,
      0
    ).catch(() => null);
    if (pagePos) {
      this.pos = pagePos;
    }
    return { ...this.pos };
  }

  public getCursorStyle(): VirtualCursorStyleConfig {
    return { ...this.cursorStyle };
  }

  public updateActiveStyleFromPage(style: VirtualCursorStyleConfig): void {
    if (style && typeof style === 'object') {
      this.cursorStyle = resolveCursorStyle(style);
    }
  }

  public isUnloadGuardEnabled(): boolean {
    return this.unloadGuardEnabled;
  }

  public async setUnloadGuard(on: boolean): Promise<void> {
    this.unloadGuardEnabled = Boolean(on);
    if (this.unloadGuardEnabled) {
      await this.ensureCursorHUD(false);
    }
    await safeEvaluate(
      this.page,
      (flag: boolean) => {
        (window as any).__dshCursorAPI?.setUnloadGuard?.(flag);
      },
      undefined,
      { arg: this.unloadGuardEnabled, retries: 0 }
    );
  }

  public async ensureCursorHUD(syncActiveState = false): Promise<void> {
    const resolvedStyle = resolveCursorStyle(this.cursorStyle);
    const initScript = buildVirtualCursorInitScript(resolvedStyle, {
      showTakeoverControl: this.showTakeoverControl,
      roleLabel: this.takeoverRole,
      takeoverHotkey: this.takeoverHotkey,
      unloadGuard: this.unloadGuardEnabled,
    });
    await safeEvaluate(
      this.page,
      (arg: {
        script: string;
        sync: boolean;
        style: VirtualCursorStyleConfig;
        hotkey: string;
        unloadGuard: boolean;
      }) => {
        if (!(window as any).__dshVirtualCursorInstalled) {
          (0, eval)(arg.script);
          return;
        }
        if (arg.sync && (window as any).__dshCursorAPI) {
          (window as any).__dshCursorAPI.setStyle?.(arg.style, { fromHost: true });
          (window as any).__dshCursorAPI.setTakeoverHotkey?.(arg.hotkey);
          (window as any).__dshCursorAPI.setUnloadGuard?.(arg.unloadGuard);
        }
      },
      undefined,
      {
        arg: {
          script: initScript,
          sync: syncActiveState,
          style: resolvedStyle,
          hotkey: this.takeoverHotkey,
          unloadGuard: this.unloadGuardEnabled,
        },
        retries: 1,
      }
    );
  }

  public async setTakeoverHotkey(hotkey: string): Promise<void> {
    this.takeoverHotkey = hotkey;
    await this.ensureCursorHUD(false);
    await safeEvaluate(
      this.page,
      (hk: string) => {
        (window as any).__dshCursorAPI?.setTakeoverHotkey?.(hk);
      },
      undefined,
      { arg: hotkey, retries: 0 }
    );
  }

  public async setTakeoverState(mode: TakeoverControlMode, roleLabel?: string): Promise<void> {
    if (typeof roleLabel === 'string') {
      this.takeoverRole = roleLabel;
    }
    this.takeoverMode = mode;
    this.showTakeoverControl = mode !== 'hidden';
    await this.ensureCursorHUD(false);
    await safeEvaluate(
      this.page,
      ({ m, role }: { m: TakeoverControlMode; role: string }) => {
        (window as any).__dshCursorAPI?.setTakeoverState(m, role);
      },
      undefined,
      { arg: { m: mode, role: this.takeoverRole }, retries: 0 }
    );
  }

  public async resetTakeoverRequest(): Promise<void> {
    await safeEvaluate(
      this.page,
      () => {
        (window as any).__dshCursorAPI?.resetTakeoverRequest();
      },
      undefined,
      0
    );
  }

  /**
   * Dynamically updates the virtual cursor & trail style (preset or custom colors/width/length/variant).
   */
  public async setCursorStyle(style: VirtualCursorStyleConfig): Promise<void> {
    this.cursorStyle = mergeCursorStyleConfig(this.cursorStyle, style);
    await this.ensureCursorHUD(false);
    await safeEvaluate(
      this.page,
      (cfg: VirtualCursorStyleConfig) => {
        (window as any).__dshCursorAPI?.setStyle(cfg, { fromHost: true });
      },
      undefined,
      { arg: this.cursorStyle, retries: 1 }
    );
  }

  public async clearTrail(): Promise<void> {
    await this.ensureCursorHUD();
    await safeEvaluate(
      this.page,
      () => {
        (window as any).__dshCursorAPI?.clearTrail();
      },
      undefined,
      1
    );
  }

  /**
   * Moves the virtual mouse along a cubic Bezier arc with human-like acceleration/deceleration.
   */
  public async moveTo(targetX: number, targetY: number, opts: MotionOptions = {}): Promise<Point2D> {
    await this.ensureCursorHUD();

    const steps = opts.steps ?? 24;
    const durationMs = opts.durationMs ?? 340;
    const curvature = opts.arcCurvature ?? 0.16;
    const label = opts.label ?? 'MOVE';

    const p0 = { ...this.pos };
    const p3 = { x: targetX, y: targetY };
    const dx = p3.x - p0.x;
    const dy = p3.y - p0.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 1) {
      await this.syncHUD(p3.x, p3.y, label);
      return p3;
    }

    const nx = -dy / dist;
    const ny = dx / dist;
    const arcOffset = dist * curvature;

    const p1: Point2D = {
      x: p0.x + dx * 0.3 + nx * arcOffset,
      y: p0.y + dy * 0.3 + ny * arcOffset,
    };
    const p2: Point2D = {
      x: p0.x + dx * 0.72 + nx * (arcOffset * 0.55),
      y: p0.y + dy * 0.72 + ny * (arcOffset * 0.55),
    };

    const stepDelay = Math.max(4, Math.round(durationMs / steps));

    for (let i = 1; i <= steps; i++) {
      if (this.shouldAbort?.()) break;
      const progress = easeInOutCubic(i / steps);
      const pt = cubicBezier(p0, p1, p2, p3, progress);
      this.pos = pt;

      await this.page.mouse.move(pt.x, pt.y);
      await this.syncHUD(pt.x, pt.y, i === steps ? label : 'MOVING');
      await this.page.waitForTimeout(stepDelay);
    }

    return { ...this.pos };
  }

  public async sweepPath(waypoints: Point2D[], opts: MotionOptions = {}): Promise<Point2D> {
    for (let i = 0; i < waypoints.length; i++) {
      if (this.shouldAbort?.()) break;
      const wp = waypoints[i];
      await this.moveTo(wp.x, wp.y, {
        steps: opts.steps ?? 16,
        durationMs: opts.durationMs ?? 200,
        arcCurvature: opts.arcCurvature ?? 0.12,
        label: opts.label ?? `SWEEP ${i + 1}/${waypoints.length}`,
      });
    }
    return { ...this.pos };
  }

  public async probeSelector(
    selector: string,
    timeoutMs?: number
  ): Promise<
    | { ok: true; center: Point2D; box: { x: number; y: number; width: number; height: number } }
    | { ok: false; blocked: ActionBlockedReason; hint: string }
  > {
    const isRef = /^\[data-dsh-ref="(\d+)"\]$/.test(selector.trim());
    const loc = this.page.locator(selector).first();
    let visible = await loc.isVisible().catch(() => false);

    if (!visible) {
      if (isRef) {
        return {
          ok: false,
          blocked: 'REF_STALE',
          hint: 'target not visible; page may have advanced — re-observe and pick another target',
        };
      }
      const waitBudget = Math.max(200, Math.min(8000, timeoutMs ?? 1200));
      visible = await loc
        .waitFor({ state: 'visible', timeout: waitBudget })
        .then(() => true)
        .catch(() => false);
      if (!visible) {
        return {
          ok: false,
          blocked: 'ELEMENT_NOT_FOUND',
          hint: `Target ${selector} not visible within ${waitBudget}ms`,
        };
      }
    }

    const box = await loc.boundingBox().catch(() => null);
    if (!box || box.width < 2 || box.height < 2) {
      return {
        ok: false,
        blocked: isRef ? 'REF_STALE' : 'ELEMENT_NOT_FOUND',
        hint: 'target boundingBox missing or collapsed (<2px); page may have advanced — re-observe and pick another target',
      };
    }

    const styleFresh = await safeEvaluate(
      this.page,
      (sel: string) => {
        const el = document.querySelector(sel) as HTMLElement | null;
        if (!el || !el.isConnected) return false;
        const cs = window.getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.05) {
          return false;
        }
        const r = el.getBoundingClientRect();
        return r.width >= 2 && r.height >= 2;
      },
      true,
      { arg: selector, retries: 0 }
    );
    if (!styleFresh) {
      return {
        ok: false,
        blocked: isRef ? 'REF_STALE' : 'ELEMENT_NOT_FOUND',
        hint: 'target became hidden/transparent before action; re-observe and pick another target',
      };
    }

    return {
      ok: true,
      center: {
        x: Math.round(box.x + box.width * 0.5),
        y: Math.round(box.y + box.height * 0.5),
      },
      box,
    };
  }

  public async hoverSelector(selector: string, opts: MotionOptions = {}): Promise<Point2D> {
    const probe = await this.probeSelector(selector, opts.timeoutMs ?? 1200);
    if (!probe.ok) {
      throw new Error(probe.hint);
    }
    return this.moveTo(probe.center.x, probe.center.y, {
      ...opts,
      label: opts.label ?? `HOVER ${selector}`,
    });
  }

  /**
   * Performs a Top-Layer-aware hit test at `(x, y)` before dispatching any real mouse click,
   * penetrating open Shadow DOM roots and same-origin iframes.
   */
  public async hitTestAt(x: number, y: number): Promise<ClickHitTestResult> {
    const fallback: ClickHitTestResult = {
      hitsPluginUi: false,
      topElement: 'unknown',
      stackTop: [],
    };
    return safeEvaluate<ClickHitTestResult, { px: number; py: number }>(
      this.page,
      ({ px, py }) => {
        const stack = document.elementsFromPoint(px, py);
        let inShadowRoot = false;
        let inIframe = false;
        let resolvedTop: Element | null = stack[0] ?? null;
        let depth = 0;

        while (resolvedTop && depth < 12) {
          depth++;
          if (resolvedTop.closest?.('#__dsh_vc_root__')) break;

          if ((resolvedTop as HTMLElement).shadowRoot) {
            const sr: ShadowRoot = (resolvedTop as HTMLElement).shadowRoot!;
            const innerEl = sr.elementFromPoint(px, py);
            const innerStack: Element[] =
              typeof (sr as any).elementsFromPoint === 'function'
                ? (sr as any).elementsFromPoint(px, py)
                : innerEl
                  ? [innerEl]
                  : [];
            let inner: Element | null = null;
            for (let i = 0; i < innerStack.length; i++) {
              if (innerStack[i] !== resolvedTop) {
                inner = innerStack[i];
                break;
              }
            }
            if (inner && inner !== resolvedTop) {
              inShadowRoot = true;
              resolvedTop = inner;
              continue;
            }
          }

          if (resolvedTop.tagName === 'IFRAME') {
            try {
              const iframe = resolvedTop as HTMLIFrameElement;
              const doc = iframe.contentDocument;
              if (doc) {
                const rect = iframe.getBoundingClientRect();
                const lx = px - rect.left;
                const ly = py - rect.top;
                const frameStack = doc.elementsFromPoint(lx, ly);
                if (frameStack[0]) {
                  inIframe = true;
                  resolvedTop = frameStack[0];
                  continue;
                }
              }
            } catch {
              // Cross-origin iframe cannot be inspected locally; stop descending safely.
            }
          }
          break;
        }

        const hitsPluginUi =
          Boolean(stack[0]?.closest?.('#__dsh_vc_root__')) ||
          Boolean(resolvedTop?.closest?.('#__dsh_vc_root__'));

        const stackTop: string[] = [];
        for (let i = 0; i < Math.min(stack.length, 5); i++) {
          const el = stack[i];
          const tag = el.tagName.toLowerCase();
          const idPart = el.id ? `#${el.id}` : '';
          let clsPart = '';
          if (!el.id && typeof el.className === 'string' && el.className.trim()) {
            const firstCls = el.className.trim().split(/\s+/)[0];
            if (firstCls) clsPart = `.${firstCls}`;
          }
          stackTop.push(`${tag}${idPart}${clsPart}`);
        }

        let topElement = 'none';
        if (resolvedTop) {
          if (resolvedTop.closest?.('#__dsh_vc_root__')) {
            const chain: string[] = [];
            let cur: Element | null = resolvedTop;
            while (cur) {
              const tag = cur.tagName.toLowerCase();
              const idPart = cur.id ? `#${cur.id}` : '';
              let clsPart = '';
              if (!cur.id && typeof cur.className === 'string' && cur.className.trim()) {
                const firstCls = cur.className.trim().split(/\s+/)[0];
                if (firstCls) clsPart = `.${firstCls}`;
              }
              chain.unshift(`${tag}${idPart}${clsPart}`);
              if (cur.id === '__dsh_vc_root__') break;
              cur = cur.parentElement;
            }
            topElement = chain.join(' > ');
          } else {
            const tag = resolvedTop.tagName.toLowerCase();
            const idPart = resolvedTop.id ? `#${resolvedTop.id}` : '';
            let clsPart = '';
            if (!resolvedTop.id && typeof resolvedTop.className === 'string' && resolvedTop.className.trim()) {
              const firstCls = resolvedTop.className.trim().split(/\s+/)[0];
              if (firstCls) clsPart = `.${firstCls}`;
            }
            topElement = `${tag}${idPart}${clsPart}`;
          }
        }

        return {
          hitsPluginUi,
          topElement,
          stackTop,
          ...(inShadowRoot ? { inShadowRoot: true } : {}),
          ...(inIframe ? { inIframe: true } : {}),
        };
      },
      fallback,
      { arg: { px: x, py: y }, retries: 1 }
    );
  }

  public async clickAt(x: number, y: number, opts: MotionOptions = {}): Promise<ClickActionResult> {
    await this.moveTo(x, y, { ...opts, label: opts.label ?? 'AIM' });
    const hit = await this.hitTestAt(x, y);
    if (hit.hitsPluginUi) {
      await this.syncHUD(x, y, 'BLOCKED · PLUGIN_UI_LAYER');
      return {
        ok: false,
        x: this.pos.x,
        y: this.pos.y,
        at: { x, y },
        blocked: 'PLUGIN_UI_LAYER',
        hit: hit.topElement,
        element: hit.topElement,
        hint: '该位置被工具 UI 覆盖，请滚动或用 #ref',
      };
    }

    await safeEvaluate(
      this.page,
      ({ px, py, lbl }: { px: number; py: number; lbl: string }) => {
        (window as any).__dshCursorAPI?.clickEffect(px, py, lbl);
      },
      undefined,
      { arg: { px: x, py: y, lbl: opts.label ?? 'CLICK' }, retries: 0 }
    );
    await this.page.mouse.click(x, y, { delay: 55 });
    await this.page.waitForTimeout(80);
    return {
      ok: true,
      x: this.pos.x,
      y: this.pos.y,
      at: { x, y },
      element: hit.topElement,
    };
  }

  public async clickSelector(selector: string, opts: MotionOptions = {}): Promise<ClickActionResult> {
    const probe = await this.probeSelector(selector, opts.timeoutMs);
    if (!probe.ok) {
      return {
        ok: false,
        x: this.pos.x,
        y: this.pos.y,
        at: { x: this.pos.x, y: this.pos.y },
        blocked: probe.blocked,
        hit: selector,
        hint: probe.hint,
      };
    }
    await this.moveTo(probe.center.x, probe.center.y, {
      ...opts,
      label: `AIM ${selector}`,
    });
    return this.clickAt(probe.center.x, probe.center.y, {
      ...opts,
      steps: 2,
      durationMs: 20,
      label: opts.label ?? `CLICK ${selector}`,
    });
  }

  public async resolveTargetPoint(
    target: string | Point2D,
    timeoutMs = 1200
  ): Promise<
    | { ok: true; point: Point2D }
    | { ok: false; blocked: ActionBlockedReason; hit: string; hint: string }
  > {
    if (typeof target !== 'string') {
      return { ok: true, point: { x: target.x, y: target.y } };
    }
    const probe = await this.probeSelector(target, timeoutMs);
    if (!probe.ok) {
      return { ok: false, blocked: probe.blocked, hit: target, hint: probe.hint };
    }
    return { ok: true, point: probe.center };
  }

  public async resolvePoint(target: string | Point2D): Promise<Point2D> {
    const res = await this.resolveTargetPoint(target, 1200);
    if (!res.ok) {
      throw new Error(`Cannot resolve boundingBox for target: ${String(target)} (${res.hint})`);
    }
    return res.point;
  }

  /**
   * Performs a physical mouse drag (`move(from)` -> `down()` -> Bezier interpolation -> `up()`),
   * rendering press-shrink, thickened reversed-gradient drag trail, origin anchor ring, and drop state.
   */
  public async drag(
    from: Point2D,
    to: Point2D,
    opts: MotionOptions & {
      signal?: AbortSignal;
      onPhase?: (phase: 'down' | 'dragging' | 'up') => Promise<void> | void;
    } = {}
  ): Promise<DragActionResult> {
    await this.ensureCursorHUD(false);
    await this.moveTo(from.x, from.y, {
      steps: 8,
      durationMs: 120,
      label: 'AIM DRAG',
    });

    const hit = await this.hitTestAt(from.x, from.y);
    if (hit.hitsPluginUi) {
      await this.syncHUD(from.x, from.y, 'BLOCKED · PLUGIN_UI_LAYER');
      return {
        ok: false,
        from,
        to,
        steps: 0,
        blocked: 'PLUGIN_UI_LAYER',
        hit: hit.topElement,
        at: from,
        hint: '该位置被工具 UI 覆盖，请滚动或用 #ref',
      };
    }

    const steps = Math.max(2, Math.round(opts.steps ?? 12));
    const durationMs = opts.durationMs ?? Math.max(220, steps * 22);
    const curvature = opts.arcCurvature ?? 0.08;
    const keepSelection = Boolean(opts.keepSelection);

    const p0: Point2D = { x: from.x, y: from.y };
    const p3: Point2D = { x: to.x, y: to.y };
    const dx = p3.x - p0.x;
    const dy = p3.y - p0.y;
    const dist = Math.hypot(dx, dy);
    const nx = dist > 0 ? -dy / dist : 0;
    const ny = dist > 0 ? dx / dist : 0;
    const arcOffset = dist * curvature;

    const p1: Point2D = {
      x: p0.x + dx * 0.3 + nx * arcOffset,
      y: p0.y + dy * 0.3 + ny * arcOffset,
    };
    const p2: Point2D = {
      x: p0.x + dx * 0.72 + nx * (arcOffset * 0.55),
      y: p0.y + dy * 0.72 + ny * (arcOffset * 0.55),
    };
    const stepDelay = Math.max(6, Math.round(durationMs / steps));
    const dragLabel = `DRAG (${Math.round(from.x)},${Math.round(from.y)}) → (${Math.round(to.x)},${Math.round(to.y)})`;

    let mouseIsDown = false;
    try {
      if (!keepSelection) {
        await safeEvaluate(
          this.page,
          () => {
            try {
              document.getElementById('__dsh_vc_drag_noselect__')?.remove();
              const styleEl = document.createElement('style');
              styleEl.id = '__dsh_vc_drag_noselect__';
              styleEl.textContent =
                'html,body,*{-webkit-user-select:none!important;user-select:none!important}';
              (document.head || document.documentElement)?.appendChild(styleEl);
            } catch {}
            try {
              if (!(window as any).__dshDragStartSaved) {
                (window as any).__dshPrevDragStart = document.ondragstart;
                (window as any).__dshDragStartSaved = true;
              }
              document.ondragstart = (e: DragEvent) => {
                e.preventDefault();
              };
            } catch {}
          },
          undefined,
          0
        ).catch(() => {});
      }

      await this.page.mouse.move(from.x, from.y);
      await this.page.mouse.down();
      mouseIsDown = true;
      this.pos = { x: from.x, y: from.y };

      await safeEvaluate(
        this.page,
        ({ px, py, lbl }: { px: number; py: number; lbl: string }) => {
          (window as any).__dshCursorAPI?.dragStart?.(px, py, lbl);
        },
        undefined,
        { arg: { px: from.x, py: from.y, lbl: dragLabel }, retries: 0 }
      );
      await opts.onPhase?.('down');

      let midPhaseEmitted = false;
      for (let i = 1; i <= steps; i++) {
        if (this.shouldAbort?.() || opts.signal?.aborted) break;
        const progress = easeInOutCubic(i / steps);
        const pt = cubicBezier(p0, p1, p2, p3, progress);
        this.pos = pt;

        await this.page.mouse.move(pt.x, pt.y);
        await safeEvaluate(
          this.page,
          ({ px, py, tx, ty }: { px: number; py: number; tx: number; ty: number }) => {
            (window as any).__dshCursorAPI?.dragMove?.(px, py, tx, ty);
          },
          undefined,
          { arg: { px: pt.x, py: pt.y, tx: to.x, ty: to.y }, retries: 0 }
        );
        if (!midPhaseEmitted && progress >= 0.5) {
          midPhaseEmitted = true;
          await opts.onPhase?.('dragging');
        }
        await this.page.waitForTimeout(stepDelay);
      }

      await this.page.mouse.up();
      mouseIsDown = false;
      const dropLabel = `DROP (${Math.round(this.pos.x)},${Math.round(this.pos.y)})`;
      await safeEvaluate(
        this.page,
        ({ px, py, lbl }: { px: number; py: number; lbl: string }) => {
          (window as any).__dshCursorAPI?.dragEnd?.(px, py, lbl);
        },
        undefined,
        { arg: { px: this.pos.x, py: this.pos.y, lbl: dropLabel }, retries: 0 }
      );
      await opts.onPhase?.('up');
      await this.page.waitForTimeout(80);

      return {
        ok: true,
        from: { ...from },
        to: { ...this.pos },
        steps,
      };
    } finally {
      if (mouseIsDown) {
        await this.page.mouse.up().catch(() => {});
      }
      await safeEvaluate(
        this.page,
        (shouldClearSelection: boolean) => {
          try {
            document.getElementById('__dsh_vc_drag_noselect__')?.remove();
          } catch {}
          try {
            if ((window as any).__dshDragStartSaved) {
              document.ondragstart = (window as any).__dshPrevDragStart ?? null;
              delete (window as any).__dshPrevDragStart;
              delete (window as any).__dshDragStartSaved;
            }
          } catch {}
          if (shouldClearSelection) {
            try {
              window.getSelection?.()?.removeAllRanges?.();
            } catch {}
          }
        },
        undefined,
        { arg: !keepSelection, retries: 0 }
      ).catch(() => {});
    }
  }

  public async smoothScroll(deltaY: number, frames = 16, durationMs = 360): Promise<void> {
    await this.ensureCursorHUD(false);
    const delay = Math.max(8, Math.round(durationMs / frames));
    let accumulated = 0;

    for (let i = 1; i <= frames; i++) {
      if (this.shouldAbort?.()) break;
      const targetNow = deltaY * easeInOutCubic(i / frames);
      const stepDelta = targetNow - accumulated;
      accumulated = targetNow;

      await this.page.mouse.wheel(0, stepDelta);
      const dirSign = deltaY >= 0 ? '+' : '';
      const scrollLabel = `SCROLL ${dirSign}${Math.round(accumulated)}px`;
      await safeEvaluate(
        this.page,
        ({ dy, lbl }: { dy: number; lbl: string }) => {
          (window as any).__dshCursorAPI?.scrollEffect?.(dy, lbl);
        },
        undefined,
        { arg: { dy: stepDelta || deltaY, lbl: scrollLabel }, retries: 0 }
      );
      await this.page.waitForTimeout(delay);
    }
  }

  private async syncHUD(x: number, y: number, label: string): Promise<void> {
    await safeEvaluate(
      this.page,
      ({ px, py, lbl }: { px: number; py: number; lbl: string }) => {
        (window as any).__dshCursorAPI?.update(px, py, lbl);
      },
      undefined,
      { arg: { px: x, py: y, lbl: label }, retries: 0 }
    );
  }
}
