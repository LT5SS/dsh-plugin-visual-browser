import path from 'node:path';
import type { Page } from 'playwright-core';
import type { BrowserSession } from '../driver/browser-session.js';
import type {
  MotionInspectResult,
  NavigationDiagnostic,
  Point2D,
  ScrollDiagnostic,
} from '../driver/types.js';
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

export interface DesignSnapshot {
  title: string;
  headings: Array<{ tag: string; text: string }>;
  headingsTotal: number;
  headingsError?: boolean;
  headingsNaReason?: '无 h1-h3' | '被裁切' | '可能在 canvas 内';
  sections: number[];
  sectionsTotal: number;
  sectionsError?: boolean;
  palette: { bg: string; text: string; accent: string } | null;
  canvasCoversViewport?: boolean;
  fonts: Array<{ family: string; weight: string; maxPx: number }>;
  fontsError?: boolean;
  cssVarsTotal: number;
  cssVarsSample: Array<{ name: string; value: string }>;
  cssVarsError?: boolean;
  layout: { grid: number; flex: number; fixed: number; sticky: number } | null;
  media: {
    img: number;
    video: number;
    canvas: number;
    svg: number;
    largest: {
      kind: string;
      width: number;
      height: number;
      objectFit?: string;
      canvasWidth?: number;
      canvasHeight?: number;
    } | null;
    largestCanvas?: { width: number; height: number } | null;
  } | null;
  motion: {
    transition: number;
    animation: number;
    willChange: number;
    reducedMotion: '支持' | '未检测到' | '未知';
  } | null;
  bodyText: string | null;
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
  navigation?: NavigationDiagnostic;
  scrollDiagnostic?: ScrollDiagnostic;
  motionInspect?: MotionInspectResult;
  snapshotGen?: number;
  design?: DesignSnapshot;
}

export const MAX_DESIGN_BLOCK_CHARS = 1200;

/**
 * Normalizes split-character animated text & repeated single-letter marquees while preserving
 * normal multi-character English words (e.g. "collaborate") and CJK prose intact.
 */
export function normSplit(raw: string): string {
  const t = String(raw || '').replace(/\s+/g, ' ').trim();
  const toks = t.split(' ').filter(Boolean);
  if (toks.length < 6) return t;
  const single = toks.filter((x) => x.length === 1).length;
  const foldRun = (run: string) => run.replace(/([A-Za-z])\1{1,}/g, '$1');

  if (single / toks.length >= 0.45) {
    let out = '';
    let buf = '';
    for (const tok of toks) {
      if (tok.length === 1) {
        buf += tok;
      } else {
        if (buf) {
          out += foldRun(buf) + ' ';
          buf = '';
        }
        out += tok + ' ';
      }
    }
    if (buf) out += foldRun(buf);
    return out.replace(/\s+/g, ' ').trim();
  }

  // Fallback for prose containing an embedded/trailing single-letter marquee run (>= 6 ASCII single-char tokens)
  const outParts: string[] = [];
  let i = 0;
  while (i < toks.length) {
    if (/^[A-Za-z]$/.test(toks[i])) {
      let j = i;
      while (j < toks.length && /^[A-Za-z]$/.test(toks[j])) {
        j++;
      }
      if (j - i >= 6) {
        outParts.push(foldRun(toks.slice(i, j).join('')));
        i = j;
        continue;
      }
    }
    outParts.push(toks[i]);
    i++;
  }
  return outParts.join(' ').replace(/\s+/g, ' ').trim();
}

