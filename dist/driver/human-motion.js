import { buildVirtualCursorInitScript, resolveCursorStyle } from '../injected/virtual-cursor.js';
import { mergeCursorStyleConfig } from '../settings-store.js';
import { safeEvaluate } from '../sampler/page-snapshot.js';
function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}
function cubicBezier(p0, p1, p2, p3, t) {
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
    page;
    pos = { x: 120, y: 120 };
    cursorStyle;
    showTakeoverControl;
    takeoverMode;
    shouldAbort;
    takeoverRole = '';
    takeoverHotkey;
    unloadGuardEnabled = false;
    constructor(page, initialStyle = {}, opts = {}) {
        this.page = page;
        this.cursorStyle = resolveCursorStyle(initialStyle);
        this.showTakeoverControl = Boolean(opts.showTakeoverControl);
        this.takeoverMode = this.showTakeoverControl ? 'running' : 'hidden';
        this.takeoverHotkey = typeof opts.takeoverHotkey === 'string' ? opts.takeoverHotkey : 'F8';
        this.unloadGuardEnabled = Boolean(opts.unloadGuard);
        this.shouldAbort = opts.shouldAbort;
    }
    getPosition() {
        return { ...this.pos };
    }
    setPosition(x, y) {
        if (Number.isFinite(x) && Number.isFinite(y)) {
            this.pos = { x, y };
        }
    }
    resetPosition(x = 120, y = 120) {
        this.pos = { x, y };
    }
    async syncPositionFromPage() {
        const pagePos = await safeEvaluate(this.page, () => {
            const st = window.__dshCursorAPI?.getState?.();
            if (st && Number.isFinite(st.x) && Number.isFinite(st.y)) {
                return { x: Math.round(st.x), y: Math.round(st.y) };
            }
            return null;
        }, null, 0).catch(() => null);
        if (pagePos) {
            this.pos = pagePos;
        }
        return { ...this.pos };
    }
    getCursorStyle() {
        return { ...this.cursorStyle };
    }
    updateActiveStyleFromPage(style) {
        if (style && typeof style === 'object') {
            this.cursorStyle = resolveCursorStyle(style);
        }
    }
    isUnloadGuardEnabled() {
        return this.unloadGuardEnabled;
    }
    async setUnloadGuard(on) {
        this.unloadGuardEnabled = Boolean(on);
        if (this.unloadGuardEnabled) {
            await this.ensureCursorHUD(false);
        }
        await safeEvaluate(this.page, (flag) => {
            window.__dshCursorAPI?.setUnloadGuard?.(flag);
        }, undefined, { arg: this.unloadGuardEnabled, retries: 0 });
    }
    async ensureCursorHUD(syncActiveState = false) {
        const resolvedStyle = resolveCursorStyle(this.cursorStyle);
        const initScript = buildVirtualCursorInitScript(resolvedStyle, {
            showTakeoverControl: this.showTakeoverControl,
            roleLabel: this.takeoverRole,
            takeoverHotkey: this.takeoverHotkey,
            unloadGuard: this.unloadGuardEnabled,
        });
        await safeEvaluate(this.page, (arg) => {
            if (!window.__dshVirtualCursorInstalled) {
                (0, eval)(arg.script);
                return;
            }
            if (arg.sync && window.__dshCursorAPI) {
                window.__dshCursorAPI.setStyle?.(arg.style, { fromHost: true });
                window.__dshCursorAPI.setTakeoverHotkey?.(arg.hotkey);
                window.__dshCursorAPI.setUnloadGuard?.(arg.unloadGuard);
            }
        }, undefined, {
            arg: {
                script: initScript,
                sync: syncActiveState,
                style: resolvedStyle,
                hotkey: this.takeoverHotkey,
                unloadGuard: this.unloadGuardEnabled,
            },
            retries: 1,
        });
    }
    async setTakeoverHotkey(hotkey) {
        this.takeoverHotkey = hotkey;
        await this.ensureCursorHUD(false);
        await safeEvaluate(this.page, (hk) => {
            window.__dshCursorAPI?.setTakeoverHotkey?.(hk);
        }, undefined, { arg: hotkey, retries: 0 });
    }
    async setTakeoverState(mode, roleLabel) {
        if (typeof roleLabel === 'string') {
            this.takeoverRole = roleLabel;
        }
        this.takeoverMode = mode;
        this.showTakeoverControl = mode !== 'hidden';
        await this.ensureCursorHUD(false);
        await safeEvaluate(this.page, ({ m, role }) => {
            window.__dshCursorAPI?.setTakeoverState(m, role);
        }, undefined, { arg: { m: mode, role: this.takeoverRole }, retries: 0 });
    }
    async resetTakeoverRequest() {
        await safeEvaluate(this.page, () => {
            window.__dshCursorAPI?.resetTakeoverRequest();
        }, undefined, 0);
    }
    /**
     * Dynamically updates the virtual cursor & trail style (preset or custom colors/width/length/variant).
     */
    async setCursorStyle(style) {
        this.cursorStyle = mergeCursorStyleConfig(this.cursorStyle, style);
        await this.ensureCursorHUD(false);
        await safeEvaluate(this.page, (cfg) => {
            window.__dshCursorAPI?.setStyle(cfg, { fromHost: true });
        }, undefined, { arg: this.cursorStyle, retries: 1 });
    }
    async clearTrail() {
        await this.ensureCursorHUD();
        await safeEvaluate(this.page, () => {
            window.__dshCursorAPI?.clearTrail();
        }, undefined, 1);
    }
    /**
     * Moves the virtual mouse along a cubic Bezier arc with human-like acceleration/deceleration.
     */
    async moveTo(targetX, targetY, opts = {}) {
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
        const p1 = {
            x: p0.x + dx * 0.3 + nx * arcOffset,
            y: p0.y + dy * 0.3 + ny * arcOffset,
        };
        const p2 = {
            x: p0.x + dx * 0.72 + nx * (arcOffset * 0.55),
            y: p0.y + dy * 0.72 + ny * (arcOffset * 0.55),
        };
        const stepDelay = Math.max(4, Math.round(durationMs / steps));
        for (let i = 1; i <= steps; i++) {
            if (this.shouldAbort?.())
                break;
            const progress = easeInOutCubic(i / steps);
            const pt = cubicBezier(p0, p1, p2, p3, progress);
            this.pos = pt;
            await this.page.mouse.move(pt.x, pt.y);
            await this.syncHUD(pt.x, pt.y, i === steps ? label : 'MOVING');
            await this.page.waitForTimeout(stepDelay);
        }
        return { ...this.pos };
    }
    async sweepPath(waypoints, opts = {}) {
        for (let i = 0; i < waypoints.length; i++) {
            if (this.shouldAbort?.())
                break;
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
    async hoverSelector(selector, opts = {}) {
        const loc = this.page.locator(selector).first();
        await loc.waitFor({ state: 'visible', timeout: 8000 });
        const box = await loc.boundingBox();
        if (!box) {
            throw new Error(`Cannot resolve boundingBox for selector: ${selector}`);
        }
        const cx = box.x + box.width * 0.5;
        const cy = box.y + box.height * 0.5;
        return this.moveTo(cx, cy, {
            ...opts,
            label: opts.label ?? `HOVER ${selector}`,
        });
    }
    /**
     * Performs a Top-Layer-aware hit test at `(x, y)` before dispatching any real mouse click,
     * penetrating open Shadow DOM roots and same-origin iframes.
     */
    async hitTestAt(x, y) {
        const fallback = {
            hitsPluginUi: false,
            topElement: 'unknown',
            stackTop: [],
        };
        return safeEvaluate(this.page, ({ px, py }) => {
            const stack = document.elementsFromPoint(px, py);
            let inShadowRoot = false;
            let inIframe = false;
            let resolvedTop = stack[0] ?? null;
            let depth = 0;
            while (resolvedTop && depth < 12) {
                depth++;
                if (resolvedTop.closest?.('#__dsh_vc_root__'))
                    break;
                if (resolvedTop.shadowRoot) {
                    const sr = resolvedTop.shadowRoot;
                    const innerEl = sr.elementFromPoint(px, py);
                    const innerStack = typeof sr.elementsFromPoint === 'function'
                        ? sr.elementsFromPoint(px, py)
                        : innerEl
                            ? [innerEl]
                            : [];
                    let inner = null;
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
                        const iframe = resolvedTop;
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
                    }
                    catch {
                        // Cross-origin iframe cannot be inspected locally; stop descending safely.
                    }
                }
                break;
            }
            const hitsPluginUi = Boolean(stack[0]?.closest?.('#__dsh_vc_root__')) ||
                Boolean(resolvedTop?.closest?.('#__dsh_vc_root__'));
            const stackTop = [];
            for (let i = 0; i < Math.min(stack.length, 5); i++) {
                const el = stack[i];
                const tag = el.tagName.toLowerCase();
                const idPart = el.id ? `#${el.id}` : '';
                let clsPart = '';
                if (!el.id && typeof el.className === 'string' && el.className.trim()) {
                    const firstCls = el.className.trim().split(/\s+/)[0];
                    if (firstCls)
                        clsPart = `.${firstCls}`;
                }
                stackTop.push(`${tag}${idPart}${clsPart}`);
            }
            let topElement = 'none';
            if (resolvedTop) {
                if (resolvedTop.closest?.('#__dsh_vc_root__')) {
                    const chain = [];
                    let cur = resolvedTop;
                    while (cur) {
                        const tag = cur.tagName.toLowerCase();
                        const idPart = cur.id ? `#${cur.id}` : '';
                        let clsPart = '';
                        if (!cur.id && typeof cur.className === 'string' && cur.className.trim()) {
                            const firstCls = cur.className.trim().split(/\s+/)[0];
                            if (firstCls)
                                clsPart = `.${firstCls}`;
                        }
                        chain.unshift(`${tag}${idPart}${clsPart}`);
                        if (cur.id === '__dsh_vc_root__')
                            break;
                        cur = cur.parentElement;
                    }
                    topElement = chain.join(' > ');
                }
                else {
                    const tag = resolvedTop.tagName.toLowerCase();
                    const idPart = resolvedTop.id ? `#${resolvedTop.id}` : '';
                    let clsPart = '';
                    if (!resolvedTop.id && typeof resolvedTop.className === 'string' && resolvedTop.className.trim()) {
                        const firstCls = resolvedTop.className.trim().split(/\s+/)[0];
                        if (firstCls)
                            clsPart = `.${firstCls}`;
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
        }, fallback, { arg: { px: x, py: y }, retries: 1 });
    }
    async clickAt(x, y, opts = {}) {
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
        await safeEvaluate(this.page, ({ px, py, lbl }) => {
            window.__dshCursorAPI?.clickEffect(px, py, lbl);
        }, undefined, { arg: { px: x, py: y, lbl: opts.label ?? 'CLICK' }, retries: 0 });
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
    async clickSelector(selector, opts = {}) {
        const pt = await this.hoverSelector(selector, {
            ...opts,
            label: `AIM ${selector}`,
        });
        return this.clickAt(pt.x, pt.y, {
            ...opts,
            steps: 2,
            durationMs: 20,
            label: opts.label ?? `CLICK ${selector}`,
        });
    }
    async resolvePoint(target) {
        if (typeof target !== 'string') {
            return { x: target.x, y: target.y };
        }
        const loc = this.page.locator(target).first();
        await loc.waitFor({ state: 'visible', timeout: 8000 });
        const box = await loc.boundingBox();
        if (!box) {
            throw new Error(`Cannot resolve boundingBox for target: ${target}`);
        }
        return {
            x: Math.round(box.x + box.width * 0.5),
            y: Math.round(box.y + box.height * 0.5),
        };
    }
    /**
     * Performs a physical mouse drag (`move(from)` -> `down()` -> Bezier interpolation -> `up()`),
     * rendering press-shrink, thickened reversed-gradient drag trail, origin anchor ring, and drop state.
     */
    async drag(from, to, opts = {}) {
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
        const p0 = { x: from.x, y: from.y };
        const p3 = { x: to.x, y: to.y };
        const dx = p3.x - p0.x;
        const dy = p3.y - p0.y;
        const dist = Math.hypot(dx, dy);
        const nx = dist > 0 ? -dy / dist : 0;
        const ny = dist > 0 ? dx / dist : 0;
        const arcOffset = dist * curvature;
        const p1 = {
            x: p0.x + dx * 0.3 + nx * arcOffset,
            y: p0.y + dy * 0.3 + ny * arcOffset,
        };
        const p2 = {
            x: p0.x + dx * 0.72 + nx * (arcOffset * 0.55),
            y: p0.y + dy * 0.72 + ny * (arcOffset * 0.55),
        };
        const stepDelay = Math.max(6, Math.round(durationMs / steps));
        const dragLabel = `DRAG (${Math.round(from.x)},${Math.round(from.y)}) → (${Math.round(to.x)},${Math.round(to.y)})`;
        let mouseIsDown = false;
        try {
            if (!keepSelection) {
                await safeEvaluate(this.page, () => {
                    try {
                        document.getElementById('__dsh_vc_drag_noselect__')?.remove();
                        const styleEl = document.createElement('style');
                        styleEl.id = '__dsh_vc_drag_noselect__';
                        styleEl.textContent =
                            'html,body,*{-webkit-user-select:none!important;user-select:none!important}';
                        (document.head || document.documentElement)?.appendChild(styleEl);
                    }
                    catch { }
                    try {
                        if (!window.__dshDragStartSaved) {
                            window.__dshPrevDragStart = document.ondragstart;
                            window.__dshDragStartSaved = true;
                        }
                        document.ondragstart = (e) => {
                            e.preventDefault();
                        };
                    }
                    catch { }
                }, undefined, 0).catch(() => { });
            }
            await this.page.mouse.move(from.x, from.y);
            await this.page.mouse.down();
            mouseIsDown = true;
            this.pos = { x: from.x, y: from.y };
            await safeEvaluate(this.page, ({ px, py, lbl }) => {
                window.__dshCursorAPI?.dragStart?.(px, py, lbl);
            }, undefined, { arg: { px: from.x, py: from.y, lbl: dragLabel }, retries: 0 });
            await opts.onPhase?.('down');
            let midPhaseEmitted = false;
            for (let i = 1; i <= steps; i++) {
                if (this.shouldAbort?.() || opts.signal?.aborted)
                    break;
                const progress = easeInOutCubic(i / steps);
                const pt = cubicBezier(p0, p1, p2, p3, progress);
                this.pos = pt;
                await this.page.mouse.move(pt.x, pt.y);
                await safeEvaluate(this.page, ({ px, py, tx, ty }) => {
                    window.__dshCursorAPI?.dragMove?.(px, py, tx, ty);
                }, undefined, { arg: { px: pt.x, py: pt.y, tx: to.x, ty: to.y }, retries: 0 });
                if (!midPhaseEmitted && progress >= 0.5) {
                    midPhaseEmitted = true;
                    await opts.onPhase?.('dragging');
                }
                await this.page.waitForTimeout(stepDelay);
            }
            await this.page.mouse.up();
            mouseIsDown = false;
            const dropLabel = `DROP (${Math.round(this.pos.x)},${Math.round(this.pos.y)})`;
            await safeEvaluate(this.page, ({ px, py, lbl }) => {
                window.__dshCursorAPI?.dragEnd?.(px, py, lbl);
            }, undefined, { arg: { px: this.pos.x, py: this.pos.y, lbl: dropLabel }, retries: 0 });
            await opts.onPhase?.('up');
            await this.page.waitForTimeout(80);
            return {
                ok: true,
                from: { ...from },
                to: { ...this.pos },
                steps,
            };
        }
        finally {
            if (mouseIsDown) {
                await this.page.mouse.up().catch(() => { });
            }
            await safeEvaluate(this.page, (shouldClearSelection) => {
                try {
                    document.getElementById('__dsh_vc_drag_noselect__')?.remove();
                }
                catch { }
                try {
                    if (window.__dshDragStartSaved) {
                        document.ondragstart = window.__dshPrevDragStart ?? null;
                        delete window.__dshPrevDragStart;
                        delete window.__dshDragStartSaved;
                    }
                }
                catch { }
                if (shouldClearSelection) {
                    try {
                        window.getSelection?.()?.removeAllRanges?.();
                    }
                    catch { }
                }
            }, undefined, { arg: !keepSelection, retries: 0 }).catch(() => { });
        }
    }
    async smoothScroll(deltaY, frames = 16, durationMs = 360) {
        await this.ensureCursorHUD(false);
        const delay = Math.max(8, Math.round(durationMs / frames));
        let accumulated = 0;
        for (let i = 1; i <= frames; i++) {
            if (this.shouldAbort?.())
                break;
            const targetNow = deltaY * easeInOutCubic(i / frames);
            const stepDelta = targetNow - accumulated;
            accumulated = targetNow;
            await this.page.mouse.wheel(0, stepDelta);
            const dirSign = deltaY >= 0 ? '+' : '';
            const scrollLabel = `SCROLL ${dirSign}${Math.round(accumulated)}px`;
            await safeEvaluate(this.page, ({ dy, lbl }) => {
                window.__dshCursorAPI?.scrollEffect?.(dy, lbl);
            }, undefined, { arg: { dy: stepDelta || deltaY, lbl: scrollLabel }, retries: 0 });
            await this.page.waitForTimeout(delay);
        }
    }
    async syncHUD(x, y, label) {
        await safeEvaluate(this.page, ({ px, py, lbl }) => {
            window.__dshCursorAPI?.update(px, py, lbl);
        }, undefined, { arg: { px: x, py: y, lbl: label }, retries: 0 });
    }
}
