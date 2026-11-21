import path from 'node:path';
import type { BrowserSession } from '../driver/browser-session.js';
import type { Point2D, VirtualCursorStyleConfig } from '../driver/types.js';
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
  blocked?: 'PLUGIN_UI_LAYER';
  hit?: string;
  at?: Point2D;
  hint?: string;
  midFrame?: string;
  midFramePath?: string;
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

  public async navigate(url: string, waitMs = 800): Promise<AtomicToolResult> {
    await this.session.navigate(url, 'networkidle');
    if (waitMs > 0) await this.session.page.waitForTimeout(waitMs);
    const observation = await this.sampler.captureSnapshot('navigate');
    return {
      action: `Navigated to ${url}`,
      observation,
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
      await this.session.motion.hoverSelector(selector, { label: `HOVER ${target}` });
    } else {
      await this.session.motion.moveTo(target.x, target.y, { label: `HOVER (${target.x},${target.y})` });
    }
    const observation = await this.sampler.captureSnapshot('hover');
    return {
      action: `Hovered over ${typeof target === 'string' ? target : `(${target.x},${target.y})`}`,
      observation,
      llmSummary: this.sampler.formatObservationForLLM(observation),
    };
  }

  public async click(target: string | Point2D, waitMs = 240): Promise<AtomicToolResult> {
    const clickRes =
      typeof target === 'string'
        ? await this.session.motion.clickSelector(resolveTargetSelector(target), {
            label: `CLICK ${target}`,
          })
        : await this.session.motion.clickAt(target.x, target.y, {
            label: `CLICK (${target.x},${target.y})`,
          });

    if (!clickRes.ok && clickRes.blocked === 'PLUGIN_UI_LAYER') {
      const observation = await this.sampler.captureSnapshot('click_blocked');
      const refusalJson = JSON.stringify({
        ok: false,
        blocked: clickRes.blocked,
        at: clickRes.at,
        hit: clickRes.hit,
        hint: clickRes.hint,
      });
      return {
        ok: false,
        blocked: clickRes.blocked,
        hit: clickRes.hit,
        at: clickRes.at,
        hint: clickRes.hint,
        action: `Blocked click at (${Math.round(clickRes.at.x)},${Math.round(clickRes.at.y)}) by ${clickRes.blocked} (${clickRes.hit ?? 'overlay'})`,
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
    if (!focusRes.ok && focusRes.blocked === 'PLUGIN_UI_LAYER') {
      const observation = await this.sampler.captureSnapshot('type_blocked');
      const refusalJson = JSON.stringify({
        ok: false,
        blocked: focusRes.blocked,
        at: focusRes.at,
        hit: focusRes.hit,
        hint: focusRes.hint,
      });
      return {
        ok: false,
        blocked: focusRes.blocked,
        hit: focusRes.hit,
        at: focusRes.at,
        hint: focusRes.hint,
        action: `Blocked typeText focus at (${Math.round(focusRes.at.x)},${Math.round(focusRes.at.y)}) by ${focusRes.blocked} (${focusRes.hit ?? 'overlay'})`,
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
    const fromPt = await this.session.motion.resolvePoint(fromTarget);
    const toPt = await this.session.motion.resolvePoint(toTarget);

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
    await this.session.motion.smoothScroll(deltaY, 18, 380);
    if (waitMs > 0) await this.session.page.waitForTimeout(waitMs);
    const observation = await this.sampler.captureSnapshot('scroll');
    return {
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
