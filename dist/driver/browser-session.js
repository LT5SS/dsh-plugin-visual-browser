import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { buildVirtualCursorInitScript } from '../injected/virtual-cursor.js';
import { HumanMotionController } from './human-motion.js';
import { isNavigationRaceError, safeEvaluate } from '../sampler/page-snapshot.js';
import { TelemetryCollector } from '../sampler/telemetry-collector.js';
import { launchChromeNoActivateWin32, resolveBrowserWindowMode, terminateLaunchedChrome, } from './window-manager.js';
const LOCAL_BROWSER_CANDIDATES = [
    process.env.DSH_BROWSER_EXECUTABLE,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google\\Chrome\\Application\\chrome.exe') : undefined,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium-browser',
].filter(Boolean);
export function isTransientNavigationError(error) {
    const message = String(error?.message ?? error);
    return /ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ERR_CONNECTION_ABORTED|ERR_CONNECTION_CLOSED|ERR_TIMED_OUT/i.test(message);
}
export function findLocalBrowserExecutable() {
    for (const candidate of LOCAL_BROWSER_CANDIDATES) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    throw new Error('No local Chrome or Edge executable found. Set DSH_BROWSER_EXECUTABLE or pass executablePath.');
}
export class BrowserSession {
    options;
    activeMode = 'local-background';
    resolvedWindowMode = 'visible-background';
    launchedPid;
    launchedHwnd;
    disconnected = false;
    onDisconnected;
    browser;
    context;
    page;
    motion;
    telemetry;
    isAttachedCDP = false;
    ephemeralProfileDir;
    humanTakeoverRequested = false;
    humanTakeoverSource = null;
    takeoverBindingInstalled = false;
    resumeBindingInstalled = false;
    styleBindingInstalled = false;
    closingIntentionally = false;
    navigatingViaSession = false;
    lastMainFrameDocUrl = '';
    disconnectListeners = new Set();
    resumeListeners = new Set();
    constructor(opts = {}) {
        const resolvedWindowMode = resolveBrowserWindowMode(opts);
        this.resolvedWindowMode = resolvedWindowMode;
        this.options = {
            mode: opts.mode ?? 'auto',
            viewport: opts.viewport ?? { width: 1440, height: 900 },
            backgroundSilent: opts.backgroundSilent ?? (resolvedWindowMode === 'headless'),
            ...opts,
        };
    }
    isAlive() {
        try {
            if (this.disconnected)
                return false;
            return Boolean(this.browser && this.browser.isConnected() && this.page && !this.page.isClosed());
        }
        catch {
            return false;
        }
    }
    addDisconnectListener(listener) {
        this.disconnectListeners.add(listener);
        return () => {
            this.disconnectListeners.delete(listener);
        };
    }
    handleBrowserDisconnected() {
        if (this.disconnected)
            return;
        this.disconnected = true;
        if (this.closingIntentionally)
            return;
        try {
            this.onDisconnected?.();
        }
        catch {
            // ignore listener errors
        }
        for (const cb of [...this.disconnectListeners]) {
            try {
                cb();
            }
            catch {
                // ignore listener errors
            }
        }
    }
    stripUrlHash(rawUrl) {
        try {
            const parsed = new URL(rawUrl);
            parsed.hash = '';
            return parsed.href;
        }
        catch {
            const idx = rawUrl.indexOf('#');
            return idx >= 0 ? rawUrl.slice(0, idx) : rawUrl;
        }
    }
    async checkHumanTakeoverRequested() {
        if (this.humanTakeoverRequested)
            return true;
        if (!this.page)
            return false;
        const probed = await safeEvaluate(this.page, () => ({
            requested: Boolean(window.__dshTakeoverRequested),
            source: typeof window.__dshTakeoverSource === 'string' &&
                window.__dshTakeoverSource.trim()
                ? String(window.__dshTakeoverSource).trim()
                : null,
        }), { requested: false, source: null }, 0).catch(() => ({ requested: false, source: null }));
        if (probed.requested) {
            this.humanTakeoverRequested = true;
            if (probed.source) {
                this.humanTakeoverSource = probed.source;
            }
        }
        return this.humanTakeoverRequested;
    }
    getHumanTakeoverSource() {
        return this.humanTakeoverSource;
    }
    async resetHumanTakeoverRequest() {
        this.humanTakeoverRequested = false;
        this.humanTakeoverSource = null;
        await this.motion?.resetTakeoverRequest().catch(() => { });
    }
    addResumeListener(listener) {
        this.resumeListeners.add(listener);
        return () => {
            this.resumeListeners.delete(listener);
        };
    }
    async checkAndClearResumeRequested() {
        if (!this.isAlive() || !this.page)
            return false;
        return await safeEvaluate(this.page, () => {
            if (window.__dshResumeRequested) {
                window.__dshResumeRequested = false;
                return true;
            }
            return false;
        }, false, 0).catch(() => false);
    }
    async start() {
        this.resolvedWindowMode = resolveBrowserWindowMode(this.options);
        const showTakeover = this.options.showTakeoverControl ?? (this.resolvedWindowMode !== 'headless');
        const cdpUrl = this.options.cdpEndpoint ||
            process.env.DSH_WEBVIEW_CDP_URL ||
            process.env.DSH_CDP_ENDPOINT;
        const shouldAttachCDP = this.options.mode === 'dsh-electron-webview' ||
            this.options.mode === 'cdp-attach' ||
            (this.options.mode === 'auto' && Boolean(cdpUrl));
        if (shouldAttachCDP && cdpUrl) {
            this.activeMode =
                this.options.mode === 'cdp-attach' ? 'cdp-attach' : 'dsh-electron-webview';
            this.isAttachedCDP = true;
            this.browser = await chromium.connectOverCDP(cdpUrl);
            const existingContexts = this.browser.contexts();
            this.context =
                existingContexts[0] ?? (await this.browser.newContext({ viewport: this.options.viewport }));
            const existingPages = this.context.pages();
            this.page = existingPages[0] ?? (await this.context.newPage());
        }
        else if (this.resolvedWindowMode !== 'headless' && process.platform === 'win32') {
            this.activeMode = 'local-background';
            this.isAttachedCDP = false;
            const executablePath = this.options.executablePath ?? findLocalBrowserExecutable();
            const launched = await launchChromeNoActivateWin32({
                executablePath,
                windowMode: this.resolvedWindowMode,
                windowBounds: this.options.windowBounds,
                userDataDir: this.options.userDataDir,
            });
            this.launchedPid = launched.pid;
            this.launchedHwnd = launched.hwnd;
            if (launched.ephemeralProfile) {
                this.ephemeralProfileDir = launched.userDataDir;
            }
            this.browser = await chromium.connectOverCDP(launched.wsUrl);
            const existingContexts = this.browser.contexts();
            this.context = existingContexts[0] ?? (await this.browser.newContext({ viewport: null }));
            const existingPages = this.context.pages();
            this.page = existingPages[0] ?? (await this.context.newPage());
        }
        else {
            this.activeMode = 'local-background';
            this.isAttachedCDP = false;
            const executablePath = this.options.executablePath ?? findLocalBrowserExecutable();
            const args = [
                '--mute-audio',
                '--no-first-run',
                '--no-default-browser-check',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-features=CalculateNativeWinOcclusion',
                '--disable-infobars',
            ];
            if (this.resolvedWindowMode === 'headless') {
                args.unshift('--headless=new');
                args.push('--window-size=' + `${this.options.viewport.width},${this.options.viewport.height}`);
            }
            else if (this.resolvedWindowMode === 'minimized') {
                args.push('--start-minimized');
            }
            this.browser = await chromium.launch({
                executablePath,
                headless: false,
                args,
            });
            this.context = await this.browser.newContext({
                viewport: this.resolvedWindowMode === 'headless' ? this.options.viewport : null,
                deviceScaleFactor: 1,
            });
            this.page = await this.context.newPage();
        }
        this.disconnected = false;
        this.closingIntentionally = false;
        this.browser?.on('disconnected', () => {
            this.handleBrowserDisconnected();
        });
        const initScript = buildVirtualCursorInitScript(this.options.cursorStyle, {
            showTakeoverControl: showTakeover,
            takeoverHotkey: this.options.takeoverHotkey ?? 'F8',
            unloadGuard: this.options.unloadGuard,
            activeSession: Boolean(this.options.activeSession),
        });
        await this.context.addInitScript(initScript);
        if (!this.takeoverBindingInstalled) {
            try {
                await this.context.exposeBinding('__dshRequestTakeover', (_source, trigger) => {
                    this.humanTakeoverRequested = true;
                    if (typeof trigger === 'string' && trigger.trim()) {
                        this.humanTakeoverSource = trigger.trim();
                    }
                });
            }
            catch {
                /* ignore if binding already registered on reused external CDP context */
            }
            this.takeoverBindingInstalled = true;
        }
        if (!this.resumeBindingInstalled) {
            try {
                await this.context.exposeBinding('__dshRequestResume', () => {
                    for (const cb of [...this.resumeListeners]) {
                        try {
                            cb();
                        }
                        catch {
                            // ignore resume listener errors
                        }
                    }
                });
            }
            catch {
                /* ignore if binding already registered on reused external CDP context */
            }
            this.resumeBindingInstalled = true;
        }
        if (!this.styleBindingInstalled) {
            try {
                await this.context.exposeBinding('__dshSyncCursorStyle', (_source, styleObj) => {
                    if (styleObj && typeof styleObj === 'object') {
                        this.motion?.updateActiveStyleFromPage(styleObj);
                    }
                });
            }
            catch {
                /* ignore if binding already registered on reused external CDP context */
            }
            this.styleBindingInstalled = true;
        }
        this.motion = new HumanMotionController(this.page, this.options.cursorStyle, {
            showTakeoverControl: showTakeover,
            takeoverHotkey: this.options.takeoverHotkey ?? 'F8',
            unloadGuard: this.options.unloadGuard,
            activeSession: Boolean(this.options.activeSession),
            shouldAbort: () => this.humanTakeoverRequested,
        });
        if (this.isAttachedCDP) {
            await this.motion.ensureCursorHUD(true).catch(() => { });
        }
        this.telemetry = new TelemetryCollector(this.page);
        this.lastMainFrameDocUrl = this.stripUrlHash(this.page.url());
        this.page.on('framenavigated', (frame) => {
            try {
                if (frame !== this.page.mainFrame())
                    return;
                const nextDoc = this.stripUrlHash(frame.url());
                if (nextDoc !== this.lastMainFrameDocUrl) {
                    this.lastMainFrameDocUrl = nextDoc;
                    this.motion?.resetPosition(120, 120);
                    if (!this.navigatingViaSession) {
                        void this.motion?.ensureCursorHUD(true).catch(() => { });
                    }
                }
            }
            catch {
                // ignore navigation race inspection error
            }
        });
        this.page.on('domcontentloaded', () => {
            if (!this.navigatingViaSession) {
                void this.motion?.ensureCursorHUD(true).catch(() => { });
            }
        });
        return this;
    }
    async navigate(url, waitUntil = 'domcontentloaded', timeoutMs = 30000) {
        this.telemetry.recordOrigin(url);
        const rawUrlBeforeGoto = (() => {
            try {
                return this.page.url();
            }
            catch {
                return '';
            }
        })();
        const curDoc = this.stripUrlHash(rawUrlBeforeGoto);
        const nextDoc = this.stripUrlHash(url);
        const effectiveTimeoutMs = Number.isFinite(timeoutMs)
            ? Math.max(1000, Math.min(120000, Math.round(timeoutMs)))
            : 30000;
        const startedAt = Date.now();
        // Pull any synchronous runtime setStyle() changes made directly via window.__dshCursorAPI before leaving the page.
        const dirtyStyle = await safeEvaluate(this.page, () => {
            if (window.__dshStyleDirty && window.__dshCursorAPI) {
                return window.__dshCursorAPI.getState?.()?.style ?? null;
            }
            return null;
        }, null, 0).catch(() => null);
        if (dirtyStyle && typeof dirtyStyle === 'object') {
            this.motion.updateActiveStyleFromPage(dirtyStyle);
        }
        // Temporarily disable beforeunload guard on the outgoing page so programmatic navigation is never blocked.
        if (this.motion.isUnloadGuardEnabled()) {
            await safeEvaluate(this.page, () => {
                window.__dshCursorAPI?.setUnloadGuard?.(false);
            }, undefined, 0).catch(() => { });
        }
        if (curDoc !== nextDoc) {
            this.motion.resetPosition(120, 120);
        }
        let timedOut = false;
        let retries = 0;
        let recoveredFrom;
        this.navigatingViaSession = true;
        try {
            for (let attempt = 0; attempt < 2; attempt++) {
                try {
                    await this.page.goto(url, { waitUntil, timeout: effectiveTimeoutMs });
                    break;
                }
                catch (error) {
                    const msg = String(error?.message ?? error);
                    if (attempt === 0 && isTransientNavigationError(error)) {
                        retries = 1;
                        recoveredFrom = msg.replace(/\s+/g, ' ').trim().slice(0, 160);
                        await this.page.waitForTimeout(400).catch(() => { });
                        continue;
                    }
                    if (!/Timeout/i.test(msg)) {
                        throw error;
                    }
                    timedOut = true;
                    const currentUrl = (() => {
                        try {
                            return this.page.url();
                        }
                        catch {
                            return '';
                        }
                    })();
                    const targetIsBlank = /^about:blank$/i.test(url.trim());
                    const currentIsBlank = !currentUrl || currentUrl === 'about:blank';
                    const isChromeError = /^chrome-error:\/\//i.test(currentUrl);
                    const stuckOnPreviousDoc = curDoc !== nextDoc &&
                        curDoc !== 'about:blank' &&
                        this.stripUrlHash(currentUrl) === curDoc;
                    const readyState = await safeEvaluate(this.page, () => String(document.readyState || ''), '', 0).catch(() => '');
                    if (isChromeError ||
                        stuckOnPreviousDoc ||
                        (!targetIsBlank && currentIsBlank && readyState !== 'complete')) {
                        throw error;
                    }
                    break;
                }
            }
            if (!timedOut || waitUntil === 'domcontentloaded') {
                await this.page.waitForLoadState('load', { timeout: 5000 }).catch(() => { });
            }
            await this.page.waitForTimeout(600);
            this.lastMainFrameDocUrl = this.stripUrlHash(this.page.url());
        }
        finally {
            this.navigatingViaSession = false;
        }
        await this.motion.ensureCursorHUD(true);
        return {
            wait_until: waitUntil,
            timed_out: timedOut,
            elapsed_ms: Math.max(0, Date.now() - startedAt),
            final_url: this.page.url(),
            ...(retries > 0 ? { retries, recovered_from: recoveredFrom } : {}),
        };
    }
    async screenshot(outputPath, retries = 2) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                await this.motion.ensureCursorHUD(false);
                await this.page.screenshot({ path: outputPath, fullPage: false });
                return outputPath;
            }
            catch (err) {
                if (!isNavigationRaceError(err) || attempt === retries) {
                    throw err;
                }
                await this.page.waitForLoadState('domcontentloaded').catch(() => { });
                await this.page.waitForTimeout(150 + attempt * 200).catch(() => { });
            }
        }
        return outputPath;
    }
    async close() {
        this.closingIntentionally = true;
        if (this.isAlive()) {
            await this.motion?.setUnloadGuard(false).catch(() => { });
            if (this.motion && this.motion.getTakeoverMode() !== 'hidden') {
                await this.motion.setTakeoverState('idle').catch(() => { });
            }
        }
        if (this.launchedPid) {
            try {
                if (this.browser?.isConnected()) {
                    const cdp = await this.browser.newBrowserCDPSession().catch(() => null);
                    await cdp?.send('Browser.close').catch(() => { });
                    await this.browser.close().catch(() => { });
                }
            }
            finally {
                const pid = this.launchedPid;
                const profileDir = this.ephemeralProfileDir;
                this.launchedPid = undefined;
                this.launchedHwnd = undefined;
                this.ephemeralProfileDir = undefined;
                await terminateLaunchedChrome(pid, profileDir, Boolean(profileDir));
            }
            return;
        }
        if (!this.isAttachedCDP && this.browser) {
            await this.browser.close().catch(() => { });
        }
    }
}
