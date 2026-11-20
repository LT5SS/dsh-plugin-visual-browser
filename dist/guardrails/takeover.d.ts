import type { Page } from 'playwright-core';
export type GateReason = 'CAPTCHA_DETECTED' | 'PAYMENT_REQUIRED' | 'LOGIN_REQUIRED' | 'SENSITIVE_DOMAIN_READONLY';
export interface GateDetectionResult {
    detected: boolean;
    reason?: GateReason;
    details?: string;
    url: string;
}
export interface DshApprovalCardPayload {
    cardType: 'DSH_BROWSER_TAKEOVER_CARD';
    subagentId: string;
    role: string;
    reason: GateReason | 'ORIGIN_BLOCKED';
    url: string;
    screenshotPath: string;
    title: string;
    instructions: string;
    resumeToolName: 'browser_subagent_resume';
}
/**
 * Inspects the current page DOM in a read-only manner to detect CAPTCHA / anti-bot gates,
 * payment checkout walls, or explicit login walls that require human takeover.
 * Never attempts to click through or bypass any gate.
 */
export declare function detectPageGate(page: Page, opts?: {
    pauseOnLoginWall?: boolean;
}): Promise<GateDetectionResult>;
export declare function buildApprovalCard(params: {
    subagentId: string;
    role: string;
    reason: GateReason | 'ORIGIN_BLOCKED';
    url: string;
    screenshotPath: string;
    details?: string;
}): DshApprovalCardPayload;
