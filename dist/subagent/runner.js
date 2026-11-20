import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserSession } from '../driver/browser-session.js';
import { AtomicBrowserToolset } from '../tools/atomic-tools.js';
import { HostFactsTracker } from './host-facts.js';
import { SlidingWindowHistory } from './sliding-context.js';
import { buildApprovalCard, detectPageGate, } from '../guardrails/takeover.js';
export const SUBAGENT_SYSTEM_PROMPT = `You are an isolated Visual Browser Subagent inside DeepSeek Harness (DSH).
You operate a background browser equipped with a physical Bezier virtual cursor.
At each step you receive:
1. A compact archive of earlier steps (images evicted to save context);
2. The latest 1-3 viewport screenshots with the virtual cursor & trail visible;
3. The 3-in-1 Observation HUD (scroll metrics, DOM/tech stats, console/network errors, and numbered #ref interactive controls).

Respond ONLY with a single valid JSON object matching one of these actions:
- {"type":"move_mouse","points":[{"x":300,"y":400},{"x":800,"y":420}],"label":"SWEEP","reason":"..."}
- {"type":"hover","target":"#3","reason":"..."}
- {"type":"click","target":"#8","reason":"..."}
- {"type":"type_text","target":"#5","text":"hello","pressEnter":true,"reason":"..."}
- {"type":"scroll","deltaY":800,"reason":"..."}
- {"type":"navigate","url":"https://...","reason":"..."}
- {"type":"pause_for_takeover","blockReason":"LOGIN_REQUIRED","message":"..."}
- {"type":"complete","report":"COMPLETED / TASK_COMPLETED\\n\\nDetailed markdown report..."}`;
/** Extracts the first JSON object from a model text response (handles markdown code fences gracefully). */
export function parseJsonDecision(rawText) {
    const trimmed = rawText.trim();
    const fenceMatch = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
    const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
    const firstBrace = candidate.indexOf('{');
    const lastBrace = candidate.lastIndexOf('}');
    if (firstBrace >= 0 && lastBrace > firstBrace) {
        return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
    }
    return JSON.parse(candidate);
}
/**
 * Creates a planner backed by DSH 0.2's native `ctx.llm` runtime service when available.
 */
export function createDshHostLlmPlanner(opts) {
    return async (ctx) => {
        const contentBlocks = [];
        const entries = ctx.history.getEntries();
        const archived = entries.filter((e) => e.imageBase64 === null).map((e) => `- ${e.compactText}`);
        let promptText = `## Task Goal\n${ctx.taskPrompt}\n`;
        if (archived.length > 0) {
            promptText += `\n## Archived Earlier Steps\n${archived.join('\n')}\n`;
        }
        for (const entry of entries.filter((e) => e.imageBase64 !== null)) {
            promptText += `\n---\n**Action Executed**: ${entry.actionTaken}\n${entry.fullHudText}\n`;
        }
        contentBlocks.push({ type: 'text', text: promptText });
        // Attach latest screenshot via ctx.attachments if supported by host
        const latestPath = ctx.latestObservation.screenshotPath;
        if (opts.attachments && typeof opts.attachments.saveImage === 'function' && fs.existsSync(latestPath)) {
            try {
                const ref = await opts.attachments.saveImage({
                    data: new Uint8Array(fs.readFileSync(latestPath)),
                    mediaType: 'image/png',
                    name: path.basename(latestPath),
                });
                contentBlocks.push({ type: 'image', attachment: ref });
            }
            catch {
                // Fallback to text-only HUD if attachment admission fails
            }
        }
        const stream = opts.llm.stream({
            provider: opts.provider,
            model: opts.model,
            systemPrompt: SUBAGENT_SYSTEM_PROMPT,
            messages: [
                {
                    id: `msg-${crypto.randomUUID()}`,
                    role: 'user',
                    content: contentBlocks,
                    source: { kind: 'user' },
                },
            ],
            signal: ctx.signal,
        });
        let fullText = '';
        for await (const chunk of stream) {
            if (chunk.type === 'text-delta' && typeof chunk.delta === 'string') {
                fullText += chunk.delta;
            }
            else if (chunk.type === 'text' && typeof chunk.text === 'string') {
                fullText += chunk.text;
            }
        }
        return parseJsonDecision(fullText);
    };
}
/**
 * Creates a Vision LLM planner talking to any OpenAI-compatible multimodal endpoint.
 * Includes timeout, AbortSignal propagation, and automatic fallback for gateways that reject response_format.
 */
