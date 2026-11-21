import path from 'node:path';
const NAVIGATION_RACE_PATTERN = /Execution context was destroyed|Cannot find context with specified id|most likely because of a navigation|Frame was detached|Target closed/i;
/** Returns true when a Playwright error stems from mid-evaluation navigation or frame detachment. */
export function isNavigationRaceError(error) {
    const message = String(error?.message ?? error);
    return NAVIGATION_RACE_PATTERN.test(message);
}
export async function safeEvaluate(page, fn, fallbackValue, retriesOrOptions) {
    const isOpts = typeof retriesOrOptions === 'object' && retriesOrOptions !== null;
    const retries = isOpts ? (retriesOrOptions.retries ?? 2) : (retriesOrOptions ?? 2);
    const hasArg = isOpts && Object.prototype.hasOwnProperty.call(retriesOrOptions, 'arg');
    const arg = isOpts ? retriesOrOptions.arg : undefined;
    const onDegraded = isOpts ? retriesOrOptions.onDegraded : undefined;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return hasArg
                ? await page.evaluate(fn, arg)
                : await page.evaluate(fn);
        }
        catch (error) {
            if (!isNavigationRaceError(error)) {
                throw error;
            }
            if (attempt === retries) {
                onDegraded?.(String(error?.message ?? error));
                return fallbackValue;
            }
            await page.waitForLoadState?.('domcontentloaded').catch(() => { });
            await page.waitForTimeout?.(150 + attempt * 200).catch(() => { });
        }
    }
    return fallbackValue;
}
export class PageSnapshotSampler {
    session;
    outputDir;
    stepCounter = 0;
    snapshotGen = 0;
    constructor(session, outputDir) {
        this.session = session;
        this.outputDir = outputDir;
    }
    getOutputDir() {
        return this.outputDir;
    }
    getNextStepNumber() {
        return this.stepCounter + 1;
    }
    getSnapshotGen() {
        return this.snapshotGen;
    }
    async captureSnapshot(tag = 'step') {
        this.stepCounter++;
        this.snapshotGen++;
        const currentGen = this.snapshotGen;
        const page = this.session.page;
        const safeTag = tag.replace(/[^a-zA-Z0-9_-]/g, '_');
        const filename = `step_${String(this.stepCounter).padStart(2, '0')}_${safeTag}.png`;
        const screenshotPath = path.join(this.outputDir, filename);
        // 1. Extract Scroll Metrics, DOM/Tech Stats, and stamp visible interactive elements with [data-dsh-ref]
        let degradedReason;
        const viewport = page.viewportSize?.() ?? { width: 1440, height: 900 };
        const safeUrl = (() => {
            try {
                return page.url();
            }
            catch {
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
                htmlClasses: [],
                htmlDataAttributes: {},
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
                detectedTechHints: [],
            },
            interactiveElements: [],
            cursorState: null,
        };
        const extracted = await safeEvaluate(page, ({ gen }) => {
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
            const nodes = [];
            let refIdx = 0;
            for (const el of candidates) {
                if (nodes.length >= 35)
                    break;
                if (el.closest('#__dsh_vc_root__'))
                    continue;
                const style = window.getComputedStyle(el);
                if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) < 0.05) {
                    continue;
                }
                const r = el.getBoundingClientRect();
                if (r.width < 6 || r.height < 6)
                    continue;
                // Must be at least partially within the current viewport
                if (r.bottom < 4 || r.top > vh - 4 || r.right < 4 || r.left > vw - 4)
                    continue;
                refIdx++;
                const refId = `#${refIdx}`;
                el.setAttribute('data-dsh-ref', String(refIdx));
                el.setAttribute('data-dsh-gen', String(gen));
                const explicitAria = el.getAttribute('aria-label')?.trim() || '';
                let visibleText = '';
                if (!explicitAria) {
                    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
                    const parts = [];
                    let curNode = walker.nextNode();
                    while (curNode) {
                        const txtVal = curNode.nodeValue ? curNode.nodeValue.trim() : '';
                        if (txtVal) {
                            let nodeHidden = false;
                            let curEl = curNode.parentElement;
                            const clipBoxes = [];
                            while (curEl) {
                                if (curEl.getAttribute('aria-hidden') === 'true') {
                                    nodeHidden = true;
                                    break;
                                }
                                const ncs = window.getComputedStyle(curEl);
                                if (ncs.display === 'none' ||
                                    ncs.visibility === 'hidden' ||
                                    Number(ncs.opacity) < 0.05) {
                                    nodeHidden = true;
                                    break;
                                }
                                const pr = curEl.getBoundingClientRect();
                                if (pr.width < 1 || pr.height < 1) {
                                    nodeHidden = true;
                                    break;
                                }
                                if (ncs.overflow === 'hidden' ||
                                    ncs.overflow === 'clip' ||
                                    ncs.overflowX === 'hidden' ||
                                    ncs.overflowX === 'clip' ||
                                    ncs.overflowY === 'hidden' ||
                                    ncs.overflowY === 'clip') {
                                    clipBoxes.push({ left: pr.left, right: pr.right, top: pr.top, bottom: pr.bottom });
                                }
                                if (curEl === el)
                                    break;
                                curEl = curEl.parentElement;
                            }
                            if (!nodeHidden) {
                                const range = document.createRange();
                                range.selectNodeContents(curNode);
                                const rr = range.getBoundingClientRect();
                                if (rr.width < 0.5 || rr.height < 0.5) {
                                    nodeHidden = true;
                                }
                                else {
                                    for (let ci = 0; ci < clipBoxes.length; ci++) {
                                        const cb = clipBoxes[ci];
                                        if (rr.right <= cb.left + 0.5 ||
                                            rr.left >= cb.right - 0.5 ||
                                            rr.bottom <= cb.top + 0.5 ||
                                            rr.top >= cb.bottom - 0.5) {
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
                const rawText = explicitAria ||
                    visibleText ||
                    el.innerText ||
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
                    }
                    else {
                        const words = normText.split(' ');
                        let collapsed = '';
                        if (words.length >= 2) {
                            const half = Math.floor(words.length / 2);
                            for (let unitLen = 1; unitLen <= half; unitLen++) {
                                if (words.length % unitLen !== 0)
                                    continue;
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
                        }
                        else if (normText.length >= 4) {
                            const halfC = Math.floor(normText.length / 2);
                            for (let cl = 2; cl <= halfC; cl++) {
                                if (normText.length % cl !== 0)
                                    continue;
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
                        if (collapsed)
                            normText = collapsed;
                    }
                }
                const cleanLabel = normText.slice(0, 56) || `<${el.tagName.toLowerCase()}>`;
                let selectorHint = el.tagName.toLowerCase();
                if (el.id) {
                    selectorHint += `#${el.id}`;
                }
                else if (el.className && typeof el.className === 'string') {
                    const firstCls = el.className
                        .trim()
                        .split(/\s+/)
                        .find((c) => c && !c.startsWith('is-'));
                    if (firstCls)
                        selectorHint += `.${firstCls}`;
                }
                const rawHref = el.getAttribute('href')?.trim();
                const href = rawHref ? rawHref.slice(0, 200) : undefined;
                const rawValue = 'value' in el &&
                    ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) &&
                    el.type !== 'password' &&
                    typeof el.value === 'string' &&
                    el.value.length > 0
                    ? el.value.slice(0, 80)
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
            const htmlData = {};
            for (const [k, v] of Object.entries(htmlEl.dataset)) {
                if (v !== undefined)
                    htmlData[k] = v;
            }
            const techHints = [];
            if (htmlEl.classList.contains('lenis'))
                techHints.push('Lenis Smooth Scroll');
            if (document.querySelector('[class*="astro-"]'))
                techHints.push('Astro');
            if (window.gsap || document.querySelector('[style*="translate"]'))
                techHints.push('GSAP / ScrollTrigger');
            if (window.THREE)
                techHints.push('Three.js');
            if (document.querySelectorAll('canvas').length > 0)
                techHints.push('HTML5 Canvas 2D/WebGL');
            if (document.querySelectorAll('svg path').length > 25)
                techHints.push('High-Density SVG Animation');
            const vcState = window.__dshCursorAPI?.getState?.();
            const cursorState = vcState && Number.isFinite(vcState.x) && Number.isFinite(vcState.y)
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
        }, fallbackExtracted, {
            arg: { gen: currentGen },
            retries: 2,
            onDegraded: () => {
                degradedReason = 'sampler degraded: navigation race';
            },
        });
        if (extracted.cursorState) {
            this.session.motion.setPosition?.(extracted.cursorState.x, extracted.cursorState.y);
        }
        // 2. Capture viewport screenshot with the Virtual Cursor HUD & Custom Trail
        try {
            await this.session.screenshot(screenshotPath);
        }
        catch (err) {
            if (!isNavigationRaceError(err))
                throw err;
            degradedReason = 'sampler degraded: navigation race';
        }
        const syncedPos = extracted.cursorState ??
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
        };
    }
    formatObservationForLLM(obs) {
        const { scroll, domStats, health, interactiveElements, cursorPosition, navigation, scrollDiagnostic } = obs;
        const lines = [
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
                    `- **Scroll Result**: attempted=${scrollDiagnostic.attempted}, effective_dom_delta=${scrollDiagnostic.effective_dom_delta}, dom_scrollable=${scrollDiagnostic.dom_scrollable}, visual_changed=${scrollDiagnostic.visual_changed}, at_boundary=${scrollDiagnostic.at_boundary}, locked=${scrollDiagnostic.locked}` +
                        (scrollDiagnostic.locked
                            ? ' (scroll locked — do not retry scroll; use clicks, drags, or nav links instead)'
                            : scrollDiagnostic.at_boundary
                                ? ' (reached scroll boundary)'
                                : !scrollDiagnostic.dom_scrollable && scrollDiagnostic.visual_changed
                                    ? ' (native scrollbar fixed, but visual canvas/scene responded to wheel)'
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
        for (const el of interactiveElements.slice(0, 20)) {
            const attrs = [];
            if (el.href)
                attrs.push(`href=\`${el.href}\``);
            if (el.value !== undefined && el.value !== '')
                attrs.push(`value=${JSON.stringify(el.value)}`);
            if (el.title && el.title !== el.label)
                attrs.push(`title=${JSON.stringify(el.title)}`);
            if (el.alt && el.alt !== el.label)
                attrs.push(`alt=${JSON.stringify(el.alt)}`);
            const attrSuffix = attrs.length > 0 ? ` ${attrs.join(' ')}` : '';
            lines.push(`  - \`${el.ref}\` [${el.tag}] "${el.label}"${attrSuffix} @ (${el.center.x}, ${el.center.y}) (${el.selectorHint})`);
        }
        return lines.join('\n');
    }
}
