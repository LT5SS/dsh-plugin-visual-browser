import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { defineTool, } from '@deepseek-ai/dsh-tools';
import { BrowserSession } from './driver/browser-session.js';
import { resolveBrowserWindowMode } from './driver/window-manager.js';
import { resolveCursorStyle } from './injected/virtual-cursor.js';
import { AtomicBrowserToolset } from './tools/atomic-tools.js';
import { BrowserSubagentRunner, createBuiltinInspectorPlanner, createDshHostLlmPlanner, createOpenAIVisionPlanner, summarizeDecisionAction, } from './subagent/runner.js';
export * from './driver/types.js';
export * from './driver/browser-session.js';
export * from './driver/window-manager.js';
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
 * Unwraps a Cordis/Cosmokit Volatile<T> ref or returns plain values directly.
 */
export function readVolatileValue(value) {
    if (value !== null &&
        typeof value === 'object' &&
        typeof value.get === 'function') {
        return value.get();
    }
    return value;
}
async function loadSchemastery() {
    try {
        const mod = await import('@deepseek-ai/schemastery');
        return mod?.default ?? mod;
    }
    catch {
        try {
            const req = createRequire(import.meta.url);
            let toolsEntry;
            const metaResolve = import.meta.resolve;
            if (typeof metaResolve === 'function') {
                try {
                    const resolvedUrl = metaResolve.call(import.meta, '@deepseek-ai/dsh-tools');
                    if (typeof resolvedUrl === 'string' && resolvedUrl.startsWith('file:')) {
                        toolsEntry = fileURLToPath(resolvedUrl);
                    }
                }
                catch {
                    // fall back to createRequire
                }
            }
            if (!toolsEntry) {
                toolsEntry = req.resolve('@deepseek-ai/dsh-tools');
            }
            const realToolsEntry = fs.realpathSync(toolsEntry);
            const nestedReq = createRequire(realToolsEntry);
            const schemaPath = nestedReq.resolve('@deepseek-ai/schemastery');
            const mod = await import(pathToFileURL(schemaPath).href);
            return mod?.default ?? mod;
        }
        catch {
            return null;
        }
    }
}
export function buildPluginConfigSchema(z) {
    const cursorStyleSchema = z
        .object({
        preset: z
            .union([
            'cyber-neon',
            'comet-gold',
            'laser-dots',
            'stealth-minimal',
            'clean-none',
            'custom',
        ])
            .default('cyber-neon')
            .description('虚拟鼠标预设样式'),
        pointerShape: z
            .union(['arrow', 'crosshair', 'dot', 'star', 'ring', 'custom-svg', 'custom-image'])
            .description('指针图形样式'),
        pointerColor: z.string().description('指针填充颜色（Hex/CSS）'),
        pointerBorderColor: z.string().description('指针描边颜色'),
        pointerScale: z.number().min(0.4).max(3).description('指针缩放倍数（0.4 - 3.0）'),
        customPointerSvgPath: z
            .string()
            .max(2000)
            .description('自定义 SVG <path d="...">（28x28 viewBox）'),
        customPointerImageUrl: z
            .string()
            .max(200000)
            .description('自定义指针图片 URL 或 data:image Data URI'),
        customPointerHotspotX: z.number().min(0).max(28).description('自定义指针热点 X（0 - 28）'),
        customPointerHotspotY: z.number().min(0).max(28).description('自定义指针热点 Y（0 - 28）'),
        trailVariant: z
            .union(['dashed', 'solid', 'dots', 'comet', 'none'])
            .description('拖尾渲染样式'),
        trailColorStart: z.string().description('拖尾起点颜色'),
        trailColorEnd: z.string().description('拖尾终点颜色'),
        trailWidth: z.number().min(0).max(12).description('拖尾粗细（px）'),
        trailLength: z.number().min(2).max(60).description('拖尾保留点数（2 - 60）'),
        trailGlow: z.boolean().description('是否开启拖尾外发光'),
        rippleColor: z.string().description('点击波纹颜色'),
        showBadge: z.boolean().description('是否显示坐标与动作徽标'),
        badgeTextPrefix: z.string().max(24).description('徽标前缀文本（默认 DSH）'),
    })
        .default({})
        .description('虚拟鼠标与拖尾实时外观设置')
        .volatile();
    return z.object({
        mode: z
            .union(['auto', 'dsh-electron-webview', 'local-background', 'cdp-attach'])
            .default('auto')
            .description('浏览器连接运行模式'),
        cdpEndpoint: z.string().description('可选 CDP 调试端点'),
        executablePath: z.string().description('可选本地 Chrome/Edge 可执行文件路径'),
        windowMode: z
            .union(['visible-background', 'minimized', 'headless'])
            .default('visible-background')
            .description('窗口显示方式（visible-background 后台可见不抢焦点）')
            .volatile(),
        keepWindowOpen: z
            .boolean()
            .default(true)
            .description('任务完成后保持单窗口打开并复用')
            .volatile(),
        showTakeoverControl: z
            .boolean()
            .default(true)
            .description('在浏览器右上角显示状态条与接管提示')
            .volatile(),
        takeoverHotkey: z
            .string()
            .default('F8')
            .description('随时触发人工暂停接管的全局快捷键')
            .volatile(),
        windowBounds: z
            .object({
            x: z.number(),
            y: z.number(),
            width: z.number(),
            height: z.number(),
        })
            .description('可见后台窗口自定义坐标与尺寸'),
        backgroundSilent: z.boolean().description('兼容旧版全静默开关'),
        artifactDir: z.string().description('截图与诊断输出目录'),
        maxSteps: z.number().min(1).max(60).default(12).description('默认最大执行步数'),
        maxRecentImages: z.number().min(1).max(10).default(3).description('滑动上下文保留截图数'),
        allowedOrigins: z.array(z.string()).description('允许访问的源白名单'),
        blockedOrigins: z.array(z.string()).description('禁止访问的源黑名单'),
        cursorStyle: cursorStyleSchema,
        hostProvider: z.string().description('覆盖宿主 LLM Provider'),
        hostModel: z.string().description('覆盖宿主 LLM Model'),
        visionApiKey: z.string().description('外部 Vision API Key'),
        visionBaseUrl: z.string().description('外部 Vision API Base URL'),
        visionModel: z.string().description('外部 Vision API Model'),
        customPlanner: z.any().description('程序化测试自定义规划器'),
    });
}
const schemasteryRuntime = await loadSchemastery();
export const Config = schemasteryRuntime ? buildPluginConfigSchema(schemasteryRuntime) : undefined;
/**
 * Guarantees a canonical lossless JSON object with zero `undefined` members or non-plain prototypes,
 * satisfying `@deepseek-ai/dsh-tools` 0.2.x output validation.
 */