export function createOpenAIVisionPlanner(opts) {
    const baseUrl = (opts.baseUrl || 'https://api.openai.com/v1').replace(/\/+$/, '');
    const model = opts.model || 'gpt-4o-mini';
    const timeoutMs = opts.timeoutMs ?? 45000;
    return async (ctx) => {
        const messages = ctx.history.buildMultimodalMessages(SUBAGENT_SYSTEM_PROMPT, ctx.taskPrompt);
        const callApi = async (useJsonObjectFormat) => {
            const timeoutSignal = AbortSignal.timeout(timeoutMs);
            const signal = ctx.signal
                ? AbortSignal.any([ctx.signal, timeoutSignal])
                : timeoutSignal;
            const body = {
                model,
                messages,
                temperature: 0.2,
            };
            if (useJsonObjectFormat) {
                body.response_format = { type: 'json_object' };
            }
            const res = await fetch(`${baseUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${opts.apiKey}`,
                },
                body: JSON.stringify(body),
                signal,
            });
            return res;
        };
        let res = await callApi(true);
        if (!res.ok && res.status === 400) {
            // Retry without response_format for OpenAI-compatible gateways that don't support json_object mode with vision
            res = await callApi(false);
        }
        if (!res.ok) {
            throw new Error(`Vision LLM request failed: HTTP ${res.status} ${await res.text()}`);
        }
        const data = (await res.json());
        const rawContent = data.choices?.[0]?.message?.content || '{}';
        return parseJsonDecision(rawContent);
    };
}
/**
 * Built-in Zero-Config Autonomous Visual Walkthrough Planner.
 * Used when neither a custom planner, DSH host LLM selection, nor DSH_VISION_API_KEY is configured,
 * ensuring `browser_subagent_run` works out-of-the-box without hard-crashing.
 */
