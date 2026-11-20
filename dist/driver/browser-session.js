import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { buildVirtualCursorInitScript } from '../injected/virtual-cursor.js';
import { HumanMotionController } from './human-motion.js';
import { TelemetryCollector } from '../sampler/telemetry-collector.js';
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
    browser;
    context;
    page;
    motion;
    telemetry;
    isAttachedCDP = false;
    constructor(opts = {}) {
        this.options = {
            mode: opts.mode ?? 'auto',
            viewport: opts.viewport ?? { width: 1440, height: 900 },
            backgroundSilent: opts.backgroundSilent ?? true,
            ...opts,
        };
    }
    async start() {
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
            this.context = existingContexts[0] ?? (await this.browser.newContext({ viewport: this.options.viewport }));
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
                '--disable-infobars',
                '--window-size=' + `${this.options.viewport.width},${this.options.viewport.height}`,
            ];
            if (this.options.backgroundSilent) {
                args.unshift('--headless=new');
            }
            this.browser = await chromium.launch({
                executablePath,
                headless: false,
                args,
            });
            this.context = await this.browser.newContext({
                viewport: this.options.viewport,
                deviceScaleFactor: 1,
            });
            this.page = await this.context.newPage();
        }
        const initScript = buildVirtualCursorInitScript(this.options.cursorStyle);
        await this.context.addInitScript(initScript);
        this.motion = new HumanMotionController(this.page, this.options.cursorStyle);
        this.telemetry = new TelemetryCollector(this.page);
        return this;
    }
    async navigate(url, waitUntil = 'load') {
        this.telemetry.recordOrigin(url);
        await this.page.goto(url, { waitUntil, timeout: 30000 });
        await this.motion.ensureCursorHUD();
    }
    async screenshot(outputPath) {
        await this.motion.ensureCursorHUD();
        fs.mkdirSync(path.dirname(outputPath), { recursive: true });
        await this.page.screenshot({ path: outputPath, fullPage: false });
        return outputPath;
    }
    async close() {
        if (!this.browser)
            return;
        await this.browser.close();
    }
}
