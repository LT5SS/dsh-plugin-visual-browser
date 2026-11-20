import { type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools';
import type { BrowserRuntimeMode, VirtualCursorStyleConfig } from './driver/types.js';
import { BrowserSubagentRunner, type SubagentPlanner } from './subagent/runner.js';
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
export interface DshCordisContext {
    tools: {
        register: (tool: ToolDefinition) => (() => void) | void;
    };
    llm?: any;
    attachments?: any;
    get?: (name: string) => any;
    inject?: (deps: string[] | Record<string, any>, callback: (ctx: any) => void) => any;
    effect?: (fn: () => (() => void) | void, label?: string) => any;
    on?: (event: string, listener: (...args: any[]) => void) => void;
}
export interface OptionalHostServices {
    llm?: any;
    attachments?: any;
}
export type PlannerMode = 'custom' | 'host-ctx-llm' | 'host-ctx-llm-fallback' | 'external-vision-api' | 'external-vision-api-fallback' | 'builtin-inspector';
export interface VisualBrowserPluginConfig {
    mode?: BrowserRuntimeMode;
    cdpEndpoint?: string;
    executablePath?: string;
    backgroundSilent?: boolean;
    artifactDir?: string;
    maxSteps?: number;
    maxRecentImages?: number;
    allowedOrigins?: string[];
    blockedOrigins?: string[];
    cursorStyle?: VirtualCursorStyleConfig;
    /** Optional explicit DSH host LLM provider/model route override */
    hostProvider?: string;
    hostModel?: string;
    /** Optional external OpenAI-compatible Vision API configuration */
    visionApiKey?: string;
    visionBaseUrl?: string;
    visionModel?: string;
    customPlanner?: SubagentPlanner;
}
export declare const name = "dsh-plugin-visual-browser";
export declare const inject: string[];
/**
 * Guarantees a canonical lossless JSON object with zero `undefined` members or non-plain prototypes,
 * satisfying `@deepseek-ai/dsh-tools` 0.2.x output validation.
 */
export declare function toLosslessJson(value: unknown): any;
/**
 * Resolves the default absolute artifact directory anchored to:
 * 1. Explicit `config.artifactDir` (from cordis.yml)
 * 2. `DSH_BROWSER_ARTIFACT_DIR` env var
 * 3. `DSH_HOME` env var (set by DSH Desktop pack launcher) or `~/.dsh` fallback
 */
export declare function resolveDefaultArtifactDir(configuredDir?: string, _ctx?: DshCordisContext): string;
/**
 * Formats the single-line planner & host-service diagnostics footer appended to `browser_subagent_run`
 * rendered output so the model, UI, and DSH session logs can observe the active routing & fallback reason.
 */
export declare function formatPlannerDiagnosticsLine(value: any): string;
/**
 * Resolves the provider/model route from plugin overrides or the active DSH tool execution context.
 */
export declare function resolveHostLlmRoute(config: VisualBrowserPluginConfig, exec?: Partial<ToolRunContext>): {
    provider: string;
    model: string;
} | null;
/**
 * Resolves which planner backend will handle `browser_subagent_run` given config and bound host services.
 */
export declare function resolvePlannerMode(config: VisualBrowserPluginConfig, hostServices?: OptionalHostServices, exec?: Partial<ToolRunContext>): PlannerMode;
/**
 * Builds the 4 DSH 0.2.x `ToolDefinition` objects using official `defineTool()`.
 */
export declare function createVisualBrowserTools(ctx: DshCordisContext, config?: VisualBrowserPluginConfig, runner?: BrowserSubagentRunner, hostServices?: OptionalHostServices): ToolDefinition[];
/**
 * DeepSeek Harness (Cordis) Plugin Entry Point
 */
export declare function apply(ctx: DshCordisContext, config?: VisualBrowserPluginConfig): {
    runner: BrowserSubagentRunner;
    tools: ToolDefinition[];
    hostServices: OptionalHostServices;
};
