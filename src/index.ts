import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  defineTool,
  type ToolDefinition,
  type ToolRunContext,
} from '@deepseek-ai/dsh-tools';
import { BrowserSession } from './driver/browser-session.js';
import type {
  BrowserRuntimeMode,
  BrowserWindowBounds,
  BrowserWindowMode,
  NavigateWaitUntil,
  TrailVariant,
  VirtualCursorPreset,
  VirtualCursorShape,
  VirtualCursorStyleConfig,
} from './driver/types.js';
import { resolveBrowserWindowMode } from './driver/window-manager.js';
import { resolveCursorStyle } from './injected/virtual-cursor.js';
import { AtomicBrowserToolset } from './tools/atomic-tools.js';
import {
  loadPersistedSettings,
  mergeCursorStyleConfig,
  resolveSettingsFilePath,
  savePersistedSettings,
  type PersistedVisualBrowserSettings,
} from './settings-store.js';
import {
  BrowserSubagentRunner,
  createBuiltinInspectorPlanner,
  createDshHostLlmPlanner,
  createOpenAIVisionPlanner,
  summarizeDecisionAction,
  type PlannerStepDiagnostic,
  type SubagentPlanner,
} from './subagent/runner.js';

export * from './driver/types.js';
export * from './driver/browser-session.js';
export * from './driver/window-manager.js';
export * from './driver/human-motion.js';
export * from './injected/virtual-cursor.js';
export * from './sampler/telemetry-collector.js';
export * from './sampler/page-snapshot.js';
export * from './sampler/png-pixels.js';
export * from './tools/atomic-tools.js';
export * from './settings-store.js';
export * from './subagent/host-facts.js';
export * from './subagent/sliding-context.js';
export * from './subagent/findings.js';
export * from './subagent/runner.js';
export * from './guardrails/takeover.js';

export interface DshCordisContext {
  tools: {
    register: (tool: ToolDefinition) => (() => void) | void;
  };
  llm?: any;
  attachments?: any;
  webServer?: any;
  get?: (name: string) => any;
  inject?: (deps: string[] | Record<string, any>, callback: (ctx: any) => void) => any;
  effect?: (fn: () => (() => void) | void, label?: string) => any;
  on?: (event: string, listener: (...args: any[]) => void) => (() => void) | void;
}

export interface OptionalHostServices {
  llm?: any;
  attachments?: any;
  webServer?: any;
}

export type PlannerMode =
  | 'custom'
  | 'host-ctx-llm'
  | 'host-ctx-llm-fallback'
  | 'external-vision-api'
  | 'external-vision-api-fallback'
  | 'builtin-inspector';

export interface VolatileRef<T> {
  get(): T;
}

export type MaybeVolatile<T> = T | VolatileRef<T>;

export interface VisualBrowserPluginConfig {
  mode?: BrowserRuntimeMode;
  cdpEndpoint?: string;
  executablePath?: string;
  windowMode?: MaybeVolatile<BrowserWindowMode>;
  keepWindowOpen?: MaybeVolatile<boolean>;
  showTakeoverControl?: MaybeVolatile<boolean>;
  takeoverHotkey?: MaybeVolatile<string>;
  windowBounds?: BrowserWindowBounds;
  backgroundSilent?: boolean;
  artifactDir?: string;
  maxSteps?: number;
  maxRecentImages?: number;
  allowedOrigins?: string[];
  blockedOrigins?: string[];
  cursorStyle?: MaybeVolatile<VirtualCursorStyleConfig>;
  /** Optional explicit DSH host LLM provider/model route override */
  hostProvider?: string;
  hostModel?: string;
  /** Optional external OpenAI-compatible Vision API configuration */
  visionApiKey?: string;
  visionBaseUrl?: string;
  visionModel?: string;
  customPlanner?: SubagentPlanner;
}

export const name = 'dsh-plugin-visual-browser';
export const inject = ['tools'];

/**
 * Unwraps a Cordis/Cosmokit Volatile<T> ref or returns plain values directly.
 */
export function readVolatileValue<T>(value: MaybeVolatile<T> | undefined): T | undefined {
  if (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as any).get === 'function'
  ) {
    return (value as VolatileRef<T>).get();
  }
  return value as T | undefined;
}

async function loadSchemastery(): Promise<any | null> {
  try {
    const mod: any = await import('@deepseek-ai/schemastery');
    return mod?.default ?? mod;
  } catch {
    const candidateHosts = ['@deepseek-ai/dsh-tools', '@deepseek-ai/cordis'];
    const req = createRequire(import.meta.url);
    const metaResolve = (import.meta as any).resolve;

    for (const hostPkg of candidateHosts) {
      try {
        let hostEntry: string | undefined;
        if (typeof metaResolve === 'function') {
          try {
            const resolvedUrl = metaResolve.call(import.meta, hostPkg);
            if (typeof resolvedUrl === 'string' && resolvedUrl.startsWith('file:')) {
              hostEntry = fileURLToPath(resolvedUrl);
            }
          } catch {
            // fall back to createRequire
          }
        }
        if (!hostEntry) {
          hostEntry = req.resolve(hostPkg);
        }
        const realHostEntry = fs.realpathSync(hostEntry);
        try {
          const nestedReq = createRequire(realHostEntry);
          const schemaPath = nestedReq.resolve('@deepseek-ai/schemastery');
          const mod: any = await import(pathToFileURL(schemaPath).href);
          return mod?.default ?? mod;
        } catch {
          // Probe sibling pnpm store entries (`.../.pnpm/@deepseek-ai+schemastery@*/node_modules/@deepseek-ai/schemastery`)
          const pnpmIdx = realHostEntry.lastIndexOf(`${path.sep}.pnpm${path.sep}`);
          if (pnpmIdx >= 0) {
            const pnpmRoot = realHostEntry.slice(0, pnpmIdx + 6);
            const entries = fs.readdirSync(pnpmRoot).filter((d) => d.startsWith('@deepseek-ai+schemastery@')).sort().reverse();
            for (const entry of entries) {
              const candidatePkg = path.join(pnpmRoot, entry, 'node_modules', '@deepseek-ai', 'schemastery', 'package.json');
              if (fs.existsSync(candidatePkg)) {
                const siblingReq = createRequire(candidatePkg);
                const schemaPath = siblingReq.resolve('@deepseek-ai/schemastery');
                const mod: any = await import(pathToFileURL(schemaPath).href);
                return mod?.default ?? mod;
              }
            }
          }
        }
      } catch {
        // try next host package
      }
    }
    return null;
  }
}

