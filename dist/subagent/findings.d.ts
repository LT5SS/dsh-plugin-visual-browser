import type { PageObservation } from '../sampler/page-snapshot.js';
export interface SubagentFinding {
    step: number;
    note: string;
}
export declare const MAX_FINDINGS_ENTRIES = 12;
export declare const MAX_FINDING_NOTE_CHARS = 120;
export declare const MAX_FINDINGS_TOTAL_CHARS = 1200;
export declare const RECENT_FINDINGS_WINDOW = 6;
export declare class FindingsLedger {
    private entries;
    private earlySteps;
    record(step: number, obs: PageObservation, shortAction: string, modelNote?: string): SubagentFinding;
    private enforceBudget;
    getFindings(): SubagentFinding[];
    getTotalChars(): number;
    formatForPrompt(currentStepIndex: number): string;
}
