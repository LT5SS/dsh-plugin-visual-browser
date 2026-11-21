import path from 'node:path';
import type { BrowserSession } from '../driver/browser-session.js';
import type {
  ActionBlockedReason,
  NavigateWaitUntil,
  NavigationDiagnostic,
  Point2D,
  ScrollDiagnostic,
  VirtualCursorStyleConfig,
} from '../driver/types.js';
import { PageSnapshotSampler, safeEvaluate, type PageObservation } from '../sampler/page-snapshot.js';

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
    waitMs = 220
  ): Promise<AtomicToolResult> {
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
        return {
          scrollTop: Math.round(se ? se.scrollTop : window.scrollY || 0),
          scrollHeight,
          clientHeight,
          vw,
          vh,
          overflowHidden,
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

    await this.session.motion.smoothScroll(deltaY, 18, 380);
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
    const scrollDiag: ScrollDiagnostic = {
      attempted: Math.round(deltaY),
      effective_dom_delta: effectiveDomDelta,
      dom_scrollable: domScrollable,
      visual_changed: visualChanged,
      at_boundary: atBoundary,
      locked,
    };

    const observation = await this.sampler.captureSnapshot('scroll');
    observation.scrollDiagnostic = scrollDiag;
    return {
      ok: true,
      scroll: scrollDiag,
      action: `Scrolled by ${deltaY}px`,
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