export function buildPluginConfigSchema(z: any) {
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
export function toLosslessJson(value: unknown): any {
  return JSON.parse(JSON.stringify(value));
}

function safeRead<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

/**
 * Safely binds optional Cordis host services (`llm`, `attachments`) using secondary child fibers
 * (`ctx.inject([serviceName], callback)`) so missing optional services remain pending cleanly
 * without blocking top-level plugin activation or throwing on uninjected Cordis 4.x property getters.
 */
function bindOptionalHostServices(
  ctx: DshCordisContext | undefined,
  hostServices: OptionalHostServices,
  onServiceBound?: (
    serviceName: keyof OptionalHostServices,
    service: any,
    sub?: any
  ) => (() => void) | void
): void {
  if (!ctx) return;
  const serviceNames: Array<keyof OptionalHostServices> = ['llm', 'attachments', 'webServer'];
  const injectFn = safeRead(() => ctx.inject);

  if (typeof injectFn === 'function') {
    for (const serviceName of serviceNames) {
      try {
        injectFn.call(ctx, [serviceName], (sub: any) => {
          const service = safeRead(() => sub?.[serviceName]);
          if (service !== undefined) {
            hostServices[serviceName] = service;
            const boundDisposer = onServiceBound?.(serviceName, service, sub);
            if (typeof sub?.effect === 'function') {
              sub.effect(
                () => () => {
                  if (typeof boundDisposer === 'function') {
                    try {
                      boundDisposer();
                    } catch {
                      // ignore disposer error
                    }
                  }
                  if (hostServices[serviceName] === service) {
                    hostServices[serviceName] = undefined;
                  }
                },
                `dsh-plugin-visual-browser.unbind.${serviceName}`
              );
            }
          }
        });
      } catch {
        /* secondary injection unavailable on this mock host */
      }
    }
    return;
  }

  // Fallback only for legacy non-Cordis test stubs that expose services directly without ctx.inject
  for (const serviceName of serviceNames) {
    const service = safeRead(() => (ctx as any)?.[serviceName]);
    if (service !== undefined) {
      hostServices[serviceName] = service;
      onServiceBound?.(serviceName, service, ctx);
    }
  }
}

function getEffectiveHostServices(
  hostServices: OptionalHostServices,
  ctx?: DshCordisContext
): OptionalHostServices {
  const result: OptionalHostServices = {};
  const hasInjectApi = typeof safeRead(() => ctx?.inject) === 'function';
  for (const serviceName of ['llm', 'attachments', 'webServer'] as const) {
    result[serviceName] =
      hostServices[serviceName] ??
      safeRead(() => (ctx as any)?.get?.(serviceName)) ??
      (hasInjectApi ? undefined : safeRead(() => (ctx as any)?.[serviceName]));
  }
  return result;
}

/**
 * Resolves the default absolute artifact directory anchored to:
 * 1. Explicit `config.artifactDir` (from cordis.yml)
 * 2. `DSH_BROWSER_ARTIFACT_DIR` env var
 * 3. `DSH_HOME` env var (set by DSH Desktop pack launcher) or `~/.dsh` fallback
 */
export function resolveDefaultArtifactDir(
  configuredDir?: string,
  _ctx?: DshCordisContext
): string {
  const raw =
    configuredDir ||
    process.env.DSH_BROWSER_ARTIFACT_DIR ||
    path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'artifacts', 'dsh-browser');
  return path.resolve(raw);
}

async function tryRegisterImageAttachment(
  hostServices: OptionalHostServices,
  ctx: DshCordisContext | undefined,
  screenshotPath: string | null | undefined
): Promise<any | null> {
  if (!screenshotPath || !fs.existsSync(screenshotPath)) return null;
  const attachments = getEffectiveHostServices(hostServices, ctx).attachments;
  if (!attachments || typeof attachments.saveImage !== 'function') return null;
  try {
    const bytes = fs.readFileSync(screenshotPath);
    const ref = await attachments.saveImage({
      data: new Uint8Array(bytes),
      mediaType: 'image/png',
      name: path.basename(screenshotPath),
    });
    return toLosslessJson(ref);
  } catch {
    return null;
  }
}

function renderToolContent(textSummary: string, imageAttachment?: any): any[] {
  const blocks: any[] = [{ type: 'text', text: textSummary }];
  if (
    imageAttachment &&
    typeof imageAttachment === 'object' &&
    typeof imageAttachment.attachmentId === 'string'
  ) {
    blocks.push({ type: 'image', attachment: imageAttachment });
  }
  return blocks;
}

/**
 * Formats the single-line planner & host-service diagnostics footer appended to `browser_subagent_run`
 * rendered output so the model, UI, and DSH session logs can observe the active routing & fallback reason.
 */
