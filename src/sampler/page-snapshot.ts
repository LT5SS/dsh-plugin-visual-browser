import path from 'node:path';
import type { BrowserSession } from '../driver/browser-session.js';
import type { Point2D } from '../driver/types.js';
import type { TelemetryHealthReport } from './telemetry-collector.js';

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
    const extracted = await page.evaluate(() => {
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
      }> = [];

      let refIdx = 0;
      for (const el of candidates) {
        if (nodes.length >= 35) break;
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
            button: document.querySelectorAll('button').length,
            a: document.querySelectorAll('a').length,
            openDialogs: document.querySelectorAll('dialog[open]').length,
          },
          detectedTechHints: techHints,
        },
        interactiveElements: nodes,
      };
    });

    // 2. Capture viewport screenshot with the Virtual Cursor HUD & Custom Trail
    await this.session.screenshot(screenshotPath);

    return {
      stepIndex: this.stepCounter,
      timestamp: new Date().toISOString(),
      screenshotPath,
      cursorPosition: this.session.motion.getPosition(),
      scroll: extracted.scroll,
      domStats: extracted.domStats,
      interactiveElements: extracted.interactiveElements,
      health: this.session.telemetry.getHealthReport(),
    };
  }

  public formatObservationForLLM(obs: PageObservation): string {
    const { scroll, domStats, health, interactiveElements, cursorPosition } = obs;
    const lines: string[] = [
      `### [Step ${obs.stepIndex}] Page Observation HUD`,
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
      lines.push(
        `  - \`${el.ref}\` [${el.tag}] "${el.label}" @ (${el.center.x}, ${el.center.y}) (${el.selectorHint})`
      );
    }

    return lines.join('\n');
  }
}
