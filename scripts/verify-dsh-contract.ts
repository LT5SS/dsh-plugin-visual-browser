import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  projectToolSchema,
  validateJsonSchemaValue,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools';
import { apply, type DshCordisContext } from '../src/index.js';

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

function startSilentStaticServer(rootDir: string): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const cleanUrl = (req.url || '/').split('?')[0];
      const relPath = cleanUrl === '/' ? 'index.html' : cleanUrl.replace(/^\/+/, '');
      const fullPath = path.join(rootDir, decodeURIComponent(relPath));

      if (!fullPath.startsWith(rootDir) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const ext = path.extname(fullPath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_MAP[ext] || 'application/octet-stream' });
      fs.createReadStream(fullPath).pipe(res);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}/`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function main() {
  const distDir = path.resolve('E:/AI_Work/Antigravity/aw-argon-edition/dist');
  const artifactDir = path.resolve('E:/AI_Work/Antigravity/dsh-plugin-visual-browser/artifacts/contract-test');
  fs.mkdirSync(artifactDir, { recursive: true });

  const srv = await startSilentStaticServer(distDir);

  const registeredTools = new Map<string, ToolDefinition>();
  const effectDisposers: Array<() => void> = [];
  let hostLlmCalls = 0;

  // Authentic DSH 0.2.x ToolsService.register contract check + ctx.llm + ctx.attachments + ctx.effect
  const strictDshCtx: DshCordisContext = {
    tools: {
      register(definition: ToolDefinition) {
        const name = definition.name;
        const output = definition.output;
        if (
          output === undefined ||
          typeof output !== 'object' ||
          typeof output.render !== 'function' ||
          (output.presentationMeta !== undefined && typeof output.presentationMeta !== 'function')
        ) {
          throw new TypeError(`tool "${name}" must declare output { schema, render, presentationMeta? }`);
        }
        // Official @deepseek-ai/dsh-tools schema checks:
        assertObjectJsonSchema(definition.parameters);
        assertSupportedJsonSchema(output.schema);
        const projected = projectToolSchema(definition, true);
        assertObjectJsonSchema(projected.parameters);

        registeredTools.set(name, definition);
        console.log(`[Strict DSH 0.2 Contract] Verified & registered tool: ${name}`);
        return () => registeredTools.delete(name);
      },
    },
    attachments: {
      async saveImage(input: { data: Uint8Array; mediaType: string; name?: string }) {
        const hash = crypto.createHash('sha256').update(input.data).digest('hex');
        return {
          attachmentId: `sha256:${hash}`,
          mediaType: 'image/png',
          bytes: input.data.byteLength,
          width: 1440,
          height: 900,
          ...(input.name ? { name: input.name } : {}),
        };
      },
    },
    llm: {
      async *stream(_options: any) {
        hostLlmCalls++;
        if (hostLlmCalls === 1) {
          yield {
            type: 'text-delta',
            delta: JSON.stringify({
              type: 'move_mouse',
              points: [
                { x: 320, y: 440 },
                { x: 860, y: 420 },
              ],
              label: 'HOST-LLM SWEEP',
              reason: 'Driven by native DSH ctx.llm stream',
            }),
          };
        } else {
          yield {
            type: 'text-delta',
            delta: JSON.stringify({
              type: 'complete',
              report: 'COMPLETED / TASK_COMPLETED\n\nVerified native ctx.llm + ctx.attachments integration!',
            }),
          };
        }
      },
    },
    effect(fn) {
      const disposer = fn();
      if (typeof disposer === 'function') effectDisposers.push(disposer);
      return disposer;
    },
  };

  apply(strictDshCtx, {
    mode: 'auto',
    backgroundSilent: true,
    artifactDir,
    hostProvider: 'deepseek',
    hostModel: 'deepseek-chat',
  });

  if (registeredTools.size !== 4) {
    throw new Error(`Expected 4 tools registered, got ${registeredTools.size}`);
  }
  if (effectDisposers.length === 0) {
    throw new Error('Expected ctx.effect(() => disposer) to be registered');
  }

  try {
    const controller = new AbortController();
    const fakeExec: any = {
      callId: 'call-1',
      rootCallId: 'call-1',
      name: 'test',
      arguments: {},
      signal: controller.signal,
      deferContext() {},
      concludeTurn() {},
    };

    // 1. Verify browser_set_cursor_trail
    const trailDef = registeredTools.get('browser_set_cursor_trail')!;
    const trailVal = await trailDef.execute({ preset: 'comet-gold', trail_width: 4 }, fakeExec);
    const trailViolations = validateJsonSchemaValue(trailDef.output.schema, trailVal);
    if (trailViolations.length > 0) {
      throw new Error(`browser_set_cursor_trail output violations: ${trailViolations.join('; ')}`);
    }

    // 2. Verify browser_quick_snapshot + ctx.attachments ImageBlock rendering
    const snapDef = registeredTools.get('browser_quick_snapshot')!;
    const snapVal: any = await snapDef.execute({ url: srv.url }, fakeExec);
    const snapViolations = validateJsonSchemaValue(snapDef.output.schema, snapVal);
    if (snapViolations.length > 0) {
      throw new Error(`browser_quick_snapshot output violations: ${snapViolations.join('; ')}`);
    }
    const snapBlocks = snapDef.output.render({ url: srv.url }, snapVal);
    const hasImageBlock = snapBlocks.some((b: any) => b.type === 'image' && b.attachment?.attachmentId?.startsWith('sha256:'));
    console.log(`[Strict DSH 0.2 Contract] browser_quick_snapshot rendered blocks: ${snapBlocks.map((b: any) => b.type).join(', ')} (hasImageBlock=${hasImageBlock})`);
    if (!hasImageBlock) {
      throw new Error('Expected browser_quick_snapshot output.render to include an image ContentBlock from ctx.attachments');
    }

    // 3. Verify browser_subagent_run using native ctx.llm + ctx.attachments
    const runDef = registeredTools.get('browser_subagent_run')!;
    const runVal: any = await runDef.execute(
      {
        url: srv.url,
        role: 'Contract Verifier',
        task_prompt: 'Test host ctx.llm integration and output schema compliance.',
        max_steps: 4,
      },
      fakeExec
    );
    const runViolations = validateJsonSchemaValue(runDef.output.schema, runVal);
    if (runViolations.length > 0) {
      throw new Error(`browser_subagent_run output violations: ${runViolations.join('; ')}`);
    }
    const runBlocks = runDef.output.render({}, runVal);
    console.log(`[Strict DSH 0.2 Contract] browser_subagent_run (hostLlmCalls=${hostLlmCalls}) rendered blocks: ${runBlocks.map((b: any) => b.type).join(', ')}`);

    console.log('\n✅ ALL DSH 0.2.x CONTRACT CHECKS (P0 + P1 + P2) PASSED!');
  } finally {
    for (const d of effectDisposers) d();
    await srv.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
