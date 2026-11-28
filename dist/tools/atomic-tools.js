import fs from 'node:fs';
import path from 'node:path';
import { PageSnapshotSampler, normSplit, safeEvaluate } from '../sampler/page-snapshot.js';
import { computePatchMeanPixelDiff, computePngAvgColorHex, decodePngRgba } from '../sampler/png-pixels.js';
const EXTRACT_ATTR_BASE = new Set(['text', 'href', 'src', 'title', 'alt', 'value']);
export function parseExtractFieldsSpec(raw) {
    let obj = raw;
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!trimmed)
            return undefined;
        obj = JSON.parse(trimmed);
    }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj))
        return undefined;
    const out = {};
    for (const [rawKey, rawVal] of Object.entries(obj)) {
        const fieldName = String(rawKey).trim().slice(0, 48);
        if (!fieldName)
            continue;
        let selector = '';
        let attr = 'text';
        let trim = true;
        if (typeof rawVal === 'string') {
            selector = rawVal.trim().slice(0, 160);
        }
        else if (rawVal && typeof rawVal === 'object' && !Array.isArray(rawVal)) {
            const rec = rawVal;
            if (typeof rec.selector === 'string')
                selector = rec.selector.trim().slice(0, 160);
            if (typeof rec.attr === 'string')
                attr = rec.attr.trim().slice(0, 48);
            if (typeof rec.trim === 'boolean')
                trim = rec.trim;
        }
        else {
            continue;
        }
        const normalizedAttr = attr.toLowerCase();
        const validAttr = EXTRACT_ATTR_BASE.has(normalizedAttr) ||
            (/^attr:[a-z0-9_-]{1,40}$/i.test(attr) && !/^attr:on/i.test(attr));
        if (!validAttr)
            continue;
        out[fieldName] = {
            ...(selector ? { selector } : {}),
            attr: EXTRACT_ATTR_BASE.has(normalizedAttr) ? normalizedAttr : `attr:${attr.slice(5)}`,
            trim,
        };
        if (Object.keys(out).length >= 24)
            break;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}