export function toLosslessJson(value) {
    return JSON.parse(JSON.stringify(value));
}
function safeRead(read) {
    try {
        return read();
    }
    catch {
        return undefined;
    }
}
/**
 * Safely binds optional Cordis host services (`llm`, `attachments`) using secondary child fibers
 * (`ctx.inject([serviceName], callback)`) so missing optional services remain pending cleanly
 * without blocking top-level plugin activation or throwing on uninjected Cordis 4.x property getters.
 */
function bindOptionalHostServices(ctx, hostServices) {
    if (!ctx)
        return;
    const serviceNames = ['llm', 'attachments'];
    const injectFn = safeRead(() => ctx.inject);
    if (typeof injectFn === 'function') {
        for (const serviceName of serviceNames) {
            try {
                injectFn.call(ctx, [serviceName], (sub) => {
                    const service = safeRead(() => sub?.[serviceName]);
                    if (service !== undefined) {
                        hostServices[serviceName] = service;
                        if (typeof sub?.effect === 'function') {
                            sub.effect(() => () => {
                                if (hostServices[serviceName] === service) {
                                    hostServices[serviceName] = undefined;
                                }
                            }, `dsh-plugin-visual-browser.unbind.${serviceName}`);
                        }
                    }
                });
            }
            catch {
                /* secondary injection unavailable on this mock host */
            }
        }
        return;
    }
    // Fallback only for legacy non-Cordis test stubs that expose services directly without ctx.inject
    for (const serviceName of serviceNames) {
        const service = safeRead(() => ctx?.[serviceName]);
        if (service !== undefined) {
            hostServices[serviceName] = service;
        }
    }
}
function getEffectiveHostServices(hostServices, ctx) {
    const result = {};
    const hasInjectApi = typeof safeRead(() => ctx?.inject) === 'function';
    for (const serviceName of ['llm', 'attachments']) {
        result[serviceName] =
            hostServices[serviceName] ??
                safeRead(() => ctx?.get?.(serviceName)) ??
                (hasInjectApi ? undefined : safeRead(() => ctx?.[serviceName]));
    }
    return result;
}
/**
 * Resolves the default absolute artifact directory anchored to:
 * 1. Explicit `config.artifactDir` (from cordis.yml)
 * 2. `DSH_BROWSER_ARTIFACT_DIR` env var
 * 3. `DSH_HOME` env var (set by DSH Desktop pack launcher) or `~/.dsh` fallback
 */