export function formatPlannerDiagnosticsLine(value: any): string {
  const d = value?.planner_detail ?? {};
  const hs = value?.host_services ?? {};
  const downgraded = Boolean(d.initial_mode && d.initial_mode !== d.effective_mode);
  const route = d.provider && d.model ? ` | route: ${d.provider}/${d.model}` : '';
  return (
    `\n\n— planner: ${value?.planner_mode ?? '?'}` +
    (downgraded
      ? ` (initial ${d.initial_mode}${d.last_fallback_reason ? `, reason ${d.last_fallback_reason}` : ''}, fallbacks ${d.fallback_count ?? '?'})`
      : '') +
    ` | host services: llm ${hs.llm ? 'yes' : 'no'}, attachments ${hs.attachments ? 'yes' : 'no'}${route}`
  );
}

/**
 * Resolves the provider/model route from plugin overrides or the active DSH tool execution context.
 */
export function resolveHostLlmRoute(
  config: VisualBrowserPluginConfig,
  exec?: Partial<ToolRunContext>
): { provider: string; model: string } | null {
  const agentAny = exec?.agent as any;
  const selection =
    safeRead(() => agentAny?.model?.current?.()) ??
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
export function resolvePlannerMode(
  config: VisualBrowserPluginConfig,
  hostServices: OptionalHostServices = {},
  exec?: Partial<ToolRunContext>
): PlannerMode {
  if (config.customPlanner) {
    return 'custom';
  }
  if (
    hostServices.llm &&
    typeof hostServices.llm.stream === 'function' &&
    resolveHostLlmRoute(config, exec)
  ) {
    return 'host-ctx-llm';
  }
  if (config.visionApiKey || process.env.DSH_VISION_API_KEY) {
    return 'external-vision-api';
  }
  return 'builtin-inspector';
}

interface PlannerExecutionTracker {
  initialMode: PlannerMode;
  effectiveMode: PlannerMode;
  provider?: string;
  model?: string;
  fallbackCount: number;
  lastFallbackReason?: string;
  lastFallbackPreview?: string;
  steps: PlannerStepDiagnostic[];
}

function resolveSubagentPlanner(
  hostServices: OptionalHostServices,
  ctx: DshCordisContext | undefined,
  config: VisualBrowserPluginConfig,
  exec?: Partial<ToolRunContext>
): { planner: SubagentPlanner; tracker: PlannerExecutionTracker; effectiveServices: OptionalHostServices } {
  const effectiveServices = getEffectiveHostServices(hostServices, ctx);
  const initialMode = resolvePlannerMode(config, effectiveServices, exec);
  const route = resolveHostLlmRoute(config, exec);

  const tracker: PlannerExecutionTracker = {
    initialMode,
    effectiveMode: initialMode,
    ...(route ? { provider: route.provider, model: route.model } : {}),
    fallbackCount: 0,
    steps: [],
  };

  const onStepDiagnostic = (diag: PlannerStepDiagnostic) => {
    tracker.steps.push(diag);
    if (diag.fallback_reason) {
      tracker.fallbackCount++;
      tracker.lastFallbackReason = diag.fallback_reason;
      tracker.lastFallbackPreview = diag.text_preview;
      tracker.effectiveMode =
        initialMode === 'host-ctx-llm' ? 'host-ctx-llm-fallback' : 'external-vision-api-fallback';
    }
  };

  if (initialMode === 'custom' && config.customPlanner) {
    return { planner: config.customPlanner, tracker, effectiveServices };
  }

  if (initialMode === 'host-ctx-llm' && effectiveServices.llm && route) {
    const agentAny = exec?.agent as any;
    const rawSessionId =
      safeRead(() => agentAny?.sessionId) ?? safeRead(() => agentAny?.session?.id);
    const sessionId =
      typeof rawSessionId === 'string' && rawSessionId.length > 0 ? rawSessionId : undefined;
    const rawMaxTokens =
      safeRead(() => agentAny?.model?.current?.()?.maxTokens) ??
      safeRead(() => agentAny?.model?.current?.()?.maxOutputTokens);
    const maxTokens =
      typeof rawMaxTokens === 'number' && Number.isFinite(rawMaxTokens) && rawMaxTokens > 0
        ? rawMaxTokens
        : undefined;

    return {
      planner: createDshHostLlmPlanner({
        llm: effectiveServices.llm,
        attachments: effectiveServices.attachments,
        provider: route.provider,
        model: route.model,
        ...(sessionId ? { sessionId } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
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

export interface EffectiveVisualBrowserSettings {
  cursorStyle: VirtualCursorStyleConfig;
  windowMode: BrowserWindowMode;
  keepWindowOpen: boolean;
  showTakeoverControl: boolean;
  takeoverHotkey: string;
  settingsFile: string;
}

export interface LiveVisualBrowserSettingsBridge {
  syncFromSettingsDocument: () => void;
  getEffectiveSettings: () => EffectiveVisualBrowserSettings;
  saveSettings: (
    patch: Partial<PersistedVisualBrowserSettings>,
    opts?: { persist?: boolean }
  ) => EffectiveVisualBrowserSettings;
}

const MAX_HTTP_BODY_BYTES = 512 * 1024;

function readJsonRequestBody(req: any): Promise<Record<string, any>> {
  if (req && typeof req.body === 'object' && req.body !== null) {
    return Promise.resolve(req.body as Record<string, any>);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      total += buf.byteLength;
      if (total > MAX_HTTP_BODY_BYTES) {
        reject(new Error('PAYLOAD_TOO_LARGE'));
        req.destroy?.();
        return;
      }
      chunks.push(buf);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8').trim();
        const parsed = raw ? JSON.parse(raw) : {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(new Error('INVALID_JSON_OBJECT'));
          return;
        }
        resolve(parsed as Record<string, any>);
      } catch {
        reject(new Error('INVALID_JSON'));
      }
    });
    req.on('error', (err: Error) => reject(err));
  });
}

/**
 * Builds the Node HTTP handler mounted at `/__dsh_visual_browser` (serving `/settings`)
 * so the DSH browser settings panel can read and persist settings.json even when the host
 * does not inject a writable configForm provider.
 */
export function createSettingsHttpHandler(
  bridge: Pick<LiveVisualBrowserSettingsBridge, 'getEffectiveSettings' | 'saveSettings'>
) {
  return async (req: any, res: any) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };
    const send = (status: number, body?: unknown) => {
      res.writeHead(status, headers);
      res.end(body === undefined ? '' : JSON.stringify(body));
    };

    const method = String(req?.method || 'GET').toUpperCase();
    const rawUrl = String(req?.url || '/');
    const pathname = rawUrl.split('?')[0] || '/';
    const isSettingsRoute =
      pathname === '/settings' ||
      pathname === '/__dsh_visual_browser/settings' ||
      pathname.endsWith('/settings');

    if (method === 'OPTIONS') {
      send(204);
      return;
    }

    if (!isSettingsRoute) {
      send(404, { ok: false, error: 'Not found' });
      return;
    }

    if (method === 'GET') {
      send(200, { ok: true, writable: true, ...bridge.getEffectiveSettings() });
      return;
    }

    if (method === 'POST') {
      try {
        const body = await readJsonRequestBody(req);
        const persist = body.persist !== false;
        const patch: Partial<PersistedVisualBrowserSettings> = {};
        if (body.cursorStyle && typeof body.cursorStyle === 'object') {
          patch.cursorStyle = body.cursorStyle;
        }
        if (typeof body.windowMode === 'string') {
          patch.windowMode = body.windowMode as BrowserWindowMode;
        }
        if (typeof body.keepWindowOpen === 'boolean') {
          patch.keepWindowOpen = body.keepWindowOpen;
        }
        if (typeof body.showTakeoverControl === 'boolean') {
          patch.showTakeoverControl = body.showTakeoverControl;
        }
        if (typeof body.takeoverHotkey === 'string') {
          patch.takeoverHotkey = body.takeoverHotkey;
        }
        const effective = bridge.saveSettings(patch, { persist });
        send(200, { ok: true, persisted: persist, ...effective });
      } catch (err: any) {
        const msg = String(err?.message ?? err);
        send(msg === 'PAYLOAD_TOO_LARGE' ? 413 : 400, { ok: false, error: msg });
      }
      return;
    }

    send(405, { ok: false, error: `Method ${method} not allowed` });
  };
}

/**
 * Builds the 4 DSH 0.2.x `ToolDefinition` objects using official `defineTool()`.
 */
export function createVisualBrowserTools(
  ctx: DshCordisContext,
  config: VisualBrowserPluginConfig = {},
  runner = new BrowserSubagentRunner(),
  hostServices?: OptionalHostServices,
  bridgeOut?: { bridge?: LiveVisualBrowserSettingsBridge }
): ToolDefinition[] {
  const resolvedServices: OptionalHostServices = hostServices ?? {};
  if (!hostServices) {
    bindOptionalHostServices(ctx, resolvedServices);
  }
  const artifactRoot = resolveDefaultArtifactDir(config.artifactDir);
  const settingsFilePath = resolveSettingsFilePath(artifactRoot);
  let persistedSettings: PersistedVisualBrowserSettings | null = loadPersistedSettings(settingsFilePath);
  let toolCursorOverride: VirtualCursorStyleConfig | null = null;

  const getLiveCursorStyle = (): VirtualCursorStyleConfig => {
    const baseCfg = readVolatileValue(config.cursorStyle) ?? {};
    const withBase = resolveCursorStyle({
      preset: 'cyber-neon',
      ...baseCfg,
    });
    const withPersisted = persistedSettings?.cursorStyle
      ? mergeCursorStyleConfig(withBase, persistedSettings.cursorStyle)
      : withBase;
    if (toolCursorOverride) {
      return mergeCursorStyleConfig(withPersisted, toolCursorOverride);
    }
    return withPersisted;
  };

  const getLiveWindowMode = (override?: BrowserWindowMode): BrowserWindowMode => {
    return resolveBrowserWindowMode({
      windowMode: override ?? persistedSettings?.windowMode ?? readVolatileValue(config.windowMode),
      backgroundSilent: config.backgroundSilent,
    });
  };

  const getLiveKeepWindowOpen = (effectiveMode: BrowserWindowMode): boolean => {
    return (
      persistedSettings?.keepWindowOpen ??
      readVolatileValue(config.keepWindowOpen) ??
      effectiveMode !== 'headless'
    );
  };

  const getLiveShowTakeoverControl = (effectiveMode: BrowserWindowMode): boolean => {
    return (
      persistedSettings?.showTakeoverControl ??
      readVolatileValue(config.showTakeoverControl) ??
      effectiveMode !== 'headless'
    );
  };

  const getLiveTakeoverHotkey = (): string => {
    const raw = persistedSettings?.takeoverHotkey ?? readVolatileValue(config.takeoverHotkey);
    return typeof raw === 'string' && raw.trim() ? raw.trim() : 'F8';
  };

  const applyLiveSettingsToSessions = (nextStyle: VirtualCursorStyleConfig, nextHotkey: string) => {
    for (const sess of runner.getAllActiveSessions()) {
      void sess.motion.setCursorStyle(nextStyle).catch(() => {});
      void sess.motion.setTakeoverHotkey(nextHotkey).catch(() => {});
    }
  };

  const localBridge: LiveVisualBrowserSettingsBridge = {
    syncFromSettingsDocument: () => {
      toolCursorOverride = null;
      persistedSettings = null;
      const nextStyle = getLiveCursorStyle();
      const nextHotkey = getLiveTakeoverHotkey();
      applyLiveSettingsToSessions(nextStyle, nextHotkey);
    },
    getEffectiveSettings: () => {
      const effectiveMode = getLiveWindowMode();
      return {
        cursorStyle: resolveCursorStyle(getLiveCursorStyle()),
        windowMode: effectiveMode,
        keepWindowOpen: getLiveKeepWindowOpen(effectiveMode),
        showTakeoverControl: getLiveShowTakeoverControl(effectiveMode),
        takeoverHotkey: getLiveTakeoverHotkey(),
        settingsFile: settingsFilePath.replace(/\\/g, '/'),
      };
    },
    saveSettings: (patch, opts = {}) => {
      if (opts.persist === false) {
        if (patch.cursorStyle) {
          toolCursorOverride = mergeCursorStyleConfig(getLiveCursorStyle(), patch.cursorStyle);
        }
      } else {
        toolCursorOverride = null;
        persistedSettings = savePersistedSettings(
          settingsFilePath,
          patch,
          persistedSettings ?? undefined
        );
      }
      const effective = localBridge.getEffectiveSettings();
      applyLiveSettingsToSessions(effective.cursorStyle, effective.takeoverHotkey);
      return effective;
    },
  };

  if (bridgeOut) {
    bridgeOut.bridge = localBridge;
  }

  // 1. browser_subagent_run
  const subagentRunTool = defineTool({
    name: 'browser_subagent_run',
    description:
      'Launch an isolated Visual Browser Subagent in the background (with a physical Bezier virtual cursor, 3-in-1 vision+DOM+console sampler, sliding image window, and BROWSER_HOST_FACTS verification). Uses host ctx.llm, DSH_VISION_API_KEY, or built-in autonomous walkthrough inspector. Requires local Chrome/Edge or DSH_BROWSER_EXECUTABLE.',
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
        ] as const,
      },
      window_mode: {
        type: 'string',
        description:
          'Optional window presentation override ("visible-background", "minimized", or "headless")',
        enum: ['visible-background', 'minimized', 'headless'] as const,
      },
      wait_until: {
        type: 'string',
        description:
          'Navigation wait condition ("domcontentloaded" default + settle, "load", or "networkidle")',
        enum: ['domcontentloaded', 'load', 'networkidle'] as const,
      },
      timeout_ms: {
        type: 'integer',
        description: 'Navigation goto timeout in ms (1000..120000, default: 30000)',
      },
      viewport_width: {
        type: 'integer',
        description: 'Optional explicit desktop viewport width override (320..2560; default preserves window size)',
      },
      viewport_height: {
        type: 'integer',
        description: 'Optional explicit desktop viewport height override (240..1600; default preserves window size)',
      },
      device_scale_factor: {
        type: 'number',
        description: 'Optional explicit DPR scale override (1..2; requires viewport override)',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          status: {
            type: 'string',
            enum: ['COMPLETED', 'BLOCKED', 'PAUSED_FOR_TAKEOVER', 'MAX_STEPS_REACHED'] as const,
          },
          subagent_id: { type: 'string' },
          host_facts_block: { type: 'string' },
          subagent_report: { type: 'string' },
        },
      },
      render(_args, value: any) {
        const text = `${value?.host_facts_block ?? ''}\n\n${value?.subagent_report ?? ''}${formatPlannerDiagnosticsLine(value)}`;
        return renderToolContent(text, value?.image_attachment);
      },
    },
    async execute(args, exec) {
      const liveStyle = getLiveCursorStyle();
      const style: VirtualCursorStyleConfig = args.cursor_preset
        ? resolveCursorStyle({
            ...liveStyle,
            preset: args.cursor_preset as VirtualCursorPreset,
          })
        : liveStyle;

      const subagentId = `subagent-${crypto.randomUUID().slice(0, 8)}`;
      const { planner, tracker, effectiveServices } = resolveSubagentPlanner(
        resolvedServices,
        ctx,
        config,
        exec
      );

      const buildPlannerDetail = () => ({
        initial_mode: tracker.initialMode,
        effective_mode: tracker.effectiveMode,
        ...(tracker.provider ? { provider: tracker.provider } : {}),
        ...(tracker.model ? { model: tracker.model } : {}),
        fallback_count: tracker.fallbackCount,
        ...(tracker.lastFallbackReason ? { last_fallback_reason: tracker.lastFallbackReason } : {}),
        ...(tracker.lastFallbackReason
          ? {
              fallback_reason: tracker.lastFallbackPreview
                ? `${tracker.lastFallbackReason}: ${tracker.lastFallbackPreview}`
                : tracker.lastFallbackReason,
            }
          : {}),
        ...(tracker.steps.length > 0 ? { llm_steps: tracker.steps } : {}),
      });

      const hostServicesStatus = {
        llm: Boolean(effectiveServices.llm && typeof effectiveServices.llm.stream === 'function'),
        attachments: Boolean(
          effectiveServices.attachments &&
            typeof effectiveServices.attachments.saveImage === 'function'
        ),
      };

      let diagWriteChain = Promise.resolve();
      const writeDiagnostics = async (
        payload: Record<string, unknown>
      ): Promise<string | undefined> => {
        const subagentDir = path.join(artifactRoot, subagentId);
        const targetFile = path.join(subagentDir, 'diagnostics.json');
        let writtenPath: string | undefined;
        diagWriteChain = diagWriteChain.then(async () => {
          try {
            await fs.promises.mkdir(subagentDir, { recursive: true });
            await fs.promises.writeFile(
              targetFile,
              JSON.stringify(toLosslessJson(payload), null, 2),
              'utf8'
            );
            writtenPath = targetFile.replace(/\\/g, '/');
          } catch {
            writtenPath = undefined;
          }
        });
        await diagWriteChain;
        return writtenPath;
      };

      const effectiveWindowMode = getLiveWindowMode(args.window_mode as BrowserWindowMode | undefined);
      const keepWindowOpen = getLiveKeepWindowOpen(effectiveWindowMode);
      const showTakeoverControl = getLiveShowTakeoverControl(effectiveWindowMode);
      const takeoverHotkey = getLiveTakeoverHotkey();
      const waitUntil: NavigateWaitUntil =
        args.wait_until === 'load' || args.wait_until === 'networkidle' || args.wait_until === 'domcontentloaded'
          ? (args.wait_until as NavigateWaitUntil)
          : 'domcontentloaded';
      const rawTimeout = Number(args.timeout_ms);
      const timeoutMs = Number.isFinite(rawTimeout)
        ? Math.max(1000, Math.min(120000, Math.round(rawTimeout)))
        : 30000;

      const hasExplicitViewport =
        args.viewport_width !== undefined ||
        args.viewport_height !== undefined ||
        args.device_scale_factor !== undefined;
      const viewportOverride = hasExplicitViewport
        ? {
            width: Number.isFinite(Number(args.viewport_width)) ? Number(args.viewport_width) : 1440,
            height: Number.isFinite(Number(args.viewport_height)) ? Number(args.viewport_height) : 900,
            ...(Number.isFinite(Number(args.device_scale_factor))
              ? { deviceScaleFactor: Number(args.device_scale_factor) }
              : {}),
          }
        : undefined;

      try {
        const res = await runner.runTask({
          subagentId,
          role: String(args.role || 'Browser Subagent'),
          taskPrompt: String(args.task_prompt),
          startUrl: String(args.url),
          waitUntil,
          timeoutMs,
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
            ...(viewportOverride ? { viewportOverride } : {}),
          },
          onActionResult: (info) => {
            const actionSummary: Record<string, unknown> = {
              ...summarizeDecisionAction(info.decision),
              ok: info.ok,
              ...(info.blocked ? { blocked: info.blocked } : {}),
              ...(info.skipped ? { skipped: true } : {}),
              ...(info.hit ? { hit: info.hit } : {}),
              ...(info.at ? { at: info.at } : {}),
              ...(info.midFrame ? { mid_frame: info.midFrame } : {}),
              ...(info.scroll ? { scroll: info.scroll } : {}),
              ...(info.motion ? { motion: info.motion } : {}),
            };
            const existing = tracker.steps.find((s) => s.step === info.stepIndex);
            if (existing) {
              existing.action = actionSummary;
            } else if (
              info.blocked ||
              info.midFrame ||
              info.scroll ||
              info.motion ||
              !info.ok ||
              info.skipped
            ) {
              tracker.steps.push({
                step: info.stepIndex,
                backend:
                  tracker.initialMode === 'external-vision-api'
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
          onDiagnosticsUpdate: async (update) => {
            await writeDiagnostics({
              timestamp: new Date().toISOString(),
              status: update.status,
              ...(update.result?.reason ? { reason: update.result.reason } : {}),
              ...(update.pausedAt ? { paused_at: update.pausedAt } : {}),
              ...(update.pausedBy ? { paused_by: update.pausedBy } : {}),
              ...(update.resumedAt ? { resumed_at: update.resumedAt } : {}),
              ...(update.resumedBy ? { resumed_by: update.resumedBy } : {}),
              subagent_id: update.subagentId,
              window_mode: effectiveWindowMode,
              ...(update.navigation ? { navigation: update.navigation } : {}),
              planner_mode: tracker.effectiveMode,
              planner_detail: buildPlannerDetail(),
              host_services: hostServicesStatus,
              ...(update.contextStats ? { steps: update.contextStats } : {}),
              ...(update.findings ? { findings: update.findings } : {}),
              ...(update.hostFacts ? { host_facts: update.hostFacts } : {}),
            });
          },
          planner,
        });

        const imageAttachment = await tryRegisterImageAttachment(
          resolvedServices,
          ctx,
          res.hostFacts.latestScreenshot
        );

        const plannerDetail = buildPlannerDetail();
        const stalePauseAfterButtonResume =
          res.status === 'PAUSED_FOR_TAKEOVER' && runner.isResumingOrCompleted(subagentId);
        const diagnosticsPath = stalePauseAfterButtonResume
          ? path.join(artifactRoot, subagentId, 'diagnostics.json').replace(/\\/g, '/')
          : await writeDiagnostics({
              timestamp: new Date().toISOString(),
              status: res.status,
              ...(res.reason ? { reason: res.reason } : {}),
              ...(res.pausedAt ? { paused_at: res.pausedAt } : {}),
              ...(res.pausedBy ? { paused_by: res.pausedBy } : {}),
              ...(res.resumedAt ? { resumed_at: res.resumedAt } : {}),
              ...(res.resumedBy ? { resumed_by: res.resumedBy } : {}),
              subagent_id: res.subagentId,
              window_mode: effectiveWindowMode,
              ...(res.navigation ? { navigation: res.navigation } : {}),
              planner_mode: tracker.effectiveMode,
              planner_detail: plannerDetail,
              host_services: hostServicesStatus,
              steps: res.contextStats,
              findings: res.findings ?? [],
              host_facts: res.hostFacts,
            });

        if (res.status === 'PAUSED_FOR_TAKEOVER') {
          try {
            const notifySvc = safeRead(() => (ctx as any)?.get?.('notify'));
            const msg = '子代理已暂停，窗口保持打开；关闭窗口会结束该任务';
            if (typeof notifySvc === 'function') {
              notifySvc(msg);
            } else if (notifySvc && typeof notifySvc.info === 'function') {
              notifySvc.info(msg);
            }
          } catch {
            // optional host notification failure must never block tool result
          }
        }

        const fallbackNotice =
          tracker.fallbackCount > 0
            ? `\n\n> ⚠️ 降级提示：本轮有 ${tracker.fallbackCount} 步决策走了 fallback（${tracker.lastFallbackReason ?? 'unknown'}），报告质量可能下降，详见 diagnostics.json。`
            : '';

        return toLosslessJson({
          status: res.status,
          subagent_id: res.subagentId,
          ...(res.reason ? { reason: res.reason } : {}),
          ...(res.navigation ? { navigation: res.navigation } : {}),
          planner_mode: tracker.effectiveMode,
          planner_detail: plannerDetail,
          host_services: hostServicesStatus,
          ...(diagnosticsPath ? { diagnostics_path: diagnosticsPath } : {}),
          host_facts_block: res.hostFactsBlock,
          subagent_report: `${res.subagentReport}${fallbackNotice}`,
          approval_card: res.approvalCard ?? null,
          sliding_window_stats: res.contextStats,
          findings: res.findings ?? [],
          ...(imageAttachment ? { image_attachment: imageAttachment } : {}),
        });
      } catch (error: any) {
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
    description:
      'Resume a paused browser subagent session (PAUSED_FOR_TAKEOVER) in the exact same open tab after the user completes login, payment, or human verification.',
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
            enum: [
              'COMPLETED',
              'BLOCKED',
              'PAUSED_FOR_TAKEOVER',
              'MAX_STEPS_REACHED',
              'SESSION_LOST',
              'SESSION_NOT_FOUND',
            ] as const,
          },
          subagent_id: { type: 'string' },
          host_facts_block: { type: 'string' },
          subagent_report: { type: 'string' },
        },
      },
      render(_args, value: any) {
        const body = value?.subagent_report ?? value?.hint ?? '';
        const text = `${value?.host_facts_block ?? ''}\n\n${body}`;
        return renderToolContent(text, value?.image_attachment);
      },
    },
    async execute(args, exec) {
      const res = await runner.resumeTask(
        String(args.subagent_id),
        args.user_note ? String(args.user_note) : undefined,
        exec?.signal
      );

      const imageAttachment = await tryRegisterImageAttachment(
        resolvedServices,
        ctx,
        res.hostFacts.latestScreenshot
      );

      return toLosslessJson({
        status: res.status,
        subagent_id: res.subagentId,
        ...(res.reason ? { reason: res.reason } : {}),
        ...(res.hint ? { hint: res.hint } : {}),
        host_facts_block: res.hostFactsBlock,
        subagent_report: res.subagentReport,
        approval_card: res.approvalCard ?? null,
        sliding_window_stats: res.contextStats,
        findings: res.findings ?? [],
        ...(imageAttachment ? { image_attachment: imageAttachment } : {}),
      });
    },
  });

  // 3. browser_set_cursor_trail
  const setCursorTrailTool = defineTool({
    name: 'browser_set_cursor_trail',
    description:
      'Customize the virtual mouse cursor and motion trail style (choose from presets or custom shape, SVG path, custom image URL, colors, trail width, length, and variant).',
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
        ] as const,
      },
      pointer_shape: {
        type: 'string',
        description: 'Cursor shape',
        enum: ['arrow', 'crosshair', 'dot', 'star', 'ring', 'custom-svg', 'custom-image'] as const,
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
        enum: ['dashed', 'solid', 'dots', 'comet', 'none'] as const,
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
      render(_args, value: any) {
        return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
      },
    },
    async execute(args) {
      const explicitPatch: VirtualCursorStyleConfig = {
        ...(args.preset ? { preset: args.preset as VirtualCursorPreset } : {}),
        ...(args.pointer_shape ? { pointerShape: args.pointer_shape as VirtualCursorShape } : {}),
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
        ...(args.trail_variant ? { trailVariant: args.trail_variant as TrailVariant } : {}),
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
      const mergedStyle = mergeCursorStyleConfig(getLiveCursorStyle(), explicitPatch);
      const effective = localBridge.saveSettings({ cursorStyle: mergedStyle }, { persist: true });
      return toLosslessJson({
        updated: true,
        persisted: true,
        settings_file: effective.settingsFile,
        active_cursor_style: effective.cursorStyle,
      });
    },
  });

  // 4. browser_quick_snapshot
  const quickSnapshotTool = defineTool({
    name: 'browser_quick_snapshot',
    description:
      'Silently capture a single 3-in-1 multimodal snapshot (viewport screenshot + numbered interactive controls + DOM/tech/console health) of a URL in the background. Registers an ImageBlock via ctx.attachments when available so the main model can view the screenshot.',
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: 'Target URL to snapshot',
      },
      wait_until: {
        type: 'string',
        description:
          'Navigation wait condition ("domcontentloaded" default + settle, "load", or "networkidle")',
        enum: ['domcontentloaded', 'load', 'networkidle'] as const,
      },
      timeout_ms: {
        type: 'integer',
        description: 'Navigation goto timeout in ms (1000..120000, default: 30000)',
      },
      viewport_width: {
        type: 'integer',
        description: 'Optional explicit desktop viewport width override (320..2560; default preserves window size)',
      },
      viewport_height: {
        type: 'integer',
        description: 'Optional explicit desktop viewport height override (240..1600; default preserves window size)',
      },
      device_scale_factor: {
        type: 'number',
        description: 'Optional explicit DPR scale override (1..2)',
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
      render(_args, value: any) {
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
      const hasExplicitViewport =
        args.viewport_width !== undefined ||
        args.viewport_height !== undefined ||
        args.device_scale_factor !== undefined;
      const viewportOverride = hasExplicitViewport
        ? {
            width: Number.isFinite(Number(args.viewport_width)) ? Number(args.viewport_width) : 1440,
            height: Number.isFinite(Number(args.viewport_height)) ? Number(args.viewport_height) : 900,
            ...(Number.isFinite(Number(args.device_scale_factor))
              ? { deviceScaleFactor: Number(args.device_scale_factor) }
              : {}),
          }
        : undefined;

      const acquired = useShared
        ? await runner.acquireReusableSession(
            {
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
              ...(viewportOverride ? { viewportOverride } : {}),
            },
            true
          )
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
              ...(viewportOverride ? { viewportOverride } : {}),
            }).start(),
            isShared: false,
            reused: false,
          };

      const session = acquired.session;
      const onAbort = () => {
        if (acquired.isShared) runner.detachSharedSessionForTakeover(session);
        void session.close().catch(() => {});
      };
      exec?.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        const tools = new AtomicBrowserToolset(
          session,
          path.join(artifactRoot, 'quick-snapshots')
        );
        const waitUntil: NavigateWaitUntil =
          args.wait_until === 'load' || args.wait_until === 'networkidle' || args.wait_until === 'domcontentloaded'
            ? (args.wait_until as NavigateWaitUntil)
            : 'domcontentloaded';
        const rawTimeout = Number(args.timeout_ms);
        const timeoutMs = Number.isFinite(rawTimeout)
          ? Math.max(1000, Math.min(120000, Math.round(rawTimeout)))
          : 30000;
        const res = await tools.navigate(String(args.url), 600, { waitUntil, timeoutMs });
        exec?.signal?.throwIfAborted();

        const imageAttachment = await tryRegisterImageAttachment(
          resolvedServices,
          ctx,
          res.observation.screenshotPath
        );

        return toLosslessJson({
          screenshot_path: res.observation.screenshotPath.replace(/\\/g, '/'),
          ...(res.navigation ? { navigation: res.navigation } : {}),
          hud_summary: res.llmSummary,
          dom_stats: res.observation.domStats,
          health: res.observation.health,
          ...(imageAttachment ? { image_attachment: imageAttachment } : {}),
        });
      } finally {
        exec?.signal?.removeEventListener('abort', onAbort);
        await runner.releaseReusableSession(
          session,
          Boolean(useShared && acquired.isShared && !exec?.signal?.aborted)
        );
      }
    },
  });

  return [subagentRunTool, subagentResumeTool, setCursorTrailTool, quickSnapshotTool];
}

