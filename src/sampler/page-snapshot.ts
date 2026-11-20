import path from 'node:path';
import type { Page } from 'playwright-core';
import type { BrowserSession } from '../driver/browser-session.js';
import type { Point2D } from '../driver/types.js';
import type { TelemetryHealthReport } from './telemetry-collector.js';

const NAVIGATION_RACE_PATTERN =
  /Execution context was destroyed|Cannot find context with specified id|most likely because of a navigation|Frame was detached|Target closed/i;

/** Returns true when a Playwright error stems from mid-evaluation navigation or frame detachment. */
export function isNavigationRaceError(error: unknown): boolean {
  const message = String((error as any)?.message ?? error);
  return NAVIGATION_RACE_PATTERN.test(message);
}

export type SafeEvaluatePage = Pick<Page, 'evaluate'> &
  Partial<Pick<Page, 'waitForLoadState' | 'waitForTimeout'>>;

/**
 * Runs `page.evaluate()` with automatic retries and fallback on navigation-race errors.
 * Non-navigation errors always rethrow immediately so real bugs are never masked.
 */
export async function safeEvaluate<T>(
  page: SafeEvaluatePage,
  fn: () => T,
  fallbackValue: T,
  retriesOrOptions?: number | { retries?: number; onDegraded?: (reason: string) => void }
): Promise<T>;
export async function safeEvaluate<T, Arg>(
  page: SafeEvaluatePage,
  fn: (arg: Arg) => T,
  fallbackValue: T,
  options: { arg: Arg; retries?: number; onDegraded?: (reason: string) => void }
): Promise<T>;
export async function safeEvaluate<T, Arg = undefined>(
  page: SafeEvaluatePage,
  fn: any,
  fallbackValue: T,
  retriesOrOptions?:
    | number
    | { retries?: number; arg?: Arg; onDegraded?: (reason: string) => void }
): Promise<T> {
  const isOpts = typeof retriesOrOptions === 'object' && retriesOrOptions !== null;
  const retries = isOpts ? (retriesOrOptions.retries ?? 2) : (retriesOrOptions ?? 2);
  const hasArg = isOpts && Object.prototype.hasOwnProperty.call(retriesOrOptions, 'arg');
  const arg = isOpts ? retriesOrOptions.arg : undefined;
  const onDegraded = isOpts ? retriesOrOptions.onDegraded : undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return hasArg
        ? await (page as any).evaluate(fn, arg)
        : await (page as any).evaluate(fn);
    } catch (error) {
      if (!isNavigationRaceError(error)) {
        throw error;
      }
      if (attempt === retries) {
        onDegraded?.(String((error as Error)?.message ?? error));
        return fallbackValue;
      }
      await page.waitForLoadState?.('domcontentloaded').catch(() => {});
      await page.waitForTimeout?.(150 + attempt * 200).catch(() => {});
    }
  }
  return fallbackValue;
}

export interface ScrollMetrics {
  scrollX: number;
  scrollY: number;
  scrollWidth: number;
  scrollHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  scrollProgressPercent: number;
}

export interface InteractiveElementNode {
  ref: string; // e.g. "#1", "#2"
  tag: string;
  role: string;
  label: string;
  selectorHint: string;
  center: Point2D;
  rect: { x: number; y: number; width: number; height: number };
  href?: string;
  value?: string;
  title?: string;
  ariaLabel?: string;
  alt?: string;
}

export interface DomTechStats {
  title: string;
  url: string;
  htmlClasses: string[];
  htmlDataAttributes: Record<string, string>;
  counts: {
    canvas: number;
    video: number;
    svg: number;
    img: number;
    section: number;
    article: number;
    button: number;
    a: number;
    openDialogs: number;
  };
  detectedTechHints: string[];
}

export interface PageObservation {
  stepIndex: number;
  timestamp: string;
  screenshotPath: string;
  cursorPosition: Point2D;
  scroll: ScrollMetrics;
  domStats: DomTechStats;
  interactiveElements: InteractiveElementNode[];
  health: TelemetryHealthReport;
  degradedReason?: string;
}

export class PageSnapshotSampler {
  private session: BrowserSession;
  private outputDir: string;
  private stepCounter = 0;

  constructor(session: BrowserSession, outputDir: string) {
    this.session = session;
    this.outputDir = outputDir;
  }

