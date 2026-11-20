import { type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { BrowserRuntimeMode, BrowserSessionOptions, BrowserWindowMode } from './types.js';
import { HumanMotionController } from './human-motion.js';
import { TelemetryCollector } from '../sampler/telemetry-collector.js';
export declare function findLocalBrowserExecutable(): string;
export declare class BrowserSession {
    readonly options: Required<Pick<BrowserSessionOptions, 'mode' | 'viewport' | 'backgroundSilent'>> & BrowserSessionOptions;
    activeMode: Exclude<BrowserRuntimeMode, 'auto'>;
    resolvedWindowMode: BrowserWindowMode;
    launchedPid?: number;
    launchedHwnd?: number;
    browser: Browser;
    context: BrowserContext;
    page: Page;
    motion: HumanMotionController;
    telemetry: TelemetryCollector;
    private isAttachedCDP;
    private ephemeralProfileDir?;
    private humanTakeoverRequested;
    private takeoverBindingInstalled;
    constructor(opts?: BrowserSessionOptions);
    isAlive(): boolean;
    checkHumanTakeoverRequested(): Promise<boolean>;
    resetHumanTakeoverRequest(): Promise<void>;
    start(): Promise<this>;
    navigate(url: string, waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void>;
    screenshot(outputPath: string, retries?: number): Promise<string>;
    close(): Promise<void>;
}
