import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defineTool, } from '@deepseek-ai/dsh-tools';
import { BrowserSession } from './driver/browser-session.js';
import { AtomicBrowserToolset } from './tools/atomic-tools.js';
import { BrowserSubagentRunner, createBuiltinInspectorPlanner, createDshHostLlmPlanner, createOpenAIVisionPlanner, } from './subagent/runner.js';
export * from './driver/types.js';
export * from './driver/browser-session.js';
export * from './driver/human-motion.js';
export * from './injected/virtual-cursor.js';
export * from './sampler/telemetry-collector.js';
export * from './sampler/page-snapshot.js';
export * from './tools/atomic-tools.js';
export * from './subagent/host-facts.js';
export * from './subagent/sliding-context.js';
export * from './subagent/runner.js';
export * from './guardrails/takeover.js';
export const name = 'dsh-plugin-visual-browser';
export const inject = ['tools'];
/**
 * Guarantees a canonical lossless JSON object with zero `undefined` members or non-plain prototypes,
 * satisfying `@deepseek-ai/dsh-tools` 0.2.x output validation.
 */
export function toLosslessJson(value) {
    return JSON.parse(JSON.stringify(value));
}
/**
 * Resolves the default absolute artifact directory anchored to:
 * 1. Explicit `config.artifactDir` (from cordis.yml)
 * 2. `DSH_BROWSER_ARTIFACT_DIR` env var
 * 3. Host Cordis `ctx.baseDir` (active profile / pack directory in DSH Desktop & CLI)
 * 4. `DSH_HOME` env var or `~/.dsh` fallback
 */
export function resolveDefaultArtifactDir(configuredDir, ctx) {
    const ctxAny = ctx;
    const hostBaseDir = typeof ctxAny?.baseDir === 'string'
        ? ctxAny.baseDir
        : typeof ctxAny?.root?.config?.baseDir === 'string'
            ? ctxAny.root.config.baseDir
            : undefined;
    const raw = configuredDir ||
        process.env.DSH_BROWSER_ARTIFACT_DIR ||
        (hostBaseDir ? path.join(hostBaseDir, 'artifacts', 'dsh-browser') : undefined) ||
        path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'artifacts', 'dsh-browser');
    return path.resolve(raw);
}
function getAttachmentsService(ctx) {
    return ctx.attachments ?? ctx.get?.('attachments');
}
function getLlmService(ctx) {
    return ctx.llm ?? ctx.get?.('llm');
}
async function tryRegisterImageAttachment(ctx, screenshotPath) {
    if (!screenshotPath || !fs.existsSync(screenshotPath))
        return null;
    const attachments = getAttachmentsService(ctx);
    if (!attachments || typeof attachments.saveImage !== 'function')
        return null;
    try {
        const bytes = fs.readFileSync(screenshotPath);
        const ref = await attachments.saveImage({
            data: new Uint8Array(bytes),
            mediaType: 'image/png',
            name: path.basename(screenshotPath),
        });
        return toLosslessJson(ref);
    }
    catch {
        return null;
    }
}
function renderToolContent(textSummary, imageAttachment) {
    const blocks = [{ type: 'text', text: textSummary }];
    if (imageAttachment &&
        typeof imageAttachment === 'object' &&
        typeof imageAttachment.attachmentId === 'string') {
        blocks.push({ type: 'image', attachment: imageAttachment });
    }
    return blocks;
}
function resolveSubagentPlanner(ctx, config, exec) {
    if (config.customPlanner) {
        return config.customPlanner;
    }
    // 1. Prefer DSH 0.2 native `ctx.llm` service if available and a model route is known
    const llm = getLlmService(ctx);
    if (llm && typeof llm.stream === 'function') {
        const agentAny = exec?.agent;
        const agentSelection = agentAny?.model?.current?.() ?? agentAny?.session?.requestHeader?.()?.config;
        const provider = config.hostProvider || agentSelection?.provider;
        const model = config.hostModel || agentSelection?.model;
        if (provider && model) {
            return createDshHostLlmPlanner({
                llm,
                attachments: getAttachmentsService(ctx),
                provider,
                model,
            });
        }
    }
    // 2. Next check explicit OpenAI-compatible Vision API key
    const apiKey = config.visionApiKey || process.env.DSH_VISION_API_KEY;
    if (apiKey) {
        return createOpenAIVisionPlanner({
            apiKey,
            baseUrl: config.visionBaseUrl || process.env.DSH_VISION_BASE_URL,
            model: config.visionModel || process.env.DSH_VISION_MODEL,
        });
    }
    // 3. Zero-config deterministic visual walkthrough fallback (never hard-crashes)
    return createBuiltinInspectorPlanner();
}
/**
 * Builds the 4 DSH 0.2.x `ToolDefinition` objects using official `defineTool()`.
 */
