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
    browser;
    context;
    page;
    motion;
    telemetry;
    isAttachedCDP = false;
    ephemeralProfileDir;
    humanTakeoverRequested = false;
    takeoverBindingInstalled = false;
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
            return Boolean(this.browser && this.browser.isConnected() && this.page && !this.page.isClosed());
        }
        catch {
            return false;
        }
    }
    async checkHumanTakeoverRequested() {
        if (this.humanTakeoverRequested)
            return true;
        if (!this.page)
            return false;
        const flag = await safeEvaluate(this.page, () => Boolean(window.__dshTakeoverRequested), false, 0).catch(() => false);
        if (flag) {
            this.humanTakeoverRequested = true;
        }
        return this.humanTakeoverRequested;
    }
    async resetHumanTakeoverRequest() {
        this.humanTakeoverRequested = false;
        await this.motion?.resetTakeoverRequest().catch(() => { });
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
        const initScript = buildVirtualCursorInitScript(this.options.cursorStyle, {
            showTakeoverControl: showTakeover,
            takeoverHotkey: this.options.takeoverHotkey ?? 'F8',
        });
        await this.context.addInitScript(initScript);
        if (!this.takeoverBindingInstalled) {
            try {
                await this.context.exposeBinding('__dshRequestTakeover', () => {
                    this.humanTakeoverRequested = true;
                });
            }
            catch {
                /* ignore if binding already registered on reused external CDP context */
            }
            this.takeoverBindingInstalled = true;
        }
        this.motion = new HumanMotionController(this.page, this.options.cursorStyle, {
            showTakeoverControl: showTakeover,
            takeoverHotkey: this.options.takeoverHotkey ?? 'F8',
            shouldAbort: () => this.humanTakeoverRequested,
        });
        this.telemetry = new TelemetryCollector(this.page);
        return this;
    }
    async navigate(url, waitUntil = 'load') {
        this.telemetry.recordOrigin(url);
        await this.page.goto(url, { waitUntil, timeout: 30000 });
        await this.motion.ensureCursorHUD();
    }
    async screenshot(outputPath, retries = 2) {
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        for (let attempt = 0; attempt <= retries; attempt++) {
            try {
                await this.motion.ensureCursorHUD();
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
