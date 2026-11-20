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
export interface DshToolDefinition {
    name: string;
    description: string;
    parameters: Record<string, {
        type: string;
        required?: boolean;
        description: string;
        enum?: string[];
    }>;
    execute: (args: Record<string, any>) => Promise<any>;
}
export interface DshCordisContext {
    tools: {
        register: (tool: DshToolDefinition) => void;
    };
    on?: (event: string, listener: (...args: any[]) => void) => void;
}
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
    visionApiKey?: string;
    visionBaseUrl?: string;
    visionModel?: string;
    customPlanner?: SubagentPlanner;
}
export declare const name = "dsh-plugin-visual-browser";
export declare const inject: string[];
/**
 * DeepSeek Harness (Cordis) Plugin Entry Point
 */
export declare function apply(ctx: DshCordisContext, config?: VisualBrowserPluginConfig): {
    runner: BrowserSubagentRunner;
};
