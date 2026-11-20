import { type Browser, type BrowserContext, type Page } from 'playwright-core';
import type { BrowserRuntimeMode, BrowserSessionOptions } from './types.js';
import { HumanMotionController } from './human-motion.js';
import { TelemetryCollector } from '../sampler/telemetry-collector.js';
export declare function findLocalBrowserExecutable(): string;
export declare class BrowserSession {
    readonly options: Required<Pick<BrowserSessionOptions, 'mode' | 'viewport' | 'backgroundSilent'>> & BrowserSessionOptions;
    activeMode: Exclude<BrowserRuntimeMode, 'auto'>;
    browser: Browser;
    context: BrowserContext;
    page: Page;
    motion: HumanMotionController;
    telemetry: TelemetryCollector;
    private isAttachedCDP;
    constructor(opts?: BrowserSessionOptions);
    start(): Promise<this>;
    navigate(url: string, waitUntil?: 'load' | 'domcontentloaded' | 'networkidle'): Promise<void>;
    screenshot(outputPath: string): Promise<string>;
    close(): Promise<void>;
}