export function createVisualBrowserTools(ctx, config = {}, runner = new BrowserSubagentRunner()) {
    const artifactRoot = resolveDefaultArtifactDir(config.artifactDir, ctx);
    let activeCursorStyle = {
        preset: 'cyber-neon',
        ...(config.cursorStyle || {}),
    };
    // 1. browser_subagent_run
    const subagentRunTool = defineTool({
        name: 'browser_subagent_run',
        description: 'Launch an isolated Visual Browser Subagent in the background (with a physical Bezier virtual cursor, 3-in-1 vision+DOM+console sampler, sliding image window, and BROWSER_HOST_FACTS verification). Uses host ctx.llm, DSH_VISION_API_KEY, or built-in autonomous walkthrough inspector. Requires local Chrome/Edge or DSH_BROWSER_EXECUTABLE.',
        parameters: {
            url: {
                type: 'string',
                required: true,
                description: 'Target starting URL (e.g. https://example.com or http://localhost:5173)',
            },
            role: {
                type: 'string',
                required: true,
                description: 'Short 2-5 word role title for the subagent (e.g. "Frontend Visual QA Analyst")',
            },
            task_prompt: {
                type: 'string',
                required: true,
                description: 'Clear actionable instructions and completion condition for the browser subagent',
            },
            max_steps: {
                type: 'integer',
                description: 'Maximum interaction steps (default: 10)',
            },
            cursor_preset: {
                type: 'string',
                description: 'Optional virtual cursor trail preset',
                enum: ['cyber-neon', 'comet-gold', 'laser-dots', 'stealth-minimal', 'clean-none'],
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    status: {
                        type: 'string',
                        enum: ['COMPLETED', 'BLOCKED', 'PAUSED_FOR_TAKEOVER', 'MAX_STEPS_REACHED'],
                    },
                    subagent_id: { type: 'string' },
                    host_facts_block: { type: 'string' },
                    subagent_report: { type: 'string' },
                },
            },
            render(_args, value) {
                const text = `${value.host_facts_block}\n\n${value.subagent_report}`;
                return renderToolContent(text, value.image_attachment);
            },
        },
        async execute(args, exec) {
            const style = args.cursor_preset
                ? { ...activeCursorStyle, preset: args.cursor_preset }
                : activeCursorStyle;
            const planner = resolveSubagentPlanner(ctx, config, exec);
            const res = await runner.runTask({
                role: String(args.role || 'Browser Subagent'),
                taskPrompt: String(args.task_prompt),
                startUrl: String(args.url),
                artifactDir: artifactRoot,
                maxSteps: Number(args.max_steps ?? config.maxSteps ?? 10),
                maxRecentImages: config.maxRecentImages ?? 3,
                allowedOrigins: config.allowedOrigins,
                blockedOrigins: config.blockedOrigins,
                signal: exec?.signal,
                sessionOptions: {
                    mode: config.mode ?? 'auto',
                    cdpEndpoint: config.cdpEndpoint,
                    executablePath: config.executablePath,
                    backgroundSilent: config.backgroundSilent ?? true,
                    cursorStyle: style,
                },
                planner,
            });
            const imageAttachment = await tryRegisterImageAttachment(ctx, res.hostFacts.latestScreenshot);
            return toLosslessJson({
                status: res.status,
                subagent_id: res.subagentId,
                host_facts_block: res.hostFactsBlock,
                subagent_report: res.subagentReport,
                approval_card: res.approvalCard ?? null,
                sliding_window_stats: res.contextStats,
                ...(imageAttachment ? { image_attachment: imageAttachment } : {}),
            });
        },
    });
    // 2. browser_subagent_resume
    const subagentResumeTool = defineTool({
        name: 'browser_subagent_resume',
        description: 'Resume a paused browser subagent session (PAUSED_FOR_TAKEOVER) in the exact same open tab after the user completes login, payment, or human verification.',
        parameters: {
            subagent_id: {
                type: 'string',
                required: true,
                description: 'The subagent_id returned by browser_subagent_run when paused',
            },
            user_note: {
                type: 'string',
                description: 'Optional follow-up note or instructions after human takeover',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    status: {
                        type: 'string',
                        enum: ['COMPLETED', 'BLOCKED', 'PAUSED_FOR_TAKEOVER', 'MAX_STEPS_REACHED'],
                    },
                    subagent_id: { type: 'string' },
                    host_facts_block: { type: 'string' },
                    subagent_report: { type: 'string' },
                },
            },
            render(_args, value) {
                const text = `${value.host_facts_block}\n\n${value.subagent_report}`;
                return renderToolContent(text, value.image_attachment);
            },
        },
        async execute(args, exec) {
            const res = await runner.resumeTask(String(args.subagent_id), args.user_note ? String(args.user_note) : undefined, exec?.signal);
            const imageAttachment = await tryRegisterImageAttachment(ctx, res.hostFacts.latestScreenshot);
            return toLosslessJson({
                status: res.status,
                subagent_id: res.subagentId,
                host_facts_block: res.hostFactsBlock,
                subagent_report: res.subagentReport,
                approval_card: res.approvalCard ?? null,
                sliding_window_stats: res.contextStats,
                ...(imageAttachment ? { image_attachment: imageAttachment } : {}),
            });
        },
    });
    // 3. browser_set_cursor_trail
    const setCursorTrailTool = defineTool({
        name: 'browser_set_cursor_trail',
        description: 'Customize the virtual mouse cursor and motion trail style (choose from 5 presets or set custom colors, trail width, length, and variant).',
        parameters: {
            preset: {
                type: 'string',
                description: 'Preset name',
                enum: ['cyber-neon', 'comet-gold', 'laser-dots', 'stealth-minimal', 'clean-none'],
            },
            trail_variant: {
                type: 'string',
                description: 'Trail rendering style',
                enum: ['dashed', 'solid', 'dots', 'comet', 'none'],
            },
            pointer_color: {
                type: 'string',
                description: 'Cursor arrow fill color (hex/rgb)',
            },
            trail_color_start: {
                type: 'string',
                description: 'Trail tail-end color',
            },
            trail_color_end: {
                type: 'string',
                description: 'Trail head color near cursor tip',
            },
            trail_width: {
                type: 'number',
                description: 'Trail stroke width in px (1 - 10)',
            },
            trail_length: {
                type: 'integer',
                description: 'Number of trail history points (2 - 60)',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    updated: { type: 'boolean', required: true },
                },
            },
            render(_args, value) {
                return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
            },
        },
        async execute(args) {
            activeCursorStyle = {
                ...activeCursorStyle,
                ...(args.preset ? { preset: args.preset } : {}),
                ...(args.trail_variant ? { trailVariant: args.trail_variant } : {}),
                ...(args.pointer_color ? { pointerColor: String(args.pointer_color) } : {}),
                ...(args.trail_color_start ? { trailColorStart: String(args.trail_color_start) } : {}),
                ...(args.trail_color_end ? { trailColorEnd: String(args.trail_color_end) } : {}),
                ...(args.trail_width !== undefined ? { trailWidth: Number(args.trail_width) } : {}),
                ...(args.trail_length !== undefined ? { trailLength: Number(args.trail_length) } : {}),
            };
            return toLosslessJson({
                updated: true,
                active_cursor_style: activeCursorStyle,
            });
        },
    });
    // 4. browser_quick_snapshot
    const quickSnapshotTool = defineTool({
        name: 'browser_quick_snapshot',
        description: 'Silently capture a single 3-in-1 multimodal snapshot (viewport screenshot + numbered interactive controls + DOM/tech/console health) of a URL in the background. Registers an ImageBlock via ctx.attachments when available so the main model can view the screenshot.',
        parameters: {
            url: {
                type: 'string',
                required: true,
                description: 'Target URL to snapshot',
            },
        },
        output: {
            schema: {
                type: 'object',
                additionalProperties: true,
                properties: {
                    screenshot_path: { type: 'string', required: true },
                    hud_summary: { type: 'string', required: true },
                },
            },
            render(_args, value) {
                return renderToolContent(value.hud_summary, value.image_attachment);
            },
        },
        async execute(args, exec) {
            exec?.signal?.throwIfAborted();
            const session = await new BrowserSession({
                mode: config.mode ?? 'auto',
                cdpEndpoint: config.cdpEndpoint,
                executablePath: config.executablePath,
                backgroundSilent: config.backgroundSilent ?? true,
                cursorStyle: activeCursorStyle,
            }).start();
            const onAbort = () => {
                void session.close().catch(() => { });
            };
            exec?.signal?.addEventListener('abort', onAbort, { once: true });
            try {
                const tools = new AtomicBrowserToolset(session, path.join(artifactRoot, 'quick-snapshots'));
                const res = await tools.navigate(String(args.url), 1200);
                exec?.signal?.throwIfAborted();
                const imageAttachment = await tryRegisterImageAttachment(ctx, res.observation.screenshotPath);
                return toLosslessJson({
                    screenshot_path: res.observation.screenshotPath.replace(/\\/g, '/'),
                    hud_summary: res.llmSummary,
                    dom_stats: res.observation.domStats,
                    health: res.observation.health,
                    ...(imageAttachment ? { image_attachment: imageAttachment } : {}),
                });
            }
            finally {
                exec?.signal?.removeEventListener('abort', onAbort);
                await session.close();
            }
        },
    });
    return [subagentRunTool, subagentResumeTool, setCursorTrailTool, quickSnapshotTool];
}
/**
 * DeepSeek Harness (Cordis) Plugin Entry Point
 */
export function apply(ctx, config = {}) {
    const runner = new BrowserSubagentRunner();
    const tools = createVisualBrowserTools(ctx, config, runner);
    for (const tool of tools) {
        ctx.tools.register(tool);
    }
    // Standard Cordis 4.x disposal hook via ctx.effect(() => disposer)
    const disposeAll = () => {
        void runner.closeAllPausedSessions();
    };
    if (typeof ctx.effect === 'function') {
        ctx.effect(() => disposeAll, 'dsh-plugin-visual-browser.disposePausedSessions');
    }
    else {
        ctx.on?.('dispose', disposeAll);
    }
    return { runner, tools };
}
