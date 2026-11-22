import path from 'node:path';
import type { BrowserSession } from '../driver/browser-session.js';
import type {
  ActionBlockedReason,
  MotionInspectResult,
  MotionProbeState,
  NavigateWaitUntil,
  NavigationDiagnostic,
  Point2D,
  ScrollDiagnostic,
  VirtualCursorStyleConfig,
} from '../driver/types.js';
import { PageSnapshotSampler, safeEvaluate, type PageObservation } from '../sampler/page-snapshot.js';
import { computePatchMeanPixelDiff } from '../sampler/png-pixels.js';

export interface DomInspectSample {
  tag: string;
  text: string;
  classes: string;
  href?: string;
  value?: string;
  title?: string;
  alt?: string;
  computedStyle: Record<string, string>;
}

export interface DomInspectResult {
  count: number;
  samples: DomInspectSample[];
  degraded?: boolean;
  degradedReason?: string;
}

export interface AtomicToolResult {
  action: string;
  observation: PageObservation;
  llmSummary: string;
  ok?: boolean;
  blocked?: ActionBlockedReason;
  ref?: string;
  skipped?: boolean;
  hit?: string;
  at?: Point2D;
  hint?: string;
  midFrame?: string;
  midFramePath?: string;
  navigation?: NavigationDiagnostic;
  scroll?: ScrollDiagnostic;
  motion?: MotionInspectResult;
  extraData?: unknown;
}

/**
 * Normalizes a target string:
 * - "#4" (when matching a sampled ref ID) -> '[data-dsh-ref="4"]'
 * - Otherwise leaves CSS selector as-is
 */
export function resolveTargetSelector(target: string): string {
  const trimmed = target.trim();
  const refMatch = /^#?(\d+)$/.exec(trimmed);
  if (refMatch) {
    return `[data-dsh-ref="${refMatch[1]}"]`;
  }
  return trimmed;
}

export class AtomicBrowserToolset {
  public readonly session: BrowserSession;
  public readonly sampler: PageSnapshotSampler;

  constructor(session: BrowserSession, snapshotDir: string) {
    this.session = session;
    this.sampler = new PageSnapshotSampler(session, snapshotDir);
  }

  public async navigate(
    url: string,
    waitMs = 800,
    opts?: { waitUntil?: NavigateWaitUntil; timeoutMs?: number }
  ): Promise<AtomicToolResult> {
    const navigation = await this.session.navigate(
      url,
      opts?.waitUntil ?? 'domcontentloaded',
      opts?.timeoutMs ?? 30000
    );
    if (waitMs > 0) await this.session.page.waitForTimeout(waitMs);
    const observation = await this.sampler.captureSnapshot('navigate');
    observation.navigation = navigation;
    return {
      action: `Navigated to ${url}`,
      observation,
      navigation,
      llmSummary: this.sampler.formatObservationForLLM(observation),
    };
  }

  public async setCursorStyle(style: VirtualCursorStyleConfig): Promise< void > {
    await this.session.motion.setCursorStyle(style);
  }

  public async moveMouse(
    target: Point2D | Point2D[],
    label = 'MOVE'
  ): Promise<AtomicToolResult> {
    if (Array.isArray(target)) {
      await this.session.motion.sweepPath(target, { label });
    } else {
      await this.session.motion.moveTo(target.x, target.y, { label });
    }
    const observation = await this.sampler.captureSnapshot('move_mouse');
    return {
      action: `Moved virtual mouse (${label})`,
      observation,
      llmSummary: this.sampler.formatObservationForLLM(observation),
    };
  }

  public async hover(target: string | Point2D): Promise<AtomicToolResult> {
    if (typeof target === 'string') {
      const selector = resolveTargetSelector(target);
      const probe = await this.session.motion.resolveTargetPoint(selector, 1200);
      if (!probe.ok) {
        const observation = await this.sampler.captureSnapshot('hover_refused');
        const refusalJson = JSON.stringify({
          ok: false,
          blocked: probe.blocked,
          ref: target,
          hit: probe.hit,
          hint: probe.hint,
        });
        return {
          ok: false,
          blocked: probe.blocked,
          ref: target,
          hit: probe.hit,
          hint: probe.hint,
          action: `Hover target unavailable (${target}): ${probe.blocked}`,
          observation,
          llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
        };
      }
      await this.session.motion.moveTo(probe.point.x, probe.point.y, { label: `HOVER ${target}` });
    } else {
      await this.session.motion.moveTo(target.x, target.y, { label: `HOVER (${target.x},${target.y})` });
    }
    const observation = await this.sampler.captureSnapshot('hover');
    return {
      ok: true,
      action: `Hovered over ${typeof target === 'string' ? target : `(${target.x},${target.y})`}`,
      observation,
      llmSummary: this.sampler.formatObservationForLLM(observation),
    };
  }