  public async captureSnapshot(tag = 'step'): Promise<PageObservation> {
    this.stepCounter++;
    const page = this.session.page;
    const safeTag = tag.replace(/[^a-zA-Z0-9_-]/g, '_');
    const filename = `step_${String(this.stepCounter).padStart(2, '0')}_${safeTag}.png`;
    const screenshotPath = path.join(this.outputDir, filename);

    // 1. Extract Scroll Metrics, DOM/Tech Stats, and stamp visible interactive elements with [data-dsh-ref]
    let degradedReason: string | undefined;
    const viewport = page.viewportSize?.() ?? { width: 1440, height: 900 };
    const safeUrl = (() => {
      try {
        return page.url();
      } catch {
        return 'about:blank';
      }
    })();
    const fallbackExtracted = {
      scroll: {
        scrollX: 0,
        scrollY: 0,
        scrollWidth: viewport.width,
        scrollHeight: viewport.height,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
        scrollProgressPercent: 0,
      },
      domStats: {
        title: '',
        url: safeUrl,
        htmlClasses: [] as string[],
        htmlDataAttributes: {} as Record<string, string>,
        counts: {
          canvas: 0,
          video: 0,
          svg: 0,
          img: 0,
          section: 0,
          article: 0,
          button: 0,
          a: 0,
          openDialogs: 0,
        },
        detectedTechHints: [] as string[],
      },
      interactiveElements: [] as InteractiveElementNode[],
      cursorState: null as Point2D | null,
    };

    const extracted = await safeEvaluate(
      page,
      () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const sx = Math.round(window.scrollX);
      const sy = Math.round(window.scrollY);
      const sw = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0, vw);
      const sh = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, vh);
      const maxScroll = Math.max(1, sh - vh);
      const progress = Math.min(100, Math.max(0, Math.round((sy / maxScroll) * 100)));

      // Clear previous dsh-ref attributes
      document.querySelectorAll('[data-dsh-ref]').forEach((el) => el.removeAttribute('data-dsh-ref'));

      const selectorQuery = [
        'a[href]',
        'area[href]',
        'button',
        'input',
        'select',
        'textarea',
        '[role="button"]',
        '[role="tab"]',
        'summary',
        '[data-essay]',
        '[data-set-cue]',
        '[data-highlight]',
      ].join(',');

      const candidates = Array.from(document.querySelectorAll(selectorQuery));
      const nodes: Array<{
        ref: string;
        tag: string;
        role: string;
        label: string;
        selectorHint: string;
        center: { x: number; y: number };
        rect: { x: number; y: number; width: number; height: number };
        href?: string;
        value?: string;
        title?: string;
        ariaLabel?: string;
        alt?: string;
      }> = [];

