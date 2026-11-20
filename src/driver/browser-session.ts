import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { BrowserRuntimeMode, BrowserSessionOptions, BrowserWindowMode } from './types.js';
import { buildVirtualCursorInitScript } from '../injected/virtual-cursor.js';
import { HumanMotionController } from './human-motion.js';
import { isNavigationRaceError, safeEvaluate } from '../sampler/page-snapshot.js';
import { TelemetryCollector } from '../sampler/telemetry-collector.js';
import {
  launchChromeNoActivateWin32,
  resolveBrowserWindowMode,
  terminateLaunchedChrome,
} from './window-manager.js';

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
].filter(Boolean) as string[];

export function findLocalBrowserExecutable(): string {
  for (const candidate of LOCAL_BROWSER_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error(
    'No local Chrome or Edge executable found. Set DSH_BROWSER_EXECUTABLE or pass executablePath.'
  );
}

export class BrowserSession {
  public readonly options: Required<Pick<BrowserSessionOptions, 'mode' | 'viewport' | 'backgroundSilent'>> &
    BrowserSessionOptions;
  public activeMode: Exclude<BrowserRuntimeMode, 'auto'> = 'local-background';
  public resolvedWindowMode: BrowserWindowMode = 'visible-background';
  public launchedPid?: number;
  public launchedHwnd?: number;
  public disconnected = false;
  public onDisconnected?: () => void;
  public browser!: Browser;
  public context!: BrowserContext;
  public page!: Page;
  public motion!: HumanMotionController;
  public telemetry!: TelemetryCollector;
  private isAttachedCDP = false;
  private ephemeralProfileDir?: string;
  private humanTakeoverRequested = false;
  private takeoverBindingInstalled = false;
  private styleBindingInstalled = false;
  private closingIntentionally = false;
  private navigatingViaSession = false;
  private lastMainFrameDocUrl = '';
  private disconnectListeners = new Set<() => void>();

  constructor(opts: BrowserSessionOptions = {}) {
    const resolvedWindowMode = resolveBrowserWindowMode(opts);
    this.resolvedWindowMode = resolvedWindowMode;
    this.options = {
      mode: opts.mode ?? 'auto',
      viewport: opts.viewport ?? { width: 1440, height: 900 },
      backgroundSilent: opts.backgroundSilent ?? (resolvedWindowMode === 'headless'),
      ...opts,
    };
  }

  public isAlive(): boolean {
    try {
      if (this.disconnected) return false;
      return Boolean(this.browser && this.browser.isConnected() && this.page && !this.page.isClosed());
    } catch {
      return false;
    }
  }

  public addDisconnectListener(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  private handleBrowserDisconnected(): void {
    if (this.disconnected) return;
    this.disconnected = true;
    if (this.closingIntentionally) return;
    try {
      this.onDisconnected?.();
    } catch {
      // ignore listener errors
    }
    for (const cb of [...this.disconnectListeners]) {
      try {
        cb();
      } catch {
        // ignore listener errors
      }
    }
  }

  private stripUrlHash(rawUrl: string): string {
    try {
      const parsed = new URL(rawUrl);
      parsed.hash = '';
      return parsed.href;
    } catch {
      const idx = rawUrl.indexOf('#');
      return idx >= 0 ? rawUrl.slice(0, idx) : rawUrl;
    }
  }

  public async checkHumanTakeoverRequested(): Promise<boolean> {
    if (this.humanTakeoverRequested) return true;
    if (!this.page) return false;
    const flag = await safeEvaluate(
      this.page,
      () => Boolean((window as any).__dshTakeoverRequested),
      false,
      0
    ).catch(() => false);
    if (flag) {
      this.humanTakeoverRequested = true;
    }
    return this.humanTakeoverRequested;
  }

  public async resetHumanTakeoverRequest(): Promise<void> {
    this.humanTakeoverRequested = false;
    await this.motion?.resetTakeoverRequest().catch(() => {});
  }

  public async start(): Promise<this> {
    this.resolvedWindowMode = resolveBrowserWindowMode(this.options);
    const showTakeover =
      this.options.showTakeoverControl ?? (this.resolvedWindowMode !== 'headless');

    const cdpUrl =
      this.options.cdpEndpoint ||
      process.env.DSH_WEBVIEW_CDP_URL ||
      process.env.DSH_CDP_ENDPOINT;

    const shouldAttachCDP =
      this.options.mode === 'dsh-electron-webview' ||
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
    } else if (this.resolvedWindowMode !== 'headless' && process.platform === 'win32') {
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
    } else {
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
      } else if (this.resolvedWindowMode === 'minimized') {
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
    });
    await this.context.addInitScript(initScript);
    if (!this.takeoverBindingInstalled) {
      try {
        await this.context.exposeBinding('__dshRequestTakeover', () => {
          this.humanTakeoverRequested = true;
        });
      } catch {
        /* ignore if binding already registered on reused external CDP context */
      }
      this.takeoverBindingInstalled = true;
    }
    if (!this.styleBindingInstalled) {
      try {
        await this.context.exposeBinding('__dshSyncCursorStyle', (_source: unknown, styleObj: unknown) => {
          if (styleObj && typeof styleObj === 'object') {
            this.motion?.updateActiveStyleFromPage(styleObj as any);
          }
        });
      } catch {
        /* ignore if binding already registered on reused external CDP context */
      }
      this.styleBindingInstalled = true;
    }

    this.motion = new HumanMotionController(this.page, this.options.cursorStyle, {
      showTakeoverControl: showTakeover,
      takeoverHotkey: this.options.takeoverHotkey ?? 'F8',
      unloadGuard: this.options.unloadGuard,
      shouldAbort: () => this.humanTakeoverRequested,
    });
    this.telemetry = new TelemetryCollector(this.page);

    this.lastMainFrameDocUrl = this.stripUrlHash(this.page.url());
    this.page.on('framenavigated', (frame) => {
      try {
        if (frame !== this.page.mainFrame()) return;
        const nextDoc = this.stripUrlHash(frame.url());
        if (nextDoc !== this.lastMainFrameDocUrl) {
          this.lastMainFrameDocUrl = nextDoc;
          this.motion?.resetPosition(120, 120);
          if (!this.navigatingViaSession) {
            void this.motion?.ensureCursorHUD(true).catch(() => {});
          }
        }
      } catch {
        // ignore navigation race inspection error
      }
    });
    this.page.on('domcontentloaded', () => {
      if (!this.navigatingViaSession) {
        void this.motion?.ensureCursorHUD(true).catch(() => {});
      }
    });
    return this;
  }

  public async navigate(
    url: string,
    waitUntil: 'load' | 'domcontentloaded' | 'networkidle' = 'load'
  ): Promise<void> {
    this.telemetry.recordOrigin(url);
    const curDoc = this.stripUrlHash(this.page.url());
    const nextDoc = this.stripUrlHash(url);

    // Pull any synchronous runtime setStyle() changes made directly via window.__dshCursorAPI before leaving the page.
    const dirtyStyle = await safeEvaluate<any>(
      this.page,
      () => {
        if ((window as any).__dshStyleDirty && (window as any).__dshCursorAPI) {
          return (window as any).__dshCursorAPI.getState?.()?.style ?? null;
        }
        return null;
      },
      null,
      0
    ).catch(() => null);
    if (dirtyStyle && typeof dirtyStyle === 'object') {
      this.motion.updateActiveStyleFromPage(dirtyStyle);
    }

    // Temporarily disable beforeunload guard on the outgoing page so programmatic navigation is never blocked.
    if (this.motion.isUnloadGuardEnabled()) {
      await safeEvaluate(
        this.page,
        () => {
          (window as any).__dshCursorAPI?.setUnloadGuard?.(false);
        },
        undefined,
        0
      ).catch(() => {});
    }

    if (curDoc !== nextDoc) {
      this.motion.resetPosition(120, 120);
    }

    this.navigatingViaSession = true;
    try {
      await this.page.goto(url, { waitUntil, timeout: 30000 });
      this.lastMainFrameDocUrl = this.stripUrlHash(this.page.url());
    } finally {
      this.navigatingViaSession = false;
    }
    await this.motion.ensureCursorHUD(true);
  }

  public async screenshot(outputPath: string, retries = 2): Promise<string> {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.motion.ensureCursorHUD(false);
        await this.page.screenshot({ path: outputPath, fullPage: false });
        return outputPath;
      } catch (err) {
        if (!isNavigationRaceError(err) || attempt === retries) {
          throw err;
        }
        await this.page.waitForLoadState('domcontentloaded').catch(() => {});
        await this.page.waitForTimeout(150 + attempt * 200).catch(() => {});
      }
    }
    return outputPath;
  }

  public async close(): Promise<void> {
    this.closingIntentionally = true;
    if (this.isAlive()) {
      await this.motion?.setUnloadGuard(false).catch(() => {});
    }
    if (this.launchedPid) {
      try {
        if (this.browser?.isConnected()) {
          const cdp = await this.browser.newBrowserCDPSession().catch(() => null);
          await cdp?.send('Browser.close').catch(() => {});
          await this.browser.close().catch(() => {});
        }
      } finally {
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
      await this.browser.close().catch(() => {});
    }
  }
}