  public async click(
    target: string | Point2D,
    waitMs = 240,
    opts?: { ifPresent?: boolean; timeoutMs?: number }
  ): Promise<AtomicToolResult> {
    const clickRes =
      typeof target === 'string'
        ? await this.session.motion.clickSelector(resolveTargetSelector(target), {
            label: `CLICK ${target}`,
            timeoutMs: opts?.timeoutMs,
          })
        : await this.session.motion.clickAt(target.x, target.y, {
            label: `CLICK (${target.x},${target.y})`,
          });

    if (!clickRes.ok && clickRes.blocked) {
      const targetLabel = typeof target === 'string' ? target : `(${target.x},${target.y})`;
      if (
        opts?.ifPresent &&
        (clickRes.blocked === 'REF_STALE' || clickRes.blocked === 'ELEMENT_NOT_FOUND')
      ) {
        const observation = await this.sampler.captureSnapshot('click_if_present_skipped');
        const skipInfo = JSON.stringify({
          ok: true,
          skipped: true,
          reason: clickRes.blocked,
          target: targetLabel,
        });
        return {
          ok: true,
          skipped: true,
          ...(typeof target === 'string' ? { ref: target } : {}),
          action: `Optional click skipped (${clickRes.blocked}): ${targetLabel} no longer present`,
          observation,
          llmSummary: `[OPTIONAL_CLICK_SKIPPED] ${skipInfo}\n\n${this.sampler.formatObservationForLLM(observation)}`,
        };
      }

      const observation = await this.sampler.captureSnapshot('click_blocked');
      const refusalJson = JSON.stringify({
        ok: false,
        blocked: clickRes.blocked,
        ...(typeof target === 'string' ? { ref: target } : {}),
        at: clickRes.at,
        hit: clickRes.hit,
        hint: clickRes.hint,
      });
      return {
        ok: false,
        blocked: clickRes.blocked,
        ...(typeof target === 'string' ? { ref: target } : {}),
        hit: clickRes.hit,
        at: clickRes.at,
        hint: clickRes.hint,
        action: `Blocked click (${targetLabel}) by ${clickRes.blocked} (${clickRes.hit ?? 'target'})`,
        observation,
        llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
      };
    }

    if (waitMs > 0) await this.session.page.waitForTimeout(waitMs);
    const observation = await this.sampler.captureSnapshot('click');
    return {
      ok: true,
      action: `Clicked ${typeof target === 'string' ? target : `(${target.x},${target.y})`}`,
      observation,
      llmSummary: this.sampler.formatObservationForLLM(observation),
    };
  }

  public async typeText(
    target: string,
    text: string,
    pressEnter = false
  ): Promise<AtomicToolResult> {
    const selector = resolveTargetSelector(target);
    const focusRes = await this.session.motion.clickSelector(selector, {
      label: `FOCUS ${target}`,
    });
    if (!focusRes.ok && focusRes.blocked) {
      const observation = await this.sampler.captureSnapshot('type_blocked');
      const refusalJson = JSON.stringify({
        ok: false,
        blocked: focusRes.blocked,
        ref: target,
        at: focusRes.at,
        hit: focusRes.hit,
        hint: focusRes.hint,
      });
      return {
        ok: false,
        blocked: focusRes.blocked,
        ref: target,
        hit: focusRes.hit,
        at: focusRes.at,
        hint: focusRes.hint,
        action: `Blocked typeText focus (${target}) by ${focusRes.blocked} (${focusRes.hit ?? 'target'})`,
        observation,
        llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
      };
    }

    await this.session.page.keyboard.type(text, { delay: 35 });
    if (pressEnter) {
      await this.session.page.keyboard.press('Enter');
    }
    await this.session.page.waitForTimeout(200);
    const observation = await this.sampler.captureSnapshot('type_text');
    return {
      ok: true,
      action: `Typed "${text}" into ${target}`,
      observation,
      llmSummary: this.sampler.formatObservationForLLM(observation),
    };
  }