export function createBuiltinInspectorPlanner() {
    return async (ctx) => {
        const { stepIndex, maxSteps, latestObservation, history } = ctx;
        const { scroll, domStats, interactiveElements, health } = latestObservation;
        if (stepIndex === 1) {
            return {
                type: 'move_mouse',
                points: [
                    { x: Math.round(scroll.viewportWidth * 0.25), y: Math.round(scroll.viewportHeight * 0.48) },
                    { x: Math.round(scroll.viewportWidth * 0.52), y: Math.round(scroll.viewportHeight * 0.42) },
                    { x: Math.round(scroll.viewportWidth * 0.76), y: Math.round(scroll.viewportHeight * 0.5) },
                ],
                label: 'HERO PROBE',
                reason: 'Probe hero section for mouse-reactive animations and hover states',
            };
        }
        if (scroll.scrollProgressPercent < 88 && stepIndex < maxSteps - 1) {
            const stepDelta = Math.max(700, Math.round(scroll.viewportHeight * 0.85));
            return {
                type: 'scroll',
                deltaY: stepDelta,
                reason: `Scroll down (+${stepDelta}px) to inspect next viewport section (current: ${scroll.scrollProgressPercent}%)`,
            };
        }
        const entries = history.getEntries();
        const controlSamples = interactiveElements
            .slice(0, 10)
            .map((el) => `${el.ref} [${el.tag}] "${el.label}"`)
            .join(', ');
        return {
            type: 'complete',
            report: [
                `COMPLETED / TASK_COMPLETED`,
                ``,
                `### Visual Browser Subagent Inspection Report`,
                `- **URL**: ${domStats.url}`,
                `- **Title**: ${domStats.title}`,
                `- **Page Dimensions**: ${scroll.viewportWidth}x${scroll.viewportHeight} viewport, ${scroll.scrollHeight}px total height (scrolled to ${scroll.scrollProgressPercent}%)`,
                `- **Detected Tech Stack**: ${domStats.detectedTechHints.join(', ') || 'Standard HTML/CSS/JS'}`,
                `- **DOM Counts**: canvas=${domStats.counts.canvas}, svg=${domStats.counts.svg}, video=${domStats.counts.video}, img=${domStats.counts.img}, section=${domStats.counts.section}, button=${domStats.counts.button}, a=${domStats.counts.a}`,
                `- **Sampled Interactive Controls**: ${controlSamples || 'none'}`,
                `- **Runtime Health**: ConsoleErrors=${health.consoleErrorsCount}, FailedRequests=${health.failedRequestsCount}/${health.totalRequests}`,
                `- **Steps Captured**: ${entries.length} snapshots (latest: \`${latestObservation.screenshotPath}\`)`,
            ].join('\n'),
        };
    };
}
export class BrowserSubagentRunner {
    pausedSessions = new Map();
    isOriginPermitted(targetUrl, allowedOrigins, blockedOrigins) {
        try {
            const origin = new URL(targetUrl).origin;
            if (blockedOrigins && blockedOrigins.includes(origin))
                return false;
            if (allowedOrigins && allowedOrigins.length > 0 && !allowedOrigins.includes(origin)) {
                return false;
            }
            return true;
        }
        catch {
            return false;
        }
    }
    getPausedSession(subagentId) {
        return this.pausedSessions.get(subagentId);
    }
    async closeAllPausedSessions() {
        const sessions = [...this.pausedSessions.values()];
        this.pausedSessions.clear();
        for (const state of sessions) {
            try {
                await state.session.close();
            }
            catch {
                // ignore cleanup error on already-closed browser
            }
        }
    }
    async runTask(req) {
        req.signal?.throwIfAborted();
        const subagentId = `subagent-${crypto.randomUUID().slice(0, 8)}`;
        const maxSteps = req.maxSteps ?? 10;
        const maxRecentImages = req.maxRecentImages ?? 3;
        const snapshotDir = path.join(req.artifactDir, subagentId);
        const session = await new BrowserSession(req.sessionOptions).start();
        const onAbort = () => {
            void session.close().catch(() => { });
        };
        req.signal?.addEventListener('abort', onAbort, { once: true });
        try {
            const hostFacts = new HostFactsTracker(subagentId, req.role, session);
            const history = new SlidingWindowHistory(maxRecentImages);
            const tools = new AtomicBrowserToolset(session, snapshotDir);
            const planner = req.planner ||
                (process.env.DSH_VISION_API_KEY
                    ? createOpenAIVisionPlanner({
                        apiKey: process.env.DSH_VISION_API_KEY,
                        baseUrl: process.env.DSH_VISION_BASE_URL,
                        model: process.env.DSH_VISION_MODEL,
                    })
                    : createBuiltinInspectorPlanner());
            if (!this.isOriginPermitted(req.startUrl, req.allowedOrigins, req.blockedOrigins)) {
                hostFacts.recordBlockedOrigin(req.startUrl);
                await session.close();
                return {
                    subagentId,
                    role: req.role,
                    status: 'BLOCKED',
                    subagentReport: `BLOCKED: Origin of ${req.startUrl} is not permitted by host policy.`,
                    hostFactsBlock: hostFacts.formatHostFactsBlock(),
                    hostFacts: hostFacts.getFacts(),
                    contextStats: history.getStats(),
                };
            }
            const initRes = await tools.navigate(req.startUrl, 1200);
            req.signal?.throwIfAborted();
            hostFacts.recordStep(initRes.observation.screenshotPath);
            history.pushObservation(initRes.action, initRes.observation, initRes.llmSummary);
            return await this.executeLoop({
                subagentId,
                req,
                session,
                tools,
                hostFacts,
                history,
                planner,
                nextStep: 1,
                maxSteps,
                latestObs: initRes.observation,
            });
        }
        finally {
            req.signal?.removeEventListener('abort', onAbort);
        }
    }
    async resumeTask(subagentId, userFollowupNote = 'Human takeover completed. Continue the task.', signal) {
        signal?.throwIfAborted();
        const paused = this.pausedSessions.get(subagentId);
        if (!paused) {
            throw new Error(`No paused subagent session found for subagentId: ${subagentId}`);
        }
        this.pausedSessions.delete(subagentId);
        const { req, session, tools, hostFacts, history, planner, nextStep, maxSteps } = paused;
        req.signal = signal;
        if (userFollowupNote) {
            req.taskPrompt = `${req.taskPrompt}\n\n[User Follow-up Note]: ${userFollowupNote}`;
        }
        const onAbort = () => {
            void session.close().catch(() => { });
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        try {
            const postTakeoverObs = await tools.sampler.captureSnapshot('resumed_after_takeover');
            signal?.throwIfAborted();
            hostFacts.recordStep(postTakeoverObs.screenshotPath);
            history.pushObservation(`Resumed after human takeover (${userFollowupNote})`, postTakeoverObs, tools.sampler.formatObservationForLLM(postTakeoverObs));
            return await this.executeLoop({
                subagentId,
                req,
                session,
                tools,
                hostFacts,
                history,
                planner,
                nextStep,
                maxSteps,
                latestObs: postTakeoverObs,
            });
        }
        finally {
            signal?.removeEventListener('abort', onAbort);
        }
    }
    async executeLoop(state) {
        const { subagentId, req, session, tools, hostFacts, history, planner, maxSteps } = state;
        let latestObs = state.latestObs;
        let keepSessionAlive = false;
        try {
            for (let step = state.nextStep; step <= maxSteps; step++) {
                req.signal?.throwIfAborted();
                if (req.pauseOnGate ?? true) {
                    const gate = await detectPageGate(session.page);
                    if (gate.detected && gate.reason) {
                        keepSessionAlive = true;
                        this.pausedSessions.set(subagentId, {
                            subagentId,
                            req,
                            session,
                            tools,
                            hostFacts,
                            history,
                            planner,
                            nextStep: step,
                            maxSteps,
                        });
                        const card = buildApprovalCard({
                            subagentId,
                            role: req.role,
                            reason: gate.reason,
                            url: gate.url,
                            screenshotPath: latestObs.screenshotPath,
                            details: gate.details,
                        });
                        return {
                            subagentId,
                            role: req.role,
                            status: 'PAUSED_FOR_TAKEOVER',
                            subagentReport: `${card.title}\n${card.instructions}`,
                            hostFactsBlock: hostFacts.formatHostFactsBlock(),
                            hostFacts: hostFacts.getFacts(),
                            contextStats: history.getStats(),
                            approvalCard: card,
                        };
                    }
                }
                const decision = await planner({
                    stepIndex: step,
                    maxSteps,
                    taskPrompt: req.taskPrompt,
                    latestObservation: latestObs,
                    history,
                    hostFacts,
                    signal: req.signal,
                });
                req.signal?.throwIfAborted();
                if (decision.type === 'complete') {
                    return {
                        subagentId,
                        role: req.role,
                        status: 'COMPLETED',
                        subagentReport: decision.report,
                        hostFactsBlock: hostFacts.formatHostFactsBlock(),
                        hostFacts: hostFacts.getFacts(),
                        contextStats: history.getStats(),
                    };
                }
                if (decision.type === 'pause_for_takeover') {
                    keepSessionAlive = true;
                    this.pausedSessions.set(subagentId, {
                        subagentId,
                        req,
                        session,
                        tools,
                        hostFacts,
                        history,
                        planner,
                        nextStep: step + 1,
                        maxSteps,
                    });
                    const card = buildApprovalCard({
                        subagentId,
                        role: req.role,
                        reason: decision.blockReason,
                        url: session.page.url(),
                        screenshotPath: latestObs.screenshotPath,
                        details: decision.message,
                    });
                    return {
                        subagentId,
                        role: req.role,
                        status: 'PAUSED_FOR_TAKEOVER',
                        subagentReport: `${card.title}\n${card.instructions}`,
                        hostFactsBlock: hostFacts.formatHostFactsBlock(),
                        hostFacts: hostFacts.getFacts(),
                        contextStats: history.getStats(),
                        approvalCard: card,
                    };
                }
                if (decision.type === 'navigate') {
                    if (!this.isOriginPermitted(decision.url, req.allowedOrigins, req.blockedOrigins)) {
                        hostFacts.recordBlockedOrigin(decision.url);
                        const snap = await tools.sampler.captureSnapshot('origin_blocked');
                        hostFacts.recordStep(snap.screenshotPath);
                        history.pushObservation(`BLOCKED navigation to ${decision.url} (origin policy)`, snap, tools.sampler.formatObservationForLLM(snap));
                        latestObs = snap;
                        continue;
                    }
                    const res = await tools.navigate(decision.url, 900);
                    hostFacts.recordStep(res.observation.screenshotPath);
                    history.pushObservation(`${res.action} (${decision.reason})`, res.observation, res.llmSummary);
                    latestObs = res.observation;
                    continue;
                }
                if (decision.type === 'set_cursor_style') {
                    await tools.setCursorStyle(decision.style);
                    continue;
                }
                let actionResult;
                if (decision.type === 'move_mouse') {
                    actionResult = await tools.moveMouse(decision.points, decision.label ?? 'SUBAGENT SWEEP');
                }
                else if (decision.type === 'hover') {
                    actionResult = await tools.hover(decision.target);
                }
                else if (decision.type === 'click') {
                    actionResult = await tools.click(decision.target, 320);
                }
                else if (decision.type === 'type_text') {
                    actionResult = await tools.typeText(decision.target, decision.text, decision.pressEnter ?? false);
                }
                else if (decision.type === 'scroll') {
                    actionResult = await tools.scroll(decision.deltaY, 320);
                }
                else {
                    throw new Error(`Unsupported decision: ${JSON.stringify(decision)}`);
                }
                hostFacts.recordStep(actionResult.observation.screenshotPath);
                history.pushObservation(`${actionResult.action} — ${decision.reason}`, actionResult.observation, actionResult.llmSummary);
                latestObs = actionResult.observation;
            }
            return {
                subagentId,
                role: req.role,
                status: 'MAX_STEPS_REACHED',
                subagentReport: `MAX_STEPS_REACHED after ${maxSteps} steps.`,
                hostFactsBlock: hostFacts.formatHostFactsBlock(),
                hostFacts: hostFacts.getFacts(),
                contextStats: history.getStats(),
            };
        }
        finally {
            if (!keepSessionAlive) {
                await session.close();
            }
        }
    }
}
