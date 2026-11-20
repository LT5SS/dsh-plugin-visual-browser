import assert from 'node:assert/strict';
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
  // 0. Verify package.json dsh.bundle.patch manifest contract (guards against P0-1 regression)
  const pkgRoot = path.resolve('E:/AI_Work/Antigravity/dsh-plugin-visual-browser');
  const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));
  if (
    typeof pkgJson?.dsh?.bundle !== 'object' ||
    pkgJson.dsh.bundle === null ||
    typeof pkgJson.dsh.bundle.patch !== 'string' ||
    !fs.existsSync(path.resolve(pkgRoot, pkgJson.dsh.bundle.patch))
  ) {
    throw new Error(
      `Invalid dsh.bundle manifest in package.json: expected { bundle: { patch: "./cordis.yml" } }, got ${JSON.stringify(pkgJson?.dsh)}`
    );
  }
  if (pkgJson?.dependencies?.['@deepseek-ai/dsh-tools'] || pkgJson?.dependencies?.['@deepseek-ai/cordis']) {
    throw new Error(
      '@deepseek-ai/dsh-tools and @deepseek-ai/cordis must be in peerDependencies/devDependencies, not runtime dependencies'
    );
  }
  console.log('[Strict DSH 0.2 Contract] Verified package.json dsh.bundle.patch & peerDependencies!');

  // 0b. Cordis 4.x restricted-ctx regression checks (must survive bare & hostile uninjected getters)
  const bareTools: ToolDefinition[] = [];
  const bareCtx = {
    tools: { register: (t: ToolDefinition) => bareTools.push(t) },
    effect: (fn: () => void) => fn(),
    on() {},
    get: () => undefined,
  };
  assert.doesNotThrow(
    () => apply(bareCtx as any, {}),
    'apply() must survive a ctx without optional services'
  );
  assert.equal(bareTools.length, 4, 'bareCtx must register all 4 tools');

  const hostileTools: ToolDefinition[] = [];
  const hostileBase = {
    tools: { register: (t: ToolDefinition) => hostileTools.push(t) },
    effect: (fn: () => void) => fn(),
    on() {},
    get: (name: string) => {
      throw new Error(`cannot get service "${name}" without inject`);
    },
  };
  const hostileCtx = new Proxy(hostileBase, {
    get(target, key) {
      if (['tools', 'effect', 'on', 'get'].includes(String(key))) {
        return (target as any)[key];
      }
      throw new Error(`cannot get property "${String(key)}" without inject`);
    },
  });
  assert.doesNotThrow(
    () => apply(hostileCtx as any, {}),
    'apply() must not read services it did not inject'
  );
  assert.equal(hostileTools.length, 4, 'hostileCtx must register all 4 tools');
  console.log('[Strict DSH 0.2 Contract] Verified bareCtx & hostileCtx apply() guards (4/4 tools registered)!');

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
    console.log(`[Strict DSH 0.2 Contract] browser_subagent_run (hostLlmCalls=${hostLlmCalls}, planner_mode=${runVal.planner_mode}) rendered blocks: ${runBlocks.map((b: any) => b.type).join(', ')}`);
    assert.equal(runVal.planner_mode, 'host-ctx-llm', 'Expected planner_mode to be host-ctx-llm when ctx.llm is provided');

    // 4. Execute browser_quick_snapshot on hostileCtx to verify getAttachmentsService does not throw during execute()
    const hostileSnapDef = hostileTools.find((t) => t.name === 'browser_quick_snapshot')!;
    const hostileSnapVal: any = await hostileSnapDef.execute({ url: srv.url }, fakeExec);
    const hostileSnapViolations = validateJsonSchemaValue(hostileSnapDef.output.schema, hostileSnapVal);
    assert.equal(hostileSnapViolations.length, 0, `hostileCtx snapshot output violations: ${hostileSnapViolations.join('; ')}`);
    console.log('[Strict DSH 0.2 Contract] Verified browser_quick_snapshot on hostileCtx (no throw on uninjected attachments)!');

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