  public async drag(
    from: string | Point2D,
    to: string | Point2D,
    steps = 12,
    waitMs = 200,
    opts?: {
      keepSelection?: boolean;
      signal?: AbortSignal;
      onPhase?: (phase: 'down' | 'dragging' | 'up') => Promise<void> | void;
    }
  ): Promise<AtomicToolResult> {
    const fromTarget = typeof from === 'string' ? resolveTargetSelector(from) : from;
    const toTarget = typeof to === 'string' ? resolveTargetSelector(to) : to;
    const fromResolved = await this.session.motion.resolveTargetPoint(fromTarget, 1200);
    if (!fromResolved.ok) {
      const observation = await this.sampler.captureSnapshot('drag_blocked');
      const refusalJson = JSON.stringify({
        ok: false,
        blocked: fromResolved.blocked,
        ...(typeof from === 'string' ? { ref: from } : {}),
        hit: fromResolved.hit,
        hint: fromResolved.hint,
      });
      return {
        ok: false,
        blocked: fromResolved.blocked,
        ...(typeof from === 'string' ? { ref: from } : {}),
        hit: fromResolved.hit,
        hint: fromResolved.hint,
        action: `Blocked drag origin (${String(from)}) by ${fromResolved.blocked}`,
        observation,
        llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
      };
    }
    const toResolved = await this.session.motion.resolveTargetPoint(toTarget, 1200);
    if (!toResolved.ok) {
      const observation = await this.sampler.captureSnapshot('drag_blocked');
      const refusalJson = JSON.stringify({
        ok: false,
        blocked: toResolved.blocked,
        ...(typeof to === 'string' ? { ref: to } : {}),
        hit: toResolved.hit,
        hint: toResolved.hint,
      });
      return {
        ok: false,
        blocked: toResolved.blocked,
        ...(typeof to === 'string' ? { ref: to } : {}),
        hit: toResolved.hit,
        hint: toResolved.hint,
        action: `Blocked drag destination (${String(to)}) by ${toResolved.blocked}`,
        observation,
        llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
      };
    }
    const fromPt = fromResolved.point;
    const toPt = toResolved.point;

    const midFilename = `step_${String(this.sampler.getNextStepNumber()).padStart(2, '0')}_drag_mid.png`;
    const midFullPath = path.join(this.sampler.getOutputDir(), midFilename);
    let capturedMidPath: string | undefined;
    let capturedMidFile: string | undefined;

    const dragRes = await this.session.motion.drag(fromPt, toPt, {
      steps,
      keepSelection: opts?.keepSelection,
      signal: opts?.signal,
      onPhase: async (phase) => {
        if (phase === 'dragging' && !capturedMidPath) {
          try {
            capturedMidPath = await this.session.screenshot(midFullPath);
            capturedMidFile = midFilename;
          } catch {
            // mid-drag evidence frame failure must never abort drag action
          }
        }
        await opts?.onPhase?.(phase);
      },
    });

    if (!dragRes.ok && dragRes.blocked === 'PLUGIN_UI_LAYER') {
      const observation = await this.sampler.captureSnapshot('drag_blocked');
      const refusalJson = JSON.stringify({
        ok: false,
        blocked: dragRes.blocked,
        at: dragRes.at,
        hit: dragRes.hit,
        hint: dragRes.hint,
      });
      return {
        ok: false,
        blocked: dragRes.blocked,
        hit: dragRes.hit,
        at: dragRes.at,
        hint: dragRes.hint,
        action: `Blocked drag start at (${Math.round(dragRes.at?.x ?? fromPt.x)},${Math.round(dragRes.at?.y ?? fromPt.y)}) by ${dragRes.blocked} (${dragRes.hit ?? 'overlay'})`,
        observation,
        llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
      };
    }

    if (waitMs > 0) await this.session.page.waitForTimeout(waitMs);
    const observation = await this.sampler.captureSnapshot('drag');
    return {
      ok: true,
      ...(capturedMidFile ? { midFrame: capturedMidFile, midFramePath: capturedMidPath } : {}),
      action: `Dragged from (${Math.round(fromPt.x)},${Math.round(fromPt.y)}) to (${Math.round(toPt.x)},${Math.round(toPt.y)})`,
      observation,
      llmSummary: this.sampler.formatObservationForLLM(observation),
    };
  }