      let refIdx = 0;
      for (const el of candidates) {
        if (nodes.length >= 35) break;
        if (el.closest('#__dsh_vc_root__')) continue;
        const style = window.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) {
          continue;
        }
        const r = el.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) continue;
        // Must be at least partially within the current viewport
        if (r.bottom < 4 || r.top > vh - 4 || r.right < 4 || r.left > vw - 4) continue;

        refIdx++;
        const refId = `#${refIdx}`;
        el.setAttribute('data-dsh-ref', String(refIdx));

        const rawText =
          el.getAttribute('aria-label') ||
          (el as HTMLElement).innerText ||
          el.getAttribute('placeholder') ||
          el.getAttribute('title') ||
          el.getAttribute('href') ||
          '';
        const cleanLabel = rawText.replace(/\s+/g, ' ').trim().slice(0, 56) || `<${el.tagName.toLowerCase()}>`;

        let selectorHint = el.tagName.toLowerCase();
        if (el.id) {
          selectorHint += `#${el.id}`;
        } else if (el.className && typeof el.className === 'string') {
          const firstCls = el.className
            .trim()
            .split(/\s+/)
            .find((c) => c && !c.startsWith('is-'));
          if (firstCls) selectorHint += `.${firstCls}`;
        }

        const rawHref = el.getAttribute('href')?.trim();
        const href = rawHref ? rawHref.slice(0, 200) : undefined;
        const rawValue =
          'value' in el &&
          ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) &&
          (el as HTMLInputElement).type !== 'password' &&
          typeof (el as HTMLInputElement).value === 'string' &&
          (el as HTMLInputElement).value.length > 0
            ? (el as HTMLInputElement).value.slice(0, 80)
            : undefined;
        const title = el.getAttribute('title')?.trim().slice(0, 120) || undefined;
        const ariaLabel = el.getAttribute('aria-label')?.trim().slice(0, 120) || undefined;
        const alt = el.getAttribute('alt')?.trim().slice(0, 120) || undefined;

        nodes.push({
          ref: refId,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute('role') || el.tagName.toLowerCase(),
          label: cleanLabel,
          selectorHint,
          center: {
            x: Math.round(r.left + r.width * 0.5),
            y: Math.round(r.top + r.height * 0.5),
          },
          rect: {
            x: Math.round(r.left),
            y: Math.round(r.top),
            width: Math.round(r.width),
            height: Math.round(r.height),
          },
          ...(href ? { href } : {}),
          ...(rawValue !== undefined ? { value: rawValue } : {}),
          ...(title ? { title } : {}),
          ...(ariaLabel ? { ariaLabel } : {}),
          ...(alt ? { alt } : {}),
        });
      }

      const htmlEl = document.documentElement;
      const htmlData: Record<string, string> = {};
      for (const [k, v] of Object.entries(htmlEl.dataset)) {
        if (v !== undefined) htmlData[k] = v;
      }

      const techHints: string[] = [];
      if (htmlEl.classList.contains('lenis')) techHints.push('Lenis Smooth Scroll');
      if (document.querySelector('[class*="astro-"]')) techHints.push('Astro');
      if ((window as any).gsap || document.querySelector('[style*="translate"]')) techHints.push('GSAP / ScrollTrigger');
      if ((window as any).THREE) techHints.push('Three.js');
      if (document.querySelectorAll('canvas').length > 0) techHints.push('HTML5 Canvas 2D/WebGL');
      if (document.querySelectorAll('svg path').length > 25) techHints.push('High-Density SVG Animation');

      const vcState = (window as any).__dshCursorAPI?.getState?.();
      const cursorState =
        vcState && Number.isFinite(vcState.x) && Number.isFinite(vcState.y)
          ? { x: Math.round(vcState.x), y: Math.round(vcState.y) }
          : null;

      return {
        scroll: {
          scrollX: sx,
          scrollY: sy,
          scrollWidth: sw,
          scrollHeight: sh,
          viewportWidth: vw,
          viewportHeight: vh,
          scrollProgressPercent: progress,
        },
        domStats: {
          title: document.title,
          url: window.location.href,
          htmlClasses: Array.from(htmlEl.classList),
          htmlDataAttributes: htmlData,
          counts: {
            canvas: document.querySelectorAll('canvas').length,
            video: document.querySelectorAll('video').length,
            svg: document.querySelectorAll('svg:not(#__dsh_vc_svg__):not(#__dsh_vc_arrow_svg__)').length,
            img: document.querySelectorAll('img').length,
            section: document.querySelectorAll('section').length,
            article: document.querySelectorAll('article').length,
            button: document.querySelectorAll('button:not(#__dsh_vc_root__ button)').length,
            a: document.querySelectorAll('a:not(#__dsh_vc_root__ a)').length,
            openDialogs: document.querySelectorAll('dialog[open]').length,
          },
          detectedTechHints: techHints,
        },
        interactiveElements: nodes,
        cursorState,
      };
    },
      fallbackExtracted,
      {
        retries: 2,
        onDegraded: () => {
          degradedReason = 'sampler degraded: navigation race';
        },
      }
    );

    if (extracted.cursorState) {
      this.session.motion.setPosition?.(extracted.cursorState.x, extracted.cursorState.y);
    }

    // 2. Capture viewport screenshot with the Virtual Cursor HUD & Custom Trail
    try {
      await this.session.screenshot(screenshotPath);
    } catch (err) {
      if (!isNavigationRaceError(err)) throw err;
      degradedReason = 'sampler degraded: navigation race';
    }

    const syncedPos =
      extracted.cursorState ??
      (await this.session.motion.syncPositionFromPage?.()) ??
      this.session.motion.getPosition();

    return {
      stepIndex: this.stepCounter,
      timestamp: new Date().toISOString(),
      screenshotPath,
      cursorPosition: syncedPos,
      scroll: extracted.scroll,
      domStats: extracted.domStats,
      interactiveElements: extracted.interactiveElements,
      health: this.session.telemetry.getHealthReport(),
      ...(degradedReason ? { degradedReason } : {}),
    };
  }

  public formatObservationForLLM(obs: PageObservation): string {
    const { scroll, domStats, health, interactiveElements, cursorPosition } = obs;
    const lines: string[] = [
      `### [Step ${obs.stepIndex}] Page Observation HUD`,
      ...(obs.degradedReason ? [`- **Notice**: ${obs.degradedReason}`] : []),
      `- **URL**: ${domStats.url} ("${domStats.title}")`,
      `- **Screenshot**: ${obs.screenshotPath}`,
      `- **Virtual Cursor**: (${Math.round(cursorPosition.x)}, ${Math.round(cursorPosition.y)})`,
      `- **Scroll Progress**: ${scroll.scrollProgressPercent}% (Y: ${scroll.scrollY} / ${scroll.scrollHeight}px, Viewport: ${scroll.viewportWidth}x${scroll.viewportHeight})`,
      `- **DOM & Tech**: canvas=${domStats.counts.canvas}, svg=${domStats.counts.svg}, video=${domStats.counts.video}, img=${domStats.counts.img}, section=${domStats.counts.section}, openDialogs=${domStats.counts.openDialogs} | Tech=[${domStats.detectedTechHints.join(', ')}] | htmlData=${JSON.stringify(domStats.htmlDataAttributes)}`,
      `- **Runtime Health**: ConsoleErrors=${health.consoleErrorsCount}, FailedRequests=${health.failedRequestsCount}/${health.totalRequests}`,
      ``,
      `#### Visible Interactive Controls (${interactiveElements.length} in viewport):`,
    ];

    for (const el of interactiveElements.slice(0, 20)) {
      const attrs: string[] = [];
      if (el.href) attrs.push(`href=\`${el.href}\``);
      if (el.value !== undefined && el.value !== '') attrs.push(`value=${JSON.stringify(el.value)}`);
      if (el.title && el.title !== el.label) attrs.push(`title=${JSON.stringify(el.title)}`);
      if (el.alt && el.alt !== el.label) attrs.push(`alt=${JSON.stringify(el.alt)}`);
      const attrSuffix = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
      lines.push(
        `  - \`${el.ref}\` [${el.tag}] "${el.label}"${attrSuffix} @ (${el.center.x}, ${el.center.y}) (${el.selectorHint})`
      );
    }

    return lines.join('\n');
  }
}
