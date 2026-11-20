import path from 'node:path';
import { BrowserSession } from './driver/browser-session.js';
import { AtomicBrowserToolset } from './tools/atomic-tools.js';
import { BrowserSubagentRunner, createOpenAIVisionPlanner, } from './subagent/runner.js';
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
 * DeepSeek Harness (Cordis) Plugin Entry Point
 */
export function apply(ctx, config = {}) {
    const runner = new BrowserSubagentRunner();
    const artifactRoot = path.resolve(config.artifactDir || './artifacts/dsh-browser');
    let activeCursorStyle = {
        preset: 'cyber-neon',
        ...(config.cursorStyle || {}),
    };
    // 1. Primary Tool: Delegate multi-step visual browser task to an isolated Subagent
    ctx.tools.register({
        name: 'browser_subagent_run',
        description: 'Launch an isolated Visual Browser Subagent in the background (with a physical Bezier virtual cursor, 3-in-1 vision+DOM+console sampler, sliding image window, and BROWSER_HOST_FACTS verification). Does not steal OS window focus.',
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
                type: 'number',
                required: false,
                description: 'Maximum interaction steps (default: 10)',
            },
            cursor_preset: {
                type: 'string',
                required: false,
                description: 'Optional virtual cursor trail preset',
                enum: ['cyber-neon', 'comet-gold', 'laser-dots', 'stealth-minimal', 'clean-none'],
            },
        },
        async execute(args) {
            const style = args.cursor_preset
                ? { ...activeCursorStyle, preset: args.cursor_preset }
                : activeCursorStyle;
            const planner = config.customPlanner ||
                (config.visionApiKey || process.env.DSH_VISION_API_KEY
                    ? createOpenAIVisionPlanner({
                        apiKey: (config.visionApiKey || process.env.DSH_VISION_API_KEY),
                        baseUrl: config.visionBaseUrl || process.env.DSH_VISION_BASE_URL,
                        model: config.visionModel || process.env.DSH_VISION_MODEL,
                    })
                    : undefined);
            const res = await runner.runTask({
                role: String(args.role || 'Browser Subagent'),
                taskPrompt: String(args.task_prompt),
                startUrl: String(args.url),
                artifactDir: artifactRoot,
                maxSteps: Number(args.max_steps || config.maxSteps || 10),
                maxRecentImages: config.maxRecentImages ?? 3,
                allowedOrigins: config.allowedOrigins,
                blockedOrigins: config.blockedOrigins,
                sessionOptions: {
                    mode: config.mode ?? 'auto',
                    cdpEndpoint: config.cdpEndpoint,
                    executablePath: config.executablePath,
                    backgroundSilent: config.backgroundSilent ?? true,
                    cursorStyle: style,
                },
                planner,
            });
            return {
                status: res.status,
                subagent_id: res.subagentId,
                host_facts_block: res.hostFactsBlock,
                subagent_report: res.subagentReport,
                approval_card: res.approvalCard ?? null,
                sliding_window_stats: res.contextStats,
            };
        },
    });
    // 2. Resume Tool: Resume a paused subagent session in the exact same open tab after human takeover
    ctx.tools.register({
        name: 'browser_subagent_resume',
        description: 'Resume a paused browser subagent session (PAUSED_FOR_TAKEOVER) in the same open tab after the user completes login, payment, or human verification.',
        parameters: {
            subagent_id: {
                type: 'string',
                required: true,
                description: 'The subagent_id returned by browser_subagent_run when paused',
            },
            user_note: {
                type: 'string',
                required: false,
                description: 'Optional follow-up note or instructions after human takeover',
            },
        },
        async execute(args) {
            const res = await runner.resumeTask(String(args.subagent_id), args.user_note ? String(args.user_note) : undefined);
            return {
                status: res.status,
                subagent_id: res.subagentId,
                host_facts_block: res.hostFactsBlock,
                subagent_report: res.subagentReport,
                approval_card: res.approvalCard ?? null,
                sliding_window_stats: res.contextStats,
            };
        },
    });
    // 3. Cursor & Trail Style Customization Tool
    ctx.tools.register({
        name: 'browser_set_cursor_trail',
        description: 'Customize the virtual mouse cursor and motion trail style (choose from 5 presets or set custom colors, trail width, length, and variant).',
        parameters: {
            preset: {
                type: 'string',
                required: false,
                description: 'Preset name',
                enum: ['cyber-neon', 'comet-gold', 'laser-dots', 'stealth-minimal', 'clean-none'],
            },
            trail_variant: {
                type: 'string',
                required: false,
                description: 'Trail rendering style',
                enum: ['dashed', 'solid', 'dots', 'comet', 'none'],
            },
            pointer_color: {
                type: 'string',
                required: false,
                description: 'Cursor arrow fill color (hex/rgb)',
            },
            trail_color_start: {
                type: 'string',
                required: false,
                description: 'Trail tail-end color',
            },
            trail_color_end: {
                type: 'string',
                required: false,
                description: 'Trail head color near cursor tip',
            },
            trail_width: {
                type: 'number',
                required: false,
                description: 'Trail stroke width in px (1 - 10)',
            },
            trail_length: {
                type: 'number',
                required: false,
                description: 'Number of trail history points (2 - 60)',
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
            return {
                updated: true,
                active_cursor_style: activeCursorStyle,
            };
        },
    });
    // 4. Quick One-Shot Background Snapshot Tool
    ctx.tools.register({
        name: 'browser_quick_snapshot',
        description: 'Silently capture a single 3-in-1 multimodal snapshot (viewport screenshot + numbered interactive controls + DOM/tech/console health) of a URL in the background.',
        parameters: {
            url: {
                type: 'string',
                required: true,
                description: 'Target URL to snapshot',
            },
        },
        async execute(args) {
            const session = await new BrowserSession({
                mode: config.mode ?? 'auto',
                cdpEndpoint: config.cdpEndpoint,
                executablePath: config.executablePath,
                backgroundSilent: config.backgroundSilent ?? true,
                cursorStyle: activeCursorStyle,
            }).start();
            try {
                const tools = new AtomicBrowserToolset(session, path.join(artifactRoot, 'quick-snapshots'));
                const res = await tools.navigate(String(args.url), 1200);
                return {
                    screenshot_path: res.observation.screenshotPath,
                    hud_summary: res.llmSummary,
                    dom_stats: res.observation.domStats,
                    health: res.observation.health,
                };
            }
            finally {
                await session.close();
            }
        },
    });
    ctx.on?.('dispose', async () => {
        await runner.closeAllPausedSessions();
    });
    return { runner };
}