  public async scroll(
    directionOrDelta: 'down' | 'up' | number = 'down',
    waitMs = 220,
    opts?: { driver?: 'wheel' | 'programmatic' }
  ): Promise<AtomicToolResult> {
    const driver: 'wheel' | 'programmatic' = opts?.driver ?? 'wheel';
    const deltaY =
      typeof directionOrDelta === 'number'
        ? directionOrDelta
        : directionOrDelta === 'down'
          ? 760
          : -760;

    const beforeState = await safeEvaluate(
      this.session.page,
      () => {
        const se = document.scrollingElement || document.documentElement || document.body;
        const vw = window.innerWidth || 1;
        const vh = window.innerHeight || 1;
        const csBody = document.body ? window.getComputedStyle(document.body) : null;
        const csHtml = window.getComputedStyle(document.documentElement);
        const scrollHeight = Math.round(se ? se.scrollHeight : document.documentElement.scrollHeight || vh);
        const clientHeight = Math.round(se ? se.clientHeight : vh);
        const overflowHidden =
          (csHtml.overflowY === 'hidden' && (!csBody || csBody.overflowY === 'hidden')) ||
          (csBody?.overflowY === 'hidden' && scrollHeight <= clientHeight + 2) ||
          (csHtml.overflowY === 'hidden' && scrollHeight <= clientHeight + 2);
        const hasLenisContainer = Boolean(
          document.documentElement.classList.contains('lenis') ||
            document.querySelector('[data-lenis-prevent], .lenis-smooth, .lenis') ||
            (window as any).lenis ||
            (window as any).Lenis
        );
        return {
          scrollTop: Math.round(se ? se.scrollTop : window.scrollY || 0),
          scrollHeight,
          clientHeight,
          vw,
          vh,
          overflowHidden,
          hasLenisContainer,
          url: window.location.href,
          textLen: (document.body?.innerText || '').trim().length,
        };
      },
      {
        scrollTop: 0,
        scrollHeight: 0,
        clientHeight: 0,
        vw: 1280,
        vh: 720,
        overflowHidden: false,
        hasLenisContainer: false,
        url: '',
        textLen: 0,
      },
      0
    );

    const cursorPos = this.session.motion.getPosition();
    const probeClip =
      beforeState.vw >= 320 && beforeState.vh >= 240
        ? {
            x:
              cursorPos.x > beforeState.vw * 0.5
                ? Math.max(16, Math.floor(beforeState.vw * 0.12))
                : Math.max(16, Math.floor(beforeState.vw * 0.56)),
            y: Math.max(56, Math.floor((beforeState.vh - Math.min(180, Math.floor(beforeState.vh * 0.35))) * 0.5)),
            width: Math.min(260, Math.floor(beforeState.vw * 0.35)),
            height: Math.min(180, Math.floor(beforeState.vh * 0.35)),
          }
        : null;
    const beforeProbe = probeClip
      ? await this.session.page
          .screenshot({ clip: probeClip, type: 'jpeg', quality: 65 })
          .catch(() => null)
      : null;

    if (driver === 'programmatic') {
      await safeEvaluate(
        this.session.page,
        (dy: number) => {
          window.scrollBy(0, dy);
        },
        undefined,
        { arg: deltaY, retries: 0 }
      );
    } else {
      await this.session.motion.smoothScroll(deltaY, 18, 380);
    }
    if (waitMs > 0) await this.session.page.waitForTimeout(waitMs);

    const afterState = await safeEvaluate(
      this.session.page,
      () => {
        const se = document.scrollingElement || document.documentElement || document.body;
        return {
          scrollTop: Math.round(se ? se.scrollTop : window.scrollY || 0),
          url: window.location.href,
          textLen: (document.body?.innerText || '').trim().length,
        };
      },
      { scrollTop: beforeState.scrollTop, url: beforeState.url, textLen: beforeState.textLen },
      0
    );

    const effectiveDomDelta = Math.round(afterState.scrollTop - beforeState.scrollTop);
    const domScrollable =
      beforeState.scrollHeight > beforeState.clientHeight + 2 && !beforeState.overflowHidden;
    const atBoundary =
      domScrollable &&
      ((deltaY > 0 && beforeState.scrollTop + beforeState.clientHeight >= beforeState.scrollHeight - 2) ||
        (deltaY < 0 && beforeState.scrollTop <= 2));

    let visualChanged =
      effectiveDomDelta !== 0 ||
      afterState.url !== beforeState.url ||
      afterState.textLen !== beforeState.textLen;
    if (!visualChanged && beforeProbe && probeClip) {
      const afterProbe = await this.session.page
        .screenshot({ clip: probeClip, type: 'jpeg', quality: 65 })
        .catch(() => null);
      if (afterProbe) {
        visualChanged = !beforeProbe.equals(afterProbe);
      }
    }

    const locked = effectiveDomDelta === 0 && !visualChanged && (!domScrollable || !atBoundary);
    const programmaticBlockedHint =
      driver === 'programmatic' &&
      effectiveDomDelta === 0 &&
      beforeState.hasLenisContainer &&
      !atBoundary
        ? '⚠️ 该页拦截程序化滚动（Lenis 类），请用 wheel/scroll 动作而非 window.scrollTo'
        : undefined;
    const scrollDiag: ScrollDiagnostic = {
      attempted: Math.round(deltaY),
      effective_dom_delta: effectiveDomDelta,
      dom_scrollable: domScrollable,
      visual_changed: visualChanged,
      at_boundary: atBoundary,
      locked,
      driver,
      ...(programmaticBlockedHint ? { programmatic_blocked_hint: programmaticBlockedHint } : {}),
    };

    const observation = await this.sampler.captureSnapshot('scroll');
    observation.scrollDiagnostic = scrollDiag;
    return {
      ok: true,
      scroll: scrollDiag,
      action: driver === 'programmatic' ? `Scrolled (programmatic) by ${deltaY}px` : `Scrolled by ${deltaY}px`,
      observation,
      llmSummary: this.sampler.formatObservationForLLM(observation),
    };
  }

