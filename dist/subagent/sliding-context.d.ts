import type { PageObservation } from '../sampler/page-snapshot.js';
export interface SubagentHistoryEntry {
    stepIndex: number;
    actionTaken: string;
    fullHudText: string;
    compactText: string;
    screenshotPath: string;
    /** Present only for the most recent K steps; evicted to null for older steps to save VLM tokens */
    imageBase64: string | null;
    originalImageBytes: number;
}
export interface SlidingContextStats {
    maxRecentImages: number;
    totalSteps: number;
    totalImagesCaptured: number;
    activeImagesInContext: number;
    evictedImagesCount: number;
    totalImageBytesCaptured: number;
    activeImageBytesInContext: number;
    savedImageBytes: number;
    savingsPercent: number;
}
export interface MultimodalMessagePart {
    type: 'text' | 'image_url';
    text?: string;
    image_url?: {
        url: string;
        detail?: 'low' | 'high' | 'auto';
    };
}
export declare class SlidingWindowHistory {
    readonly maxRecentImages: number;
    private entries;
    private totalImageBytesCaptured;
    constructor(maxRecentImages?: number);
    pushObservation(actionTaken: string, obs: PageObservation, fullHudText: string): void;
    private evictOldImages;
    getEntries(): readonly SubagentHistoryEntry[];
    /**
     * Builds the token-optimized multimodal message payload for a Vision LLM.
     * Older steps are compressed into a single text log; only the last K steps include screenshots.
     */
    buildMultimodalMessages(systemPrompt: string, taskPrompt: string): Array<{
        role: 'system' | 'user';
        content: string | MultimodalMessagePart[];
    }>;
    getStats(): SlidingContextStats;
}
