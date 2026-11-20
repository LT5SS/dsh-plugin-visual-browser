import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  projectToolSchema,
  validateJsonSchemaValue,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools';
import {
  apply,
  extractHostStreamChunk,
  parseJsonDecision,
  resolvePlannerMode,
  type DshCordisContext,
} from '../src/index.js';

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

function createStrictScopedProxy(
  target: Record<string, any>,
  allowedKeys: readonly string[]
): any {
  const allowed = new Set(allowedKeys);
  return new Proxy(target, {
    get(obj, key) {
      if (allowed.has(String(key))) {
        return obj[String(key)];
      }
      throw new Error(`cannot get property "${String(key)}" without inject`);
    },
  });
}

function createAttachmentsStub() {
  return {
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
  };
}

function createCordisStrictCtx(opts: {
  services?: Record<string, any>;
  validateSchemas?: boolean;
  deferInject?: boolean;
}) {
  const registeredTools = new Map<string, ToolDefinition>();
  const effectDisposers: Array<() => void> = [];
  const pendingInjects: Array<{ deps: string[]; cb: (sub: any) => void }> = [];

  const register = (definition: ToolDefinition) => {
    if (opts.validateSchemas) {
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
      assertObjectJsonSchema(definition.parameters);
      assertSupportedJsonSchema(output.schema);
      const projected = projectToolSchema(definition, true);
      assertObjectJsonSchema(projected.parameters);
      console.log(`[Strict DSH 0.2 Contract] Verified & registered tool: ${name}`);
    }
    registeredTools.set(definition.name, definition);
    return () => registeredTools.delete(definition.name);
  };

  const effect = (fn: () => (() => void) | void) => {
    const disposer = fn();
    if (typeof disposer === 'function') effectDisposers.push(disposer);
    return disposer;
  };

  const inject = (deps: string[] | Record<string, any>, cb: (sub: any) => void) => {
    const depList = Array.isArray(deps) ? deps : Object.keys(deps);
    if (opts.deferInject) {
      pendingInjects.push({ deps: depList, cb });
      return;
    }
    if (opts.services && depList.every((d) => opts.services![d] !== undefined)) {
      const subTarget: Record<string, any> = { effect };
      for (const dep of depList) subTarget[dep] = opts.services[dep];
      cb(createStrictScopedProxy(subTarget, [...depList, 'effect']));
    }
  };

  const ctx = createStrictScopedProxy(
    {
      tools: { register },
      effect,
      on() {},
      get: () => undefined,
      inject,
    },
    ['tools', 'effect', 'on', 'get', 'inject']
  ) as DshCordisContext;

  return { ctx, registeredTools, effectDisposers, pendingInjects };
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

  // 0b. Cordis 4.x restricted-ctx negative regression checks (bare + hostile + no-inject fallback)
  const bareTools: ToolDefinition[] = [];
  const bareCtx = {
    tools: { register: (t: ToolDefinition) => bareTools.push(t) },
    effect: (fn: () => void) => fn(),
    on() {},
    get: () => undefined,
    inject: () => {},
  };
  let bareRes!: ReturnType<typeof apply>;
  assert.doesNotThrow(
    () => {
      bareRes = apply(bareCtx as any, {});
    },
    'apply() must survive a ctx without optional services'
  );
  assert.equal(bareTools.length, 4, 'bareCtx must register all 4 tools');
  assert.equal(bareRes.hostServices.llm, undefined);
  assert.equal(bareRes.hostServices.attachments, undefined);

  const hostile = createCordisStrictCtx({ validateSchemas: false });
  let hostileRes!: ReturnType<typeof apply>;
  assert.doesNotThrow(
    () => {
      hostileRes = apply(hostile.ctx, {});
    },
    'apply() must not read uninjected services directly on Cordis 4.x ctx'
  );
  assert.equal(hostile.registeredTools.size, 4, 'hostileCtx must register all 4 tools');
  assert.equal(resolvePlannerMode({}, hostileRes.hostServices), 'builtin-inspector');

  const noInjectTools: ToolDefinition[] = [];
  const hostileCtxNoInject = createStrictScopedProxy(
    {
      tools: { register: (t: ToolDefinition) => noInjectTools.push(t) },
      effect: (fn: () => void) => fn(),
      on() {},
      get: () => undefined,
    },
    ['tools', 'effect', 'on', 'get']
  );
  assert.doesNotThrow(
    () => apply(hostileCtxNoInject as any, {}),
    'apply() fallback without ctx.inject must also survive hostile getters'
  );
  assert.equal(noInjectTools.length, 4, 'hostileCtxNoInject must register all 4 tools');
  console.log('[Strict DSH 0.2 Contract] Verified bareCtx, hostileCtx & hostileCtxNoInject guards (4/4 tools)!');

  // 0c. Pure unit checks for parseJsonDecision() and resolvePlannerMode()
  assert.equal(parseJsonDecision(''), null);
  assert.equal(parseJsonDecision('not json at all'), null);
  assert.equal(parseJsonDecision('{}'), null);
  assert.equal(parseJsonDecision('{"type":"click"}'), null);
  const parsedAction = parseJsonDecision('```json\n{"type":"click","target":"#1","reason":"test"}\n```');
  assert.deepEqual(parsedAction, { type: 'click', target: '#1', reason: 'test' });

  const finishErrChunk = extractHostStreamChunk({
    type: 'finish',
    reason: { kind: 'error', failure: { code: 'NO_ADAPTER', message: 'no adapter registered' } },
  });
  assert.equal(finishErrChunk.kind, 'finish');
  assert.equal(finishErrChunk.text, '');
  assert.ok(finishErrChunk.error?.includes('NO_ADAPTER'));

  const finishStopChunk = extractHostStreamChunk({
    type: 'finish',
    reason: { kind: 'stop' },
  });
  assert.equal(finishStopChunk.kind, 'finish');
  assert.equal(finishStopChunk.text, '');
  assert.equal(finishStopChunk.error, undefined);

  const prevVisionKey = process.env.DSH_VISION_API_KEY;
  try {
    delete process.env.DSH_VISION_API_KEY;
    const llmStub = { stream: () => {} };
    assert.equal(
      resolvePlannerMode({ customPlanner: async () => ({ type: 'scroll', deltaY: 100, reason: 'x' }) }, { llm: llmStub }),
      'custom'
    );
    assert.equal(
      resolvePlannerMode({ hostProvider: 'deepseek', hostModel: 'deepseek-chat' }, { llm: llmStub }),
      'host-ctx-llm'
    );
    assert.equal(
      resolvePlannerMode({}, { llm: llmStub }, {
        agent: { model: { current: () => ({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }) } },
      } as any),
      'host-ctx-llm'
    );
    assert.equal(
      resolvePlannerMode({}, { llm: llmStub }, {
        agent: { session: { requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-reasoner' } }) } },
      } as any),
      'host-ctx-llm'
    );
    assert.equal(resolvePlannerMode({ visionApiKey: 'sk-test' }, {}), 'external-vision-api');
    assert.equal(resolvePlannerMode({}, {}), 'builtin-inspector');
    assert.equal(resolvePlannerMode({}, { llm: llmStub }), 'builtin-inspector');
  } finally {
    if (prevVisionKey !== undefined) process.env.DSH_VISION_API_KEY = prevVisionKey;
    else delete process.env.DSH_VISION_API_KEY;
  }
  console.log('[Strict DSH 0.2 Contract] Verified parseJsonDecision() & resolvePlannerMode() unit checks!');

  // 0d. Async secondary ctx.inject late-binding + child-fiber effect disposal check
  const asyncHost = createCordisStrictCtx({ validateSchemas: false, deferInject: true });
  const asyncCfg = { hostProvider: 'deepseek', hostModel: 'deepseek-chat' };
  const asyncRes = apply(asyncHost.ctx, asyncCfg);
  assert.equal(asyncRes.hostServices.llm, undefined);
  assert.equal(asyncRes.hostServices.attachments, undefined);
  assert.equal(resolvePlannerMode(asyncCfg, asyncRes.hostServices), 'builtin-inspector');
  assert.equal(asyncHost.pendingInjects.length, 2, 'apply() must register 2 independent ctx.inject child fibers');

  const lateLlmStub = { stream: () => {} };
  const lateAttachmentsStub = createAttachmentsStub();
  let llmChildDisposer: (() => void) | undefined;

  for (const entry of asyncHost.pendingInjects) {
    if (entry.deps.includes('llm')) {
      const subProxy = createStrictScopedProxy(
        {
          llm: lateLlmStub,
          effect: (fn: () => (() => void) | void) => {
            const d = fn();
            if (typeof d === 'function') llmChildDisposer = d;
            return d;
          },
        },
        ['llm', 'effect']
      );
      entry.cb(subProxy);
    } else if (entry.deps.includes('attachments')) {
      const subProxy = createStrictScopedProxy(
        {
          attachments: lateAttachmentsStub,
          effect: () => {},
        },
        ['attachments', 'effect']
      );
      entry.cb(subProxy);
    }
  }

  assert.equal(asyncRes.hostServices.llm, lateLlmStub);
  assert.equal(asyncRes.hostServices.attachments, lateAttachmentsStub);
  assert.equal(resolvePlannerMode(asyncCfg, asyncRes.hostServices), 'host-ctx-llm');
  assert.ok(llmChildDisposer, 'llm secondary child fiber must register an unbind effect disposer');
  llmChildDisposer!();
  assert.equal(asyncRes.hostServices.llm, undefined);
  assert.equal(resolvePlannerMode(asyncCfg, asyncRes.hostServices), 'builtin-inspector');
  console.log('[Strict DSH 0.2 Contract] Verified async ctx.inject late-binding & child-fiber unbind!');

  // Checks 1-5: End-to-end tool execution with headless Chromium & local static server
  const distDir = path.resolve('E:/AI_Work/Antigravity/aw-argon-edition/dist');
  const artifactDir = path.resolve('E:/AI_Work/Antigravity/dsh-plugin-visual-browser/artifacts/contract-test');
  fs.mkdirSync(artifactDir, { recursive: true });

  const srv = await startSilentStaticServer(distDir);
  let hostLlmCalls = 0;
  const capturedStreamOptions: any[] = [];

  const strictHost = createCordisStrictCtx({
    validateSchemas: true,
    services: {
      attachments: createAttachmentsStub(),
      llm: {
        async *stream(options: any) {
          capturedStreamOptions.push(options);
          hostLlmCalls++;
          if (hostLlmCalls === 1) {
            yield {
              type: 'text-delta',
              text: JSON.stringify({
                type: 'move_mouse',
                points: [
                  { x: 320, y: 440 },
                  { x: 860, y: 420 },
                ],
                label: 'HOST-LLM SWEEP',
                reason: 'Driven by native DSH ctx.llm stream (text payload)',
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
    },
  });

  apply(strictHost.ctx, {
    mode: 'auto',
    backgroundSilent: true,
    artifactDir,
    hostProvider: 'deepseek',
    hostModel: 'deepseek-chat',
  });

  if (strictHost.registeredTools.size !== 4) {
    throw new Error(`Expected 4 tools registered, got ${strictHost.registeredTools.size}`);
  }
  if (strictHost.effectDisposers.length === 0) {
    throw new Error('Expected ctx.effect(() => disposer) to be registered');
  }

  const allDisposers = [...strictHost.effectDisposers, ...hostile.effectDisposers];

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
    const trailDef = strictHost.registeredTools.get('browser_set_cursor_trail')!;
    const trailVal = await trailDef.execute({ preset: 'comet-gold', trail_width: 4 }, fakeExec);
    const trailViolations = validateJsonSchemaValue(trailDef.output.schema, trailVal);
    if (trailViolations.length > 0) {
      throw new Error(`browser_set_cursor_trail output violations: ${trailViolations.join('; ')}`);
    }

    // 2. Verify browser_quick_snapshot + ctx.inject(['attachments']) ImageBlock rendering
    const snapDef = strictHost.registeredTools.get('browser_quick_snapshot')!;
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

    // 3. Verify browser_subagent_run using Cordis-injected ctx.llm + ctx.attachments + sessionId & system forwarding
    const runDef = strictHost.registeredTools.get('browser_subagent_run')!;
    const runVal: any = await runDef.execute(
      {
        url: srv.url,
        role: 'Contract Verifier',
        task_prompt: 'Test host ctx.llm integration and output schema compliance.',
        max_steps: 4,
      },
      { ...fakeExec, agent: { sessionId: 'sess-contract-123' } } as any
    );
    const runViolations = validateJsonSchemaValue(runDef.output.schema, runVal);
    if (runViolations.length > 0) {
      throw new Error(`browser_subagent_run output violations: ${runViolations.join('; ')}`);
    }
    const runBlocks = runDef.output.render({}, runVal);
    console.log(`[Strict DSH 0.2 Contract] browser_subagent_run (hostLlmCalls=${hostLlmCalls}, planner_mode=${runVal.planner_mode}) rendered blocks: ${runBlocks.map((b: any) => b.type).join(', ')}`);
    assert.equal(runVal.planner_mode, 'host-ctx-llm', 'Expected planner_mode to be host-ctx-llm when ctx.llm is injected');
    assert.equal(runVal.host_services?.llm, true);
    assert.equal(runVal.host_services?.attachments, true);
    assert.equal(runVal.planner_detail?.fallback_count, 0);
    assert.ok(capturedStreamOptions.length >= 1, 'Expected ctx.llm.stream to receive call options');
    assert.equal(capturedStreamOptions[0].sessionId, 'sess-contract-123');
    assert.equal(typeof capturedStreamOptions[0].system, 'string');
    assert.ok(capturedStreamOptions[0].system.length > 0);
    assert.equal(
      Object.prototype.hasOwnProperty.call(capturedStreamOptions[0], 'systemPrompt'),
      false,
      'ctx.llm.stream options must not use legacy systemPrompt field'
    );

    const runRenderedText = runBlocks.find((b: any) => b.type === 'text')?.text ?? '';
    assert.ok(runRenderedText.includes('— planner: host-ctx-llm'));
    assert.ok(runRenderedText.includes('llm yes, attachments yes'));
    assert.ok(runRenderedText.includes('route: deepseek/deepseek-chat'));
    assert.equal(typeof runVal.diagnostics_path, 'string');
    assert.equal(
      path.resolve(runVal.diagnostics_path),
      path.resolve(artifactDir, runVal.subagent_id, 'diagnostics.json')
    );
    assert.ok(fs.existsSync(runVal.diagnostics_path), 'Expected diagnostics.json to be written on disk');
    const runDiagJson = JSON.parse(fs.readFileSync(runVal.diagnostics_path, 'utf8'));
    assert.equal(runDiagJson.status, 'COMPLETED');
    assert.equal(runDiagJson.planner_mode, 'host-ctx-llm');
    assert.equal(runDiagJson.planner_detail?.provider, 'deepseek');
    assert.equal(runDiagJson.planner_detail?.model, 'deepseek-chat');
    assert.equal(runDiagJson.host_services?.llm, true);
    assert.equal(runDiagJson.host_services?.attachments, true);

    // 3b. Acceptance #2 & boundary checks for output.render() formatting (v1.1.4)
    const fakeFallbackValue = {
      host_facts_block: '[BROWSER_HOST_FACTS]',
      subagent_report: 'Synthetic fallback report',
      planner_mode: 'host-ctx-llm-fallback',
      planner_detail: {
        initial_mode: 'host-ctx-llm',
        effective_mode: 'host-ctx-llm-fallback',
        fallback_count: 1,
        last_fallback_reason: 'EMPTY_STREAM',
      },
      host_services: { llm: true, attachments: false },
    };
    const fakeRenderText = runDef.output.render({}, fakeFallbackValue)[0].text;
    assert.ok(fakeRenderText.includes('\n\n— planner:'));
    assert.ok(fakeRenderText.includes('host-ctx-llm-fallback'));
    assert.ok(fakeRenderText.includes('EMPTY_STREAM'));
    assert.ok(fakeRenderText.includes('llm yes'));
    assert.ok(fakeRenderText.includes('attachments no'));

    const sparseRenderText = runDef.output.render({}, { host_facts_block: 'h', subagent_report: 'r' })[0].text;
    assert.ok(sparseRenderText.includes('— planner: ?'));
    assert.ok(sparseRenderText.includes('llm no, attachments no'));

    const resumeDef = strictHost.registeredTools.get('browser_subagent_resume')!;
    const resumeRenderText = resumeDef.output.render({}, { host_facts_block: 'h', subagent_report: 'r' })[0].text;
    assert.ok(!resumeRenderText.includes('— planner:'), 'browser_subagent_resume must not append planner footer');
    console.log('[Strict DSH 0.2 Contract] Verified output.render() diagnostics line & diagnostics.json persistence!');

    // 4. Execute browser_quick_snapshot on hostileCtx to verify zero throw on uninjected attachments
    const hostileSnapDef = hostile.registeredTools.get('browser_quick_snapshot')!;
    const hostileSnapVal: any = await hostileSnapDef.execute({ url: srv.url }, fakeExec);
    const hostileSnapViolations = validateJsonSchemaValue(hostileSnapDef.output.schema, hostileSnapVal);
    assert.equal(hostileSnapViolations.length, 0, `hostileCtx snapshot output violations: ${hostileSnapViolations.join('; ')}`);
    console.log('[Strict DSH 0.2 Contract] Verified browser_quick_snapshot on hostileCtx (no throw on uninjected attachments)!');

    // 5a. Issue #4 repro: empty llm.stream() + exec.agent.model.current() falls back to builtin inspector cleanly
    const emptyLlmTools = new Map<string, ToolDefinition>();
    const emptyLlmCtx = {
      tools: { register: (t: ToolDefinition) => emptyLlmTools.set(t.name, t) },
      effect: (fn: () => (() => void) | void) => {
        const d = fn();
        if (typeof d === 'function') allDisposers.push(d);
        return d;
      },
      on() {},
      get: (name: string) =>
        name === 'llm' ? { stream: () => (async function* () {})() } : undefined,
    };
    apply(emptyLlmCtx as any, { mode: 'auto', backgroundSilent: true, artifactDir });
    const emptyRunDef = emptyLlmTools.get('browser_subagent_run')!;
    const emptyExec = {
      ...fakeExec,
      agent: { model: { current: () => ({ provider: 'opencode-go', model: 'deepseek-v4.1-flash' }) } },
    };
    const emptyRunVal: any = await emptyRunDef.execute(
      { url: srv.url, role: 'QA', task_prompt: 'Verify title without crashing on empty stream', max_steps: 1 },
      emptyExec
    );
    assert.equal(validateJsonSchemaValue(emptyRunDef.output.schema, emptyRunVal).length, 0);
    assert.equal(emptyRunVal.status, 'COMPLETED');
    assert.equal(emptyRunVal.planner_mode, 'host-ctx-llm-fallback');
    assert.equal(emptyRunVal.planner_detail?.last_fallback_reason, 'EMPTY_STREAM');
    assert.ok((emptyRunVal.planner_detail?.fallback_count ?? 0) >= 1);
    const emptyRenderedText = emptyRunDef.output.render({}, emptyRunVal).find((b: any) => b.type === 'text')?.text ?? '';
    assert.ok(
      emptyRenderedText.includes(
        '— planner: host-ctx-llm-fallback (initial host-ctx-llm, reason EMPTY_STREAM, fallbacks 1) | host services: llm yes, attachments no'
      )
    );
    assert.ok(emptyRenderedText.includes('route: opencode-go/deepseek-v4.1-flash'));
    assert.equal(typeof emptyRunVal.diagnostics_path, 'string');
    assert.ok(fs.existsSync(emptyRunVal.diagnostics_path));
    const emptyDiagJson = JSON.parse(fs.readFileSync(emptyRunVal.diagnostics_path, 'utf8'));
    assert.equal(emptyDiagJson.planner_detail?.last_fallback_reason, 'EMPTY_STREAM');
    assert.equal(emptyDiagJson.planner_detail?.provider, 'opencode-go');
    assert.equal(emptyDiagJson.planner_detail?.model, 'deepseek-v4.1-flash');
    console.log('[Strict DSH 0.2 Contract] 5a Verified empty llm.stream() graceful fallback (EMPTY_STREAM)!');

    // 5b. Issue #4 regression: error chunk on image attachment triggers automatic text-only retry
    const retryHost = createCordisStrictCtx({
      validateSchemas: false,
      services: {
        attachments: createAttachmentsStub(),
        llm: {
          async *stream(options: any) {
            const content: any[] = options?.messages?.[0]?.content ?? [];
            const hasImage = content.some((b) => b?.type === 'image');
            if (hasImage) {
              yield { type: 'error', error: 'image input not supported' };
              return;
            }
            yield {
              type: 'text-delta',
              text: JSON.stringify({
                type: 'complete',
                report: 'COMPLETED / TEXT_ONLY_RETRY_OK',
              }),
            };
          },
        },
      },
    });
    apply(retryHost.ctx, {
      mode: 'auto',
      backgroundSilent: true,
      artifactDir,
      hostProvider: 'opencode-go',
      hostModel: 'deepseek-v4.1-flash',
    });
    allDisposers.push(...retryHost.effectDisposers);
    const retryRunDef = retryHost.registeredTools.get('browser_subagent_run')!;
    const retryRunVal: any = await retryRunDef.execute(
      { url: srv.url, role: 'Retry Verifier', task_prompt: 'Trigger text-only retry', max_steps: 2 },
      fakeExec
    );
    assert.equal(retryRunVal.status, 'COMPLETED');
    assert.equal(retryRunVal.planner_mode, 'host-ctx-llm');
    assert.equal(retryRunVal.planner_detail?.fallback_count, 0);
    assert.equal(retryRunVal.planner_detail?.llm_steps?.[0]?.retried_text_only, true);
    console.log('[Strict DSH 0.2 Contract] 5b Verified image-rejected error chunk triggers text-only retry!');

    // 5c. Issue #4 regression: unrecognized chunks + plain prose text record diagnostics & fall back
    const proseHost = createCordisStrictCtx({
      validateSchemas: false,
      services: {
        llm: {
          async *stream() {
            yield { type: 'weird-event', foo: 123 };
            yield { type: 'text-delta', text: 'Sorry, plain prose response' };
          },
        },
      },
    });
    apply(proseHost.ctx, {
      mode: 'auto',
      backgroundSilent: true,
      artifactDir,
      hostProvider: 'opencode-go',
      hostModel: 'deepseek-v4.1-flash',
    });
    allDisposers.push(...proseHost.effectDisposers);
    const proseRunDef = proseHost.registeredTools.get('browser_subagent_run')!;
    const proseRunVal: any = await proseRunDef.execute(
      { url: srv.url, role: 'Prose Verifier', task_prompt: 'Test prose fallback diagnostics', max_steps: 1 },
      fakeExec
    );
    assert.equal(proseRunVal.status, 'COMPLETED');
    assert.equal(proseRunVal.planner_mode, 'host-ctx-llm-fallback');
    assert.equal(proseRunVal.planner_detail?.last_fallback_reason, 'INVALID_JSON_DECISION');
    assert.equal(proseRunVal.planner_detail?.llm_steps?.[0]?.chunk_types?.['weird-event'], 1);
    assert.ok(proseRunVal.planner_detail?.llm_steps?.[0]?.sample_unrecognized_keys?.includes('foo'));
    console.log('[Strict DSH 0.2 Contract] 5c Verified unrecognized chunk diagnostics & prose fallback!');

    // 5d. Issue #5 / TASK-v1.1.5: finish chunk with error reason surfaces NO_ADAPTER & skips useless retry
    let finishErrCalls = 0;
    const finishErrHost = createCordisStrictCtx({
      validateSchemas: false,
      services: {
        attachments: createAttachmentsStub(),
        llm: {
          async *stream() {
            finishErrCalls++;
            yield {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: {
                  code: 'NO_ADAPTER',
                  message: 'no adapter registered for provider "opencode-go"',
                },
              },
            };
          },
        },
      },
    });
    apply(finishErrHost.ctx, {
      mode: 'auto',
      backgroundSilent: true,
      artifactDir,
      hostProvider: 'opencode-go',
      hostModel: 'deepseek-v4.1-flash',
    });
    allDisposers.push(...finishErrHost.effectDisposers);
    const finishErrRunDef = finishErrHost.registeredTools.get('browser_subagent_run')!;
    const finishErrVal: any = await finishErrRunDef.execute(
      { url: srv.url, role: 'Finish Error Verifier', task_prompt: 'Verify finish error chunk handling', max_steps: 1 },
      fakeExec
    );
    assert.equal(finishErrVal.status, 'COMPLETED');
    assert.equal(finishErrVal.planner_mode, 'host-ctx-llm-fallback');
    assert.equal(finishErrVal.planner_detail?.last_fallback_reason, 'HOST_LLM_ERROR_CHUNK');
    assert.ok(String(finishErrVal.planner_detail?.llm_steps?.[0]?.stream_error ?? '').includes('NO_ADAPTER'));
    assert.equal(finishErrCalls, 1, 'Expected config error NO_ADAPTER to skip redundant text-only retry');
    assert.equal(finishErrVal.planner_detail?.llm_steps?.[0]?.retried_text_only, undefined);
    console.log('[Strict DSH 0.2 Contract] 5d Verified finish error chunk (NO_ADAPTER) surfaced & retry skipped!');

    // 5e. Issue #6 / TASK-v1.1.6: INVALID_REQUEST / MissingSessionID skips redundant text-only retry
    let invalidReqCalls = 0;
    const invalidReqHost = createCordisStrictCtx({
      validateSchemas: false,
      services: {
        attachments: createAttachmentsStub(),
        llm: {
          async *stream() {
            invalidReqCalls++;
            yield {
              type: 'finish',
              reason: {
                kind: 'error',
                failure: {
                  code: 'INVALID_REQUEST',
                  message: 'MissingSessionID',
                },
              },
            };
          },
        },
      },
    });
    apply(invalidReqHost.ctx, {
      mode: 'auto',
      backgroundSilent: true,
      artifactDir,
      hostProvider: 'opencode-go',
      hostModel: 'deepseek-v4.1-flash',
    });
    allDisposers.push(...invalidReqHost.effectDisposers);
    const invalidReqRunDef = invalidReqHost.registeredTools.get('browser_subagent_run')!;
    const invalidReqVal: any = await invalidReqRunDef.execute(
      { url: srv.url, role: 'InvalidReq Verifier', task_prompt: 'Verify INVALID_REQUEST skips retry', max_steps: 1 },
      fakeExec
    );
    assert.equal(invalidReqVal.status, 'COMPLETED');
    assert.equal(invalidReqVal.planner_mode, 'host-ctx-llm-fallback');
    assert.equal(invalidReqVal.planner_detail?.last_fallback_reason, 'HOST_LLM_ERROR_CHUNK');
    assert.ok(String(invalidReqVal.planner_detail?.llm_steps?.[0]?.stream_error ?? '').includes('INVALID_REQUEST'));
    assert.equal(invalidReqCalls, 1, 'Expected INVALID_REQUEST MissingSessionID to skip redundant text-only retry');
    assert.equal(invalidReqVal.planner_detail?.llm_steps?.[0]?.retried_text_only, undefined);
    console.log('[Strict DSH 0.2 Contract] 5e Verified INVALID_REQUEST MissingSessionID skips redundant retry!');

    console.log('\n✅ ALL DSH 0.2.x CONTRACT CHECKS PASSED!');
  } finally {
    for (const d of allDisposers) d();
    await srv.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
