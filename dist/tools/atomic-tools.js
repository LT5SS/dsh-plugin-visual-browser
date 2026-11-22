import path from 'node:path';
import { PageSnapshotSampler, safeEvaluate } from '../sampler/page-snapshot.js';
/**
 * Normalizes a target string:
 * - "#4" (when matching a sampled ref ID) -> '[data-dsh-ref="4"]'
 * - Otherwise leaves CSS selector as-is
 */
export function resolveTargetSelector(target) {
    const trimmed = target.trim();
    const refMatch = /^#?(\d+)$/.exec(trimmed);
    if (refMatch) {
        return `[data-dsh-ref="${refMatch[1]}"]`;
    }
    return trimmed;
}
export class AtomicBrowserToolset {
    session;
    sampler;
    constructor(session, snapshotDir) {
        this.session = session;
        this.sampler = new PageSnapshotSampler(session, snapshotDir);
    }
    async navigate(url, waitMs = 800, opts) {
        const navigation = await this.session.navigate(url, opts?.waitUntil ?? 'domcontentloaded', opts?.timeoutMs ?? 30000);
        if (waitMs > 0)
            await this.session.page.waitForTimeout(waitMs);
        const observation = await this.sampler.captureSnapshot('navigate');
        observation.navigation = navigation;
        return {
            action: `Navigated to ${url}`,
            observation,
            navigation,
            llmSummary: this.sampler.formatObservationForLLM(observation),
        };
    }
    async setCursorStyle(style) {
        await this.session.motion.setCursorStyle(style);
    }
    async moveMouse(target, label = 'MOVE') {
        if (Array.isArray(target)) {
            await this.session.motion.sweepPath(target, { label });
        }
        else {
            await this.session.motion.moveTo(target.x, target.y, { label });
        }
        const observation = await this.sampler.captureSnapshot('move_mouse');
        return {
            action: `Moved virtual mouse (${label})`,
            observation,
            llmSummary: this.sampler.formatObservationForLLM(observation),
        };
    }
    async hover(target) {
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
        }
        else {
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
    async click(target, waitMs = 240, opts) {
        const clickRes = typeof target === 'string'
            ? await this.session.motion.clickSelector(resolveTargetSelector(target), {
                label: `CLICK ${target}`,
                timeoutMs: opts?.timeoutMs,
            })
            : await this.session.motion.clickAt(target.x, target.y, {
                label: `CLICK (${target.x},${target.y})`,
            });
        if (!clickRes.ok && clickRes.blocked) {
            const targetLabel = typeof target === 'string' ? target : `(${target.x},${target.y})`;
            if (opts?.ifPresent &&
                (clickRes.blocked === 'REF_STALE' || clickRes.blocked === 'ELEMENT_NOT_FOUND')) {
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
        if (waitMs > 0)
            await this.session.page.waitForTimeout(waitMs);
        const observation = await this.sampler.captureSnapshot('click');
        return {
            ok: true,
            action: `Clicked ${typeof target === 'string' ? target : `(${target.x},${target.y})`}`,
            observation,
            llmSummary: this.sampler.formatObservationForLLM(observation),
        };
    }
    async typeText(target, text, pressEnter = false) {
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
    async drag(from, to, steps = 12, waitMs = 200, opts) {
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
        let capturedMidPath;
        let capturedMidFile;
        const dragRes = await this.session.motion.drag(fromPt, toPt, {
            steps,
            keepSelection: opts?.keepSelection,
            signal: opts?.signal,
            onPhase: async (phase) => {
                if (phase === 'dragging' && !capturedMidPath) {
                    try {
                        capturedMidPath = await this.session.screenshot(midFullPath);
                        capturedMidFile = midFilename;
                    }
                    catch {
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
        if (waitMs > 0)
            await this.session.page.waitForTimeout(waitMs);
        const observation = await this.sampler.captureSnapshot('drag');
        return {
            ok: true,
            ...(capturedMidFile ? { midFrame: capturedMidFile, midFramePath: capturedMidPath } : {}),
            action: `Dragged from (${Math.round(fromPt.x)},${Math.round(fromPt.y)}) to (${Math.round(toPt.x)},${Math.round(toPt.y)})`,
            observation,
            llmSummary: this.sampler.formatObservationForLLM(observation),
        };
    }
    async scroll(directionOrDelta = 'down', waitMs = 220, opts) {
        const driver = opts?.driver ?? 'wheel';
        const deltaY = typeof directionOrDelta === 'number'
            ? directionOrDelta
            : directionOrDelta === 'down'
                ? 760
                : -760;
        const beforeState = await safeEvaluate(this.session.page, () => {
            const se = document.scrollingElement || document.documentElement || document.body;
            const vw = window.innerWidth || 1;
            const vh = window.innerHeight || 1;
            const csBody = document.body ? window.getComputedStyle(document.body) : null;
            const csHtml = window.getComputedStyle(document.documentElement);
            const scrollHeight = Math.round(se ? se.scrollHeight : document.documentElement.scrollHeight || vh);
            const clientHeight = Math.round(se ? se.clientHeight : vh);
            const overflowHidden = (csHtml.overflowY === 'hidden' && (!csBody || csBody.overflowY === 'hidden')) ||
                (csBody?.overflowY === 'hidden' && scrollHeight <= clientHeight + 2) ||
                (csHtml.overflowY === 'hidden' && scrollHeight <= clientHeight + 2);
            const hasLenisContainer = Boolean(document.documentElement.classList.contains('lenis') ||
                document.querySelector('[data-lenis-prevent], .lenis-smooth, .lenis') ||
                window.lenis ||
                window.Lenis);
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
        }, {
            scrollTop: 0,
            scrollHeight: 0,
            clientHeight: 0,
            vw: 1280,
            vh: 720,
            overflowHidden: false,
            hasLenisContainer: false,
            url: '',
            textLen: 0,
        }, 0);
        const cursorPos = this.session.motion.getPosition();
        const probeClip = beforeState.vw >= 320 && beforeState.vh >= 240
            ? {
                x: cursorPos.x > beforeState.vw * 0.5
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
            await safeEvaluate(this.session.page, (dy) => {
                window.scrollBy(0, dy);
            }, undefined, { arg: deltaY, retries: 0 });
        }
        else {
            await this.session.motion.smoothScroll(deltaY, 18, 380);
        }
        if (waitMs > 0)
            await this.session.page.waitForTimeout(waitMs);
        const afterState = await safeEvaluate(this.session.page, () => {
            const se = document.scrollingElement || document.documentElement || document.body;
            return {
                scrollTop: Math.round(se ? se.scrollTop : window.scrollY || 0),
                url: window.location.href,
                textLen: (document.body?.innerText || '').trim().length,
            };
        }, { scrollTop: beforeState.scrollTop, url: beforeState.url, textLen: beforeState.textLen }, 0);
        const effectiveDomDelta = Math.round(afterState.scrollTop - beforeState.scrollTop);
        const domScrollable = beforeState.scrollHeight > beforeState.clientHeight + 2 && !beforeState.overflowHidden;
        const atBoundary = domScrollable &&
            ((deltaY > 0 && beforeState.scrollTop + beforeState.clientHeight >= beforeState.scrollHeight - 2) ||
                (deltaY < 0 && beforeState.scrollTop <= 2));
        let visualChanged = effectiveDomDelta !== 0 ||
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
        const programmaticBlockedHint = driver === 'programmatic' &&
            effectiveDomDelta === 0 &&
            beforeState.hasLenisContainer &&
            !atBoundary
            ? '⚠️ 该页拦截程序化滚动（Lenis 类），请用 wheel/scroll 动作而非 window.scrollTo'
            : undefined;
        const scrollDiag = {
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
     * records target computed styles & rect before moving mouse to center, moves without clicking,
     * waits settleMs (default 120ms), re-reads state, and reports property deltas & active animations.
     */
    async inspectMotion(target, settleMs = 120) {
        const targetLabel = typeof target === 'string'
            ? target.trim()
            : `(${Math.round(target.x)}, ${Math.round(target.y)})`;
        let pt;
        let selector = null;
        if (typeof target === 'string') {
            selector = resolveTargetSelector(target);
            const probe = await this.session.motion.resolveTargetPoint(selector, 1200);
            if (!probe.ok) {
                const observation = await this.sampler.captureSnapshot('inspect_motion_refused');
                const motionFail = {
                    target: targetLabel,
                    ok: false,
                    blocked: probe.blocked,
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
        }
        else {
            pt = { x: Math.round(target.x), y: Math.round(target.y) };
        }
        // Ensure baseline is captured outside target hover area if cursor already rests inside it
        const curPos = this.session.motion.getPosition();
        const preRect = await safeEvaluate(this.session.page, (arg) => {
            const el = arg.sel ? document.querySelector(arg.sel) : document.elementFromPoint(arg.x, arg.y);
            if (!el)
                return null;
            const r = el.getBoundingClientRect();
            return {
                left: r.left,
                top: r.top,
                right: r.right,
                bottom: r.bottom,
                vw: window.innerWidth || 1280,
                vh: window.innerHeight || 720,
            };
        }, null, { arg: { sel: selector, x: pt.x, y: pt.y }, retries: 0 });
        if (preRect &&
            curPos.x >= preRect.left - 2 &&
            curPos.x <= preRect.right + 2 &&
            curPos.y >= preRect.top - 2 &&
            curPos.y <= preRect.bottom + 2) {
            const outX = preRect.left >= 24 ? Math.max(4, Math.round(preRect.left - 16)) : Math.min(preRect.vw - 4, Math.round(preRect.right + 16));
            const outY = preRect.top >= 24 ? Math.max(4, Math.round(preRect.top - 16)) : Math.min(preRect.vh - 4, Math.round(preRect.bottom + 16));
            await this.session.motion.moveTo(outX, outY, { steps: 6, durationMs: 80, label: 'BASELINE' });
            await this.session.page.waitForTimeout(80);
        }
        const sampleProbe = async () => safeEvaluate(this.session.page, (arg) => {
            const el = arg.sel ? document.querySelector(arg.sel) : document.elementFromPoint(arg.x, arg.y);
            if (!el)
                return null;
            const cs = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            const se = document.scrollingElement || document.documentElement || document.body;
            let childTransform;
            const child = el.querySelector('img, video, svg, span, div');
            if (child) {
                childTransform = window.getComputedStyle(child).transform || 'none';
            }
            const anims = typeof el.getAnimations === 'function' ? el.getAnimations().length : 0;
            const subAnims = typeof el.getAnimations === 'function'
                ? el.getAnimations({ subtree: true }).length
                : 0;
            return {
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
            };
        }, null, { arg: { sel: selector, x: pt.x, y: pt.y }, retries: 0 });
        const before = await sampleProbe();
        await this.session.motion.moveTo(pt.x, pt.y, {
            steps: 10,
            durationMs: 140,
            label: 'INSPECT MOTION',
        });
        if (settleMs > 0)
            await this.session.page.waitForTimeout(settleMs);
        const after = await sampleProbe();
        const changed = [];
        const delta = {};
        if (before && after) {
            const strKeys = [
                'transform',
                'opacity',
                'filter',
                'color',
                'backgroundColor',
                'borderColor',
                'boxShadow',
            ];
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
            for (const rk of ['x', 'y', 'width', 'height']) {
                if (Math.abs(before.rect[rk] - after.rect[rk]) >= 0.5) {
                    const name = `rect.${rk}`;
                    changed.push(name);
                    delta[name] = { before: before.rect[rk], after: after.rect[rk] };
                }
            }
        }
        const animCount = after ? Math.max(after.animations, after.subtreeAnimations) : 0;
        const triggers = [];
        if (after) {
            const hasTransDur = after.transitionDuration
                .split(',')
                .some((d) => parseFloat(d) > 0);
            if (changed.length > 0 && (hasTransDur || animCount > 0)) {
                triggers.push('hover-transition');
            }
            if (changed.includes('transform') ||
                changed.includes('child_transform') ||
                changed.includes('rect.width') ||
                changed.includes('rect.height')) {
                triggers.push('pointer-transform');
            }
            if ((after.animationName && after.animationName !== 'none') ||
                (before && after.animations > before.animations)) {
                triggers.push('css-animation');
            }
            if (changed.includes('scrollTop')) {
                triggers.push('scroll-coupled');
            }
            if (changed.length > 0 && triggers.length === 0) {
                triggers.push('hover-style-change');
            }
        }
        const motionResult = {
            target: targetLabel,
            ok: true,
            at: pt,
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
            action: `Inspected motion on ${targetLabel}: changed=[${changed.join(', ')}], animations=${animCount}`,
            observation,
            llmSummary: this.sampler.formatObservationForLLM(observation),
        };
    }
    /**
     * Read-only DOM & computed style inspection query for the agent.
     * Uses `safeEvaluate()` to tolerate navigation races and expose link/input attributes.
     */
    async inspectDom(selector) {
        const fallback = {
            count: 0,
            samples: [],
            degraded: true,
            degradedReason: 'inspectDom degraded: navigation race',
        };
        return safeEvaluate(this.session.page, (sel) => {
            const els = Array.from(document.querySelectorAll(sel));
            return {
                count: els.length,
                samples: els.slice(0, 5).map((el) => {
                    const cs = window.getComputedStyle(el);
                    const rawHref = el.getAttribute('href')?.trim();
                    const href = rawHref ? rawHref.slice(0, 200) : undefined;
                    const value = 'value' in el &&
                        ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) &&
                        el.type !== 'password' &&
                        typeof el.value === 'string' &&
                        el.value.length > 0
                        ? el.value.slice(0, 80)
                        : undefined;
                    const title = el.getAttribute('title')?.trim().slice(0, 120) || undefined;
                    const alt = el.getAttribute('alt')?.trim().slice(0, 120) || undefined;
                    return {
                        tag: el.tagName.toLowerCase(),
                        text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80),
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
        }, fallback, { arg: selector, retries: 2 });
    }
}
