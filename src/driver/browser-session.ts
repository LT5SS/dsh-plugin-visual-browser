import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type CDPSession, type Dialog, type Page } from 'playwright-core';
import type {
  BrowserRuntimeMode,
  BrowserSessionOptions,
  BrowserWindowMode,
  NativeDialogRecord,
  NavigateWaitUntil,
  NavigationDiagnostic,
  NotTopmostResult,
  SetViewportOptions,
  ViewportEmulationState,
} from './types.js';
import { buildVirtualCursorInitScript } from '../injected/virtual-cursor.js';
import { HumanMotionController } from './human-motion.js';
import { isNavigationRaceError, safeEvaluate } from '../sampler/page-snapshot.js';
import { TelemetryCollector } from '../sampler/telemetry-collector.js';
import {
  ensureWindowNotTopmostWin32,
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

const ALLOWED_NAVIGATION_SCHEMES = new Set([
  'http:',
  'https:',
  'about:',
  'blob:',
  'data:',
  'file:',
]);

export function classifyUrlProtocol(
  rawUrl: string
): { allowed: true; protocol: string; href: string } | { allowed: false; blocked: 'EXTERNAL_PROTOCOL' | 'JS_URL'; protocol: string; href: string } {
  const trimmed = String(rawUrl ?? '').trim();
  if (!trimmed) {
    return { allowed: true, protocol: '', href: trimmed };
  }
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(trimmed);
  if (!match) {
    return { allowed: true, protocol: '', href: trimmed };
  }
  const protocol = `${match[1].toLowerCase()}:`;
  if (protocol === 'javascript:') {
    return { allowed: false, blocked: 'JS_URL', protocol, href: trimmed };
  }
  if (!ALLOWED_NAVIGATION_SCHEMES.has(protocol)) {
    return { allowed: false, blocked: 'EXTERNAL_PROTOCOL', protocol, href: trimmed };
  }
  return { allowed: true, protocol, href: trimmed };
}

export function isTransientNavigationError(error: unknown): boolean {
  const message = String((error as any)?.message ?? error);
  return /ERR_NETWORK_CHANGED|ERR_CONNECTION_RESET|ERR_CONNECTION_ABORTED|ERR_CONNECTION_CLOSED|ERR_TIMED_OUT/i.test(
    message
  );
}

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
  private humanTakeoverSource: 'f8' | 'button' | string | null = null;
  private takeoverBindingInstalled = false;
  private resumeBindingInstalled = false;
  private styleBindingInstalled = false;
  private closingIntentionally = false;
  private navigatingViaSession = false;
  private lastMainFrameDocUrl = '';
  private disconnectListeners = new Set<() => void>();
  private resumeListeners = new Set<() => void>();
  private cdpSession: CDPSession | null = null;
  private viewportEmulation: ViewportEmulationState | null = null;
  private physicalViewportSize: { width: number; height: number } | null = null;
  private dialogListenerAttached = false;
  private dialogHistory: NativeDialogRecord[] = [];
  private unreadDialogs: NativeDialogRecord[] = [];
  private pendingPromptDialog: NativeDialogRecord | null = null;
  private lastNotTopmostResult: NotTopmostResult = { checked: false, clearedTopmost: false };

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
    const probed = await safeEvaluate<{ requested: boolean; source: string | null }>(
      this.page,
      () => ({
        requested: Boolean((window as any).__dshTakeoverRequested),
        source:
          typeof (window as any).__dshTakeoverSource === 'string' &&
          (window as any).__dshTakeoverSource.trim()
            ? String((window as any).__dshTakeoverSource).trim()
            : null,
      }),
      { requested: false, source: null },
      0
    ).catch(() => ({ requested: false, source: null }));
    if (probed.requested) {
      this.humanTakeoverRequested = true;
      if (probed.source) {
        this.humanTakeoverSource = probed.source;
      }
    }
    return this.humanTakeoverRequested;
  }

  public getHumanTakeoverSource(): 'f8' | 'button' | string | null {
    return this.humanTakeoverSource;
  }

  public async resetHumanTakeoverRequest(): Promise<void> {
    this.humanTakeoverRequested = false;
    this.humanTakeoverSource = null;
    await this.motion?.resetTakeoverRequest().catch(() => {});
  }

  public addResumeListener(listener: () => void): () => void {
    this.resumeListeners.add(listener);
    return () => {
      this.resumeListeners.delete(listener);
    };
  }

  public async checkAndClearResumeRequested(): Promise<boolean> {
    if (!this.isAlive() || !this.page) return false;
    return await safeEvaluate<boolean>(
      this.page,
      () => {
        if ((window as any).__dshResumeRequested) {
          (window as any).__dshResumeRequested = false;
          return true;
        }
        return false;
      },
      false,
      0
    ).catch(() => false);
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
      activeSession: Boolean(this.options.activeSession),
    });
    await this.context.addInitScript(initScript);
    if (!this.takeoverBindingInstalled) {
      try {
        await this.context.exposeBinding('__dshRequestTakeover', (_source: unknown, trigger?: unknown) => {
          this.humanTakeoverRequested = true;
          if (typeof trigger === 'string' && trigger.trim()) {
            this.humanTakeoverSource = trigger.trim();
          }
        });
      } catch {
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
            } catch {
              // ignore resume listener errors
            }
          }
        });
      } catch {
        /* ignore if binding already registered on reused external CDP context */
      }
      this.resumeBindingInstalled = true;
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
      activeSession: Boolean(this.options.activeSession),
      shouldAbort: () => this.humanTakeoverRequested,
    });
    if (this.isAttachedCDP) {
      await this.motion.ensureCursorHUD(true).catch(() => {});
    }
    this.telemetry = new TelemetryCollector(this.page);

    this.lastMainFrameDocUrl = this.stripUrlHash(this.page.url());
    this.attachDialogHandler();
    if (this.options.viewportOverride) {
      await this.setViewport(this.options.viewportOverride);
    }
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

  private attachDialogHandler(): void {
    if (this.dialogListenerAttached || !this.page) return;
    this.dialogListenerAttached = true;
    this.page.on('dialog', (dialog: Dialog) => {
      void this.handleNativeDialog(dialog);
    });
  }

  private async handleNativeDialog(dialog: Dialog): Promise<void> {
    const rawType = dialog.type();
    const type: NativeDialogRecord['type'] =
      rawType === 'alert' || rawType === 'confirm' || rawType === 'prompt' || rawType === 'beforeunload'
        ? rawType
        : 'alert';
    const message = String(dialog.message?.() ?? '');
    const defaultValue = typeof dialog.defaultValue === 'function' ? dialog.defaultValue() : undefined;
    const timestamp = new Date().toISOString();

    if (type === 'beforeunload') {
      const shouldAccept =
        this.closingIntentionally ||
        this.navigatingViaSession ||
        this.motion?.getTakeoverMode?.() === 'paused' ||
        !this.motion?.isUnloadGuardEnabled();
      if (shouldAccept) {
        await dialog.accept().catch(() => {});
      } else {
        await dialog.dismiss().catch(() => {});
      }
      return;
    }

    if (type === 'prompt') {
      await dialog.dismiss().catch(() => {});
      const record: NativeDialogRecord = {
        type: 'prompt',
        message,
        ...(defaultValue !== undefined ? { defaultValue } : {}),
        handled: 'dismissed',
        timestamp,
      };
      this.pushDialogRecord(record);
      this.pendingPromptDialog = record;
      return;
    }

    await dialog.accept().catch(() => {});
    this.pushDialogRecord({
      type,
      message,
      handled: 'accepted',
      timestamp,
    });
  }

  private pushDialogRecord(record: NativeDialogRecord): void {
    this.dialogHistory.push(record);
    if (this.dialogHistory.length > 50) {
      this.dialogHistory.shift();
    }
    this.unreadDialogs.push(record);
    if (this.unreadDialogs.length > 20) {
      this.unreadDialogs.shift();
    }
  }

  public consumePendingDialogs(): NativeDialogRecord[] {
    if (this.unreadDialogs.length === 0) return [];
    return this.unreadDialogs.splice(0, this.unreadDialogs.length);
  }

  public consumePendingPromptDialog(): NativeDialogRecord | null {
    const out = this.pendingPromptDialog;
    this.pendingPromptDialog = null;
    return out;
  }

  public getDialogHistory(): NativeDialogRecord[] {
    return [...this.dialogHistory];
  }

  private async getOrCreateCdpSession(): Promise<CDPSession> {
    if (this.cdpSession) return this.cdpSession;
    this.cdpSession = await this.context.newCDPSession(this.page);
    return this.cdpSession;
  }

  public getViewportEmulation(): ViewportEmulationState | null {
    return this.viewportEmulation ? { ...this.viewportEmulation } : null;
  }

  public async setViewport(opts: SetViewportOptions = {}): Promise<ViewportEmulationState | null> {
    if (opts.reset) {
      const cdp = await this.getOrCreateCdpSession();
      await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
      this.viewportEmulation = null;
      await this.motion?.setViewportEmulation(null).catch(() => {});
      await this.page.waitForTimeout(80).catch(() => {});
      return null;
    }

    if (!this.physicalViewportSize) {
      const measured = await safeEvaluate<{ width: number; height: number }>(
        this.page,
        () => ({
          width: Math.max(1, window.innerWidth || document.documentElement?.clientWidth || 754),
          height: Math.max(1, window.innerHeight || document.documentElement?.clientHeight || 751),
        }),
        { width: 754, height: 751 },
        0
      ).catch(() => ({ width: 754, height: 751 }));
      this.physicalViewportSize = measured;
    }

    const rawW = opts.width ?? this.viewportEmulation?.width ?? 1440;
    const rawH = opts.height ?? this.viewportEmulation?.height ?? 900;
    const rawDpr = opts.deviceScaleFactor ?? this.viewportEmulation?.deviceScaleFactor ?? 1.5;
    const width = Math.max(320, Math.min(2560, Math.round(Number.isFinite(rawW) ? rawW : 1440)));
    const height = Math.max(240, Math.min(1600, Math.round(Number.isFinite(rawH) ? rawH : 900)));
    const dprClamped = Math.max(1, Math.min(2, Number.isFinite(rawDpr) ? rawDpr : 1.5));
    const deviceScaleFactor = Number(dprClamped.toFixed(2));

    let fitScale = 1;
    const cdp = await this.getOrCreateCdpSession();
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor,
      mobile: false,
      screenWidth: width,
      screenHeight: height,
      scale: fitScale,
    });

    const nextState: ViewportEmulationState = {
      active: true,
      width,
      height,
      deviceScaleFactor,
      physicalWidth: this.physicalViewportSize.width,
      physicalHeight: this.physicalViewportSize.height,
    };
    this.viewportEmulation = nextState;
    await this.motion?.setViewportEmulation(nextState).catch(() => {});
    await this.page.waitForTimeout(80).catch(() => {});
    return { ...nextState };
  }

  public async ensureNotTopmost(): Promise<NotTopmostResult> {
    if (
      process.platform !== 'win32' ||
      this.resolvedWindowMode === 'headless' ||
      !this.launchedHwnd ||
      this.launchedHwnd <= 0
    ) {
      this.lastNotTopmostResult = { checked: false, clearedTopmost: false };
      return { ...this.lastNotTopmostResult };
    }
    this.lastNotTopmostResult = await ensureWindowNotTopmostWin32(this.launchedHwnd);
    return { ...this.lastNotTopmostResult };
  }

  public getLastNotTopmostResult(): NotTopmostResult {
    return { ...this.lastNotTopmostResult };
  }

  public async getNavigationHistory(): Promise<{
    currentIndex: number;
    entries: Array<{ id: number; url: string; title: string }>;
  } | null> {
    try {
      const cdp = await this.getOrCreateCdpSession();
      const res = (await cdp.send('Page.getNavigationHistory')) as {
        currentIndex: number;
        entries: Array<{ id: number; url: string; title: string }>;
      };
      if (res && typeof res.currentIndex === 'number' && Array.isArray(res.entries)) {
        return res;
      }
      return null;
    } catch {
      return null;
    }
  }

  public async navigate(
    url: string,
    waitUntil: NavigateWaitUntil = 'domcontentloaded',
    timeoutMs = 30000
  ): Promise<NavigationDiagnostic> {
    const rawUrlBeforeGoto = (() => {
      try {
        return this.page.url();
      } catch {
        return '';
      }
    })();
    const protoCheck = classifyUrlProtocol(url);
    if (!protoCheck.allowed) {
      return {
        wait_until: waitUntil,
        timed_out: false,
        elapsed_ms: 0,
        final_url: rawUrlBeforeGoto || 'about:blank',
        blocked: protoCheck.blocked,
        protocol: protoCheck.protocol,
        href: protoCheck.href,
      };
    }

    this.telemetry.recordOrigin(url);
    const curDoc = this.stripUrlHash(rawUrlBeforeGoto);
    const nextDoc = this.stripUrlHash(url);
    const effectiveTimeoutMs = Number.isFinite(timeoutMs)
      ? Math.max(1000, Math.min(120000, Math.round(timeoutMs)))
      : 30000;
    const startedAt = Date.now();

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

    let timedOut = false;
    let retries = 0;
    let recoveredFrom: string | undefined;
    this.navigatingViaSession = true;
    try {
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          await this.page.goto(url, { waitUntil, timeout: effectiveTimeoutMs });
          break;
        } catch (error) {
          const msg = String((error as Error)?.message ?? error);
          if (attempt === 0 && isTransientNavigationError(error)) {
            retries = 1;
            recoveredFrom = msg.replace(/\s+/g, ' ').trim().slice(0, 160);
            await this.page.waitForTimeout(400).catch(() => {});
            continue;
          }
          if (!/Timeout/i.test(msg)) {
            throw error;
          }
          timedOut = true;
          const currentUrl = (() => {
            try {
              return this.page.url();
            } catch {
              return '';
            }
          })();
          const targetIsBlank = /^about:blank$/i.test(url.trim());
          const currentIsBlank = !currentUrl || currentUrl === 'about:blank';
          const isChromeError = /^chrome-error:\/\//i.test(currentUrl);
          const stuckOnPreviousDoc =
            curDoc !== nextDoc &&
            curDoc !== 'about:blank' &&
            this.stripUrlHash(currentUrl) === curDoc;
          const readyState = await safeEvaluate(
            this.page,
            () => String(document.readyState || ''),
            '',
            0
          ).catch(() => '');

          if (
            isChromeError ||
            stuckOnPreviousDoc ||
            (!targetIsBlank && currentIsBlank && readyState !== 'complete')
          ) {
            throw error;
          }
          break;
        }
      }

      if (!timedOut || waitUntil === 'domcontentloaded') {
        await this.page.waitForLoadState('load', { timeout: 5000 }).catch(() => {});
      }
      await this.page.waitForTimeout(600);
      this.lastMainFrameDocUrl = this.stripUrlHash(this.page.url());
    } finally {
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

  public async screenshot(outputPath: string, retries = 2): Promise<string> {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const hidePanelForScreenshot = Boolean(
      this.viewportEmulation?.active &&
        this.viewportEmulation.physicalWidth &&
        this.viewportEmulation.physicalWidth < this.viewportEmulation.width &&
        this.motion.getTakeoverMode() !== 'paused'
    );
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.motion.ensureCursorHUD(false);
        if (hidePanelForScreenshot) {
          await this.motion.setPanelScreenshotHidden(true).catch(() => {});
        }
        try {
          if (this.viewportEmulation?.active) {
            const cdp = await this.getOrCreateCdpSession();
            const res = (await cdp.send('Page.captureScreenshot', {
              format: 'png',
              fromSurface: true,
            })) as { data: string };
            fs.writeFileSync(outputPath, Buffer.from(res.data, 'base64'));
          } else {
            await this.page.screenshot({ path: outputPath, fullPage: false });
          }
        } finally {
          if (hidePanelForScreenshot) {
            await this.motion.setPanelScreenshotHidden(false).catch(() => {});
          }
        }
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

  public async captureRegionPng(clip: {
    x: number;
    y: number;
    width: number;
    height: number;
    scale: number;
  }): Promise<Buffer> {
    const cdp = await this.getOrCreateCdpSession();
    const res = (await cdp.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      clip: {
        x: clip.x,
        y: clip.y,
        width: clip.width,
        height: clip.height,
        scale: clip.scale,
      },
    })) as { data: string };
    return Buffer.from(res.data, 'base64');
  }

  public async captureClipBuffer(
    clip: { x: number; y: number; width: number; height: number },
    opts: { format?: 'png' | 'jpeg'; quality?: number } = {}
  ): Promise<Buffer> {
    const format = opts.format ?? 'png';
    if (this.viewportEmulation?.active) {
      const cdp = await this.getOrCreateCdpSession();
      const res = (await cdp.send('Page.captureScreenshot', {
        format,
        ...(format === 'jpeg' ? { quality: opts.quality ?? 65 } : {}),
        fromSurface: true,
        clip: {
          x: clip.x,
          y: clip.y,
          width: clip.width,
          height: clip.height,
          scale: 1,
        },
      })) as { data: string };
      return Buffer.from(res.data, 'base64');
    }
    return await this.page.screenshot({
      clip,
      type: format,
      ...(format === 'jpeg' ? { quality: opts.quality ?? 65 } : {}),
    });
  }

  public async close(): Promise<void> {
    this.closingIntentionally = true;
    if (this.cdpSession) {
      await this.cdpSession.detach().catch(() => {});
      this.cdpSession = null;
    }
    if (this.isAlive()) {
      await this.motion?.setUnloadGuard(false).catch(() => {});
      if (this.motion && this.motion.getTakeoverMode() !== 'hidden') {
        await this.motion.setTakeoverState('idle').catch(() => {});
      }
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