export function formatDesignBlock(design?: DesignSnapshot): string {
  if (!design) return '';

  const titleLine = `- title: ${design.title || 'n/a'}`;

  let headingsDetail = 'n/a';
  if (!design.headingsError) {
    if (design.headings.length > 0) {
      const items = design.headings.map((h) => `${h.tag} "${h.text}"`).join(' | ');
      headingsDetail = `${items} (共 ${design.headingsTotal} 条，最多 5)`;
    } else if (design.headingsNaReason === '被裁切') {
      headingsDetail = 'n/a（标题被裁切）';
    } else if (design.headingsNaReason === '可能在 canvas 内') {
      headingsDetail = 'n/a（标题可能在 <canvas> 内）';
    } else {
      headingsDetail = 'n/a（视口内无 h1-h3）';
    }
  }

  let headingsCompact = 'n/a';
  if (!design.headingsError && design.headings.length > 0) {
    headingsCompact = design.headings
      .slice(0, 2)
      .map((h) => `${h.tag} "${h.text.slice(0, 24)}"`)
      .join(' | ');
  }

  const sectionsDetail = design.sectionsError
    ? 'n/a'
    : design.sectionsTotal === 0
      ? '0'
      : `${design.sectionsTotal} (y=${design.sections[0] ?? 0}${design.sections
          .slice(1)
          .map((y) => ` / ${y}`)
          .join('')})`;
  const sectionsCompact = design.sectionsError ? 'n/a' : `${design.sectionsTotal}`;

  const paletteDetail = !design.palette
    ? 'n/a'
    : design.canvasCoversViewport
      ? `⚠️ DOM 背景为 ${design.palette.bg}，但视口被 <canvas> 覆盖 → 实际视觉配色请以截图为依据`
      : `bg ${design.palette.bg} · text ${design.palette.text} · accent ${design.palette.accent}`;
  const paletteCompact = !design.palette
    ? 'n/a'
    : design.canvasCoversViewport
      ? `⚠️ DOM bg ${design.palette.bg} 被<canvas>覆盖，以截图为准`
      : `${design.palette.bg}/${design.palette.text}/${design.palette.accent}`;

  const fontsDetail =
    design.fontsError || design.fonts.length === 0
      ? 'n/a'
      : design.fonts
          .map((f) => `${f.family} ${f.weight} (max ${f.maxPx}px)`)
          .join(' | ');
  const fontsCompact =
    design.fontsError || design.fonts.length === 0
      ? 'n/a'
      : `${design.fonts[0].family} (${design.fonts[0].maxPx}px)`;

  const cssVarsDetail = design.cssVarsError
    ? 'n/a'
    : design.cssVarsTotal === 0
      ? '0 个'
      : `${design.cssVarsTotal} 个 · ${design.cssVarsSample
          .map((v) => `${v.name}:${v.value}`)
          .join('; ')}`;
  const cssVarsCompact = design.cssVarsError ? 'n/a' : `${design.cssVarsTotal} 个`;

  const layoutDetail = design.layout
    ? `grid×${design.layout.grid} · flex×${design.layout.flex} · fixed×${design.layout.fixed} · sticky×${design.layout.sticky}`
    : 'n/a';
  const layoutCompact = design.layout
    ? `g${design.layout.grid}/f${design.layout.flex}/fx${design.layout.fixed}/s${design.layout.sticky}`
    : 'n/a';

  let mediaDetail = 'n/a';
  let mediaCompact = 'n/a';
  if (design.media) {
    const base = `img ${design.media.img} · video ${design.media.video} · canvas ${design.media.canvas} · svg ${design.media.svg}`;
    mediaCompact = base;
    const extras: string[] = [];
    if (design.media.largest) {
      const l = design.media.largest;
      const fit = l.objectFit ? ` (${l.objectFit})` : '';
      const cDims =
        l.kind === 'canvas' && l.canvasWidth && l.canvasHeight
          ? ` [canvas ${l.canvasWidth}×${l.canvasHeight}]`
          : '';
      extras.push(`最大 ${l.width}×${l.height}${fit}${cDims}`);
    }
    if (
      design.media.canvas > 0 &&
      design.media.largestCanvas &&
      design.media.largest?.kind !== 'canvas'
    ) {
      extras.push(
        `canvas ${design.media.largestCanvas.width}×${design.media.largestCanvas.height}`
      );
    }
    mediaDetail = extras.length > 0 ? `${base} · ${extras.join(' · ')}` : base;
  }

  const motionDetail = design.motion
    ? `transition ${design.motion.transition} · animation ${design.motion.animation} · will-change ${design.motion.willChange} · reduced-motion ${design.motion.reducedMotion}`
    : 'n/a';
  const motionCompact = design.motion
    ? `t${design.motion.transition}/a${design.motion.animation}/wc${design.motion.willChange}/${design.motion.reducedMotion}`
    : 'n/a';

  const formatBody = (txt: string | null, limit?: number): string => {
    if (txt === null) return 'n/a';
    if (txt.length === 0) return '（几乎为空，主体可能在 <canvas> 内）';
    const clipped = limit !== undefined && txt.length > limit ? txt.slice(0, limit) : txt;
    if (txt.length < 20 || (Boolean(design.canvasCoversViewport) && txt.length < 40)) {
      return `"${clipped}" （几乎为空，主体可能在 <canvas> 内）`;
    }
    return `"${clipped}"`;
  };

  let curHeadings = headingsDetail;
  let curSections = sectionsDetail;
  let curPalette = paletteDetail;
  let curFonts = fontsDetail;
  let curCssVars = cssVarsDetail;
  let curLayout = layoutDetail;
  let curMedia = mediaDetail;
  let curMotion = motionDetail;
  let curBody = formatBody(design.bodyText);

  const buildBlock = () =>
    [
      '## Design',
      titleLine,
      `- headings: ${curHeadings}`,
      `- sections: ${curSections}`,
      `- palette: ${curPalette}`,
      `- fonts: ${curFonts}`,
      `- cssVars: ${curCssVars}`,
      `- layout: ${curLayout}`,
      `- media: ${curMedia}`,
      `- motion: ${curMotion}`,
      `- bodyText: ${curBody}`,
    ].join('\n');

  let out = buildBlock();
  if (out.length <= MAX_DESIGN_BLOCK_CHARS) return out;

  // Truncation priority (TASK-v1.4.0 §3): headings -> palette/fonts/cssVars -> sections -> media/motion/layout -> bodyText LAST
  curHeadings = headingsCompact;
  out = buildBlock();
  if (out.length <= MAX_DESIGN_BLOCK_CHARS) return out;

  curHeadings = design.headingsTotal > 0 ? `${design.headingsTotal} 条` : 'n/a';
  out = buildBlock();
  if (out.length <= MAX_DESIGN_BLOCK_CHARS) return out;

  curCssVars = cssVarsCompact;
  out = buildBlock();
  if (out.length <= MAX_DESIGN_BLOCK_CHARS) return out;

  curFonts = fontsCompact;
  curPalette = paletteCompact;
  out = buildBlock();
  if (out.length <= MAX_DESIGN_BLOCK_CHARS) return out;

  curSections = sectionsCompact;
  out = buildBlock();
  if (out.length <= MAX_DESIGN_BLOCK_CHARS) return out;

  curMedia = mediaCompact;
  curMotion = motionCompact;
  curLayout = layoutCompact;
  out = buildBlock();
  if (out.length <= MAX_DESIGN_BLOCK_CHARS) return out;

  if (design.bodyText !== null && design.bodyText.length > 0) {
    const withoutBodyLen = out.length - curBody.length;
    const avail = Math.max(0, MAX_DESIGN_BLOCK_CHARS - withoutBodyLen - 2);
    curBody = avail > 24 ? formatBody(design.bodyText, avail - 2) : `"${design.bodyText.slice(0, Math.max(0, avail - 2))}"`;
    out = buildBlock();
  }

  return out.length > MAX_DESIGN_BLOCK_CHARS ? out.slice(0, MAX_DESIGN_BLOCK_CHARS) : out;
}

export class PageSnapshotSampler {
  private session: BrowserSession;
  private outputDir: string;
  private stepCounter = 0;
  private snapshotGen = 0;

  constructor(session: BrowserSession, outputDir: string) {
    this.session = session;
    this.outputDir = outputDir;
  }

  public getOutputDir(): string {
    return this.outputDir;
  }

  public getNextStepNumber(): number {
    return this.stepCounter + 1;
  }

  public getSnapshotGen(): number {
    return this.snapshotGen;
  }

  public async captureSnapshot(tag = 'step'): Promise<PageObservation> {
    this.stepCounter++;
    this.snapshotGen++;
    const currentGen = this.snapshotGen;
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
      design: undefined as DesignSnapshot | undefined,
    };

    const extracted = await safeEvaluate(
      page,
      ({ gen }: { gen: number }) => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const sx = Math.round(window.scrollX);
      const sy = Math.round(window.scrollY);
      const sw = Math.max(document.documentElement.scrollWidth, document.body?.scrollWidth || 0, vw);
      const sh = Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight || 0, vh);
      const maxScroll = Math.max(1, sh - vh);
      const progress = Math.min(100, Math.max(0, Math.round((sy / maxScroll) * 100)));

      // Clear previous dsh-ref & generation attributes
      document.querySelectorAll('[data-dsh-ref]').forEach((el) => {
        el.removeAttribute('data-dsh-ref');
        el.removeAttribute('data-dsh-gen');
      });

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
        el.setAttribute('data-dsh-gen', String(gen));