export function normalizeExtractSpec(raw) {
    if (typeof raw.itemSelector !== 'string' || !raw.itemSelector.trim())
        return undefined;
    const itemSelector = raw.itemSelector.trim().slice(0, 200);
    const fields = raw.fields !== undefined ? parseExtractFieldsSpec(raw.fields) : undefined;
    const rawMax = Number(raw.maxItems);
    const maxItems = Number.isFinite(rawMax) ? Math.max(1, Math.min(1000, Math.round(rawMax))) : 200;
    const dedupeBy = typeof raw.dedupeBy === 'string' && raw.dedupeBy.trim()
        ? raw.dedupeBy.trim().slice(0, 48)
        : undefined;
    return {
        itemSelector,
        ...(fields ? { fields } : {}),
        maxItems,
        ...(dedupeBy ? { dedupeBy } : {}),
        ...(typeof raw.includeEmpty === 'boolean' ? { includeEmpty: raw.includeEmpty } : {}),
    };
}
export function formatRegionTextSummary(region) {
    const parts = [
        `center=(${region.x},${region.y}) r=${region.radius} zoom=${region.zoom}x (${region.width}x${region.height}px)`,
        `topElement=${region.topElement ?? 'none'}`,
    ];
    if (region.rect) {
        parts.push(`rect={x:${region.rect.x},y:${region.rect.y},w:${region.rect.width},h:${region.rect.height}}`);
    }
    if (region.avgColor) {
        parts.push(`avgColor=${region.avgColor}`);
    }
    if (region.visibleText) {
        parts.push(`visibleText=${JSON.stringify(region.visibleText.slice(0, 120))}`);
    }
    return parts.join(' | ');
}
const CURATED_STYLE_KEYS = [
    'display',
    'position',
    'zIndex',
    'width',
    'height',
    'color',
    'backgroundColor',
    'fontFamily',
    'fontSize',
    'fontWeight',
    'lineHeight',
    'letterSpacing',
    'opacity',
    'transform',
    'overflow',
    'visibility',
    'pointerEvents',
    'cursor',
];
const STYLE_TRIM_DROP_ORDER = [
    'cursor',
    'pointerEvents',
    'visibility',
    'letterSpacing',
    'lineHeight',
    'fontWeight',
    'zIndex',
    'overflow',
    'transform',
    'opacity',
    'fontFamily',
    'fontSize',
    'backgroundColor',
    'color',
];
export function formatStylesBlockWithinBudget(res, maxChars = 1000) {
    const styles = { ...(res.computedStyle ?? {}) };
    let box = res.boxModel ? { ...res.boxModel } : undefined;
    const render = () => {
        const lines = [
            `### [Styles Probe] ${res.target}${res.tag ? ` <${res.tag}>` : ''}`,
            ...(res.rect
                ? [`- rect: x=${res.rect.x}, y=${res.rect.y}, w=${res.rect.width}, h=${res.rect.height}`]
                : []),
            ...(box ? [`- box: margin="${box.margin}" | padding="${box.padding}" | border="${box.border}"`] : []),
        ];
        for (const [k, v] of Object.entries(styles)) {
            if (v !== undefined && v !== '')
                lines.push(`- ${k}: ${v}`);
        }
        return lines.join('\n');
    };
    let out = render();
    if (out.length <= maxChars)
        return out;
    // 1) Trim long transform / overflow values first
    if (typeof styles.transform === 'string' && styles.transform.length > 40) {
        styles.transform = styles.transform.slice(0, 39) + '…';
    }
    if (typeof styles.overflow === 'string' && (styles.overflow === 'visible' || styles.overflow.length > 24)) {
        delete styles.overflow;
    }
    out = render();
    if (out.length <= maxChars)
        return out;
    // 2) Shorten fontFamily next
    if (typeof styles.fontFamily === 'string' && styles.fontFamily.length > 42) {
        styles.fontFamily = styles.fontFamily.slice(0, 41) + '…';
    }
    out = render();
    if (out.length <= maxChars)
        return out;
    // 3) Drop secondary style keys deterministically before touching box/rect
    for (const dropKey of STYLE_TRIM_DROP_ORDER) {
        if (dropKey in styles) {
            delete styles[dropKey];
            out = render();
            if (out.length <= maxChars)
                return out;
        }
    }
    if (box && out.length > maxChars) {
        box = undefined;
        out = render();
    }
    return out.length <= maxChars ? out : out.slice(0, maxChars - 1) + '…';
}
export function isReservedHotkey(key, takeoverHotkey = 'F8') {
    const tokens = String(key ?? '')
        .split('+')
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
    if (tokens.length === 0)
        return false;
    const normalizedTakeover = String(takeoverHotkey || 'F8')
        .trim()
        .toLowerCase();
    if (tokens.includes('f8'))
        return true;
    if (normalizedTakeover && tokens.includes(normalizedTakeover))
        return true;
    if (tokens.includes('alt') && tokens.includes('f4'))
        return true;
    return false;
}
function normalizePlaywrightKey(key) {
    const parts = key
        .split('+')
        .map((p) => p.trim())
        .filter(Boolean);
    if (parts.length <= 1)
        return parts[0] ?? key.trim();
    const hasShift = parts.slice(0, -1).some((p) => p.toLowerCase() === 'shift');
    const normalizedMods = parts.slice(0, -1).map((p) => {
        const low = p.toLowerCase();
        if (low === 'ctrl' || low === 'control')
            return 'Control';
        if (low === 'alt' || low === 'option')
            return 'Alt';
        if (low === 'shift')
            return 'Shift';
        if (low === 'meta' || low === 'cmd' || low === 'command' || low === 'win')
            return 'Meta';
        return p;
    });
    let mainKey = parts[parts.length - 1];
    if (!hasShift && /^[A-Z]$/.test(mainKey)) {
        mainKey = mainKey.toLowerCase();
    }
    return [...normalizedMods, mainKey].join('+');
}
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
        if (navigation.blocked) {
            const observation = await this.sampler.captureSnapshot('navigate_blocked');
            observation.navigation = navigation;
            const hint = navigation.blocked === 'JS_URL'
                ? '已拦截 javascript: 协议链接（安全红线：禁止执行任意页面脚本）'
                : `已拦截外部协议链接 (${navigation.protocol ?? 'external'})，未拉起系统应用；可直接使用 href 中的联系信息`;
            const refusalJson = JSON.stringify({
                ok: false,
                blocked: navigation.blocked,
                protocol: navigation.protocol,
                href: navigation.href,
                hint,
            });
            return {
                ok: false,
                blocked: navigation.blocked,
                protocol: navigation.protocol,
                href: navigation.href,
                hint,
                action: `Blocked navigation (${navigation.blocked}): ${navigation.href ?? url}`,
                observation,
                navigation,
                llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
            };
        }
        await this.sampler.invalidateRefs?.({ bumpRefOffset: false });
        if (waitMs > 0)
            await this.session.page.waitForTimeout(waitMs);
        const promptDialog = this.session.consumePendingPromptDialog?.();
        const observation = await this.sampler.captureSnapshot('navigate');
        observation.navigation = navigation;
        if (promptDialog) {
            const refusalJson = JSON.stringify({
                ok: false,
                blocked: 'PROMPT_REQUIRES_HUMAN',
                message: promptDialog.message,
            });
            return {
                ok: false,
                blocked: 'PROMPT_REQUIRES_HUMAN',
                promptDialog,
                hint: `页面弹出 prompt("${promptDialog.message}")，已自动取消并等待人工处理`,
                action: `Prompt dialog intercepted during navigate`,
                observation,
                navigation,
                llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
            };
        }
        return {
            ok: true,
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
        if (this.session.motion.getTakeoverMode?.() !== 'paused') {
            await this.session.motion.setProtocolGuardArmed?.(true).catch(() => { });
        }
        await this.session.motion.clearInterceptedProtocol?.().catch(() => { });
        const { clickRes, intercepted } = await this.session.withAgentNavigationAllowed(async () => {
            const cr = typeof target === 'string'
                ? await this.session.motion.clickSelector(resolveTargetSelector(target), {
                    label: `CLICK ${target}`,
                    timeoutMs: opts?.timeoutMs,
                })
                : await this.session.motion.clickAt(target.x, target.y, {
                    label: `CLICK (${target.x},${target.y})`,
                });
            if (!cr.ok && cr.blocked) {
                return { clickRes: cr, intercepted: null };
            }
            const inter = await this.session.motion.consumeInterceptedProtocol?.().catch(() => null);
            if (inter) {
                return { clickRes: cr, intercepted: inter };
            }
            if (waitMs > 0)
                await this.session.page.waitForTimeout(waitMs);
            await this.session.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { });
            return { clickRes: cr, intercepted: null };
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
        if (intercepted) {
            const observation = await this.sampler.captureSnapshot('click_protocol_blocked');
            const hint = intercepted.kind === 'JS_URL'
                ? '已拦截 javascript: 协议链接（安全红线：禁止执行任意页面脚本）'
                : '已拦截外部协议链接，未拉起系统应用；可直接使用 href 中的联系信息';
            const refusalJson = JSON.stringify({
                ok: false,
                blocked: intercepted.kind,
                ...(typeof target === 'string' ? { ref: target } : {}),
                protocol: intercepted.protocol,
                href: intercepted.href,
                hint,
            });
            return {
                ok: false,
                blocked: intercepted.kind,
                ...(typeof target === 'string' ? { ref: target } : {}),
                protocol: intercepted.protocol,
                href: intercepted.href,
                hint,
                action: `Blocked link protocol (${intercepted.kind}): ${intercepted.href}`,
                observation,
                llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
            };
        }
        const promptDialog = this.session.consumePendingPromptDialog?.();
        const observation = await this.sampler.captureSnapshot('click');
        if (promptDialog) {
            const refusalJson = JSON.stringify({
                ok: false,
                blocked: 'PROMPT_REQUIRES_HUMAN',
                message: promptDialog.message,
            });
            return {
                ok: false,
                blocked: 'PROMPT_REQUIRES_HUMAN',
                ...(typeof target === 'string' ? { ref: target } : {}),
                promptDialog,
                hint: `点击触发了 prompt("${promptDialog.message}")，已自动取消并暂停等待人工处理`,
                action: `Click triggered prompt() requiring human input`,
                observation,
                llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
            };
        }
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
        if (pressEnter) {
            await this.session.withAgentNavigationAllowed(async () => {
                await this.session.page.keyboard.type(text, { delay: 35 });
                await this.session.page.keyboard.press('Enter');
                await this.session.page.waitForTimeout(200);
                await this.session.page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => { });
            });
        }
        else {
            await this.session.page.keyboard.type(text, { delay: 35 });
            await this.session.page.waitForTimeout(200);
        }
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
            ? await this.session
                .captureClipBuffer(probeClip, { format: 'jpeg', quality: 65 })
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
            const afterProbe = await this.session
                .captureClipBuffer(probeClip, { format: 'jpeg', quality: 65 })
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
     * accepts either a CSS/#ref selector or viewport `{ x, y }` coordinate (including `<canvas>` regions).
     * Records DOM/computed-style deltas plus a cursor-hidden 32x32 PNG patch diff before & after hovering.
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
        }
        else {
            pt = { x: Math.round(target.x), y: Math.round(target.y) };
        }
        // Clamp coordinate targets to viewport & inspect target bounds/topElement without bare page.evaluate
        const preInfo = await safeEvaluate(this.session.page, (arg) => {
            const vw = Math.max(1, window.innerWidth || 1280);
            const vh = Math.max(1, window.innerHeight || 720);
            const cx = Math.max(0, Math.min(vw - 1, Math.round(arg.x)));
            const cy = Math.max(0, Math.min(vh - 1, Math.round(arg.y)));
            let el = null;
            if (arg.sel) {
                el = document.querySelector(arg.sel);
            }
            else {
                const stack = typeof document.elementsFromPoint === 'function'
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
                    if (single && !single.closest('#__dsh_vc_root__'))
                        el = single;
                }
            }
            let topElement;
            if (el) {
                const tag = el.tagName.toUpperCase();
                if (el.id) {
                    topElement = `${tag}#${el.id}`;
                }
                else if (el.className && typeof el.className === 'string') {
                    const firstCls = el.className.trim().split(/\s+/).find((c) => c && !c.startsWith('is-'));
                    topElement = firstCls ? `${tag}.${firstCls}` : tag;
                }
                else {
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
        }, {
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
        }, { arg: { sel: selector, x: pt.x, y: pt.y }, retries: 0 });
        if (selector === null) {
            pt = { x: preInfo.clampedX, y: preInfo.clampedY };
        }
        // Ensure baseline is captured outside target hover area when cursor already rests near/inside it
        const curPos = this.session.motion.getPosition();
        if (preInfo.isLargeTarget) {
            if (Math.hypot(curPos.x - pt.x, curPos.y - pt.y) <= 48) {
                const outX = pt.x > preInfo.vw * 0.5
                    ? Math.max(12, Math.round(preInfo.vw * 0.15))
                    : Math.min(preInfo.vw - 12, Math.round(preInfo.vw * 0.85));
                const outY = pt.y > preInfo.vh * 0.5
                    ? Math.max(12, Math.round(preInfo.vh * 0.15))
                    : Math.min(preInfo.vh - 12, Math.round(preInfo.vh * 0.85));
                await this.session.motion.moveTo(outX, outY, { steps: 6, durationMs: 80, label: 'BASELINE' });
                await this.session.page.waitForTimeout(80);
            }
        }
        else if (preInfo.hasRect &&
            curPos.x >= preInfo.left - 2 &&
            curPos.x <= preInfo.right + 2 &&
            curPos.y >= preInfo.top - 2 &&
            curPos.y <= preInfo.bottom + 2) {
            const outX = preInfo.left >= 24
                ? Math.max(4, Math.round(preInfo.left - 16))
                : Math.min(preInfo.vw - 4, Math.round(preInfo.right + 16));
            const outY = preInfo.top >= 24
                ? Math.max(4, Math.round(preInfo.top - 16))
                : Math.min(preInfo.vh - 4, Math.round(preInfo.bottom + 16));
            await this.session.motion.moveTo(outX, outY, { steps: 6, durationMs: 80, label: 'BASELINE' });
            await this.session.page.waitForTimeout(80);
        }
        const clipW = Math.min(32, Math.max(1, preInfo.vw));
        const clipH = Math.min(32, Math.max(1, preInfo.vh));
        const clipX = Math.max(0, Math.min(preInfo.vw - clipW, Math.round(pt.x - clipW / 2)));
        const clipY = Math.max(0, Math.min(preInfo.vh - clipH, Math.round(pt.y - clipH / 2)));
        const captureCleanPatch = async () => {
            const prevVis = await safeEvaluate(this.session.page, () => {
                const root = document.getElementById('__dsh_vc_root__');
                if (!root)
                    return null;
                const prev = root.style.visibility;
                root.style.visibility = 'hidden';
                return prev;
            }, null, 0);
            try {
                return await this.session
                    .captureClipBuffer({ x: clipX, y: clipY, width: clipW, height: clipH }, { format: 'png' })
                    .catch(() => null);
            }
            finally {
                if (prevVis !== null) {
                    await safeEvaluate(this.session.page, (v) => {
                        const root = document.getElementById('__dsh_vc_root__');
                        if (root)
                            root.style.visibility = v;
                    }, undefined, { arg: prevVis, retries: 0 }).catch(() => { });
                }
            }
        };
        const sampleProbe = async () => safeEvaluate(this.session.page, (arg) => {
            let el = null;
            if (arg.sel) {
                el = document.querySelector(arg.sel);
            }
            else {
                const stack = typeof document.elementsFromPoint === 'function'
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
                    if (single && !single.closest('#__dsh_vc_root__'))
                        el = single;
                }
            }
            if (!el)
                return { state: null };
            const tag = el.tagName.toUpperCase();
            let topElement = tag;
            if (el.id) {
                topElement = `${tag}#${el.id}`;
            }
            else if (el.className && typeof el.className === 'string') {
                const firstCls = el.className.trim().split(/\s+/).find((c) => c && !c.startsWith('is-'));
                if (firstCls)
                    topElement = `${tag}.${firstCls}`;
            }
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
        }, { state: null }, { arg: { sel: selector, x: pt.x, y: pt.y }, retries: 0 });
        const beforeProbe = await sampleProbe();
        const beforePatch = await captureCleanPatch();
        await this.session.motion.moveTo(pt.x, pt.y, {
            steps: 10,
            durationMs: 140,
            label: 'INSPECT MOTION',
        });
        if (settleMs > 0)
            await this.session.page.waitForTimeout(settleMs);
        const afterProbe = await sampleProbe();
        const afterPatch = await captureCleanPatch();
        const before = beforeProbe.state;
        const after = afterProbe.state;
        const topElement = afterProbe.topElement ?? beforeProbe.topElement ?? preInfo.topElement;
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
        const cssChanged = [...changed];
        const pixelDiffMean = beforePatch && afterPatch ? computePatchMeanPixelDiff(beforePatch, afterPatch) : null;
        const pixelChanged = pixelDiffMean !== null ? pixelDiffMean >= 0.5 : false;
        if (pixelChanged && pixelDiffMean !== null) {
            delta.pixel_diff_mean = { before: 0, after: pixelDiffMean };
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
        if (pixelChanged && changed.length === 0) {
            triggers.push('pointer-pixel-change');
        }
        const motionResult = {
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
    async inspectDom(selector, maxSamples = 5) {
        const safeLimit = Math.max(1, Math.min(10, Math.round(Number.isFinite(maxSamples) ? maxSamples : 5)));
        const fallback = {
            count: 0,
            samples: [],
            degraded: true,
            degradedReason: 'inspectDom degraded: navigation race',
        };
        return safeEvaluate(this.session.page, (arg) => {
            const els = Array.from(document.querySelectorAll(arg.sel));
            return {
                count: els.length,
                samples: els.slice(0, arg.limit).map((el) => {
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
        }, fallback, { arg: { sel: selector, limit: safeLimit }, retries: 2 });
    }
    async inspectDomForAgent(selector, maxSamples = 5) {
        const domRes = await this.inspectDom(selector, maxSamples);
        const lines = [
            `### [DOM Probe] selector=${JSON.stringify(selector)} | count=${domRes.count}${domRes.degraded ? ' (degraded)' : ''}`,
        ];
        if (domRes.count === 0) {
            lines.push('- matches: 0 (no matching DOM nodes found)');
        }
        else {
            for (let i = 0; i < domRes.samples.length; i++) {
                const s = domRes.samples[i];
                const extras = [];
                if (s.classes)
                    extras.push(`class="${s.classes.slice(0, 50)}"`);
                if (s.href)
                    extras.push(`href="${s.href}"`);
                if (s.value !== undefined)
                    extras.push(`value="${s.value}"`);
                if (s.title)
                    extras.push(`title="${s.title}"`);
                if (s.alt)
                    extras.push(`alt="${s.alt}"`);
                const styleStr = `color=${s.computedStyle.color}; bg=${s.computedStyle.backgroundColor}; font=${s.computedStyle.fontSize} ${s.computedStyle.fontFamily.slice(0, 32)}`;
                lines.push(`- [${i}] <${s.tag}> ${JSON.stringify(s.text)}${extras.length ? ' ' + extras.join(' ') : ''} | ${styleStr}`);
            }
        }
        let block = lines.join('\n');
        if (block.length > 1200) {
            block = block.slice(0, 1199) + '…';
        }
        const observation = await this.sampler.captureSnapshot('inspect_dom');
        return {
            ok: true,
            extraData: domRes,
            action: `Inspected DOM selector "${selector}": count=${domRes.count}`,
            observation,
            llmSummary: `${block}\n\n${this.sampler.formatObservationForLLM(observation)}`,
        };
    }
    async inspectRegion(opts) {
        const startedAt = Date.now();
        const radius = Math.max(40, Math.min(360, Math.round(Number.isFinite(opts.radius) ? opts.radius : 140)));
        const zoom = Math.max(1.5, Math.min(3, Number(Number.isFinite(opts.zoom) ? opts.zoom : 2)));
        let rawPt;
        let resolvedSelector = null;
        if (typeof opts.target === 'string') {
            resolvedSelector = resolveTargetSelector(opts.target);
            const probe = await this.session.motion.resolveTargetPoint(resolvedSelector, 1200);
            if (!probe.ok) {
                const observation = await this.sampler.captureSnapshot('inspect_region_refused');
                const refusalJson = JSON.stringify({
                    ok: false,
                    blocked: probe.blocked,
                    target: opts.target,
                    hint: probe.hint,
                });
                return {
                    ok: false,
                    blocked: probe.blocked,
                    ref: opts.target,
                    hit: probe.hit,
                    hint: probe.hint,
                    action: `Inspect region refused on ${opts.target} (${probe.blocked})`,
                    observation,
                    llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
                };
            }
            rawPt = probe.point;
        }
        else if (opts.target && typeof opts.target === 'object') {
            rawPt = { x: Math.round(opts.target.x), y: Math.round(opts.target.y) };
        }
        else {
            rawPt = {
                x: Math.round(Number.isFinite(opts.x) ? opts.x : 360),
                y: Math.round(Number.isFinite(opts.y) ? opts.y : 240),
            };
        }
        const domCtx = await safeEvaluate(this.session.page, (arg) => {
            const vw = Math.max(1, window.innerWidth || 1440);
            const vh = Math.max(1, window.innerHeight || 900);
            const dpr = Number(window.devicePixelRatio || 1);
            const cx = Math.max(0, Math.min(vw - 1, Math.round(arg.x)));
            const cy = Math.max(0, Math.min(vh - 1, Math.round(arg.y)));
            let el = null;
            if (arg.sel) {
                el = document.querySelector(arg.sel);
            }
            else {
                const stack = typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(cx, cy) : [];
                for (let i = 0; i < stack.length; i++) {
                    if (!stack[i].closest('#__dsh_vc_root__')) {
                        el = stack[i];
                        break;
                    }
                }
                if (!el) {
                    const single = document.elementFromPoint(cx, cy);
                    if (single && !single.closest('#__dsh_vc_root__'))
                        el = single;
                }
            }
            let topElement;
            let rect;
            let visibleText;
            if (el) {
                const tag = el.tagName.toUpperCase();
                if (el.id)
                    topElement = `${tag}#${el.id}`;
                else if (el.className && typeof el.className === 'string') {
                    const c = el.className.trim().split(/\s+/).find((k) => k && !k.startsWith('is-'));
                    topElement = c ? `${tag}.${c}` : tag;
                }
                else {
                    topElement = tag;
                }
                const r = el.getBoundingClientRect();
                rect = {
                    x: Math.round(r.left),
                    y: Math.round(r.top),
                    width: Math.round(r.width),
                    height: Math.round(r.height),
                };
                const rawTxt = (el.innerText || el.textContent || '')
                    .replace(/\s+/g, ' ')
                    .trim();
                if (rawTxt)
                    visibleText = rawTxt.slice(0, 140);
            }
            return { vw, vh, dpr, cx, cy, topElement, rect, visibleText };
        }, { vw: 1440, vh: 900, dpr: 1, cx: rawPt.x, cy: rawPt.y }, { arg: { sel: resolvedSelector, x: rawPt.x, y: rawPt.y }, retries: 0 });
        const clipX = Math.max(0, domCtx.cx - radius);
        const clipY = Math.max(0, domCtx.cy - radius);
        const clipRight = Math.min(domCtx.vw, domCtx.cx + radius);
        const clipBottom = Math.min(domCtx.vh, domCtx.cy + radius);
        const clipW = Math.max(20, clipRight - clipX);
        const clipH = Math.max(20, clipBottom - clipY);
        const maxCssEdge = Math.max(clipW, clipH);
        const dprFactor = Math.max(1, domCtx.dpr || 1);
        const effectiveScale = Math.max(0.5, Math.min(zoom, Number((1440 / Math.max(1, maxCssEdge * dprFactor)).toFixed(3))));
        const regionFile = `step_${String(this.sampler.getNextStepNumber()).padStart(2, '0')}_region.png`;
        const regionPath = path.join(this.sampler.getOutputDir(), regionFile);
        fs.mkdirSync(path.dirname(regionPath), { recursive: true });
        let pngBuf;
        const prevVis = await safeEvaluate(this.session.page, () => {
            const root = document.getElementById('__dsh_vc_root__');
            if (!root)
                return null;
            const prev = root.style.visibility;
            root.style.visibility = 'hidden';
            return prev;
        }, null, 0);
        try {
            pngBuf = await this.session.captureRegionPng({
                x: clipX,
                y: clipY,
                width: clipW,
                height: clipH,
                scale: effectiveScale,
            });
        }
        finally {
            if (prevVis !== null) {
                await safeEvaluate(this.session.page, (v) => {
                    const root = document.getElementById('__dsh_vc_root__');
                    if (root)
                        root.style.visibility = v;
                }, undefined, { arg: prevVis, retries: 0 }).catch(() => { });
            }
        }
        fs.writeFileSync(regionPath, pngBuf);
        const decoded = decodePngRgba(pngBuf);
        const avgColor = computePngAvgColorHex(pngBuf) ?? undefined;
        const cleanText = domCtx.visibleText ? normSplit(domCtx.visibleText).slice(0, 120) : undefined;
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        const region = {
            ok: true,
            x: domCtx.cx,
            y: domCtx.cy,
            radius,
            zoom,
            effectiveScale,
            width: decoded?.width ?? Math.round(clipW * effectiveScale),
            height: decoded?.height ?? Math.round(clipH * effectiveScale),
            bytes: pngBuf.byteLength,
            elapsedMs,
            imagePath: regionPath,
            ...(domCtx.topElement ? { topElement: domCtx.topElement } : {}),
            ...(domCtx.rect ? { rect: domCtx.rect } : {}),
            ...(cleanText ? { visibleText: cleanText } : {}),
            ...(avgColor ? { avgColor } : {}),
        };
        const observation = await this.sampler.captureSnapshot('inspect_region');
        const summaryLine = `[REGION_PROBE] ${formatRegionTextSummary(region)}`;
        return {
            ok: true,
            at: { x: domCtx.cx, y: domCtx.cy },
            region,
            extraData: region,
            action: `Inspected region (${domCtx.cx},${domCtx.cy}) r=${radius} zoom=${zoom}x -> ${region.width}x${region.height}px (${region.bytes}B)`,
            observation,
            llmSummary: `${summaryLine}\n\n${this.sampler.formatObservationForLLM(observation)}`,
        };
    }
    async inspectStyles(target, properties) {
        const selector = resolveTargetSelector(target);
        const probe = await this.session.motion.resolveTargetPoint(selector, 1200);
        if (!probe.ok) {
            const observation = await this.sampler.captureSnapshot('inspect_styles_refused');
            const refusalJson = JSON.stringify({
                ok: false,
                blocked: probe.blocked,
                target,
                hint: probe.hint,
            });
            return {
                ok: false,
                blocked: probe.blocked,
                ref: target,
                hit: probe.hit,
                hint: probe.hint,
                action: `Blocked inspect_styles (${target}) by ${probe.blocked}`,
                observation,
                llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
            };
        }
        const safeProps = Array.isArray(properties) && properties.length > 0
            ? properties
                .map((p) => String(p).trim())
                .filter((p) => /^[a-zA-Z][a-zA-Z0-9-]*$/.test(p))
                .slice(0, 24)
            : [...CURATED_STYLE_KEYS];
        const res = await safeEvaluate(this.session.page, (arg) => {
            const el = document.querySelector(arg.sel);
            if (!el) {
                return {
                    ok: false,
                    target: arg.targetLabel,
                    blocked: 'ELEMENT_NOT_FOUND',
                    hint: 'Element detached before style extraction',
                };
            }
            const cs = window.getComputedStyle(el);
            const r = el.getBoundingClientRect();
            const computedStyle = {};
            for (const prop of arg.props) {
                const val = cs[prop] ?? cs.getPropertyValue(prop);
                if (typeof val === 'string' && val.length > 0) {
                    computedStyle[prop] = val;
                }
            }
            return {
                ok: true,
                target: arg.targetLabel,
                tag: el.tagName.toLowerCase(),
                rect: {
                    x: Math.round(r.left),
                    y: Math.round(r.top),
                    width: Math.round(r.width),
                    height: Math.round(r.height),
                },
                boxModel: {
                    margin: `${cs.marginTop} ${cs.marginRight} ${cs.marginBottom} ${cs.marginLeft}`,
                    padding: `${cs.paddingTop} ${cs.paddingRight} ${cs.paddingBottom} ${cs.paddingLeft}`,
                    border: `${cs.borderTopWidth} ${cs.borderRightWidth} ${cs.borderBottomWidth} ${cs.borderLeftWidth}`,
                },
                computedStyle,
            };
        }, { ok: false, target, blocked: 'ELEMENT_NOT_FOUND', hint: 'inspect_styles navigation race' }, { arg: { sel: selector, targetLabel: target, props: safeProps }, retries: 1 });
        const observation = await this.sampler.captureSnapshot('inspect_styles');
        if (!res.ok) {
            const refusalJson = JSON.stringify({
                ok: false,
                blocked: res.blocked ?? 'ELEMENT_NOT_FOUND',
                target,
                hint: res.hint,
            });
            return {
                ok: false,
                blocked: res.blocked ?? 'ELEMENT_NOT_FOUND',
                ref: target,
                hint: res.hint,
                observation,
                action: `inspect_styles failed on ${target}`,
                llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
            };
        }
        const stylesBlock = formatStylesBlockWithinBudget(res, 1000);
        return {
            ok: true,
            ref: target,
            extraData: res,
            action: `Inspected styles on ${target} <${res.tag}>`,
            observation,
            llmSummary: `${stylesBlock}\n\n${this.sampler.formatObservationForLLM(observation)}`,
        };
    }
    async extractOutline(maxItems = 25) {
        const safeMax = Math.max(1, Math.min(40, Math.round(Number.isFinite(maxItems) ? maxItems : 25)));
        const raw = await safeEvaluate(this.session.page, (limit) => {
            const landmarkTags = new Set(['HEADER', 'NAV', 'MAIN', 'SECTION', 'ARTICLE', 'FOOTER']);
            const headingTags = new Set(['H1', 'H2', 'H3', 'H4']);
            const all = Array.from(document.querySelectorAll('header,nav,main,section,article,footer,h1,h2,h3,h4')).filter((el) => !el.closest('#__dsh_vc_root__'));
            let totalLandmarks = 0;
            let totalHeadings = 0;
            let hiddenOrClippedHeadings = 0;
            const items = [];
            for (const el of all) {
                const tag = el.tagName.toUpperCase();
                const cs = window.getComputedStyle(el);
                const r = el.getBoundingClientRect();
                const visible = cs.display !== 'none' &&
                    cs.visibility !== 'hidden' &&
                    Number(cs.opacity) >= 0.05 &&
                    r.width >= 1 &&
                    r.height >= 1;
                const isHeading = headingTags.has(tag);
                if (isHeading) {
                    totalHeadings++;
                    if (!visible)
                        hiddenOrClippedHeadings++;
                }
                else if (landmarkTags.has(tag)) {
                    totalLandmarks++;
                }
                if (items.length < limit) {
                    const rawText = (el.innerText || el.textContent || '')
                        .replace(/\s+/g, ' ')
                        .trim()
                        .slice(0, isHeading ? 140 : 60);
                    const labelText = el.getAttribute('aria-label')?.trim() || rawText;
                    items.push({
                        kind: isHeading ? 'heading' : 'landmark',
                        tag: tag.toLowerCase(),
                        text: labelText,
                        y: Math.round(r.top + window.scrollY),
                        visible,
                    });
                }
            }
            const canvasCount = document.querySelectorAll('canvas:not(#__dsh_vc_root__ canvas)').length;
            return { totalLandmarks, totalHeadings, hiddenOrClippedHeadings, canvasCount, items };
        }, { totalLandmarks: 0, totalHeadings: 0, hiddenOrClippedHeadings: 0, canvasCount: 0, items: [] }, { arg: safeMax, retries: 1 });
        const normalizedItems = raw.items.map((item) => ({
            ...item,
            text: (item.kind === 'heading' ? normSplit(item.text) : item.text).slice(0, 80),
        }));
        const visibleHeadingCount = normalizedItems.filter((i) => i.kind === 'heading' && i.visible && i.text).length;
        const headingsReason = visibleHeadingCount === 0
            ? raw.canvasCount > 0 && raw.totalHeadings === 0
                ? '标题可能在 <canvas> 内'
                : raw.hiddenOrClippedHeadings > 0
                    ? '标题被裁切或隐藏'
                    : '无 h1-h4 标题'
            : undefined;
        const result = {
            ok: true,
            totalLandmarks: raw.totalLandmarks,
            totalHeadings: raw.totalHeadings,
            ...(headingsReason ? { headingsReason } : {}),
            items: normalizedItems,
        };
        const lines = [
            `### [Outline Probe] landmarks=${result.totalLandmarks} · headings=${result.totalHeadings}${headingsReason ? ` (${headingsReason})` : ''}`,
        ];
        for (const item of normalizedItems) {
            const visFlag = item.visible ? '' : ' [hidden]';
            const line = `- [${item.kind}] <${item.tag}> y=${item.y}${visFlag}: ${JSON.stringify(item.text)}`;
            if (lines.join('\n').length + line.length + 1 > 1200)
                break;
            lines.push(line);
        }
        const block = lines.join('\n').slice(0, 1200);
        const observation = await this.sampler.captureSnapshot('extract_outline');
        return {
            ok: true,
            extraData: result,
            action: `Extracted outline: landmarks=${result.totalLandmarks}, headings=${result.totalHeadings}`,
            observation,
            llmSummary: `${block}\n\n${this.sampler.formatObservationForLLM(observation)}`,
        };
    }
    async inspectMedia(maxItems = 12) {
        const safeMax = Math.max(1, Math.min(20, Math.round(Number.isFinite(maxItems) ? maxItems : 12)));
        const result = await safeEvaluate(this.session.page, (limit) => {
            const imgs = Array.from(document.querySelectorAll('img')).filter((el) => !el.closest('#__dsh_vc_root__'));
            const videos = Array.from(document.querySelectorAll('video')).filter((el) => !el.closest('#__dsh_vc_root__'));
            const canvases = Array.from(document.querySelectorAll('canvas')).filter((el) => !el.closest('#__dsh_vc_root__'));
            const svgs = Array.from(document.querySelectorAll('svg')).filter((el) => !el.closest('#__dsh_vc_root__'));
            const items = [];
            for (const el of canvases) {
                if (items.length >= limit)
                    break;
                const r = el.getBoundingClientRect();
                items.push({
                    kind: 'canvas',
                    info: `intrinsic=${el.width}x${el.height} css=${Math.round(r.width)}x${Math.round(r.height)}`,
                });
            }
            for (const el of videos) {
                if (items.length >= limit)
                    break;
                const dur = Number.isFinite(el.duration) ? `${el.duration.toFixed(1)}s` : 'live/na';
                items.push({
                    kind: 'video',
                    info: `size=${el.videoWidth}x${el.videoHeight} readyState=${el.readyState} paused=${el.paused} duration=${dur}`,
                });
            }
            for (const el of imgs) {
                if (items.length >= limit)
                    break;
                const r = el.getBoundingClientRect();
                const src = (el.getAttribute('src') || el.currentSrc || '').trim().slice(0, 80);
                const alt = (el.getAttribute('alt') || '').trim().slice(0, 40);
                items.push({
                    kind: 'img',
                    info: `natural=${el.naturalWidth}x${el.naturalHeight} css=${Math.round(r.width)}x${Math.round(r.height)} complete=${el.complete}${alt ? ` alt=${JSON.stringify(alt)}` : ''} src=${JSON.stringify(src)}`,
                });
            }
            for (const el of svgs) {
                if (items.length >= limit)
                    break;
                const r = el.getBoundingClientRect();
                if (r.width < 24 && r.height < 24)
                    continue;
                items.push({
                    kind: 'svg',
                    info: `css=${Math.round(r.width)}x${Math.round(r.height)} children=${el.children.length}`,
                });
            }
            return {
                ok: true,
                counts: {
                    img: imgs.length,
                    video: videos.length,
                    canvas: canvases.length,
                    svg: svgs.length,
                },
                items,
            };
        }, {
            ok: true,
            counts: { img: 0, video: 0, canvas: 0, svg: 0 },
            items: [],
            degraded: true,
            degradedReason: 'inspectMedia degraded: navigation race',
        }, { arg: safeMax, retries: 1 });
        const header = `### [Media Probe] img=${result.counts.img} · video=${result.counts.video} · canvas=${result.counts.canvas} · svg=${result.counts.svg}`;
        const lines = [header];
        for (const item of result.items) {
            const line = `- [${item.kind}] ${item.info}`;
            if (lines.join('\n').length + line.length + 1 > 1200)
                break;
            lines.push(line);
        }
        const block = lines.join('\n').slice(0, 1200);
        const observation = await this.sampler.captureSnapshot('inspect_media');
        return {
            ok: true,
            extraData: result,
            action: `Inspected media: img=${result.counts.img}, video=${result.counts.video}, canvas=${result.counts.canvas}, svg=${result.counts.svg}`,
            observation,
            llmSummary: `${block}\n\n${this.sampler.formatObservationForLLM(observation)}`,
        };
    }
    async setViewport(opts) {
        const emu = await this.session.setViewport(opts);
        const observation = await this.sampler.captureSnapshot(opts.reset ? 'set_viewport_reset' : 'set_viewport');
        const actionDesc = opts.reset || !emu
            ? 'Reset viewport to physical window size'
            : `Set viewport to ${emu.width}x${emu.height} @${emu.deviceScaleFactor}x`;
        return {
            ok: true,
            action: actionDesc,
            observation,
            extraData: emu,
            llmSummary: this.sampler.formatObservationForLLM(observation),
        };
    }
    async waitFor(opts) {
        const hasCondition = Boolean(opts.selector ||
            opts.goneSelector ||
            (opts.text && opts.text.trim().length > 0) ||
            opts.networkIdle ||
            opts.animationsSettled);
        if (!hasCondition) {
            const observation = await this.sampler.captureSnapshot('wait_for_invalid');
            return {
                ok: false,
                hint: 'wait_for requires at least one condition (selector, goneSelector, text, networkIdle, animationsSettled)',
                action: 'wait_for skipped: no condition provided',
                observation,
                llmSummary: `[WAIT_INVALID] {"ok":false,"error":"no_condition"}\n\n${this.sampler.formatObservationForLLM(observation)}`,
            };
        }
        const timeoutMs = Math.max(200, Math.min(15000, Math.round(opts.timeoutMs ?? 6000)));
        const startedAt = Date.now();
        const deadline = startedAt + timeoutMs;
        let networkIdleDone = !opts.networkIdle;
        if (opts.networkIdle) {
            networkIdleDone = await this.session.page
                .waitForLoadState('networkidle', { timeout: Math.min(timeoutMs, 2500) })
                .then(() => true)
                .catch(() => false);
        }
        const selResolved = opts.selector ? resolveTargetSelector(opts.selector) : null;
        const goneResolved = opts.goneSelector ? resolveTargetSelector(opts.goneSelector) : null;
        const textNeedle = opts.text && opts.text.trim() ? opts.text.trim().toLowerCase() : null;
        const needAnim = Boolean(opts.animationsSettled);
        let lastTextCheckAt = 0;
        let lastTextOk = !textNeedle;
        let abortedByTakeover = false;
        let satisfied = [];
        let pending = [];
        while (true) {
            if (await this.session.checkHumanTakeoverRequested().catch(() => false)) {
                abortedByTakeover = true;
                break;
            }
            const now = Date.now();
            const checkTextThisTick = Boolean(textNeedle && (!lastTextCheckAt || now - lastTextCheckAt >= 250));
            if (checkTextThisTick) {
                lastTextCheckAt = now;
            }
            const probe = await safeEvaluate(this.session.page, (arg) => {
                const isElVisible = (el) => {
                    if (!el)
                        return false;
                    const cs = window.getComputedStyle(el);
                    if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) <= 0.01) {
                        return false;
                    }
                    const r = el.getBoundingClientRect();
                    return r.width >= 1 && r.height >= 1;
                };
                let selectorOk = true;
                if (arg.sel) {
                    const matched = Array.from(document.querySelectorAll(arg.sel));
                    selectorOk = matched.some((el) => isElVisible(el));
                }
                let goneOk = true;
                if (arg.gone) {
                    const matched = Array.from(document.querySelectorAll(arg.gone));
                    goneOk = matched.length === 0 || matched.every((el) => !isElVisible(el));
                }
                let textOk = null;
                if (arg.text) {
                    const body = document.body;
                    const rawContent = body ? (body.textContent || '').toLowerCase() : '';
                    if (!rawContent.includes(arg.text)) {
                        textOk = false;
                    }
                    else {
                        const visibleText = body ? (body.innerText || '').toLowerCase() : '';
                        textOk = visibleText.includes(arg.text);
                    }
                }
                let animOk = true;
                if (arg.checkAnim && typeof document.getAnimations === 'function') {
                    const runningFinite = document.getAnimations().filter((anim) => {
                        if (anim.playState !== 'running')
                            return false;
                        try {
                            const timing = anim.effect?.getTiming?.();
                            if (timing && timing.iterations === Infinity)
                                return false;
                        }
                        catch { }
                        const effectTarget = anim.effect?.target;
                        if (effectTarget && effectTarget instanceof Element) {
                            try {
                                const cs = window.getComputedStyle(effectTarget);
                                if (cs.animationIterationCount && cs.animationIterationCount.includes('infinite')) {
                                    return false;
                                }
                            }
                            catch { }
                        }
                        return true;
                    });
                    animOk = runningFinite.length === 0;
                }
                return { selectorOk, goneOk, textOk, animOk };
            }, { selectorOk: !selResolved, goneOk: !goneResolved, textOk: textNeedle ? false : null, animOk: !needAnim }, {
                arg: {
                    sel: selResolved,
                    gone: goneResolved,
                    text: checkTextThisTick ? textNeedle : null,
                    checkAnim: needAnim,
                },
                retries: 0,
            }).catch(() => ({
                selectorOk: !selResolved,
                goneOk: !goneResolved,
                textOk: textNeedle ? false : null,
                animOk: !needAnim,
            }));
            if (checkTextThisTick && probe.textOk !== null) {
                lastTextOk = probe.textOk;
            }
            satisfied = [];
            pending = [];
            if (opts.networkIdle)
                (networkIdleDone ? satisfied : pending).push('networkIdle');
            if (selResolved)
                (probe.selectorOk ? satisfied : pending).push(`selector:${opts.selector}`);
            if (goneResolved)
                (probe.goneOk ? satisfied : pending).push(`goneSelector:${opts.goneSelector}`);
            if (textNeedle)
                (lastTextOk ? satisfied : pending).push(`text:${opts.text}`);
            if (needAnim)
                (probe.animOk ? satisfied : pending).push('animationsSettled');
            if (pending.length === 0) {
                const elapsedMs = Math.max(0, Date.now() - startedAt);
                const waitResult = {
                    ok: true,
                    timed_out: false,
                    elapsed_ms: elapsedMs,
                    satisfied,
                    pending: [],
                };
                const observation = await this.sampler.captureSnapshot('wait_for');
                return {
                    ok: true,
                    waitResult,
                    extraData: waitResult,
                    action: `wait_for satisfied [${satisfied.join(', ')}] in ${elapsedMs}ms`,
                    observation,
                    llmSummary: `[WAIT_SATISFIED] ${JSON.stringify(waitResult)}\n\n${this.sampler.formatObservationForLLM(observation)}`,
                };
            }
            if (Date.now() >= deadline) {
                break;
            }
            await this.session.page.waitForTimeout(120).catch(() => { });
        }
        const elapsedMs = Math.max(0, Date.now() - startedAt);
        const waitResult = {
            ok: false,
            timed_out: !abortedByTakeover,
            ...(abortedByTakeover ? { aborted_by_takeover: true } : {}),
            elapsed_ms: elapsedMs,
            satisfied,
            pending,
        };
        const observation = await this.sampler.captureSnapshot('wait_for_timeout');
        return {
            ok: false,
            waitResult,
            extraData: waitResult,
            hint: abortedByTakeover
                ? 'wait_for aborted due to human takeover'
                : `wait_for timed out after ${elapsedMs}ms; pending=[${pending.join(', ')}]`,
            action: abortedByTakeover
                ? `wait_for interrupted by human takeover (${elapsedMs}ms)`
                : `wait_for timed out (${elapsedMs}ms); pending=[${pending.join(', ')}]`,
            observation,
            llmSummary: `[WAIT_TIMEOUT] ${JSON.stringify(waitResult)}\n\n${this.sampler.formatObservationForLLM(observation)}`,
        };
    }
    async pressKey(key, repeat = 1) {
        const rawKey = String(key ?? '').trim();
        const takeoverHotkey = this.session.options?.takeoverHotkey ?? 'F8';
        if (!rawKey || isReservedHotkey(rawKey, takeoverHotkey)) {
            const observation = await this.sampler.captureSnapshot('press_key_blocked');
            const hint = `保留热键 (${rawKey || 'empty'}) 已被拦截，不允许子代理派发 F8 / 含 F8 组合键 / Alt+F4`;
            const refusalJson = JSON.stringify({
                ok: false,
                blocked: 'RESERVED_HOTKEY',
                key: rawKey,
                hint,
            });
            return {
                ok: false,
                blocked: 'RESERVED_HOTKEY',
                hit: rawKey,
                hint,
                action: `Blocked press_key (${rawKey}) by RESERVED_HOTKEY`,
                observation,
                llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
            };
        }
        const normalizedKey = normalizePlaywrightKey(rawKey);
        const times = Math.max(1, Math.min(10, Math.round(Number.isFinite(repeat) ? repeat : 1)));
        this.session.consumePendingPromptDialog?.();
        await this.session.withAgentNavigationAllowed(async () => {
            for (let i = 0; i < times; i++) {
                await this.session.page.keyboard.press(normalizedKey);
                if (i + 1 < times) {
                    await this.session.page.waitForTimeout(45);
                }
            }
            await this.session.page.waitForTimeout(180);
            await this.session.page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => { });
        });
        const promptDialog = this.session.consumePendingPromptDialog?.();
        const observation = await this.sampler.captureSnapshot('press_key');
        if (promptDialog) {
            const refusalJson = JSON.stringify({
                ok: false,
                blocked: 'PROMPT_REQUIRES_HUMAN',
                message: promptDialog.message,
            });
            return {
                ok: false,
                blocked: 'PROMPT_REQUIRES_HUMAN',
                promptDialog,
                hint: `按键触发了 prompt("${promptDialog.message}")，已自动取消并暂停等待人工处理`,
                action: `press_key(${rawKey}) triggered prompt()`,
                observation,
                llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
            };
        }
        return {
            ok: true,
            action: times > 1 ? `Pressed key ${rawKey} ×${times}` : `Pressed key ${rawKey}`,
            observation,
            llmSummary: this.sampler.formatObservationForLLM(observation),
        };
    }
    async selectOption(target, opts) {
        const selector = resolveTargetSelector(target);
        const probe = await this.session.motion.resolveTargetPoint(selector, 1200);
        if (!probe.ok) {
            const observation = await this.sampler.captureSnapshot('select_option_blocked');
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
                action: `Blocked select_option (${target}) by ${probe.blocked}`,
                observation,
                llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
            };
        }
        await this.session.motion.moveTo(probe.point.x, probe.point.y, { label: `SELECT ${target}` });
        this.session.consumePendingPromptDialog?.();
        const loc = this.session.page.locator(selector).first();
        let optionSpec = {};
        if (typeof opts.value === 'string')
            optionSpec = { value: opts.value };
        else if (typeof opts.label === 'string')
            optionSpec = { label: opts.label };
        else if (typeof opts.index === 'number' && Number.isFinite(opts.index)) {
            optionSpec = { index: Math.max(0, Math.round(opts.index)) };
        }
        await this.session.withAgentNavigationAllowed(async () => {
            await loc.selectOption(optionSpec, { timeout: 3000 });
            await this.session.page.waitForTimeout(180);
            await this.session.page.waitForLoadState('domcontentloaded', { timeout: 3000 }).catch(() => { });
        });
        const selected = await safeEvaluate(this.session.page, (sel) => {
            const el = document.querySelector(sel);
            if (!el)
                return { selectedValue: '', selectedLabel: '' };
            const opt = el.selectedOptions && el.selectedOptions[0];
            return {
                selectedValue: el.value ?? '',
                selectedLabel: (opt ? opt.text : '').trim(),
            };
        }, { selectedValue: '', selectedLabel: '' }, { arg: selector, retries: 1 }).catch(() => ({ selectedValue: '', selectedLabel: '' }));
        const promptDialog = this.session.consumePendingPromptDialog?.();
        const observation = await this.sampler.captureSnapshot('select_option');
        if (promptDialog) {
            const refusalJson = JSON.stringify({
                ok: false,
                blocked: 'PROMPT_REQUIRES_HUMAN',
                message: promptDialog.message,
            });
            return {
                ok: false,
                blocked: 'PROMPT_REQUIRES_HUMAN',
                ref: target,
                promptDialog,
                extraData: selected,
                hint: `下拉选择触发了 prompt("${promptDialog.message}")，已自动取消并暂停等待人工处理`,
                action: `select_option(${target}) triggered prompt()`,
                observation,
                llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
            };
        }
        return {
            ok: true,
            ref: target,
            extraData: selected,
            action: `Selected option (${selected.selectedLabel || selected.selectedValue}) on ${target}`,
            observation,
            llmSummary: `[SELECT_RESULT] ${JSON.stringify(selected)}\n\n${this.sampler.formatObservationForLLM(observation)}`,
        };
    }
    async goBack(opts) {
        return await this.runHistoryNav('back', opts);
    }
    async goForward(opts) {
        return await this.runHistoryNav('forward', opts);
    }
    async reload(opts) {
        return await this.runHistoryNav('reload', opts);
    }
    async runHistoryNav(kind, opts) {
        const waitUntil = opts?.waitUntil ?? 'domcontentloaded';
        const timeoutMs = Number.isFinite(opts?.timeoutMs)
            ? Math.max(1000, Math.min(120000, Math.round(opts.timeoutMs)))
            : 15000;
        const startedAt = Date.now();
        const tag = kind === 'back' ? 'go_back' : kind === 'forward' ? 'go_forward' : 'reload';
        if (this.session.motion.isUnloadGuardEnabled()) {
            await safeEvaluate(this.session.page, () => {
                window.__dshCursorAPI?.setUnloadGuard?.(false);
            }, undefined, 0).catch(() => { });
        }
        if (kind === 'back' || kind === 'forward') {
            const navHist = await this.session.getNavigationHistory?.().catch(() => null);
            if (navHist) {
                const noBackTarget = kind === 'back' &&
                    (navHist.currentIndex <= 0 ||
                        navHist.entries[navHist.currentIndex - 1]?.url === 'about:blank');
                const noForwardTarget = kind === 'forward' && navHist.currentIndex >= navHist.entries.length - 1;
                if (noBackTarget || noForwardTarget) {
                    const observation = await this.sampler.captureSnapshot(`${tag}_no_history`);
                    const payload = JSON.stringify({ ok: false, no_history: true, direction: kind });
                    return {
                        ok: false,
                        no_history: true,
                        hint: `No ${kind} browser history available`,
                        action: `${tag}: no history available`,
                        observation,
                        llmSummary: `[NO_HISTORY] ${payload}\n\n${this.sampler.formatObservationForLLM(observation)}`,
                    };
                }
            }
        }
        const beforeUrl = (() => {
            try {
                return this.session.page.url();
            }
            catch {
                return '';
            }
        })();
        const { response, timedOut } = await this.session.withAgentNavigationAllowed(async () => {
            let resp = null;
            let to = false;
            try {
                if (kind === 'back') {
                    resp = await this.session.page.goBack({ waitUntil, timeout: timeoutMs });
                }
                else if (kind === 'forward') {
                    resp = await this.session.page.goForward({ waitUntil, timeout: timeoutMs });
                }
                else {
                    resp = await this.session.page.reload({ waitUntil, timeout: timeoutMs });
                }
            }
            catch (err) {
                const msg = String(err?.message ?? err);
                if (/Timeout/i.test(msg)) {
                    to = true;
                }
                else {
                    throw err;
                }
            }
            return { response: resp, timedOut: to };
        });
        const afterUrl = (() => {
            try {
                return this.session.page.url();
            }
            catch {
                return '';
            }
        })();
        if ((kind === 'back' || kind === 'forward') && response === null && afterUrl === beforeUrl && !timedOut) {
            const observation = await this.sampler.captureSnapshot(`${tag}_no_history`);
            const payload = JSON.stringify({ ok: false, no_history: true, direction: kind });
            return {
                ok: false,
                no_history: true,
                hint: `No ${kind} browser history available`,
                action: `${tag}: no history available`,
                observation,
                llmSummary: `[NO_HISTORY] ${payload}\n\n${this.sampler.formatObservationForLLM(observation)}`,
            };
        }
        await this.sampler.invalidateRefs({ bumpRefOffset: true });
        await this.session.page.waitForTimeout(300).catch(() => { });
        await this.session.motion.ensureCursorHUD(true).catch(() => { });
        const navigation = {
            wait_until: waitUntil,
            timed_out: timedOut,
            elapsed_ms: Math.max(0, Date.now() - startedAt),
            final_url: this.session.page.url(),
        };
        const promptDialog = this.session.consumePendingPromptDialog?.();
        const observation = await this.sampler.captureSnapshot(tag);
        observation.navigation = navigation;
        if (promptDialog) {
            const refusalJson = JSON.stringify({
                ok: false,
                blocked: 'PROMPT_REQUIRES_HUMAN',
                message: promptDialog.message,
            });
            return {
                ok: false,
                blocked: 'PROMPT_REQUIRES_HUMAN',
                promptDialog,
                navigation,
                hint: `${tag} 触发了 prompt("${promptDialog.message}")，已自动取消并暂停等待人工处理`,
                action: `${tag} triggered prompt()`,
                observation,
                llmSummary: `[ACTION_REFUSED] ${refusalJson}\n\n${this.sampler.formatObservationForLLM(observation)}`,
            };
        }
        return {
            ok: true,
            navigation,
            action: `${tag} -> ${navigation.final_url}`,
            observation,
            llmSummary: this.sampler.formatObservationForLLM(observation),
        };
    }
    /**
     * Read-only declarative list extraction using CSS selectors and an attribute whitelist.
     * Never executes arbitrary user-supplied JS expressions; masks password values.
     */
    async extractList(spec) {
        const itemSelector = String(spec.itemSelector ?? '').trim().slice(0, 200);
        const currentUrl = (() => {
            try {
                return this.session.page.url();
            }
            catch {
                return '';
            }
        })();
        if (!itemSelector) {
            return {
                ok: false,
                selector: '',
                url: currentUrl,
                matchedCount: 0,
                extractedCount: 0,
                items: [],
                truncated: false,
                degraded: true,
                degradedReason: 'EMPTY_SELECTOR',
            };
        }
        const normalizedFields = parseExtractFieldsSpec(spec.fields);
        const maxItems = Math.max(1, Math.min(1000, Math.round(Number.isFinite(Number(spec.maxItems)) ? Number(spec.maxItems) : 200)));
        const includeEmpty = Boolean(spec.includeEmpty);
        const fallback = {
            ok: false,
            selector: itemSelector,
            url: currentUrl,
            matchedCount: 0,
            extractedCount: 0,
            items: [],
            truncated: false,
            degraded: true,
            degradedReason: 'extractList degraded: navigation race',
        };
        return safeEvaluate(this.session.page, (arg) => {
            const url = location.href;
            let nodes = [];
            try {
                nodes = Array.from(document.querySelectorAll(arg.sel));
            }
            catch (err) {
                return {
                    ok: false,
                    selector: arg.sel,
                    url,
                    matchedCount: 0,
                    extractedCount: 0,
                    items: [],
                    truncated: false,
                    degraded: true,
                    degradedReason: `INVALID_SELECTOR: ${String(err?.message ?? err).slice(0, 120)}`,
                };
            }
            const items = [];
            const fieldSpecs = arg.fields
                ? Object.entries(arg.fields)
                : [
                    ['text', { attr: 'text', trim: true }],
                    ['href', { attr: 'href', trim: true }],
                    ['src', { attr: 'src', trim: true }],
                ];
            for (const el of nodes.slice(0, arg.limit)) {
                const row = {};
                for (const [fieldKey, fSpec] of fieldSpecs) {
                    let val = null;
                    let target = el;
                    if (fSpec.selector && fSpec.selector !== 'self') {
                        try {
                            target = el.querySelector(fSpec.selector);
                        }
                        catch {
                            target = null;
                        }
                    }
                    if (target) {
                        const attr = (fSpec.attr || 'text').toLowerCase();
                        const shouldTrim = fSpec.trim !== false;
                        if (attr === 'text') {
                            const rawText = (target.innerText || target.textContent || '');
                            const clean = shouldTrim ? rawText.replace(/\s+/g, ' ').trim() : rawText;
                            val = clean ? clean.slice(0, 600) : null;
                        }
                        else if (attr === 'href' || attr === 'src') {
                            const rawRef = attr === 'href'
                                ? target.getAttribute('href') || target.querySelector('a[href]')?.getAttribute('href') || null
                                : target.getAttribute('src') || target.getAttribute('data-src');
                            if (rawRef) {
                                const trimmedRef = rawRef.trim();
                                if (trimmedRef && !/^javascript:/i.test(trimmedRef)) {
                                    try {
                                        val = new URL(trimmedRef, url).href;
                                    }
                                    catch {
                                        val = trimmedRef.slice(0, 300);
                                    }
                                }
                            }
                        }
                        else if (attr === 'value') {
                            if (target instanceof HTMLInputElement && target.type === 'password') {
                                val = '[REDACTED]';
                            }
                            else if ('value' in target && typeof target.value === 'string') {
                                const v = target.value;
                                val = v ? (shouldTrim ? v.trim() : v).slice(0, 300) : null;
                            }
                        }
                        else {
                            const attrName = attr === 'title' || attr === 'alt'
                                ? attr
                                : attr.startsWith('attr:')
                                    ? attr.slice(5)
                                    : '';
                            if (attrName) {
                                if (attrName.toLowerCase() === 'value' &&
                                    target instanceof HTMLInputElement &&
                                    target.type === 'password') {
                                    val = '[REDACTED]';
                                }
                                else {
                                    const rawAttr = target.getAttribute(attrName);
                                    if (rawAttr !== null) {
                                        const cleanAttr = shouldTrim ? rawAttr.replace(/\s+/g, ' ').trim() : rawAttr;
                                        val = cleanAttr ? cleanAttr.slice(0, 300) : null;
                                    }
                                }
                            }
                        }
                    }
                    if (arg.fields || fieldKey === 'text' || val !== null) {
                        row[fieldKey] = val;
                    }
                }
                const hasValue = Object.values(row).some((v) => v !== null && v !== '');
                if (hasValue || arg.includeEmpty) {
                    items.push(row);
                }
            }
            return {
                ok: true,
                selector: arg.sel,
                url,
                matchedCount: nodes.length,
                extractedCount: items.length,
                items,
                truncated: nodes.length > arg.limit,
            };
        }, fallback, {
            arg: {
                sel: itemSelector,
                fields: normalizedFields ?? null,
                limit: maxItems,
                includeEmpty,
            },
            retries: 2,
        });
    }
    async extractListForAgent(spec) {
        const res = await this.extractList(spec);
        const lines = [
            `### [Extract List] selector=${JSON.stringify(res.selector)} | matched=${res.matchedCount} | extracted=${res.extractedCount}${res.truncated ? ' (truncated)' : ''}${res.degraded ? ` (${res.degradedReason ?? 'degraded'})` : ''}`,
        ];
        if (res.items.length === 0) {
            lines.push('- items: [] (count=0)');
        }
        else {
            for (let i = 0; i < Math.min(3, res.items.length); i++) {
                lines.push(`- [${i}] ${JSON.stringify(res.items[i]).slice(0, 260)}`);
            }
            if (res.items.length > 3) {
                lines.push(`- ... (${res.items.length - 3} more items buffered cleanly)`);
            }
        }
        const header = lines.join('\n').slice(0, 1200);
        const observation = await this.sampler.captureSnapshot('extract_list');
        return {
            ok: res.ok,
            extractResult: res,
            action: `Extracted ${res.extractedCount}/${res.matchedCount} rows matching ${res.selector}`,
            observation,
            llmSummary: `${header}\n\n${this.sampler.formatObservationForLLM(observation)}`,
        };
    }
}