/**
 * DeepSeek Harness (Cordis) Plugin Entry Point
 */
export function apply(ctx: DshCordisContext, config: VisualBrowserPluginConfig = {}) {
  const runner = new BrowserSubagentRunner();
  const hostServices: OptionalHostServices = {};
  const bridgeHolder: { bridge?: LiveVisualBrowserSettingsBridge } = {};
  let webServerRouteDisposer: (() => void) | undefined;

  const attachWebServerRoute = (ws: any) => {
    if (!ws || typeof ws.register !== 'function' || !bridgeHolder.bridge) return undefined;
    if (typeof webServerRouteDisposer === 'function') {
      try {
        webServerRouteDisposer();
      } catch {
        // ignore prior route cleanup error
      }
      webServerRouteDisposer = undefined;
    }
    try {
      const reg = ws.register({
        kind: 'prefix',
        path: '/__dsh_visual_browser',
        handler: createSettingsHttpHandler(bridgeHolder.bridge),
      });
      webServerRouteDisposer = typeof reg === 'function' ? reg : undefined;
      return webServerRouteDisposer;
    } catch {
      return undefined;
    }
  };

  bindOptionalHostServices(ctx, hostServices, (svcName, svc) => {
    if (svcName === 'webServer') {
      return attachWebServerRoute(svc);
    }
    return undefined;
  });

  const tools = createVisualBrowserTools(ctx, config, runner, hostServices, bridgeHolder);
  if (hostServices.webServer && !webServerRouteDisposer) {
    attachWebServerRoute(hostServices.webServer);
  }

  for (const tool of tools) {
    ctx.tools.register(tool);
  }

  const unsubSettings = safeRead(() =>
    ctx.on?.('settings/document-updated', (ns?: string) => {
      if (!ns || ns === 'dsh-plugin-visual-browser') {
        bridgeHolder.bridge?.syncFromSettingsDocument();
      }
    })
  );

  // Standard Cordis 4.x disposal hook via ctx.effect(() => disposer)
  const disposeAll = () => {
    if (typeof unsubSettings === 'function') {
      unsubSettings();
    }
    if (typeof webServerRouteDisposer === 'function') {
      try {
        webServerRouteDisposer();
      } catch {
        // ignore route disposer error
      }
      webServerRouteDisposer = undefined;
    }
    void runner.closeAllSessions();
  };
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => disposeAll, 'dsh-plugin-visual-browser.disposePausedSessions');
  } else {
    ctx.on?.('dispose', disposeAll);
  }

  return { runner, tools, hostServices, bridge: bridgeHolder.bridge };
}