        const explicitAria = el.getAttribute('aria-label')?.trim() || '';
        let visibleText = '';
        if (!explicitAria) {
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          const parts: string[] = [];
          let curNode = walker.nextNode();
          while (curNode) {
            const txtVal = curNode.nodeValue ? curNode.nodeValue.trim() : '';
            if (txtVal) {
              let nodeHidden = false;
              let curEl = curNode.parentElement;
              const clipBoxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];
              while (curEl) {
                if (curEl.getAttribute('aria-hidden') === 'true') {
                  nodeHidden = true;
                  break;
                }
                const ncs = window.getComputedStyle(curEl);
                if (
                  ncs.display === 'none' ||
                  ncs.visibility === 'hidden' ||
                  Number(ncs.opacity) < 0.05
                ) {
                  nodeHidden = true;
                  break;
                }
                const pr = curEl.getBoundingClientRect();
                if (pr.width < 1 || pr.height < 1) {
                  nodeHidden = true;
                  break;
                }
                if (
                  ncs.overflow === 'hidden' ||
                  ncs.overflow === 'clip' ||
                  ncs.overflowX === 'hidden' ||
                  ncs.overflowX === 'clip' ||
                  ncs.overflowY === 'hidden' ||
                  ncs.overflowY === 'clip'
                ) {
                  clipBoxes.push({ left: pr.left, right: pr.right, top: pr.top, bottom: pr.bottom });
                }
                if (curEl === el) break;
                curEl = curEl.parentElement;
              }
              if (!nodeHidden) {
                const range = document.createRange();
                range.selectNodeContents(curNode);
                const rr = range.getBoundingClientRect();
                if (rr.width < 0.5 || rr.height < 0.5) {
                  nodeHidden = true;
                } else {
                  for (let ci = 0; ci < clipBoxes.length; ci++) {
                    const cb = clipBoxes[ci];
                    if (
                      rr.right <= cb.left + 0.5 ||
                      rr.left >= cb.right - 0.5 ||
                      rr.bottom <= cb.top + 0.5 ||
                      rr.top >= cb.bottom - 0.5
                    ) {
                      nodeHidden = true;
                      break;
                    }
                  }
                }
              }
              if (!nodeHidden) {
                parts.push(txtVal);
              }
            }
            curNode = walker.nextNode();
          }
          visibleText = parts.join(' ').replace(/\s+/g, ' ').trim();
        }

        const rawText =
          explicitAria ||
          visibleText ||
          (el as HTMLElement).innerText ||
          el.getAttribute('placeholder') ||
          el.getAttribute('title') ||
          el.getAttribute('href') ||
          '';
        let normText = rawText.replace(/\s+/g, ' ').trim();
        if (normText) {
          const explicitRepeat = /^(.*?)\s*[×x]\s*(\d+)$/i.exec(normText);
          if (explicitRepeat && explicitRepeat[1].trim() && Number(explicitRepeat[2]) >= 2) {
            const unit = explicitRepeat[1].trim();
            const suffix = ` (×${explicitRepeat[2]})`;
            const maxUnit = Math.max(8, 56 - suffix.length);
            normText =
              (unit.length > maxUnit ? unit.slice(0, maxUnit).trimEnd() : unit) + suffix;
          } else {
            const words = normText.split(' ');
            let collapsed = '';
            if (words.length >= 2) {
              const half = Math.floor(words.length / 2);
              for (let unitLen = 1; unitLen <= half; unitLen++) {
                if (words.length % unitLen !== 0) continue;
                let allMatch = true;
                for (let wi = unitLen; wi < words.length; wi++) {
                  if (words[wi] !== words[wi % unitLen]) {
                    allMatch = false;
                    break;
                  }
                }
                if (allMatch) {
                  const repeatCount = words.length / unitLen;
                  const unitStr = words.slice(0, unitLen).join(' ');
                  const suffix = ` (×${repeatCount})`;
                  const maxUnit = Math.max(8, 56 - suffix.length);
                  collapsed =
                    (unitStr.length > maxUnit ? unitStr.slice(0, maxUnit).trimEnd() : unitStr) +
                    suffix;
                  break;
                }
              }
            } else if (normText.length >= 4) {
              const halfC = Math.floor(normText.length / 2);
              for (let cl = 2; cl <= halfC; cl++) {
                if (normText.length % cl !== 0) continue;
                const unitStr = normText.slice(0, cl);
                const repeatCount = normText.length / cl;
                if (unitStr.repeat(repeatCount) === normText) {
                  const suffix = ` (×${repeatCount})`;
                  const maxUnit = Math.max(8, 56 - suffix.length);
                  collapsed =
                    (unitStr.length > maxUnit ? unitStr.slice(0, maxUnit).trimEnd() : unitStr) +
                    suffix;
                  break;
                }
              }
            }
            if (collapsed) normText = collapsed;
          }
        }
        const cleanLabel = normText.slice(0, 56) || `<${el.tagName.toLowerCase()}>`;

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

      // Design System & Structural HUD Snapshot (TASK-v1.4.0; each collector isolated via try/catch; no named nested functions!)
      const vcRoot = document.getElementById('__dsh_vc_root__');

      let dTitle = '';
      try {
        dTitle = (document.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
      } catch {
        dTitle = '';
      }

      const dHeadings: Array<{ tag: string; text: string }> = [];
      let dHeadingsTotal = 0;
      let dHeadingsError = false;
      let clippedHeadingsCount = 0;
      try {
        const seenHeadings = new Set<string>();
        const hEls = document.querySelectorAll('h1, h2, h3');
        const hCap = Math.min(hEls.length, 1500);
        for (let hi = 0; hi < hCap; hi++) {
          const hEl = hEls[hi];
          if (vcRoot && vcRoot.contains(hEl)) continue;
          const hcs = window.getComputedStyle(hEl);
          if (hcs.display === 'none' || hcs.visibility === 'hidden' || Number(hcs.opacity) < 0.05) {
            continue;
          }
          if (
            hcs.clip === 'rect(0px, 0px, 0px, 0px)' ||
            hcs.clip === 'rect(0px 0px 0px 0px)' ||
            (hcs.clipPath && hcs.clipPath.includes('inset(50%'))
          ) {
            clippedHeadingsCount++;
            continue;
          }
          const hr = hEl.getBoundingClientRect();
          if (hr.width <= 0 || hr.height <= 0) continue;
          if (hr.width <= 1.5 && hr.height <= 1.5 && (hcs.overflow === 'hidden' || hcs.overflow === 'clip')) {
            clippedHeadingsCount++;
            continue;
          }
          if (hr.bottom <= 0 || hr.top >= vh || hr.right <= 0 || hr.left >= vw) continue;

          let headingClippedOut = false;
          let hParent = hEl.parentElement;
          while (hParent && hParent !== document.documentElement) {
            const hpcs = window.getComputedStyle(hParent);
            if (
              hpcs.overflow === 'hidden' ||
              hpcs.overflow === 'clip' ||
              hpcs.overflowX === 'hidden' ||
              hpcs.overflowX === 'clip' ||
              hpcs.overflowY === 'hidden' ||
              hpcs.overflowY === 'clip'
            ) {
              const hpr = hParent.getBoundingClientRect();
              if (
                hr.right <= hpr.left + 0.5 ||
                hr.left >= hpr.right - 0.5 ||
                hr.bottom <= hpr.top + 0.5 ||
                hr.top >= hpr.bottom - 0.5
              ) {
                headingClippedOut = true;
                break;
              }
            }
            if (hParent === document.body) break;
            hParent = hParent.parentElement;
          }
          if (headingClippedOut) {
            clippedHeadingsCount++;
            continue;
          }

          let hText = '';
          const charItems: Array<{ ch: string; top: number; left: number; right: number; width: number; height: number }> = [];
          const hLeaves = hEl.querySelectorAll('*');
          const leafCap = Math.min(hLeaves.length, 300);
          for (let li = 0; li < leafCap; li++) {
            const lEl = hLeaves[li];
            if (lEl.children.length > 0) continue;
            if (lEl.getAttribute('aria-hidden') === 'true') continue;
            const lText = (lEl.textContent || '').trim();
            if (lText.length !== 1) continue;
            const lcs = window.getComputedStyle(lEl);
            if (lcs.display === 'none' || lcs.visibility === 'hidden' || Number(lcs.opacity) < 0.05) {
              continue;
            }
            const lr = lEl.getBoundingClientRect();
            if (lr.width < 1 || lr.height < 1) continue;
            if (lr.bottom <= 0 || lr.top >= vh || lr.right <= 0 || lr.left >= vw) continue;
            let dup = false;
            for (let di = 0; di < charItems.length; di++) {
              const prevC = charItems[di];
              if (
                prevC.ch === lText &&
                Math.abs(prevC.left - lr.left) < 3 &&
                Math.abs(prevC.top - lr.top) < 3
              ) {
                dup = true;
                break;
              }
            }
            if (!dup) {
              charItems.push({
                ch: lText,
                top: lr.top,
                left: lr.left,
                right: lr.right,
                width: lr.width,
                height: lr.height,
              });
            }
          }

          if (charItems.length >= 4) {
            charItems.sort((a, b) => a.top - b.top || a.left - b.left);
            let minH = charItems[0].height;
            let sumW = 0;
            for (let ci = 0; ci < charItems.length; ci++) {
              if (charItems[ci].height < minH) minH = charItems[ci].height;
              sumW += charItems[ci].width;
            }
            const rowTol = Math.max(4, minH * 0.25);
            const avgW = sumW / charItems.length;
            const wordGap = Math.max(8, avgW * 0.45);
            const rows: Array<{ top: number; items: typeof charItems }> = [];
            for (let ci = 0; ci < charItems.length; ci++) {
              const item = charItems[ci];
              let placed = false;
              for (let ri = 0; ri < rows.length; ri++) {
                if (Math.abs(rows[ri].top - item.top) <= rowTol) {
                  rows[ri].items.push(item);
                  placed = true;
                  break;
                }
              }
              if (!placed) {
                rows.push({ top: item.top, items: [item] });
              }
            }
            rows.sort((a, b) => a.top - b.top);
            const rowStrings: string[] = [];
            for (let ri = 0; ri < rows.length; ri++) {
              const items = rows[ri].items;
              items.sort((a, b) => a.left - b.left);
              let lineStr = '';
              for (let ii = 0; ii < items.length; ii++) {
                if (ii > 0 && items[ii].left - items[ii - 1].right > wordGap) {
                  lineStr += ' ';
                }
                lineStr += items[ii].ch;
              }
              if (lineStr) rowStrings.push(lineStr);
            }
            hText = rowStrings.join(' ').replace(/\s+/g, ' ').trim();
            if (hcs.textTransform === 'uppercase') hText = hText.toUpperCase();
            else if (hcs.textTransform === 'lowercase') hText = hText.toLowerCase();
          } else {
            hText = ((hEl as HTMLElement).innerText || hEl.textContent || '')
              .replace(/\s+/g, ' ')
              .trim();
          }

          if (!hText) continue;
          const hTag = hEl.tagName.toLowerCase();
          const key = `${hTag}|${hText}`;
          if (seenHeadings.has(key)) continue;
          seenHeadings.add(key);
          dHeadingsTotal++;
          if (dHeadings.length < 5) {
            dHeadings.push({ tag: hTag, text: hText.slice(0, 60) });
          }
        }
      } catch {
        dHeadingsError = true;
      }

      const dSections: number[] = [];
      let dSectionsTotal = 0;
      let dSectionsError = false;
      try {
        const secEls = document.querySelectorAll('section, main > div[class*="section"], [data-section]');
        const secCap = Math.min(secEls.length, 1500);
        for (let si = 0; si < secCap; si++) {
          const sEl = secEls[si];
          if (vcRoot && vcRoot.contains(sEl)) continue;
          const scs = window.getComputedStyle(sEl);
          if (scs.display === 'none') continue;
          const sr = sEl.getBoundingClientRect();
          dSectionsTotal++;
          if (dSections.length < 6) {
            dSections.push(Math.round(sr.top + sy));
          }
        }
      } catch {
        dSectionsError = true;
      }

      let dPalette: { bg: string; text: string; accent: string } | null = null;
      try {
        const bodyEl = document.body;
        const bodyStyle = bodyEl ? window.getComputedStyle(bodyEl) : null;
        const rootCss = window.getComputedStyle(htmlEl);
        let bgHex = '#ffffff';
        let bgFound = false;
        const bgCandidates = [bodyStyle?.backgroundColor || '', rootCss.backgroundColor || ''];
        for (let bi = 0; bi < bgCandidates.length; bi++) {
          const rawC = bgCandidates[bi];
          const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+)(%?))?\s*\)/i.exec(rawC);
          if (!m) continue;
          const alphaRaw = m[4] !== undefined ? parseFloat(m[4]) : 1;
          const alpha = m[5] === '%' ? alphaRaw / 100 : alphaRaw;
          if (alpha < 0.05) continue;
          const r = Math.max(0, Math.min(255, Math.round(parseFloat(m[1]))));
          const g = Math.max(0, Math.min(255, Math.round(parseFloat(m[2]))));
          const b = Math.max(0, Math.min(255, Math.round(parseFloat(m[3]))));
          bgHex =
            '#' +
            r.toString(16).padStart(2, '0') +
            g.toString(16).padStart(2, '0') +
            b.toString(16).padStart(2, '0');
          bgFound = true;
          break;
        }
        if (!bgFound && bodyStyle?.backgroundColor) {
          bgHex = '#ffffff';
        }

        let textHex = '#000000';
        const textCandidates = [bodyStyle?.color || '', rootCss.color || ''];
        for (let ti = 0; ti < textCandidates.length; ti++) {
          const rawC = textCandidates[ti];
          const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+)(%?))?\s*\)/i.exec(rawC);
          if (!m) continue;
          const alphaRaw = m[4] !== undefined ? parseFloat(m[4]) : 1;
          const alpha = m[5] === '%' ? alphaRaw / 100 : alphaRaw;
          if (alpha < 0.05) continue;
          const r = Math.max(0, Math.min(255, Math.round(parseFloat(m[1]))));
          const g = Math.max(0, Math.min(255, Math.round(parseFloat(m[2]))));
          const b = Math.max(0, Math.min(255, Math.round(parseFloat(m[3]))));
          textHex =
            '#' +
            r.toString(16).padStart(2, '0') +
            g.toString(16).padStart(2, '0') +
            b.toString(16).padStart(2, '0');
          break;
        }

        let chromaticDiffBg = '';
        let chromaticAny = '';
        let nonBgNonText = '';
        let chromaticUaLink = '';
        const accentEls = document.querySelectorAll('a, button, [class*="accent"], [class*="primary"]');
        const accentCap = Math.min(accentEls.length, 200);
        for (let ai = 0; ai < accentCap; ai++) {
          const aEl = accentEls[ai];
          if (vcRoot && vcRoot.contains(aEl)) continue;
          const acs = window.getComputedStyle(aEl);
          if (acs.display === 'none' || acs.visibility === 'hidden' || Number(acs.opacity) < 0.05) {
            continue;
          }
          const ar = aEl.getBoundingClientRect();
          if (ar.width < 1 || ar.height < 1) continue;
          const colorPairs = [acs.backgroundColor, acs.color];
          for (let ci = 0; ci < colorPairs.length; ci++) {
            const rawC = colorPairs[ci];
            const m = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+)(%?))?\s*\)/i.exec(rawC);
            if (!m) continue;
            const alphaRaw = m[4] !== undefined ? parseFloat(m[4]) : 1;
            const alpha = m[5] === '%' ? alphaRaw / 100 : alphaRaw;
            if (alpha < 0.1) continue;
            const r = Math.max(0, Math.min(255, Math.round(parseFloat(m[1]))));
            const g = Math.max(0, Math.min(255, Math.round(parseFloat(m[2]))));
            const b = Math.max(0, Math.min(255, Math.round(parseFloat(m[3]))));
            const hex =
              '#' +
              r.toString(16).padStart(2, '0') +
              g.toString(16).padStart(2, '0') +
              b.toString(16).padStart(2, '0');
            const chroma = Math.max(r, g, b) - Math.min(r, g, b);
            const isUaLinkDefault =
              aEl.tagName === 'A' && ci === 1 && (hex === '#0000ee' || hex === '#551a8b');
            if (isUaLinkDefault) {
              if (!chromaticUaLink) chromaticUaLink = hex;
            } else if (chroma >= 18) {
              if (!chromaticDiffBg && hex !== bgHex) chromaticDiffBg = hex;
              if (!chromaticAny) chromaticAny = hex;
            } else if (!nonBgNonText && hex !== bgHex && hex !== textHex) {
              nonBgNonText = hex;
            }
          }
          if (chromaticDiffBg) break;
        }
        const accentHex =
          chromaticDiffBg || chromaticAny || nonBgNonText || chromaticUaLink || textHex;
        dPalette = { bg: bgHex, text: textHex, accent: accentHex };
      } catch {
        dPalette = null;
      }

      const dFonts: Array<{ family: string; weight: string; maxPx: number }> = [];
      let dFontsError = false;
      try {
        const fontMap = new Map<string, { family: string; weight: string; maxPx: number }>();
        const fontEls = document.querySelectorAll('h1, h2, h3, p, a, button, span');
        const fontCap = Math.min(fontEls.length, 1500);
        for (let fi = 0; fi < fontCap; fi++) {
          const fEl = fontEls[fi];
          if (vcRoot && vcRoot.contains(fEl)) continue;
          if (!(fEl.textContent || '').trim()) continue;
          const fcs = window.getComputedStyle(fEl);
          if (fcs.display === 'none' || fcs.visibility === 'hidden' || Number(fcs.opacity) < 0.05) {
            continue;
          }
          const fr = fEl.getBoundingClientRect();
          if (fr.width < 1 || fr.height < 1) continue;
          if (fr.bottom < 0 || fr.top > vh || fr.right < 0 || fr.left > vw) continue;
          const firstFamily = (fcs.fontFamily.split(',')[0] || 'sans-serif')
            .trim()
            .replace(/^["']|["']$/g, '');
          const weight = String(fcs.fontWeight || '400');
          const px = Math.round(parseFloat(fcs.fontSize) || 0);
          if (px <= 0) continue;
          const fKey = `${firstFamily}|${weight}`;
          const prev = fontMap.get(fKey);
          if (!prev || px > prev.maxPx) {
            fontMap.set(fKey, { family: firstFamily, weight, maxPx: px });
          }
        }
        const sortedFonts = Array.from(fontMap.values()).sort((a, b) => b.maxPx - a.maxPx);
        for (let i = 0; i < Math.min(3, sortedFonts.length); i++) {
          dFonts.push(sortedFonts[i]);
        }
      } catch {
        dFontsError = true;
      }

      let dCssVarsTotal = 0;
      const dCssVarsSample: Array<{ name: string; value: string }> = [];
      let dCssVarsError = false;
      try {
        const rootStyle = window.getComputedStyle(htmlEl);
        const seenVars = new Set<string>();
        for (let vi = 0; vi < rootStyle.length; vi++) {
          const propName = rootStyle[vi];
          if (!propName || !propName.startsWith('--')) continue;
          if (seenVars.has(propName)) continue;
          const val = rootStyle.getPropertyValue(propName).trim();
          if (!val) continue;
          seenVars.add(propName);
          dCssVarsTotal++;
          if (dCssVarsSample.length < 5) {
            dCssVarsSample.push({ name: propName, value: val.slice(0, 40) });
          }
        }
        if (dCssVarsTotal === 0) {
          for (let shi = 0; shi < document.styleSheets.length; shi++) {
            try {
              const sheet = document.styleSheets[shi];
              const rules = sheet.cssRules;
              if (!rules) continue;
              for (let ri = 0; ri < rules.length; ri++) {
                const rule = rules[ri] as any;
                if (
                  rule &&
                  rule.style &&
                  typeof rule.selectorText === 'string' &&
                  /(?:^|,|\s)(?::root|html)(?:\s|,|$)/i.test(rule.selectorText)
                ) {
                  for (let ki = 0; ki < rule.style.length; ki++) {
                    const pName = rule.style[ki];
                    if (!pName || !pName.startsWith('--') || seenVars.has(pName)) continue;
                    const resolvedVal =
                      rootStyle.getPropertyValue(pName).trim() ||
                      String(rule.style.getPropertyValue(pName) || '').trim();
                    if (!resolvedVal) continue;
                    seenVars.add(pName);
                    dCssVarsTotal++;
                    if (dCssVarsSample.length < 5) {
                      dCssVarsSample.push({ name: pName, value: resolvedVal.slice(0, 40) });
                    }
                  }
                }
              }
            } catch {
              // Ignore cross-origin CSSStyleSheet access errors
            }
          }
        }
      } catch {
        dCssVarsError = true;
      }

      let dLayout: { grid: number; flex: number; fixed: number; sticky: number } | null = null;
      let dMotion: {
        transition: number;
        animation: number;
        willChange: number;
        reducedMotion: '支持' | '未检测到' | '未知';
      } | null = null;
      try {
        let gridC = 0;
        let flexC = 0;
        let fixedC = 0;
        let stickyC = 0;
        let transC = 0;
        let animC = 0;
        let wcC = 0;
        const allBodyEls = document.querySelectorAll('body *');
        const bodyCap = Math.min(allBodyEls.length, 1500);
        for (let bi = 0; bi < bodyCap; bi++) {
          const bEl = allBodyEls[bi];
          if (vcRoot && vcRoot.contains(bEl)) continue;
          const bcs = window.getComputedStyle(bEl);
          if (bcs.display === 'none' || bcs.visibility === 'hidden' || Number(bcs.opacity) < 0.05) {
            continue;
          }
          const br = bEl.getBoundingClientRect();
          if (br.width < 1 || br.height < 1) continue;
          if (br.bottom < 0 || br.top > vh || br.right < 0 || br.left > vw) continue;

          if (bcs.display === 'grid' || bcs.display === 'inline-grid') gridC++;
          else if (bcs.display === 'flex' || bcs.display === 'inline-flex') flexC++;
          if (bcs.position === 'fixed') fixedC++;
          else if (bcs.position === 'sticky') stickyC++;

          if (bcs.transitionProperty && bcs.transitionProperty !== 'none') {
            const durs = (bcs.transitionDuration || '').split(',');
            let hasDur = false;
            for (let di = 0; di < durs.length; di++) {
              if (parseFloat(durs[di]) > 0) {
                hasDur = true;
                break;
              }
            }
            if (hasDur) transC++;
          }
          if (bcs.animationName && bcs.animationName !== 'none') animC++;
          if (bcs.willChange && bcs.willChange !== 'auto') wcC++;
        }

        let reduced: '支持' | '未检测到' | '未知' = '未检测到';
        let hadSheetError = false;
        try {
          for (let shi = 0; shi < document.styleSheets.length; shi++) {
            try {
              const rules = document.styleSheets[shi].cssRules;
              if (!rules) continue;
              for (let ri = 0; ri < rules.length; ri++) {
                const rule = rules[ri] as any;
                if (rule && rule.type === 4) {
                  const cond = String(rule.conditionText || rule.media?.mediaText || '');
                  if (cond.includes('prefers-reduced-motion')) {
                    reduced = '支持';
                    break;
                  }
                }
              }
              if (reduced === '支持') break;
            } catch {
              hadSheetError = true;
            }
          }
          if (reduced !== '支持' && hadSheetError) {
            reduced = '未知';
          }
        } catch {
          reduced = '未知';
        }

        dLayout = { grid: gridC, flex: flexC, fixed: fixedC, sticky: stickyC };
        dMotion = { transition: transC, animation: animC, willChange: wcC, reducedMotion: reduced };
      } catch {
        dLayout = null;
        dMotion = null;
      }

      let dMedia: DesignSnapshot['media'] = null;
      try {
        const imgs = document.querySelectorAll('img');
        const videos = document.querySelectorAll('video');
        const canvases = document.querySelectorAll('canvas');
        const svgs = document.querySelectorAll(
          'svg:not(#__dsh_vc_svg__):not(#__dsh_vc_arrow_svg__)'
        );
        let imgCount = 0;
        let videoCount = 0;
        let canvasCount = 0;
        let svgCount = 0;
        let largest: NonNullable<DesignSnapshot['media']>['largest'] = null;
        let largestArea = 0;
        let largestCanvas: { width: number; height: number } | null = null;
        let largestCanvasArea = 0;

        for (let i = 0; i < Math.min(imgs.length, 1500); i++) {
          const mEl = imgs[i] as HTMLImageElement;
          if (vcRoot && vcRoot.contains(mEl)) continue;
          imgCount++;
          const mr = mEl.getBoundingClientRect();
          const rw = Math.round(mr.width);
          const rh = Math.round(mr.height);
          const area = rw * rh;
          if (area > largestArea) {
            largestArea = area;
            const fit = window.getComputedStyle(mEl).objectFit || 'fill';
            largest = { kind: 'img', width: rw, height: rh, objectFit: fit };
          }
        }
        for (let i = 0; i < Math.min(videos.length, 1500); i++) {
          const mEl = videos[i] as HTMLVideoElement;
          if (vcRoot && vcRoot.contains(mEl)) continue;
          videoCount++;
          const mr = mEl.getBoundingClientRect();
          const rw = Math.round(mr.width);
          const rh = Math.round(mr.height);
          const area = rw * rh;
          if (area > largestArea) {
            largestArea = area;
            const fit = window.getComputedStyle(mEl).objectFit || 'contain';
            largest = { kind: 'video', width: rw, height: rh, objectFit: fit };
          }
        }
        for (let i = 0; i < Math.min(canvases.length, 1500); i++) {
          const mEl = canvases[i] as HTMLCanvasElement;
          if (vcRoot && vcRoot.contains(mEl)) continue;
          canvasCount++;
          const mr = mEl.getBoundingClientRect();
          const rw = Math.round(mr.width);
          const rh = Math.round(mr.height);
          const cw = mEl.width || rw;
          const ch = mEl.height || rh;
          const cArea = Math.max(rw * rh, cw * ch);
          if (cArea > largestCanvasArea) {
            largestCanvasArea = cArea;
            largestCanvas = { width: cw, height: ch };
          }
          if (cArea > largestArea) {
            largestArea = cArea;
            largest = {
              kind: 'canvas',
              width: rw || cw,
              height: rh || ch,
              canvasWidth: cw,
              canvasHeight: ch,
            };
          }
        }
        for (let i = 0; i < Math.min(svgs.length, 1500); i++) {
          const mEl = svgs[i];
          if (vcRoot && vcRoot.contains(mEl)) continue;
          svgCount++;
          const mr = mEl.getBoundingClientRect();
          const rw = Math.round(mr.width);
          const rh = Math.round(mr.height);
          const area = rw * rh;
          if (area > largestArea) {
            largestArea = area;
            largest = { kind: 'svg', width: rw, height: rh };
          }
        }

        dMedia = {
          img: imgCount,
          video: videoCount,
          canvas: canvasCount,
          svg: svgCount,
          largest,
          largestCanvas,
        };
      } catch {
        dMedia = null;
      }

      let dBodyText: string | null = null;
      try {
        if (document.body) {
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          const textParts: string[] = [];
          let collectedChars = 0;
          let scannedNodes = 0;
          let prevTop = -9999;
          let prevRight = -9999;
          let prevContainer: Element | null = null;
          let prevRaw = '';
          let tNode = walker.nextNode();
          while (tNode && scannedNodes < 1500 && collectedChars < 900) {
            scannedNodes++;
            const rawVal = tNode.nodeValue || '';
            const val = rawVal.trim();
            if (val) {
              let hidden = false;
              let curParent = tNode.parentElement;
              const clipBoxes: Array<{ left: number; right: number; top: number; bottom: number }> = [];
              while (curParent) {
                const tagUp = curParent.tagName;
                if (
                  curParent.id === '__dsh_vc_root__' ||
                  tagUp === 'SCRIPT' ||
                  tagUp === 'STYLE' ||
                  tagUp === 'NOSCRIPT' ||
                  tagUp === 'TEMPLATE' ||
                  tagUp === 'SVG' ||
                  tagUp === 'CANVAS'
                ) {
                  hidden = true;
                  break;
                }
                if (curParent.getAttribute('aria-hidden') === 'true') {
                  hidden = true;
                  break;
                }
                const pcs = window.getComputedStyle(curParent);
                if (pcs.display === 'none' || pcs.visibility === 'hidden' || Number(pcs.opacity) < 0.05) {
                  hidden = true;
                  break;
                }
                if (
                  pcs.clip === 'rect(0px, 0px, 0px, 0px)' ||
                  pcs.clip === 'rect(0px 0px 0px 0px)' ||
                  (pcs.clipPath && pcs.clipPath.includes('inset(50%'))
                ) {
                  hidden = true;
                  break;
                }
                const pr = curParent.getBoundingClientRect();
                if (pr.width < 1 || pr.height < 1) {
                  hidden = true;
                  break;
                }
                if (
                  pr.width <= 1.5 &&
                  pr.height <= 1.5 &&
                  (pcs.overflow === 'hidden' || pcs.overflow === 'clip')
                ) {
                  hidden = true;
                  break;
                }
                if (
                  pcs.overflow === 'hidden' ||
                  pcs.overflow === 'clip' ||
                  pcs.overflowX === 'hidden' ||
                  pcs.overflowX === 'clip' ||
                  pcs.overflowY === 'hidden' ||
                  pcs.overflowY === 'clip'
                ) {
                  clipBoxes.push({ left: pr.left, right: pr.right, top: pr.top, bottom: pr.bottom });
                }
                if (curParent === document.body) break;
                curParent = curParent.parentElement;
              }
              let rr: DOMRect | null = null;
              if (!hidden) {
                const range = document.createRange();
                range.selectNodeContents(tNode);
                rr = range.getBoundingClientRect();
                if (
                  rr.width < 0.5 ||
                  rr.height < 0.5 ||
                  rr.bottom <= 0 ||
                  rr.top >= vh ||
                  rr.right <= 0 ||
                  rr.left >= vw
                ) {
                  hidden = true;
                } else {
                  for (let ci = 0; ci < clipBoxes.length; ci++) {
                    const cb = clipBoxes[ci];
                    if (
                      rr.right <= cb.left + 0.5 ||
                      rr.left >= cb.right - 0.5 ||
                      rr.bottom <= cb.top + 0.5 ||
                      rr.top >= cb.bottom - 0.5
                    ) {
                      hidden = true;
                      break;
                    }
                  }
                }
              }
              if (!hidden && rr) {
                const container =
                  tNode.parentElement?.closest(
                    'a,button,li,p,h1,h2,h3,h4,h5,h6,section,article,header,footer,nav,main'
                  ) ?? document.body;
                if (
                  textParts.length > 0 &&
                  container === prevContainer &&
                  Math.abs(rr.top - prevTop) < 6 &&
                  rr.left >= prevRight - 2 &&
                  rr.left <= prevRight + 2.5 &&
                  !/\s$/.test(prevRaw) &&
                  !/^\s/.test(rawVal)
                ) {
                  textParts[textParts.length - 1] += val;
                  collectedChars += val.length;
                } else {
                  textParts.push(val);
                  collectedChars += val.length + 1;
                }
                prevTop = rr.top;
                prevRight = rr.right;
                prevContainer = container;
                prevRaw = rawVal;
              }
            }
            tNode = walker.nextNode();
          }
          dBodyText = textParts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 900);
        } else {
          dBodyText = '';
        }
      } catch {
        dBodyText = null;
      }

      let dCanvasCoversViewport = false;
      try {
        const cvEls = document.querySelectorAll('canvas');
        const cvCap = Math.min(cvEls.length, 200);
        for (let ci = 0; ci < cvCap; ci++) {
          const cEl = cvEls[ci];
          if (vcRoot && vcRoot.contains(cEl)) continue;
          const ccs = window.getComputedStyle(cEl);
          if (ccs.display === 'none' || ccs.visibility === 'hidden' || Number(ccs.opacity) < 0.05) {
            continue;
          }
          const cr = cEl.getBoundingClientRect();
          const visW = Math.max(0, Math.min(cr.right, vw) - Math.max(cr.left, 0));
          const visH = Math.max(0, Math.min(cr.bottom, vh) - Math.max(cr.top, 0));
          if (visW >= vw * 0.9 && visH >= vh * 0.9) {
            dCanvasCoversViewport = true;
            break;
          }
        }
      } catch {
        dCanvasCoversViewport = false;
      }

      const dHeadingsNaReason: DesignSnapshot['headingsNaReason'] =
        !dHeadingsError && dHeadings.length === 0
          ? clippedHeadingsCount > 0
            ? '被裁切'
            : dCanvasCoversViewport
              ? '可能在 canvas 内'
              : '无 h1-h3'
          : undefined;

      const design: DesignSnapshot = {
        title: dTitle,
        headings: dHeadings,
        headingsTotal: dHeadingsTotal,
        ...(dHeadingsError ? { headingsError: true } : {}),
        ...(dHeadingsNaReason ? { headingsNaReason: dHeadingsNaReason } : {}),
        sections: dSections,
        sectionsTotal: dSectionsTotal,
        ...(dSectionsError ? { sectionsError: true } : {}),
        palette: dPalette,
        ...(dCanvasCoversViewport ? { canvasCoversViewport: true } : {}),
        fonts: dFonts,
        ...(dFontsError ? { fontsError: true } : {}),
        cssVarsTotal: dCssVarsTotal,
        cssVarsSample: dCssVarsSample,
        ...(dCssVarsError ? { cssVarsError: true } : {}),
        layout: dLayout,
        media: dMedia,
        motion: dMotion,
        bodyText: dBodyText,
      };

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
        design,
      };
    },
      fallbackExtracted,
      {
        arg: { gen: currentGen },
        retries: 2,
        onDegraded: () => {
          degradedReason = 'sampler degraded: navigation race';
        },
      }
    );

    if (extracted.design) {
      extracted.design.headings = extracted.design.headings.map((h) => ({
        tag: h.tag,
        text: normSplit(h.text).slice(0, 60),
      }));
      if (typeof extracted.design.bodyText === 'string') {
        extracted.design.bodyText = normSplit(extracted.design.bodyText).slice(0, 160);
      }
    }

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
      snapshotGen: currentGen,
      timestamp: new Date().toISOString(),
      screenshotPath,
      cursorPosition: syncedPos,
      scroll: extracted.scroll,
      domStats: extracted.domStats,
      interactiveElements: extracted.interactiveElements,
      health: this.session.telemetry.getHealthReport(),
      ...(degradedReason ? { degradedReason } : {}),
      ...(extracted.design ? { design: extracted.design } : {}),
    };
  }

  public formatObservationForLLM(obs: PageObservation): string {
    const {
      scroll,
      domStats,
      health,
      interactiveElements,
      cursorPosition,
      navigation,
      scrollDiagnostic,
      motionInspect,
    } = obs;
    const lines: string[] = [
      `### [Step ${obs.stepIndex}] Page Observation HUD`,
      ...(obs.degradedReason ? [`- **Notice**: ${obs.degradedReason}`] : []),
      `- **URL**: ${domStats.url} ("${domStats.title}")`,
      ...(navigation
        ? [
            `- **Navigation**: wait_until=${navigation.wait_until}, timed_out=${navigation.timed_out}, elapsed_ms=${navigation.elapsed_ms}, final_url=${navigation.final_url}` +
              (navigation.retries ? `, retries=${navigation.retries}` : ''),
          ]
        : []),
      `- **Screenshot**: ${obs.screenshotPath}`,
      `- **Virtual Cursor**: (${Math.round(cursorPosition.x)}, ${Math.round(cursorPosition.y)})`,
      `- **Scroll Progress**: ${scroll.scrollProgressPercent}% (Y: ${scroll.scrollY} / ${scroll.scrollHeight}px, Viewport: ${scroll.viewportWidth}x${scroll.viewportHeight})`,
      ...(scrollDiagnostic
        ? [
            `- **Scroll Result**: driver=${scrollDiagnostic.driver ?? 'wheel'}, attempted=${scrollDiagnostic.attempted}, effective_dom_delta=${scrollDiagnostic.effective_dom_delta}, dom_scrollable=${scrollDiagnostic.dom_scrollable}, visual_changed=${scrollDiagnostic.visual_changed}, at_boundary=${scrollDiagnostic.at_boundary}, locked=${scrollDiagnostic.locked}` +
              (scrollDiagnostic.programmatic_blocked_hint
                ? ` (${scrollDiagnostic.programmatic_blocked_hint})`
                : scrollDiagnostic.locked
                  ? ' (scroll locked — do not retry scroll; use clicks, drags, or nav links instead)'
                  : scrollDiagnostic.at_boundary
                    ? ' (reached scroll boundary)'
                    : !scrollDiagnostic.dom_scrollable && scrollDiagnostic.visual_changed
                      ? ' (native scrollbar fixed, but visual canvas/scene responded to wheel)'
                      : ''),
          ]
        : []),
      ...(motionInspect
        ? [
            `- **Motion Probe**: target=${motionInspect.target}, changed=[${motionInspect.changed.join(', ')}], animations=${motionInspect.animations}, triggers=[${motionInspect.triggers.join(', ')}]` +
              (Object.keys(motionInspect.delta).length > 0
                ? ` | delta=${JSON.stringify(motionInspect.delta).slice(0, 260)}`
                : ''),
          ]
        : []),
      `- **DOM & Tech**: canvas=${domStats.counts.canvas}, svg=${domStats.counts.svg}, video=${domStats.counts.video}, img=${domStats.counts.img}, section=${domStats.counts.section}, openDialogs=${domStats.counts.openDialogs} | Tech=[${domStats.detectedTechHints.join(', ')}] | htmlData=${JSON.stringify(domStats.htmlDataAttributes)}`,
      ...(domStats.counts.canvas > 0
        ? [
            `- **Canvas Notice**: tech: WebGL canvas — interactive content may live inside <canvas> and is not addressable by #ref`,
          ]
        : []),
      `- **Runtime Health**: ConsoleErrors=${health.consoleErrorsCount}, FailedRequests=${health.failedRequestsCount}/${health.totalRequests}`,
      ``,
      `#### Visible Interactive Controls (${interactiveElements.length} in viewport):`,
    ];

    if (interactiveElements.length === 0) {
      lines.push(
        `- Visible Interactive Controls: 0 个（滚动后站点可能隐藏了固定导航；不代表页面没有控件）`
      );
    }

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

    const designBlock = formatDesignBlock(obs.design);
    if (designBlock) {
      lines.push('', designBlock);
    }

    return lines.join('\n');
  }
}