  /**
   * Read-only pointer-driven motion probe (`inspect_motion`):
   * accepts either a CSS/#ref selector or viewport `{ x, y }` coordinate (including `<canvas>` regions).
   * Records DOM/computed-style deltas plus a cursor-hidden 32x32 PNG patch diff before & after hovering.
   */
  public async inspectMotion(target: string | Point2D, settleMs = 120): Promise<AtomicToolResult> {
    const targetLabel =
      typeof target === 'string'
        ? target.trim()
        : `(${Math.round(target.x)}, ${Math.round(target.y)})`;

    let pt: Point2D;
    let selector: string | null = null;
    if (typeof target === 'string') {
      selector = resolveTargetSelector(target);
      const probe = await this.session.motion.resolveTargetPoint(selector, 1200);
      if (!probe.ok) {
        const observation = await this.sampler.captureSnapshot('inspect_motion_refused');
        const motionFail: MotionInspectResult = {
          target: targetLabel,
          ok: false,
          blocked: probe.blocked,
          pixelChanged: false,
          cssChanged: [],
          changed: [],
          delta: {},
          animations: 0,
          triggers: [],
          hint: probe.hint,
        };
        observation.motionInspect = motionFail;
        const refusalJson = JSON.stringify({
          ok: false,
          blocked: probe.blocked,
          target: targetLabel,
          hint: probe.hint,
        });
        return {
          ok: false,
          blocked: probe.blocked,
          ...(/^#\d+$/.test(targetLabel) ? { ref: targetLabel } : {}),
          hit: probe.hit,
          hint: probe.hint,
          motion: motionFail,
          action: `Inspect motion skipped on ${targetLabel} (${probe.blocked ?? 'ELEMENT_NOT_FOUND'})`,
          observation,
          llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
        };
      }
      pt = probe.point;
    } else {
      pt = { x: Math.round(target.x), y: Math.round(target.y) };
    }

    // Clamp coordinate targets to viewport & inspect target bounds/topElement without bare page.evaluate
    const preInfo = await safeEvaluate<
      {
        vw: number;
        vh: number;
        clampedX: number;
        clampedY: number;
        left: number;
        top: number;
        right: number;
        bottom: number;
        hasRect: boolean;
        isLargeTarget: boolean;
        topElement?: string;
      },
      { sel: string | null; x: number; y: number }
    >(
      this.session.page,
      (arg: { sel: string | null; x: number; y: number }) => {
        const vw = Math.max(1, window.innerWidth || 1280);
        const vh = Math.max(1, window.innerHeight || 720);
        const cx = Math.max(0, Math.min(vw - 1, Math.round(arg.x)));
        const cy = Math.max(0, Math.min(vh - 1, Math.round(arg.y)));
        let el: Element | null = null;
        if (arg.sel) {
          el = document.querySelector(arg.sel);
        } else {
          const stack =
            typeof document.elementsFromPoint === 'function'
              ? document.elementsFromPoint(cx, cy)
              : [];
          for (let si = 0; si < stack.length; si++) {
            if (!stack[si].closest('#__dsh_vc_root__')) {
              el = stack[si];
              break;
            }
          }
          if (!el) {
            const single = document.elementFromPoint(cx, cy);
            if (single && !single.closest('#__dsh_vc_root__')) el = single;
          }
        }
        let topElement: string | undefined;
        if (el) {
          const tag = el.tagName.toUpperCase();
          if (el.id) {
            topElement = `${tag}#${el.id}`;
          } else if (el.className && typeof el.className === 'string') {
            const firstCls = el.className.trim().split(/\s+/).find((c) => c && !c.startsWith('is-'));
            topElement = firstCls ? `${tag}.${firstCls}` : tag;
          } else {
            topElement = tag;
          }
        }
        if (!el) {
          return {
            vw,
            vh,
            clampedX: cx,
            clampedY: cy,
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            hasRect: false,
            isLargeTarget: false,
            ...(topElement ? { topElement } : {}),
          };
        }
        const r = el.getBoundingClientRect();
        const isLargeTarget = r.width >= vw * 0.7 && r.height >= vh * 0.7;
        return {
          vw,
          vh,
          clampedX: cx,
          clampedY: cy,
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          hasRect: true,
          isLargeTarget,
          ...(topElement ? { topElement } : {}),
        };
      },
      {
        vw: 1280,
        vh: 720,
        clampedX: Math.max(0, pt.x),
        clampedY: Math.max(0, pt.y),
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        hasRect: false,
        isLargeTarget: false,
      },
      { arg: { sel: selector, x: pt.x, y: pt.y }, retries: 0 }
    );

    if (selector === null) {
      pt = { x: preInfo.clampedX, y: preInfo.clampedY };
    }

    // Ensure baseline is captured outside target hover area when cursor already rests near/inside it
    const curPos = this.session.motion.getPosition();
    if (preInfo.isLargeTarget) {
      if (Math.hypot(curPos.x - pt.x, curPos.y - pt.y) <= 48) {
        const outX =
          pt.x > preInfo.vw * 0.5
            ? Math.max(12, Math.round(preInfo.vw * 0.15))
            : Math.min(preInfo.vw - 12, Math.round(preInfo.vw * 0.85));
        const outY =
          pt.y > preInfo.vh * 0.5
            ? Math.max(12, Math.round(preInfo.vh * 0.15))
            : Math.min(preInfo.vh - 12, Math.round(preInfo.vh * 0.85));
        await this.session.motion.moveTo(outX, outY, { steps: 6, durationMs: 80, label: 'BASELINE' });
        await this.session.page.waitForTimeout(80);
      }
    } else if (
      preInfo.hasRect &&
      curPos.x >= preInfo.left - 2 &&
      curPos.x <= preInfo.right + 2 &&
      curPos.y >= preInfo.top - 2 &&
      curPos.y <= preInfo.bottom + 2
    ) {
      const outX =
        preInfo.left >= 24
          ? Math.max(4, Math.round(preInfo.left - 16))
          : Math.min(preInfo.vw - 4, Math.round(preInfo.right + 16));
      const outY =
        preInfo.top >= 24
          ? Math.max(4, Math.round(preInfo.top - 16))
          : Math.min(preInfo.vh - 4, Math.round(preInfo.bottom + 16));
      await this.session.motion.moveTo(outX, outY, { steps: 6, durationMs: 80, label: 'BASELINE' });
      await this.session.page.waitForTimeout(80);
    }

    const clipW = Math.min(32, Math.max(1, preInfo.vw));
    const clipH = Math.min(32, Math.max(1, preInfo.vh));
    const clipX = Math.max(0, Math.min(preInfo.vw - clipW, Math.round(pt.x - clipW / 2)));
    const clipY = Math.max(0, Math.min(preInfo.vh - clipH, Math.round(pt.y - clipH / 2)));

    const captureCleanPatch = async (): Promise<Buffer | null> => {
      const prevVis = await safeEvaluate<string | null>(
        this.session.page,
        () => {
          const root = document.getElementById('__dsh_vc_root__') as HTMLElement | null;
          if (!root) return null;
          const prev = root.style.visibility;
          root.style.visibility = 'hidden';
          return prev;
        },
        null,
        0
      );
      try {
        return await this.session.page
          .screenshot({
            clip: { x: clipX, y: clipY, width: clipW, height: clipH },
            type: 'png',
          })
          .catch(() => null);
      } finally {
        if (prevVis !== null) {
          await safeEvaluate(
            this.session.page,
            (v: string) => {
              const root = document.getElementById('__dsh_vc_root__') as HTMLElement | null;
              if (root) root.style.visibility = v;
            },
            undefined,
            { arg: prevVis, retries: 0 }
          ).catch(() => {});
        }
      }
    };

    const sampleProbe = async (): Promise<{ state: MotionProbeState | null; topElement?: string }> =>
      safeEvaluate<{ state: MotionProbeState | null; topElement?: string }, { sel: string | null; x: number; y: number }>(
        this.session.page,
        (arg: { sel: string | null; x: number; y: number }) => {
          let el: Element | null = null;
          if (arg.sel) {
            el = document.querySelector(arg.sel);
          } else {
            const stack =
              typeof document.elementsFromPoint === 'function'
                ? document.elementsFromPoint(arg.x, arg.y)
                : [];
            for (let si = 0; si < stack.length; si++) {
              if (!stack[si].closest('#__dsh_vc_root__')) {
                el = stack[si];
                break;
              }
            }
            if (!el) {
              const single = document.elementFromPoint(arg.x, arg.y);
              if (single && !single.closest('#__dsh_vc_root__')) el = single;
            }
          }
          if (!el) return { state: null };
          const tag = el.tagName.toUpperCase();
          let topElement = tag;
          if (el.id) {
            topElement = `${tag}#${el.id}`;
          } else if (el.className && typeof el.className === 'string') {
            const firstCls = el.className.trim().split(/\s+/).find((c) => c && !c.startsWith('is-'));
            if (firstCls) topElement = `${tag}.${firstCls}`;
          }
          const cs = window.getComputedStyle(el);
          const r = el.getBoundingClientRect();
          const se = document.scrollingElement || document.documentElement || document.body;
          let childTransform: string | undefined;
          const child = el.querySelector('img, video, svg, span, div');
          if (child) {
            childTransform = window.getComputedStyle(child).transform || 'none';
          }
          const anims = typeof (el as any).getAnimations === 'function' ? (el as any).getAnimations().length : 0;
          const subAnims =
            typeof (el as any).getAnimations === 'function'
              ? (el as any).getAnimations({ subtree: true }).length
              : 0;
          return {
            topElement,
            state: {
              transform: cs.transform || 'none',
              opacity: cs.opacity || '1',
              filter: cs.filter || 'none',
              color: cs.color || '',
              backgroundColor: cs.backgroundColor || '',
              borderColor: cs.borderColor || '',
              boxShadow: cs.boxShadow || 'none',
              scrollTop: Math.round(se ? se.scrollTop : window.scrollY || 0),
              rect: {
                x: Math.round(r.x * 10) / 10,
                y: Math.round(r.y * 10) / 10,
                width: Math.round(r.width * 10) / 10,
                height: Math.round(r.height * 10) / 10,
              },
              animations: anims,
              subtreeAnimations: subAnims,
              transitionDuration: cs.transitionDuration || '0s',
              animationName: cs.animationName || 'none',
              ...(childTransform !== undefined ? { childTransform } : {}),
            },
          };
        },
        { state: null },
        { arg: { sel: selector, x: pt.x, y: pt.y }, retries: 0 }
      );

    const beforeProbe = await sampleProbe();
    const beforePatch = await captureCleanPatch();
    await this.session.motion.moveTo(pt.x, pt.y, {
      steps: 10,
      durationMs: 140,
      label: 'INSPECT MOTION',
    });
    if (settleMs > 0) await this.session.page.waitForTimeout(settleMs);
    const afterProbe = await sampleProbe();
    const afterPatch = await captureCleanPatch();

    const before = beforeProbe.state;
    const after = afterProbe.state;
    const topElement = afterProbe.topElement ?? beforeProbe.topElement ?? preInfo.topElement;

    const changed: string[] = [];
    const delta: Record<string, { before: string | number; after: string | number }> = {};
    if (before && after) {
      const strKeys = [
        'transform',
        'opacity',
        'filter',
        'color',
        'backgroundColor',
        'borderColor',
        'boxShadow',
      ] as const;
      for (const k of strKeys) {
        if (before[k] !== after[k]) {
          changed.push(k);
          delta[k] = { before: before[k], after: after[k] };
        }
      }
      if (before.childTransform !== after.childTransform) {
        changed.push('child_transform');
        delta.child_transform = {
          before: before.childTransform ?? 'none',
          after: after.childTransform ?? 'none',
        };
      }
      if (before.scrollTop !== after.scrollTop) {
        changed.push('scrollTop');
        delta.scrollTop = { before: before.scrollTop, after: after.scrollTop };
      }
      for (const rk of ['x', 'y', 'width', 'height'] as const) {
        if (Math.abs(before.rect[rk] - after.rect[rk]) >= 0.5) {
          const name = `rect.${rk}`;
          changed.push(name);
          delta[name] = { before: before.rect[rk], after: after.rect[rk] };
        }
      }
    }

    const cssChanged = [...changed];
    const pixelDiffMean = beforePatch && afterPatch ? computePatchMeanPixelDiff(beforePatch, afterPatch) : null;
    const pixelChanged = pixelDiffMean !== null ? pixelDiffMean >= 0.5 : false;
    if (pixelChanged && pixelDiffMean !== null) {
      delta.pixel_diff_mean = { before: 0, after: pixelDiffMean };
    }

    const animCount = after ? Math.max(after.animations, after.subtreeAnimations) : 0;
    const triggers: string[] = [];
    if (after) {
      const hasTransDur = after.transitionDuration
        .split(',')
        .some((d) => parseFloat(d) > 0);
      if (changed.length > 0 && (hasTransDur || animCount > 0)) {
        triggers.push('hover-transition');
      }
      if (
        changed.includes('transform') ||
        changed.includes('child_transform') ||
        changed.includes('rect.width') ||
        changed.includes('rect.height')
      ) {
        triggers.push('pointer-transform');
      }
      if (
        (after.animationName && after.animationName !== 'none') ||
        (before && after.animations > before.animations)
      ) {
        triggers.push('css-animation');
      }
      if (changed.includes('scrollTop')) {
        triggers.push('scroll-coupled');
      }
      if (changed.length > 0 && triggers.length === 0) {
        triggers.push('hover-style-change');
      }
    }
    if (pixelChanged && changed.length === 0) {
      triggers.push('pointer-pixel-change');
    }

    const motionResult: MotionInspectResult = {
      target: targetLabel,
      ok: true,
      at: pt,
      ...(topElement ? { topElement } : {}),
      pixelChanged,
      ...(pixelDiffMean !== null ? { pixelDiffMean } : {}),
      cssChanged,
      changed,
      delta,
      animations: animCount,
      triggers,
      ...(before ? { before } : {}),
      ...(after ? { after } : {}),
    };

    const observation = await this.sampler.captureSnapshot('inspect_motion');
    observation.motionInspect = motionResult;
    return {
      ok: true,
      at: pt,
      motion: motionResult,
      action: `Inspected motion on ${targetLabel}: topElement=${topElement ?? 'none'}, pixelChanged=${pixelChanged}, cssChanged=[${cssChanged.join(', ')}], animations=${animCount}`,
      observation,
      llmSummary: this.sampler.formatObservationForLLM(observation),
    };
  }

  /**
   * Read-only DOM & computed style inspection query for the agent.
   * Uses `safeEvaluate()` to tolerate navigation races and expose link/input attributes.
   */
  public async inspectDom(selector: string): Promise<DomInspectResult> {
    const fallback: DomInspectResult = {
      count: 0,
      samples: [],
      degraded: true,
      degradedReason: 'inspectDom degraded: navigation race',
    };

    return safeEvaluate<DomInspectResult, string>(
      this.session.page,
      (sel: string): DomInspectResult => {
        const els = Array.from(document.querySelectorAll(sel));
        return {
          count: els.length,
          samples: els.slice(0, 5).map((el) => {
            const cs = window.getComputedStyle(el);
            const rawHref = el.getAttribute('href')?.trim();
            const href = rawHref ? rawHref.slice(0, 200) : undefined;
            const value =
              'value' in el &&
              ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) &&
              (el as HTMLInputElement).type !== 'password' &&
              typeof (el as HTMLInputElement).value === 'string' &&
              (el as HTMLInputElement).value.length > 0
                ? (el as HTMLInputElement).value.slice(0, 80)
                : undefined;
            const title = el.getAttribute('title')?.trim().slice(0, 120) || undefined;
            const alt = el.getAttribute('alt')?.trim().slice(0, 120) || undefined;

            return {
              tag: el.tagName.toLowerCase(),
              text: ((el as HTMLElement).innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
              classes: typeof el.className === 'string' ? el.className : '',
              ...(href ? { href } : {}),
              ...(value !== undefined ? { value } : {}),
              ...(title ? { title } : {}),
              ...(alt ? { alt } : {}),
              computedStyle: {
                color: cs.color,
                backgroundColor: cs.backgroundColor,
                fontFamily: cs.fontFamily,
                fontSize: cs.fontSize,
                position: cs.position,
                transform: cs.transform,
              },
            };
          }),
        };
      },
      fallback,
      { arg: selector, retries: 2 }
    );
  }
}
