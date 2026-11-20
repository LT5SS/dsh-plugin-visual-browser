import type { BrowserSession } from '../driver/browser-session.js';
export interface HostFactsData {
    subagentId: string;
    role: string;
    visitedOrigins: string[];
    blockedOrigins: string[];
    screenshots: string[];
    latestScreenshot: string | null;
    totalStepsExecuted: number;
    consoleErrorsCount: number;
    failedRequestsCount: number;
}
/**
 * Tamper-proof Host-Level Fact Tracker (BROWSER_HOST_FACTS).
 * Populated strictly by the TypeScript host runtime (Playwright network events + disk writes),
 * never by the subagent LLM's own text output.
 */
export declare class HostFactsTracker {
    readonly subagentId: string;
    readonly role: string;
    private session;
    private blockedOrigins;
    private screenshots;
    private stepsExecuted;
    constructor(subagentId: string, role: string, session: BrowserSession);
    recordStep(screenshotPath?: string): void;
    recordBlockedOrigin(urlOrOrigin: string): void;
    getFacts(): HostFactsData;
    /**
     * Formats the authoritative BROWSER_HOST_FACTS block injected into the main agent's context.
     */
    formatHostFactsBlock(): string;
}
