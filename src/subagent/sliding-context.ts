import fs from 'node:fs';
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
  image_url?: { url: string; detail?: 'low' | 'high' | 'auto' };
}

export class SlidingWindowHistory {
  public readonly maxRecentImages: number;
  private entries: SubagentHistoryEntry[] = [];
  private totalImageBytesCaptured = 0;

  constructor(maxRecentImages = 3) {
    this.maxRecentImages = Math.max(1, maxRecentImages);
  }

  public pushObservation(actionTaken: string, obs: PageObservation, fullHudText: string): void {
    let base64: string | null = null;
    let byteLen = 0;

    if (obs.screenshotPath && fs.existsSync(obs.screenshotPath)) {
      const buf = fs.readFileSync(obs.screenshotPath);
      byteLen = buf.byteLength;
      base64 = `data:image/png;base64,${buf.toString('base64')}`;
      this.totalImageBytesCaptured += byteLen;
    }

    const compactText =
      `[Step ${obs.stepIndex} Archived] Action: ${actionTaken} | ` +
      `URL: ${obs.domStats.url} | Scroll: ${obs.scroll.scrollProgressPercent}% (${obs.scroll.scrollY}/${obs.scroll.scrollHeight}px) | ` +
      `Cursor: (${Math.round(obs.cursorPosition.x)}, ${Math.round(obs.cursorPosition.y)}) | ` +
      `DOM: canvas=${obs.domStats.counts.canvas}, svg=${obs.domStats.counts.svg}, dialog=${obs.domStats.counts.openDialogs} | ` +
      `Errors: ${obs.health.consoleErrorsCount}`;

    this.entries.push({
      stepIndex: obs.stepIndex,
      actionTaken,
      fullHudText,
      compactText,
      screenshotPath: obs.screenshotPath,
      imageBase64: base64,
      originalImageBytes: byteLen,
    });

    this.evictOldImages();
  }

  private evictOldImages(): void {
    const cutoffIndex = this.entries.length - this.maxRecentImages;
    for (let i = 0; i < cutoffIndex; i++) {
      if (this.entries[i].imageBase64 !== null) {
        this.entries[i].imageBase64 = null;
      }
    }
  }

  public getEntries(): readonly SubagentHistoryEntry[] {
    return this.entries;
  }

  /**
   * Builds the token-optimized multimodal message payload for a Vision LLM.
   * Older steps are compressed into a single text log; only the last K steps include screenshots.
   */
  public buildMultimodalMessages(systemPrompt: string, taskPrompt: string): Array<{
    role: 'system' | 'user';
    content: string | MultimodalMessagePart[];
  }> {
    const archivedLines: string[] = [];
    const recentParts: MultimodalMessagePart[] = [
      {
        type: 'text',
        text: `## Task Goal\n${taskPrompt}\n`,
      },
    ];

    for (const entry of this.entries) {
      if (entry.imageBase64 === null) {
        archivedLines.push(entry.compactText);
      } else {
        recentParts.push({
          type: 'text',
          text: `\n---\n**Action Executed**: ${entry.actionTaken}\n${entry.fullHudText}`,
        });
        recentParts.push({
          type: 'image_url',
          image_url: { url: entry.imageBase64, detail: 'auto' },
        });
      }
    }

    if (archivedLines.length > 0) {
      recentParts.splice(1, 0, {
        type: 'text',
        text:
          `## Archived Earlier Steps (Screenshots evicted by Sliding Window to save tokens)\n` +
          archivedLines.map((l) => `- ${l}`).join('\n') +
          `\n`,
      });
    }

    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: recentParts },
    ];
  }

  public getStats(): SlidingContextStats {
    let activeImages = 0;
    let activeBytes = 0;
    let evicted = 0;

    for (const e of this.entries) {
      if (e.imageBase64 !== null) {
        activeImages++;
        activeBytes += e.originalImageBytes;
      } else if (e.originalImageBytes > 0) {
        evicted++;
      }
    }

    const savedBytes = Math.max(0, this.totalImageBytesCaptured - activeBytes);
    const savingsPercent =
      this.totalImageBytesCaptured > 0
        ? Math.round((savedBytes / this.totalImageBytesCaptured) * 100)
        : 0;

    return {
      maxRecentImages: this.maxRecentImages,
      totalSteps: this.entries.length,
      totalImagesCaptured: activeImages + evicted,
      activeImagesInContext: activeImages,
      evictedImagesCount: evicted,
      totalImageBytesCaptured: this.totalImageBytesCaptured,
      activeImageBytesInContext: activeBytes,
      savedImageBytes: savedBytes,
      savingsPercent,
    };
  }
}
