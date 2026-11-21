export const MAX_FINDINGS_ENTRIES = 12;
export const MAX_FINDING_NOTE_CHARS = 120;
export const MAX_FINDINGS_TOTAL_CHARS = 1200;
export const RECENT_FINDINGS_WINDOW = 6;
function cleanSingleLine(raw) {
    return String(raw ?? '').replace(/\s+/g, ' ').trim();
}
function clipText(raw, maxChars) {
    if (maxChars <= 0)
        return '';
    if (raw.length <= maxChars)
        return raw;
    if (maxChars <= 1)
        return raw.slice(0, maxChars);
    return `${raw.slice(0, maxChars - 1).trimEnd()}…`;
}
function dropHalfClause(text) {
    const parts = text.split(/\s*(?:[·；，|])\s*/).filter(Boolean);
    if (parts.length > 1) {
        parts.shift();
        return parts.join(' · ');
    }
    const half = Math.floor(text.length / 2);
    return half > 4 ? text.slice(half).trim() : '';
}
function extractUrlPath(rawUrl) {
    try {
        const u = new URL(rawUrl);
        return u.pathname || '/';
    }
    catch {
        return clipText(cleanSingleLine(rawUrl), 32) || '/';
    }
}
export class FindingsLedger {
    entries = [];
    earlySteps = [];
    record(step, obs, shortAction, modelNote) {
        const cleanAction = clipText(cleanSingleLine(shortAction) || 'step', 32);
        const urlPath = clipText(extractUrlPath(obs.domStats.url), 36);
        const autoText = `#${step} ${cleanAction} → ${urlPath} · scroll ${obs.scroll.scrollProgressPercent}% · ` +
            `${obs.interactiveElements.length} 控件 · canvas=${obs.domStats.counts.canvas}`;
        const cleanModelNote = modelNote ? cleanSingleLine(modelNote) : '';
        let combined;
        if (cleanModelNote) {
            if (autoText.length + 3 + cleanModelNote.length <= MAX_FINDING_NOTE_CHARS) {
                combined = `${autoText} | ${cleanModelNote}`;
            }
            else {
                const prefix = `#${step} ${cleanAction} · `;
                const remain = MAX_FINDING_NOTE_CHARS - prefix.length;
                if (remain >= 12) {
                    combined = `${prefix}${clipText(cleanModelNote, remain)}`;
                }
                else {
                    combined = clipText(`#${step} ${cleanModelNote}`, MAX_FINDING_NOTE_CHARS);
                }
            }
        }
        else {
            combined = clipText(autoText, MAX_FINDING_NOTE_CHARS);
        }
        const entry = {
            step,
            note: clipText(combined, MAX_FINDING_NOTE_CHARS),
        };
        this.entries.push(entry);
        if (step >= 1 && step <= 3) {
            const existingIdx = this.earlySteps.findIndex((e) => e.step === step);
            const summaryItem = {
                step,
                shortAction: cleanAction,
                ...(cleanModelNote ? { modelNote: clipText(cleanModelNote, 48) } : {}),
            };
            if (existingIdx >= 0) {
                this.earlySteps[existingIdx] = summaryItem;
            }
            else {
                this.earlySteps.push(summaryItem);
            }
        }
        this.enforceBudget();
        return { ...entry };
    }
    enforceBudget() {
        while (this.entries.length > MAX_FINDINGS_ENTRIES) {
            this.entries.shift();
        }
        while (this.getTotalChars() > MAX_FINDINGS_TOTAL_CHARS && this.entries.length > 0) {
            const oldest = this.entries[0];
            const shortened = dropHalfClause(oldest.note);
            if (shortened && shortened.length < oldest.note.length && shortened.length >= 8) {
                oldest.note = shortened;
            }
            else if (this.entries.length > 1) {
                this.entries.shift();
            }
            else {
                oldest.note = clipText(oldest.note, MAX_FINDINGS_TOTAL_CHARS);
                break;
            }
        }
    }
    getFindings() {
        return this.entries.map((e) => ({ step: e.step, note: e.note }));
    }
    getTotalChars() {
        let total = 0;
        for (const e of this.entries)
            total += e.note.length;
        return total;
    }
    formatForPrompt(currentStepIndex) {
        if (this.entries.length === 0)
            return '';
        const bullets = [];
        if (currentStepIndex > 3 && this.earlySteps.length > 0) {
            const summaryParts = this.earlySteps.map((s) => s.modelNote ? `#${s.step} ${s.shortAction}(${s.modelNote})` : `#${s.step} ${s.shortAction}`);
            bullets.push(`- 第1–3步：${clipText(summaryParts.join('；'), 220)}`);
        }
        const recent = this.entries.slice(-RECENT_FINDINGS_WINDOW);
        for (const item of recent) {
            bullets.push(`- ${item.note}`);
        }
        const renderBlock = () => ['## Findings so far', ...bullets].join('\n');
        let block = renderBlock();
        while (block.length > MAX_FINDINGS_TOTAL_CHARS && bullets.length > 1) {
            const oldest = bullets[0].replace(/^- /, '');
            const shortened = dropHalfClause(oldest);
            if (shortened && shortened.length < oldest.length && shortened.length >= 8) {
                bullets[0] = `- ${shortened}`;
            }
            else {
                bullets.shift();
            }
            block = renderBlock();
        }
        if (block.length > MAX_FINDINGS_TOTAL_CHARS) {
            return block.slice(0, MAX_FINDINGS_TOTAL_CHARS);
        }
        return block;
    }
}
