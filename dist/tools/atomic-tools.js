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
    async navigate(url, waitMs = 800) {
        await this.session.navigate(url, 'networkidle');
        if (waitMs > 0)
            await this.session.page.waitForTimeout(waitMs);
        const observation = await this.sampler.captureSnapshot('navigate');
        return {
            action: `Navigated to ${url}`,
            observation,
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
            await this.session.motion.hoverSelector(selector, { label: `HOVER ${target}` });
        }
        else {
            await this.session.motion.moveTo(target.x, target.y, { label: `HOVER (${target.x},${target.y})` });
        }
        const observation = await this.sampler.captureSnapshot('hover');
        return {
            action: `Hovered over ${typeof target === 'string' ? target : `(${target.x},${target.y})`}`,
            observation,
            llmSummary: this.sampler.formatObservationForLLM(observation),
        };
    }
    async click(target, waitMs = 240) {
        if (typeof target === 'string') {
            const selector = resolveTargetSelector(target);
            await this.session.motion.clickSelector(selector, { label: `CLICK ${target}` });
        }
        else {
            await this.session.motion.clickAt(target.x, target.y, { label: `CLICK (${target.x},${target.y})` });
        }
        if (waitMs > 0)
            await this.session.page.waitForTimeout(waitMs);
        const observation = await this.sampler.captureSnapshot('click');
        return {
            action: `Clicked ${typeof target === 'string' ? target : `(${target.x},${target.y})`}`,
            observation,
            llmSummary: this.sampler.formatObservationForLLM(observation),
        };
    }
    async typeText(target, text, pressEnter = false) {
        const selector = resolveTargetSelector(target);
        await this.session.motion.clickSelector(selector, { label: `FOCUS ${target}` });
        await this.session.page.keyboard.type(text, { delay: 35 });
        if (pressEnter) {
            await this.session.page.keyboard.press('Enter');
        }
        await this.session.page.waitForTimeout(200);
        const observation = await this.sampler.captureSnapshot('type_text');
        return {
            action: `Typed "${text}" into ${target}`,
            observation,
            llmSummary: this.sampler.formatObservationForLLM(observation),
        };
    }
    async scroll(directionOrDelta = 'down', waitMs = 300) {
        const deltaY = typeof directionOrDelta === 'number'
            ? directionOrDelta
            : directionOrDelta === 'down'
                ? 760
                : -760;
        await this.session.motion.smoothScroll(deltaY, 18, 380);
        if (waitMs > 0)
            await this.session.page.waitForTimeout(waitMs);
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