export function resolveDefaultArtifactDir(configuredDir, _ctx) {
    const raw = configuredDir ||
        process.env.DSH_BROWSER_ARTIFACT_DIR ||
        path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'artifacts', 'dsh-browser');
    return path.resolve(raw);
}
async function tryRegisterImageAttachment(hostServices, ctx, screenshotPath) {
    if (!screenshotPath || !fs.existsSync(screenshotPath))
        return null;
    const attachments = getEffectiveHostServices(hostServices, ctx).attachments;
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
/**
 * Formats the single-line planner & host-service diagnostics footer appended to `browser_subagent_run`
 * rendered output so the model, UI, and DSH session logs can observe the active routing & fallback reason.
 */
export function formatPlannerDiagnosticsLine(value) {
    const d = value?.planner_detail ?? {};
    const hs = value?.host_services ?? {};
    const downgraded = Boolean(d.initial_mode && d.initial_mode !== d.effective_mode);
    const route = d.provider && d.model ? ` | route: ${d.provider}/${d.model}` : '';
    return (`\n\n— planner: ${value?.planner_mode ?? '?'}` +
        (downgraded
            ? ` (initial ${d.initial_mode}${d.last_fallback_reason ? `, reason ${d.last_fallback_reason}` : ''}, fallbacks ${d.fallback_count ?? '?'})`
            : '') +
        ` | host services: llm ${hs.llm ? 'yes' : 'no'}, attachments ${hs.attachments ? 'yes' : 'no'}${route}`);
}
/**
 * Resolves the provider/model route from plugin overrides or the active DSH tool execution context.
 */
export function resolveHostLlmRoute(config, exec) {
    const agentAny = exec?.agent;
    const selection = safeRead(() => agentAny?.model?.current?.()) ??
        safeRead(() => agentAny?.session?.requestHeader?.()?.config) ??
        safeRead(() => agentAny?.session?.config) ??
        safeRead(() => agentAny?.config);
    const provider = config.hostProvider || selection?.provider;
    const model = config.hostModel || selection?.model;
    if (typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0) {
        return { provider, model };
    }
    return null;
}
/**
 * Resolves which planner backend will handle `browser_subagent_run` given config and bound host services.
 */
export function resolvePlannerMode(config, hostServices = {}, exec) {
    if (config.customPlanner) {
        return 'custom';
    }
    if (hostServices.llm &&
        typeof hostServices.llm.stream === 'function' &&
        resolveHostLlmRoute(config, exec)) {
        return 'host-ctx-llm';
    }
    if (config.visionApiKey || process.env.DSH_VISION_API_KEY) {
        return 'external-vision-api';
    }
    return 'builtin-inspector';
}
function resolveSubagentPlanner(hostServices, ctx, config, exec) {
    const effectiveServices = getEffectiveHostServices(hostServices, ctx);
    const initialMode = resolvePlannerMode(config, effectiveServices, exec);
    const route = resolveHostLlmRoute(config, exec);
    const tracker = {
        initialMode,
        effectiveMode: initialMode,
        ...(route ? { provider: route.provider, model: route.model } : {}),
        fallbackCount: 0,
        steps: [],
    };
    const onStepDiagnostic = (diag) => {
        tracker.steps.push(diag);
        if (diag.fallback_reason) {
            tracker.fallbackCount++;
            tracker.lastFallbackReason = diag.fallback_reason;
            tracker.effectiveMode =
                initialMode === 'host-ctx-llm' ? 'host-ctx-llm-fallback' : 'external-vision-api-fallback';
        }
    };
    if (initialMode === 'custom' && config.customPlanner) {
        return { planner: config.customPlanner, tracker, effectiveServices };
    }
    if (initialMode === 'host-ctx-llm' && effectiveServices.llm && route) {
        const agentAny = exec?.agent;
        const rawSessionId = safeRead(() => agentAny?.sessionId) ?? safeRead(() => agentAny?.session?.id);
        const sessionId = typeof rawSessionId === 'string' && rawSessionId.length > 0 ? rawSessionId : undefined;
        return {
            planner: createDshHostLlmPlanner({
                llm: effectiveServices.llm,
                attachments: effectiveServices.attachments,
                provider: route.provider,
                model: route.model,
                ...(sessionId ? { sessionId } : {}),
                onStepDiagnostic,
            }),
            tracker,
            effectiveServices,
        };
    }
    if (initialMode === 'external-vision-api') {
        const apiKey = config.visionApiKey || process.env.DSH_VISION_API_KEY;
        if (apiKey) {
            return {
                planner: createOpenAIVisionPlanner({
                    apiKey,
                    baseUrl: config.visionBaseUrl || process.env.DSH_VISION_BASE_URL,
                    model: config.visionModel || process.env.DSH_VISION_MODEL,
                    onStepDiagnostic,
                }),
                tracker,
                effectiveServices,
            };
        }
    }
    // Zero-config deterministic visual walkthrough fallback (never hard-crashes)
    return {
        planner: createBuiltinInspectorPlanner(),
        tracker,
        effectiveServices,
    };
}
/**
 * Builds the 4 DSH 0.2.x `ToolDefinition` objects using official `defineTool()`.
 */
export function createVisualBrowserTools(ctx, config = {}, runner = new BrowserSubagentRunner(), hostServices, bridgeOut) {
    const resolvedServices = hostServices ?? {};
    if (!hostServices) {
        bindOptionalHostServices(ctx, resolvedServices);
    }
    const artifactRoot = resolveDefaultArtifactDir(config.artifactDir);
    let toolCursorOverride = null;
    const getLiveCursorStyle = () => {
        const baseCfg = readVolatileValue(config.cursorStyle) ?? {};
        if (toolCursorOverride) {
            return resolveCursorStyle({ ...baseCfg, ...toolCursorOverride });
        }
        return resolveCursorStyle({
            preset: 'cyber-neon',
            ...baseCfg,
        });
    };
    const getLiveWindowMode = (override) => {
        return resolveBrowserWindowMode({
            windowMode: override ?? readVolatileValue(config.windowMode),
            backgroundSilent: config.backgroundSilent,
        });
    };
    const getLiveKeepWindowOpen = (effectiveMode) => {
        return readVolatileValue(config.keepWindowOpen) ?? effectiveMode !== 'headless';
    };
    const getLiveShowTakeoverControl = (effectiveMode) => {
        return readVolatileValue(config.showTakeoverControl) ?? effectiveMode !== 'headless';
    };
    const getLiveTakeoverHotkey = () => {
        const raw = readVolatileValue(config.takeoverHotkey);
        return typeof raw === 'string' ? raw : 'F8';
    };
    if (bridgeOut) {
        bridgeOut.bridge = {
            syncFromSettingsDocument: () => {
                toolCursorOverride = null;
                const shared = runner.getSharedSession();
                if (shared?.isAlive()) {
                    const nextStyle = getLiveCursorStyle();
                    const nextHotkey = getLiveTakeoverHotkey();
                    void shared.motion.setCursorStyle(nextStyle).catch(() => { });
                    void shared.motion.setTakeoverHotkey(nextHotkey).catch(() => { });
                }
            },
        };
    }
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
                enum: [
                    'cyber-neon',
                    'comet-gold',
                    'laser-dots',
                    'stealth-minimal',
                    'clean-none',
                    'custom',
                ],
            },
            window_mode: {
                type: 'string',
                description: 'Optional window presentation override ("visible-background", "minimized", or "headless")',
                enum: ['visible-background', 'minimized', 'headless'],
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
                const text = `${value?.host_facts_block ?? ''}\n\n${value?.subagent_report ?? ''}${formatPlannerDiagnosticsLine(value)}`;
                return renderToolContent(text, value?.image_attachment);
            },
        },
        async execute(args, exec) {
            const liveStyle = getLiveCursorStyle();
            const style = args.cursor_preset
                ? resolveCursorStyle({
                    ...liveStyle,
                    preset: args.cursor_preset,
                })
                : liveStyle;
            const subagentId = `subagent-${crypto.randomUUID().slice(0, 8)}`;
            const { planner, tracker, effectiveServices } = resolveSubagentPlanner(resolvedServices, ctx, config, exec);
            const buildPlannerDetail = () => ({
                initial_mode: tracker.initialMode,
                effective_mode: tracker.effectiveMode,
                ...(tracker.provider ? { provider: tracker.provider } : {}),
                ...(tracker.model ? { model: tracker.model } : {}),
                fallback_count: tracker.fallbackCount,
                ...(tracker.lastFallbackReason ? { last_fallback_reason: tracker.lastFallbackReason } : {}),
                ...(tracker.steps.length > 0 ? { llm_steps: tracker.steps } : {}),
            });
            const hostServicesStatus = {
                llm: Boolean(effectiveServices.llm && typeof effectiveServices.llm.stream === 'function'),
                attachments: Boolean(effectiveServices.attachments &&
                    typeof effectiveServices.attachments.saveImage === 'function'),
            };
            const writeDiagnostics = async (payload) => {
                try {
                    const subagentDir = path.join(artifactRoot, subagentId);
                    const targetFile = path.join(subagentDir, 'diagnostics.json');
                    await fs.promises.mkdir(subagentDir, { recursive: true });
                    await fs.promises.writeFile(targetFile, JSON.stringify(toLosslessJson(payload), null, 2), 'utf8');
                    return targetFile.replace(/\\/g, '/');
                }
                catch {
                    return undefined;
                }
            };
            const effectiveWindowMode = getLiveWindowMode(args.window_mode);
            const keepWindowOpen = getLiveKeepWindowOpen(effectiveWindowMode);
            const showTakeoverControl = getLiveShowTakeoverControl(effectiveWindowMode);
            const takeoverHotkey = getLiveTakeoverHotkey();
            try {
                const res = await runner.runTask({
                    subagentId,
                    role: String(args.role || 'Browser Subagent'),
                    taskPrompt: String(args.task_prompt),
                    startUrl: String(args.url),
                    artifactDir: artifactRoot,
                    maxSteps: Number(args.max_steps ?? config.maxSteps ?? 10),
                    maxRecentImages: config.maxRecentImages ?? 3,
                    allowedOrigins: config.allowedOrigins,
                    blockedOrigins: config.blockedOrigins,
                    keepWindowOpen,
                    signal: exec?.signal,
                    sessionOptions: {
                        mode: config.mode ?? 'auto',
                        cdpEndpoint: config.cdpEndpoint,
                        executablePath: config.executablePath,
                        windowMode: effectiveWindowMode,
                        keepWindowOpen,
                        showTakeoverControl,
                        takeoverHotkey,
                        windowBounds: config.windowBounds,
                        backgroundSilent: effectiveWindowMode === 'headless',
                        cursorStyle: style,
                    },
                    onActionResult: (info) => {
                        const actionSummary = {
                            ...summarizeDecisionAction(info.decision),
                            ...(info.blocked ? { blocked: info.blocked } : {}),
                            ...(info.hit ? { hit: info.hit } : {}),
                            ...(info.at ? { at: info.at } : {}),
                        };
                        const existing = tracker.steps.find((s) => s.step === info.stepIndex);
                        if (existing) {
                            existing.action = actionSummary;
                        }
                        else if (info.blocked) {
                            tracker.steps.push({
                                step: info.stepIndex,
                                backend: tracker.initialMode === 'external-vision-api'
                                    ? 'external-vision-api'
                                    : 'host-ctx-llm',
                                chunk_count: 0,
                                chunk_types: {},
                                text_length: 0,
                                decision_source: 'llm',
                                action: actionSummary,
                            });
                        }
                    },
                    planner,
                });
                const imageAttachment = await tryRegisterImageAttachment(resolvedServices, ctx, res.hostFacts.latestScreenshot);
                const plannerDetail = buildPlannerDetail();
                const diagnosticsPath = await writeDiagnostics({
                    timestamp: new Date().toISOString(),
                    status: res.status,
                    subagent_id: res.subagentId,
                    window_mode: effectiveWindowMode,
                    planner_mode: tracker.effectiveMode,
                    planner_detail: plannerDetail,
                    host_services: hostServicesStatus,
                    steps: res.contextStats,
                    host_facts: res.hostFacts,
                });
                return toLosslessJson({
                    status: res.status,
                    subagent_id: res.subagentId,
                    planner_mode: tracker.effectiveMode,
                    planner_detail: plannerDetail,
                    host_services: hostServicesStatus,
                    ...(diagnosticsPath ? { diagnostics_path: diagnosticsPath } : {}),
                    host_facts_block: res.hostFactsBlock,
                    subagent_report: res.subagentReport,
                    approval_card: res.approvalCard ?? null,
                    sliding_window_stats: res.contextStats,
                    ...(imageAttachment ? { image_attachment: imageAttachment } : {}),
                });
            }
            catch (error) {
                await writeDiagnostics({
                    timestamp: new Date().toISOString(),
                    status: 'FAILED',
                    subagent_id: subagentId,
                    window_mode: effectiveWindowMode,
                    error: {
                        name: error?.name || error?.constructor?.name || 'Error',
                        message: String(error?.message ?? error).slice(0, 400),
                    },
                    planner_mode: tracker.effectiveMode,
                    planner_detail: buildPlannerDetail(),
                    host_services: hostServicesStatus,
                    artifact_dir: artifactRoot,
                });
                throw error;
            }
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
            const imageAttachment = await tryRegisterImageAttachment(resolvedServices, ctx, res.hostFacts.latestScreenshot);
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
        description: 'Customize the virtual mouse cursor and motion trail style (choose from presets or custom shape, SVG path, custom image URL, colors, trail width, length, and variant).',
        parameters: {
            preset: {
                type: 'string',
                description: 'Preset name',
                enum: [
                    'cyber-neon',
                    'comet-gold',
                    'laser-dots',
                    'stealth-minimal',
                    'clean-none',
                    'custom',
                ],
            },
            pointer_shape: {
                type: 'string',
                description: 'Cursor shape',
                enum: ['arrow', 'crosshair', 'dot', 'star', 'ring', 'custom-svg', 'custom-image'],
            },
            pointer_color: {
                type: 'string',
                description: 'Cursor fill color (hex/rgb)',
            },
            pointer_border_color: {
                type: 'string',
                description: 'Cursor stroke border color (hex/rgb)',
            },
            pointer_scale: {
                type: 'number',
                description: 'Cursor scale multiplier (0.4 - 3.0)',
            },
            custom_svg_path: {
                type: 'string',
                description: 'Custom SVG <path d="..."> string in a 28x28 coordinate box',
            },
            custom_image_url: {
                type: 'string',
                description: 'Custom cursor image URL (https/http) or data:image/... URI',
            },
            trail_variant: {
                type: 'string',
                description: 'Trail rendering style',
                enum: ['dashed', 'solid', 'dots', 'comet', 'none'],
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
                description: 'Trail stroke width in px (0 - 12)',
            },
            trail_length: {
                type: 'integer',
                description: 'Number of trail history points (2 - 60)',
            },
            trail_glow: {
                type: 'boolean',
                description: 'Enable outer neon glow along the trail',
            },
            ripple_color: {
                type: 'string',
                description: 'Click ripple color',
            },
            show_badge: {
                type: 'boolean',
                description: 'Show floating coordinate badge next to the cursor',
            },
            badge_text_prefix: {
                type: 'string',
                description: 'Prefix text displayed inside the cursor badge (default: DSH)',
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
            const nextPatch = {
                ...getLiveCursorStyle(),
                ...(args.preset ? { preset: args.preset } : {}),
                ...(args.pointer_shape ? { pointerShape: args.pointer_shape } : {}),
                ...(args.pointer_color ? { pointerColor: String(args.pointer_color) } : {}),
                ...(args.pointer_border_color
                    ? { pointerBorderColor: String(args.pointer_border_color) }
                    : {}),
                ...(args.pointer_scale !== undefined ? { pointerScale: Number(args.pointer_scale) } : {}),
                ...(args.custom_svg_path !== undefined
                    ? { customPointerSvgPath: String(args.custom_svg_path) }
                    : {}),
                ...(args.custom_image_url !== undefined
                    ? { customPointerImageUrl: String(args.custom_image_url) }
                    : {}),
                ...(args.trail_variant ? { trailVariant: args.trail_variant } : {}),
                ...(args.trail_color_start ? { trailColorStart: String(args.trail_color_start) } : {}),
                ...(args.trail_color_end ? { trailColorEnd: String(args.trail_color_end) } : {}),
                ...(args.trail_width !== undefined ? { trailWidth: Number(args.trail_width) } : {}),
                ...(args.trail_length !== undefined ? { trailLength: Number(args.trail_length) } : {}),
                ...(args.trail_glow !== undefined ? { trailGlow: Boolean(args.trail_glow) } : {}),
                ...(args.ripple_color ? { rippleColor: String(args.ripple_color) } : {}),
                ...(args.show_badge !== undefined ? { showBadge: Boolean(args.show_badge) } : {}),
                ...(args.badge_text_prefix !== undefined
                    ? { badgeTextPrefix: String(args.badge_text_prefix) }
                    : {}),
            };
            toolCursorOverride = resolveCursorStyle(nextPatch);
            const shared = runner.getSharedSession();
            if (shared?.isAlive()) {
                await shared.motion.setCursorStyle(toolCursorOverride).catch(() => { });
            }
            return toLosslessJson({
                updated: true,
                active_cursor_style: toolCursorOverride,
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
            const effectiveWindowMode = getLiveWindowMode();
            const keepWindowOpen = getLiveKeepWindowOpen(effectiveWindowMode);
            const showTakeoverControl = getLiveShowTakeoverControl(effectiveWindowMode);
            const takeoverHotkey = getLiveTakeoverHotkey();
            const liveCursorStyle = getLiveCursorStyle();
            const useShared = keepWindowOpen && !runner.isSharedSessionBusy();
            const acquired = useShared
                ? await runner.acquireReusableSession({
                    mode: config.mode ?? 'auto',
                    cdpEndpoint: config.cdpEndpoint,
                    executablePath: config.executablePath,
                    windowMode: effectiveWindowMode,
                    keepWindowOpen: true,
                    showTakeoverControl,
                    takeoverHotkey,
                    windowBounds: config.windowBounds,
                    backgroundSilent: effectiveWindowMode === 'headless',
                    cursorStyle: liveCursorStyle,
                }, true)
                : {
                    session: await new BrowserSession({
                        mode: config.mode ?? 'auto',
                        cdpEndpoint: config.cdpEndpoint,
                        executablePath: config.executablePath,
                        windowMode: runner.isSharedSessionBusy() ? 'headless' : effectiveWindowMode,
                        showTakeoverControl: runner.isSharedSessionBusy() ? false : showTakeoverControl,
                        takeoverHotkey,
                        windowBounds: config.windowBounds,
                        backgroundSilent: runner.isSharedSessionBusy()
                            ? true
                            : effectiveWindowMode === 'headless',
                        cursorStyle: liveCursorStyle,
                    }).start(),
                    isShared: false,
                    reused: false,
                };
            const session = acquired.session;
            const onAbort = () => {
                if (acquired.isShared)
                    runner.detachSharedSessionForTakeover(session);
                void session.close().catch(() => { });
            };
            exec?.signal?.addEventListener('abort', onAbort, { once: true });
            try {
                const tools = new AtomicBrowserToolset(session, path.join(artifactRoot, 'quick-snapshots'));
                const res = await tools.navigate(String(args.url), 1200);
                exec?.signal?.throwIfAborted();
                const imageAttachment = await tryRegisterImageAttachment(resolvedServices, ctx, res.observation.screenshotPath);
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
                await runner.releaseReusableSession(session, Boolean(useShared && acquired.isShared && !exec?.signal?.aborted));
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
    const hostServices = {};
    bindOptionalHostServices(ctx, hostServices);
    const bridgeHolder = {};
    const tools = createVisualBrowserTools(ctx, config, runner, hostServices, bridgeHolder);
    for (const tool of tools) {
        ctx.tools.register(tool);
    }
    const unsubSettings = safeRead(() => ctx.on?.('settings/document-updated', (ns) => {
        if (!ns || ns === 'dsh-plugin-visual-browser') {
            bridgeHolder.bridge?.syncFromSettingsDocument();
        }
    }));
    // Standard Cordis 4.x disposal hook via ctx.effect(() => disposer)
    const disposeAll = () => {
        if (typeof unsubSettings === 'function') {
            unsubSettings();
        }
        void runner.closeAllSessions();
    };
    if (typeof ctx.effect === 'function') {
        ctx.effect(() => disposeAll, 'dsh-plugin-visual-browser.disposePausedSessions');
    }
    else {
        ctx.on?.('dispose', disposeAll);
    }
    return { runner, tools, hostServices, bridge: bridgeHolder.bridge };
}
