import type { Page } from 'playwright-core';
export interface ConsoleErrorEntry {
    type: 'console.error' | 'pageerror';
    text: string;
    timestamp: string;
}
export interface FailedRequestEntry {
    url: string;
    method: string;
    status?: number;
    failureText?: string;
}
export interface TelemetryHealthReport {
    totalRequests: number;
    failedRequestsCount: number;
    consoleErrorsCount: number;
    visitedOrigins: string[];
    recentConsoleErrors: ConsoleErrorEntry[];
    recentFailedRequests: FailedRequestEntry[];
}
export declare class TelemetryCollector {
    private totalRequests;
    private consoleErrors;
    private failedRequests;
    private visitedOrigins;
    constructor(page: Page);
    private attach;
    recordOrigin(urlStr: string): void;
    getHealthReport(): TelemetryHealthReport;
}
