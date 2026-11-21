import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import {
  assertObjectJsonSchema,
  assertSupportedJsonSchema,
  projectToolSchema,
  validateJsonSchemaValue,
  type ToolDefinition,
} from '@deepseek-ai/dsh-tools';
import {
  AtomicBrowserToolset,
  BrowserSession,
  BrowserSubagentRunner,
  Config,
  POINTER_SHAPE_SVG_PATHS,
  PageSnapshotSampler,
  SUBAGENT_SYSTEM_PROMPT,
  apply,
  computeDefaultBackgroundWindowBounds,
  createSettingsHttpHandler,
  extractHostStreamChunk,
  loadPersistedSettings,
  parseJsonDecision,
  readVolatileValue,
  resolveBrowserWindowMode,
  resolveCursorStyle,
  resolvePlannerMode,
  resolveSettingsFilePath,
  safeEvaluate,
  savePersistedSettings,
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
    const openStreams = new Set<http.ServerResponse>();
    const server = http.createServer((req, res) => {
      const cleanUrl = (req.url || '/').split('?')[0];
      if (cleanUrl === '/__never-ending-stream') {
        openStreams.add(res);
        res.on('close', () => openStreams.delete(res));
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        res.write(': keepalive\n\n');
        return;
      }
      if (cleanUrl === '/__slow-stream-fixture.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Canvas Stream Fixture</title></head>
<body style="margin:0;padding:24px;font-family:sans-serif;">
  <h1>Canvas Stream Fixture</h1>
  <canvas id="webgl-canvas" width="800" height="500" style="display:block;border:1px solid #333;"></canvas>
  <p><a id="projects-link" href="#projects">Projects</a></p>
  <script>
    const ctx = document.getElementById('webgl-canvas').getContext('2d');
    if (ctx) { ctx.fillStyle = '#111827'; ctx.fillRect(0, 0, 800, 500); ctx.fillStyle = '#00f0ff'; ctx.fillRect(40, 40, 120, 60); }
    fetch('/__never-ending-stream').catch(() => {});
  </script>
</body>
</html>`);
        return;
      }
      if (cleanUrl === '/__layer-iframe.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Iframe Fixture</title></head>
<body style="margin:0;padding:12px;">
  <button id="frame-btn" style="padding:8px 14px;">Frame Button</button>
</body>
</html>`);
        return;
      }
      if (cleanUrl === '/__layer-fixture.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Layer Isolation Fixture</title></head>
<body style="margin:0;padding:24px;height:2400px;font-family:sans-serif;">
  <a id="menu-link" href="#studio" style="position:fixed;top:18px;right:20px;z-index:2147483647;padding:8px 16px;background:#111827;color:#fff;text-decoration:none;border-radius:6px;font-size:13px;" onclick="window.__menuClicked=(window.__menuClicked||0)+1; return false;">Menu</a>
  <h1>Layer Isolation Fixture</h1>
  <div id="shadow-host" style="position:fixed;top:90px;left:40px;width:160px;height:44px;"></div>
  <iframe id="same-origin-frame" src="/__layer-iframe.html" style="position:fixed;top:160px;left:40px;width:240px;height:90px;border:1px solid #999;"></iframe>
  <p id="selectable-copy" style="position:fixed;top:290px;left:340px;width:440px;margin:0;font-size:18px;line-height:1.5;">Selectable body copy for drag selection clearing verification across multiple words.</p>
  <a id="drag-link" href="#drag-target" style="position:fixed;top:360px;left:340px;color:#1d4ed8;" onclick="return false;">Draggable Link</a>
  <button id="post-drag-btn" style="position:fixed;top:400px;left:340px;padding:8px 16px;" onclick="window.__postDragClicks=(window.__postDragClicks||0)+1;">Post Drag Click</button>
  <script>
    const host = document.getElementById('shadow-host');
    const sr = host.attachShadow({ mode: 'open' });
    sr.innerHTML = '<button id="shadow-btn" style="width:160px;height:44px;">Shadow Button</button>';
  </script>
</body>
</html>`);
        return;
      }
      if (cleanUrl === '/__hud-fixture.html') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>HUD Fixture</title></head>
<body style="font-family: sans-serif; padding: 24px;">
  <h1>HUD Attribute Fixture</h1>
  <p><a id="ext-link" href="https://x.example/y" title="External target">Learn more</a></p>
  <p><input id="email-box" aria-label="Email" value="abc" /></p>
  <p><input id="pwd-box" type="password" aria-label="Password" value="secret123" /></p>
  <p><button id="plain-btn">Plain Action</button></p>
</body>
</html>`);
        return;
      }
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
        close: () =>
          new Promise<void>((r) => {
            for (const streamRes of [...openStreams]) {
              try {
                streamRes.destroy();
              } catch {}
            }
            openStreams.clear();
            (server as any).closeAllConnections?.();
            server.close(() => r());
          }),
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
      hostileRes = apply(hostile.ctx, { backgroundSilent: true });
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
  assert.equal(asyncHost.pendingInjects.length, 3, 'apply() must register 3 independent ctx.inject child fibers');

  const lateLlmStub = { stream: () => {} };
  const lateAttachmentsStub = createAttachmentsStub();
  const registeredWebRoutes: Array<{ kind: string; path: string; handler: any }> = [];
  let webRouteDisposed = false;
  const lateWebServerStub = {
    register(opts: { kind: string; path: string; handler: any }) {
      registeredWebRoutes.push(opts);
      return () => {
        webRouteDisposed = true;
      };
    },
  };
  let llmChildDisposer: (() => void) | undefined;
  let webChildDisposer: (() => void) | undefined;

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
    } else if (entry.deps.includes('webServer')) {
      const subProxy = createStrictScopedProxy(
        {
          webServer: lateWebServerStub,
          effect: (fn: () => (() => void) | void) => {
            const d = fn();
            if (typeof d === 'function') webChildDisposer = d;
            return d;
          },
        },
        ['webServer', 'effect']
      );
      entry.cb(subProxy);
    }
  }

  assert.equal(asyncRes.hostServices.llm, lateLlmStub);
  assert.equal(asyncRes.hostServices.attachments, lateAttachmentsStub);
  assert.equal(asyncRes.hostServices.webServer, lateWebServerStub);
  assert.equal(registeredWebRoutes.length, 1);
  assert.equal(registeredWebRoutes[0]?.path, '/__dsh_visual_browser');
  assert.equal(resolvePlannerMode(asyncCfg, asyncRes.hostServices), 'host-ctx-llm');
  assert.ok(llmChildDisposer, 'llm secondary child fiber must register an unbind effect disposer');
  assert.ok(webChildDisposer, 'webServer secondary child fiber must register an unbind effect disposer');
  llmChildDisposer!();
  webChildDisposer!();
  assert.equal(webRouteDisposed, true, 'Expected webServer route disposer to run on unbind');
  assert.equal(asyncRes.hostServices.llm, undefined);
  assert.equal(asyncRes.hostServices.webServer, undefined);
  assert.equal(resolvePlannerMode(asyncCfg, asyncRes.hostServices), 'builtin-inspector');
  console.log('[Strict DSH 0.2 Contract] Verified async ctx.inject late-binding (llm/attachments/webServer) & child-fiber unbind!');

  // 0e. TASK-v1.1.7 P0: safeEvaluate() navigation-race resilience & non-navigation error propagation
  let navCalls = 0;
  const degradedReasons: string[] = [];
  const navPage = {
    async evaluate() {
      navCalls++;
      throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation');
    },
    async waitForLoadState() {},
    async waitForTimeout() {},
  };
  const navResult = await safeEvaluate(navPage, () => ({ ok: true }), { ok: false }, {
    retries: 2,
    onDegraded: (r) => degradedReasons.push(r),
  });
  assert.deepEqual(navResult, { ok: false });
  assert.equal(navCalls, 3, 'Expected safeEvaluate to retry retries=2 times (3 total attempts)');
  assert.equal(degradedReasons.length, 1);

  let transientCalls = 0;
  let transientDegraded = false;
  const transientNavPage = {
    async evaluate() {
      transientCalls++;
      if (transientCalls === 1) {
        throw new Error('Execution context was destroyed, most likely because of a navigation');
      }
      return { ok: true };
    },
    async waitForLoadState() {},
    async waitForTimeout() {},
  };
  const transientResult = await safeEvaluate(transientNavPage, () => ({ ok: true }), { ok: false }, {
    retries: 2,
    onDegraded: () => {
      transientDegraded = true;
    },
  });
  assert.deepEqual(transientResult, { ok: true });
  assert.equal(transientCalls, 2);
  assert.equal(transientDegraded, false);

  let bugCalls = 0;
  const bugPage = {
    async evaluate() {
      bugCalls++;
      throw new TypeError('Unexpected non-navigation bug');
    },
    async waitForLoadState() {},
    async waitForTimeout() {},
  };
  await assert.rejects(
    () => safeEvaluate(bugPage, () => 1, 0, 2),
    /Unexpected non-navigation bug/
  );
  assert.equal(bugCalls, 1, 'Non-navigation errors must rethrow immediately without retry');

  const degradedSampler = new PageSnapshotSampler(
    {
      page: {
        ...navPage,
        url: () => 'https://example.com',
        viewportSize: () => ({ width: 1280, height: 720 }),
      } as any,
      motion: { getPosition: () => ({ x: 100, y: 120 }) } as any,
      telemetry: {
        getHealthReport: () => ({
          consoleErrorsCount: 0,
          consoleErrors: [],
          pageErrorsCount: 0,
          pageErrors: [],
          failedRequestsCount: 0,
          failedRequests: [],
          totalRequests: 1,
          trackedOrigins: ['https://example.com'],
        }),
      } as any,
      screenshot: async (p: string) => p,
    } as any,
    path.resolve('E:/AI_Work/Antigravity/dsh-plugin-visual-browser/artifacts/contract-test')
  );
  const degradedObs = await degradedSampler.captureSnapshot('nav_race');
  assert.equal(degradedObs.degradedReason, 'sampler degraded: navigation race');
  assert.ok(degradedSampler.formatObservationForLLM(degradedObs).includes('sampler degraded: navigation race'));
  console.log('[Strict DSH 0.2 Contract] 0e Verified safeEvaluate() navigation-race fallback & strict rethrow!');

  // 0f. TASK-v1.1.8 Acceptance #2: AtomicBrowserToolset.inspectDom() safeEvaluate fallback & rethrow
  const navInspectToolset = new AtomicBrowserToolset(
    {
      page: navPage as any,
      motion: { getPosition: () => ({ x: 0, y: 0 }) } as any,
      telemetry: { getHealthReport: () => ({}) } as any,
      screenshot: async (p: string) => p,
    } as any,
    path.join(pkgRoot, 'artifacts/contract-test')
  );
  const navInspectRes = await navInspectToolset.inspectDom('a');
  assert.equal(navInspectRes.count, 0);
  assert.deepEqual(navInspectRes.samples, []);
  assert.equal(navInspectRes.degraded, true);
  assert.ok((navInspectRes.degradedReason ?? '').length > 0);

  const bugInspectToolset = new AtomicBrowserToolset(
    {
      page: {
        async evaluate() {
          throw new TypeError('Unexpected inspectDom bug');
        },
        async waitForLoadState() {},
        async waitForTimeout() {},
      } as any,
      motion: { getPosition: () => ({ x: 0, y: 0 }) } as any,
      telemetry: { getHealthReport: () => ({}) } as any,
      screenshot: async (p: string) => p,
    } as any,
    path.join(pkgRoot, 'artifacts/contract-test')
  );
  await assert.rejects(
    () => bugInspectToolset.inspectDom('a'),
    /Unexpected inspectDom bug/
  );
  console.log('[Strict DSH 0.2 Contract] 0f Verified inspectDom() navigation-race fallback & strict rethrow!');

  // 0g. TASK-v1.1.8 Acceptance #3: verify dist/**/*.js has NO bare .evaluate( outside safeEvaluate()
  const collectJsFiles = (dir: string): string[] => {
    const out: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...collectJsFiles(full));
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  };
  const distJsFiles = collectJsFiles(path.join(pkgRoot, 'dist'));
  assert.ok(distJsFiles.length > 0, 'Expected built dist/*.js files to exist before running contract checks');
  for (const file of distJsFiles) {
    const rel = path.relative(pkgRoot, file).replace(/\\/g, '/');
    const code = fs.readFileSync(file, 'utf8');
    const matches = code.match(/\.evaluate\s*\(/g) ?? [];
    if (rel === 'dist/sampler/page-snapshot.js') {
      assert.ok(
        matches.length <= 2,
        `Expected .evaluate( in ${rel} only inside safeEvaluate(), found ${matches.length}`
      );
    } else {
      assert.equal(
        matches.length,
        0,
        `Found bare .evaluate( in built ${rel}; all page evaluations must use safeEvaluate()`
      );
    }
  }
  console.log(`[Strict DSH 0.2 Contract] 0g Verified 0 bare page.evaluate() across ${distJsFiles.length} dist JS files!`);

  // 0h. TASK-v1.1.9 P0.5/P1: verify factual discipline & step-budget rules in SUBAGENT_SYSTEM_PROMPT
  assert.ok(SUBAGENT_SYSTEM_PROMPT.includes('HUD 未暴露该字段'));
  assert.ok(SUBAGENT_SYSTEM_PROMPT.includes('剩余步数') && SUBAGENT_SYSTEM_PROMPT.includes('complete'));
  console.log('[Strict DSH 0.2 Contract] 0h Verified SUBAGENT_SYSTEM_PROMPT factual discipline & step budget rules!');

  // 0i. v1.2.0: verify resolveBrowserWindowMode() priority tiers & computeDefaultBackgroundWindowBounds()
  const prevWinMode = process.env.DSH_BROWSER_WINDOW_MODE;
  try {
    delete process.env.DSH_BROWSER_WINDOW_MODE;
    assert.equal(resolveBrowserWindowMode({}), 'visible-background');
    assert.equal(resolveBrowserWindowMode({ backgroundSilent: true }), 'headless');
    assert.equal(resolveBrowserWindowMode({ backgroundSilent: false }), 'visible-background');
    assert.equal(resolveBrowserWindowMode({ windowMode: 'minimized', backgroundSilent: true }), 'minimized');
    assert.equal(resolveBrowserWindowMode({ windowMode: 'headless', backgroundSilent: false }), 'headless');

    process.env.DSH_BROWSER_WINDOW_MODE = 'minimized';
    assert.equal(resolveBrowserWindowMode({ backgroundSilent: true }), 'minimized');
    assert.equal(resolveBrowserWindowMode({ windowMode: 'headless' }), 'headless');

    process.env.DSH_BROWSER_WINDOW_MODE = 'headless';
    assert.equal(resolveBrowserWindowMode({}), 'headless');
    assert.equal(resolveBrowserWindowMode({ windowMode: 'visible-background' }), 'visible-background');
  } finally {
    if (prevWinMode !== undefined) process.env.DSH_BROWSER_WINDOW_MODE = prevWinMode;
    else delete process.env.DSH_BROWSER_WINDOW_MODE;
  }
  const defaultBounds = computeDefaultBackgroundWindowBounds({
    left: 0,
    top: 0,
    right: 1536,
    bottom: 864,
  });
  assert.deepEqual(defaultBounds, { x: 756, y: 12, width: 768, height: 840 });
  const customBounds = computeDefaultBackgroundWindowBounds(
    { left: 0, top: 0, right: 1536, bottom: 864 },
    { x: 100, y: 20, width: 900, height: 700 }
  );
  assert.deepEqual(customBounds, { x: 100, y: 20, width: 900, height: 700 });
  console.log('[Strict DSH 0.2 Contract] 0i Verified resolveBrowserWindowMode() & computeDefaultBackgroundWindowBounds()!');

  // 0j. v1.2.2: Verify volatile Schemastery Config schema, dsh.client manifest & dist/client.js settings registration
  assert.ok(Config && typeof Config === 'function' && 'toJSON' in Config, 'Expected Config Schemastery schema export');
  const parsedCfg = Config({
    mode: 'auto',
    windowMode: 'headless',
    cursorStyle: { preset: 'comet-gold' },
  });
  assert.equal(readVolatileValue(parsedCfg.windowMode), 'headless');
  assert.equal(readVolatileValue(parsedCfg.takeoverHotkey), 'F8');
  assert.equal(readVolatileValue(parsedCfg.keepWindowOpen), true);
  assert.equal(readVolatileValue(parsedCfg.cursorStyle)?.preset, 'comet-gold');
  assert.equal(
    readVolatileValue(parsedCfg.cursorStyle)?.pointerColor,
    undefined,
    'Preset-only cursorStyle must not inject cyber-neon pointerColor over comet-gold'
  );
  assert.equal(readVolatileValue('plain'), 'plain');
  assert.equal(readVolatileValue({ get: () => 42 }), 42);

  assert.equal(pkgJson?.dsh?.client?.platform, 'web', 'Expected package.json dsh.client.platform === "web"');
  assert.equal(pkgJson?.exports?.['./client'], './dist/client.js');
  const clientDistPath = path.join(pkgRoot, 'dist', 'client.js');
  assert.ok(fs.existsSync(clientDistPath), 'Expected built dist/client.js to exist');
  const clientSource = fs.readFileSync(clientDistPath, 'utf8');
  let registeredClientMod: any = null;
  const hookStates = new Map<string, any[]>();
  const pendingEffects: Array<() => void> = [];
  const recordedTimers: Array<{ id: number; ms: number; cb: () => void }> = [];
  let nextTimerId = 1;
  let currentCompKey = 'root';
  let currentHookIdx = 0;

  const mockReact = {
    Fragment: Symbol.for('react.fragment'),
    createElement: (type: any, props: any, ...children: any[]) => ({ type, props, children }),
    useState: (init: any) => {
      const idx = currentHookIdx++;
      let arr = hookStates.get(currentCompKey);
      if (!arr) {
        arr = [];
        hookStates.set(currentCompKey, arr);
      }
      if (!(idx in arr)) {
        arr[idx] = typeof init === 'function' ? init() : init;
      }
      const keySnap = currentCompKey;
      const setState = (next: any) => {
        const list = hookStates.get(keySnap)!;
        list[idx] = typeof next === 'function' ? next(list[idx]) : next;
      };
      return [arr[idx], setState];
    },
    useEffect: (fn: () => any) => {
      pendingEffects.push(fn);
    },
    useRef: (init: any) => {
      const idx = currentHookIdx++;
      let arr = hookStates.get(currentCompKey);
      if (!arr) {
        arr = [];
        hookStates.set(currentCompKey, arr);
      }
      if (!(idx in arr)) {
        arr[idx] = { current: init };
      }
      return arr[idx];
    },
  };
  const clientSandbox: any = {
    Object,
    Array,
    Math,
    Number,
    String,
    Boolean,
    Set,
    Map,
    Date,
    RegExp,
    JSON,
    Reflect,
    Symbol,
    Promise,
    setTimeout: (cb: () => void, ms: number) => {
      const id = nextTimerId++;
      recordedTimers.push({ id, ms, cb });
      return id;
    },
    clearTimeout: (id: number) => {
      const idx = recordedTimers.findIndex((t) => t.id === id);
      if (idx >= 0) recordedTimers.splice(idx, 1);
    },
    window: {
      __ModuleLoader__: {
        load(reg: any) {
          registeredClientMod = reg;
        },
      },
      addEventListener() {},
      removeEventListener() {},
    },
  };
  vm.runInNewContext(clientSource, clientSandbox);
  assert.ok(registeredClientMod && typeof registeredClientMod.factory === 'function');
  const clientExports = registeredClientMod.factory((id: string) => {
    if (id === 'react') return mockReact;
    throw new Error(`Unexpected require inside dist/client.js: ${id}`);
  });
  assert.deepEqual([...clientExports.inject], ['slots', 'locale', 'configForms']);

  const renderPanelTree = (panelProps: Record<string, any>, reset = true): any => {
    if (reset) {
      hookStates.clear();
      recordedTimers.length = 0;
    }
    pendingEffects.length = 0;
    const expand = (node: any, scopePath: string): any => {
      if (node == null || typeof node !== 'object') return node;
      if (Array.isArray(node)) return node.map((item, i) => expand(item, `${scopePath}[${i}]`));
      if (typeof node.type === 'function') {
        const compKey = `${scopePath}:${node.type.name || 'anon'}`;
        currentCompKey = compKey;
        currentHookIdx = 0;
        const out = node.type(node.props || {});
        return expand(out, compKey);
      }
      return {
        ...node,
        children: expand(node.children, scopePath),
      };
    };
    const tree = expand(mockReact.createElement(clientExports.VisualBrowserSettingsPanel, panelProps), 'panel');
    for (const eff of [...pendingEffects]) {
      eff();
    }
    return tree;
  };
  const collectTreeText = (node: any): string => {
    if (node == null || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(collectTreeText).join(' ');
    if (typeof node === 'object') {
      return [node.props?.children, node.children].map(collectTreeText).join(' ');
    }
    return '';
  };

  // Verify 4 UI modes per TASK-v1.2.3:
  const noProviderText = collectTreeText(renderPanelTree({}));
  assert.ok(noProviderText.includes('未向本插件提供可视化配置表单'), 'Expected immediate degraded message when host supplies neither form nor hooks');
  assert.ok(!noProviderText.includes('正在读取视觉浏览器配置…'), 'Degraded panel without provider must NEVER render loading text');
  assert.ok(noProviderText.includes('宿主能力探测：'), 'Expected P1 diagnostic line in degraded view');

  const readyFormProps = {
    form: {
      state: { status: 'ready', writable: true, revision: 1, value: { cursorStyle: { preset: 'comet-gold' } } },
      mutate: async () => true,
    },
  };
  const readyFormTree = renderPanelTree(readyFormProps);
  const readyFormText = collectTreeText(readyFormTree);
  assert.ok(!readyFormText.includes('未向本插件提供可视化配置表单'));
  assert.ok(readyFormText.includes('保存设置'));
  assert.ok(
    readyFormText.includes('在画布内移动鼠标预览拖尾，单击预览点击波纹，按住拖动预览拖拽动效。'),
    'Expected updated ZH previewHint copy in LiveCursorPreview'
  );
  assert.ok(
    clientSource.includes('Move to preview trails, click to preview the ripple, press-and-drag to preview drag.'),
    'Expected updated EN previewHint copy in dist/client.js'
  );

  const findVNode = (node: any, pred: (n: any) => boolean): any => {
    if (node == null || typeof node !== 'object') return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = findVNode(item, pred);
        if (hit) return hit;
      }
      return null;
    }
    if (pred(node)) return node;
    return findVNode(node.children, pred);
  };
  let capturedPointerId: number | null = null;
  let releasedPointerId: number | null = null;
  const mockStageTarget = {
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 420, height: 210 }),
    setPointerCapture: (id: number) => {
      capturedPointerId = id;
    },
    releasePointerCapture: (id: number) => {
      releasedPointerId = id;
    },
  };
  const stageVNode0 = findVNode(
    readyFormTree,
    (n) => typeof n?.props?.className === 'string' && n.props.className.includes('dshvb_stage')
  );
  assert.ok(stageVNode0 && typeof stageVNode0.props.onPointerDown === 'function', 'Expected pointer handlers on preview stage');
  stageVNode0.props.onPointerDown({
    button: 0,
    pointerId: 7,
    clientX: 100,
    clientY: 80,
    currentTarget: mockStageTarget,
  });
  assert.equal(capturedPointerId, 7, 'Expected setPointerCapture called on pointerdown');

  const treeDown = renderPanelTree(readyFormProps, false);
  const ptrDown = findVNode(treeDown, (n) => n?.props?.['data-dsh-preview-pointer'] === 'true');
  const anchorDown = findVNode(treeDown, (n) => n?.props?.['data-dsh-preview-anchor'] === 'true');
  assert.ok(ptrDown?.props?.style?.transform?.includes('scale(0.86)'), 'Expected scale(0.86) in preview while dragging');
  assert.ok(anchorDown && anchorDown.props.cx === 100 && anchorDown.props.cy === 80 && anchorDown.props.r === 9);
  assert.equal(anchorDown.props.strokeDasharray, '3 3');

  const stageVNodeDown = findVNode(
    treeDown,
    (n) => typeof n?.props?.className === 'string' && n.props.className.includes('dshvb_stage')
  );
  stageVNodeDown.props.onPointerMove({
    pointerId: 7,
    clientX: 220,
    clientY: 140,
    currentTarget: mockStageTarget,
  });
  const treeDragging = renderPanelTree(readyFormProps, false);
  const dragLine = findVNode(treeDragging, (n) => n?.props?.['data-dsh-preview-drag-line'] === 'true');
  assert.ok(dragLine && dragLine.props.x1 === 100 && dragLine.props.x2 === 220);
  assert.ok(Math.abs(Number(dragLine.props.strokeWidth) - Math.max(2.4, 4.5 * 1.8)) < 0.01, `Expected thickened preview drag line, got ${dragLine.props.strokeWidth}`);

  const stageVNodeMove = findVNode(
    treeDragging,
    (n) => typeof n?.props?.className === 'string' && n.props.className.includes('dshvb_stage')
  );
  // Release OUTSIDE canvas bounds (600, 400 -> clamped 412, 202) to verify setPointerCapture recovery
  stageVNodeMove.props.onPointerUp({
    pointerId: 7,
    clientX: 600,
    clientY: 400,
    currentTarget: mockStageTarget,
  });
  assert.equal(releasedPointerId, 7, 'Expected releasePointerCapture on pointerup');
  const treeDrop = renderPanelTree(readyFormProps, false);
  const ptrDrop = findVNode(treeDrop, (n) => n?.props?.['data-dsh-preview-pointer'] === 'true');
  const dropInner = findVNode(treeDrop, (n) => n?.props?.['data-dsh-preview-drop'] === 'inner');
  const dropOuter = findVNode(treeDrop, (n) => n?.props?.['data-dsh-preview-drop'] === 'outer');
  assert.ok(!ptrDrop?.props?.style?.transform?.includes('scale(0.86)'), 'Preview pointer must not stay pressed after pointerup outside stage');
  assert.ok(dropInner && dropOuter && !dropInner.props.strokeDasharray && !dropOuter.props.strokeDasharray);
  assert.ok(collectTreeText(treeDrop).includes('DROP (412,202)'), `Expected DROP badge after release, got ${collectTreeText(treeDrop)}`);
  const dropClearTimer = recordedTimers.find((tm) => tm.ms === 1000);
  assert.ok(dropClearTimer, 'Expected 1000ms timer to clear preview DROP state');
  dropClearTimer!.cb();
  const treeReset = renderPanelTree(readyFormProps, false);
  assert.ok(collectTreeText(treeReset).includes('PREVIEW'), 'Expected preview badge restored to PREVIEW after 1s');

  // v1.3.1: clean-none (trailVariant === 'none') MUST still render preview drag line & anchor, while normal trail stays hidden
  const cleanNoneProps = {
    form: {
      state: { status: 'ready', writable: true, revision: 1, value: { cursorStyle: { preset: 'clean-none' } } },
      mutate: async () => true,
    },
  };
  const cleanNoneTree = renderPanelTree(cleanNoneProps, true);
  assert.equal(
    findVNode(cleanNoneTree, (n) => n?.props?.['data-dsh-preview-trail'] === 'true'),
    null,
    'Normal preview trail must stay hidden when trailVariant === none'
  );
  const cleanStage0 = findVNode(
    cleanNoneTree,
    (n) => typeof n?.props?.className === 'string' && n.props.className.includes('dshvb_stage')
  );
  cleanStage0.props.onPointerDown({
    button: 0,
    pointerId: 8,
    clientX: 100,
    clientY: 80,
    currentTarget: mockStageTarget,
  });
  const cleanTreeDown = renderPanelTree(cleanNoneProps, false);
  const cleanStageDown = findVNode(
    cleanTreeDown,
    (n) => typeof n?.props?.className === 'string' && n.props.className.includes('dshvb_stage')
  );
  cleanStageDown.props.onPointerMove({
    pointerId: 8,
    clientX: 220,
    clientY: 140,
    currentTarget: mockStageTarget,
  });
  const cleanTreeDrag = renderPanelTree(cleanNoneProps, false);
  const cleanDragLine = findVNode(cleanTreeDrag, (n) => n?.props?.['data-dsh-preview-drag-line'] === 'true');
  const cleanAnchor = findVNode(cleanTreeDrag, (n) => n?.props?.['data-dsh-preview-anchor'] === 'true');
  assert.ok(cleanDragLine, 'Expected [data-dsh-preview-drag-line] even when trailVariant === none');
  assert.equal(cleanDragLine.props.x1, 100);
  assert.equal(cleanDragLine.props.y1, 80);
  assert.equal(cleanDragLine.props.x2, 220);
  assert.equal(cleanDragLine.props.y2, 140);
  assert.ok(Math.abs(Number(cleanDragLine.props.strokeWidth) - Math.max(2.4, 2.8 * 1.8)) < 0.01);
  assert.equal(
    findVNode(cleanTreeDrag, (n) => n?.props?.['data-dsh-preview-trail'] === 'true'),
    null,
    'Normal preview trail must stay empty/absent during clean-none drag'
  );
  assert.ok(cleanAnchor && cleanAnchor.props.fill === '#ff3b28' && cleanAnchor.props.fillOpacity === 0.16);
  const cleanStageDrag = findVNode(
    cleanTreeDrag,
    (n) => typeof n?.props?.className === 'string' && n.props.className.includes('dshvb_stage')
  );
  cleanStageDrag.props.onPointerUp({
    pointerId: 8,
    clientX: 260,
    clientY: 160,
    currentTarget: mockStageTarget,
  });
  const cleanTreeDrop = renderPanelTree(cleanNoneProps, false);
  const cleanPtrDrop = findVNode(cleanTreeDrop, (n) => n?.props?.['data-dsh-preview-pointer'] === 'true');
  assert.ok(!cleanPtrDrop?.props?.style?.transform?.includes('scale(0.86)'));
  assert.ok(collectTreeText(cleanTreeDrop).includes('DROP (260,160)'));

  // v1.3.1: laser-dots (trailVariant === 'dots') MUST also render [data-dsh-preview-drag-line] while dragging
  const dotsProps = {
    form: {
      state: { status: 'ready', writable: true, revision: 1, value: { cursorStyle: { preset: 'laser-dots' } } },
      mutate: async () => true,
    },
  };
  const dotsTree = renderPanelTree(dotsProps, true);
  const dotsStage0 = findVNode(
    dotsTree,
    (n) => typeof n?.props?.className === 'string' && n.props.className.includes('dshvb_stage')
  );
  dotsStage0.props.onPointerDown({
    button: 0,
    pointerId: 9,
    clientX: 90,
    clientY: 70,
    currentTarget: mockStageTarget,
  });
  const dotsTreeDown = renderPanelTree(dotsProps, false);
  const dotsStageDown = findVNode(
    dotsTreeDown,
    (n) => typeof n?.props?.className === 'string' && n.props.className.includes('dshvb_stage')
  );
  dotsStageDown.props.onPointerMove({
    pointerId: 9,
    clientX: 210,
    clientY: 130,
    currentTarget: mockStageTarget,
  });
  const dotsTreeDrag = renderPanelTree(dotsProps, false);
  const dotsDragLine = findVNode(dotsTreeDrag, (n) => n?.props?.['data-dsh-preview-drag-line'] === 'true');
  assert.ok(dotsDragLine && dotsDragLine.props.x1 === 90 && dotsDragLine.props.x2 === 210);
  assert.ok(Math.abs(Number(dotsDragLine.props.strokeWidth) - Math.max(2.4, 3.6 * 1.8)) < 0.01);
  assert.equal(findVNode(dotsTreeDrag, (n) => n?.props?.['data-dsh-preview-trail'] === 'true'), null);

  const useHookText = collectTreeText(
    renderPanelTree({
      useConfigForm: (sel: (s: any) => any) =>
        sel({ status: 'ready', writable: true, revision: 2, value: { cursorStyle: { preset: 'laser-dots' } } }),
    })
  );
  assert.ok(!useHookText.includes('未向本插件提供可视化配置表单'));
  assert.ok(useHookText.includes('保存设置'));

  const loadingStoreProps = {
    configFormStore: {
      getSnapshot: () => ({ status: 'loading', writable: false }),
      subscribe: () => () => {},
      mutate: async () => false,
    },
  };
  const initialLoadingText = collectTreeText(renderPanelTree(loadingStoreProps, true));
  assert.ok(initialLoadingText.includes('正在读取视觉浏览器配置…'));
  const timeoutTimer = recordedTimers.find((t) => t.ms === 2500);
  assert.ok(timeoutTimer, 'Expected 2500ms loading timeout fallback timer');
  timeoutTimer!.cb();
  const timedOutText = collectTreeText(renderPanelTree(loadingStoreProps, false));
  assert.ok(timedOutText.includes('未向本插件提供可视化配置表单'), 'Expected degraded view after 2.5s timeout');
  assert.ok(!timedOutText.includes('正在读取视觉浏览器配置…'), 'Loading text must vanish after 2.5s timeout');

  const slotRegistrations: Array<{ name: string; opts: any; comp: any }> = [];
  const mutateCalls: Array<{ ns: string; ops: any[]; rev?: number }> = [];
  const mockClientCtx = {
    locale: {
      bind: (ns: string) => (k: string) => `${ns}:${k}`,
      register: () => () => {},
    },
    effect: (fn: () => any) => fn(),
    slots: {
      inject: (_name: string, fn: () => any) => fn(),
      register: (opts: any, comp: any) => {
        slotRegistrations.push({ name: opts.name, opts, comp });
        return () => {};
      },
    },
    configForms: {
      get: (ns: string) => ({
        getSnapshot: () => ({ status: 'ready', writable: true, revision: 3, value: { cursorStyle: { preset: 'cyber-neon' } } }),
        subscribe: () => () => {},
        mutate: async (ops: any[], rev?: number) => {
          mutateCalls.push({ ns, ops, rev });
          return true;
        },
      }),
      describe: () => ({
        getSnapshot: () => ({ status: 'ready', view: { namespaces: [{ ns: 'dsh-plugin-visual-browser', value: { cursorStyle: { preset: 'cyber-neon' } } }] } }),
        subscribe: () => () => {},
      }),
    },
  };
  clientExports.apply(mockClientCtx);
  const settingsSlot = slotRegistrations.find((s) => s.name === 'settings.section' && s.opts.id === 'visual-browser');
  const bundleSlot = slotRegistrations.find((s) => s.name === 'plugins.bundle.config' && s.opts.key === 'dsh-plugin-visual-browser');
  assert.ok(settingsSlot, 'Expected settings.section registration with id="visual-browser"');
  assert.ok(bundleSlot, 'Expected plugins.bundle.config registration with key="dsh-plugin-visual-browser"');
  const injectedFace = settingsSlot!.opts.inject();
  assert.equal(await injectedFace.saveMutation([{ op: 'set', path: ['cursorStyle'], value: { preset: 'custom' } }], 3), true);
  assert.equal(mutateCalls.length, 1);
  assert.equal(mutateCalls[0]?.ns, 'dsh-plugin-visual-browser');
  console.log('[Strict DSH 0.2 Contract] 0j Verified Config schema, dsh.client manifest & dist/client.js settings slots!');

  // Checks 1-5: End-to-end tool execution with headless Chromium & local static server
  const distDir = path.resolve('E:/AI_Work/Antigravity/aw-argon-edition/dist');
  const artifactDir = path.resolve('E:/AI_Work/Antigravity/dsh-plugin-visual-browser/artifacts/contract-test');
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.rmSync(path.join(artifactDir, 'settings.json'), { force: true });

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
    assert.equal(runDiagJson.planner_detail?.llm_steps?.[0]?.decision_source, 'llm');
    assert.equal(runDiagJson.planner_detail?.llm_steps?.[0]?.action?.type, 'move_mouse');
    assert.equal(runDiagJson.planner_detail?.llm_steps?.[1]?.action?.type, 'complete');

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
    assert.equal(emptyDiagJson.planner_detail?.llm_steps?.[0]?.decision_source, 'inspector');
    assert.equal(emptyDiagJson.planner_detail?.llm_steps?.[0]?.action?.type, 'complete');
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

    // 5f. TASK-v1.1.7 P1: runTask() throw STILL persists diagnostics.json with status=FAILED
    const failArtifactDir = path.join(artifactDir, 'fail-diag-check');
    fs.rmSync(failArtifactDir, { recursive: true, force: true });
    fs.mkdirSync(failArtifactDir, { recursive: true });
    const failHost = createCordisStrictCtx({ validateSchemas: false });
    apply(failHost.ctx, {
      mode: 'auto',
      backgroundSilent: true,
      artifactDir: failArtifactDir,
      customPlanner: async () => {
        throw new Error('Synthetic step crash for diagnostics check');
      },
    });
    allDisposers.push(...failHost.effectDisposers);
    const failRunDef = failHost.registeredTools.get('browser_subagent_run')!;
    await assert.rejects(
      () =>
        failRunDef.execute(
          { url: srv.url, role: 'Fail Verifier', task_prompt: 'Trigger crash', max_steps: 2 },
          fakeExec
        ),
      /Synthetic step crash for diagnostics check/
    );
    const failSubdirs = fs.readdirSync(failArtifactDir).filter((d) => d.startsWith('subagent-'));
    assert.equal(failSubdirs.length, 1, 'Expected subagent-* directory under failArtifactDir');
    const failDiagFile = path.join(failArtifactDir, failSubdirs[0], 'diagnostics.json');
    assert.ok(fs.existsSync(failDiagFile), 'Expected diagnostics.json to be written even when runTask() throws');
    const failDiagJson = JSON.parse(fs.readFileSync(failDiagFile, 'utf8'));
    assert.equal(failDiagJson.status, 'FAILED');
    assert.ok(String(failDiagJson.error?.message ?? '').includes('Synthetic step crash for diagnostics check'));
    assert.equal(failDiagJson.planner_mode, 'custom');
    console.log('[Strict DSH 0.2 Contract] 5f Verified FAILED runTask() still persists diagnostics.json!');

    // 5g. TASK-v1.1.9 Acceptance #2: real Chromium HUD + inspectDom() expose href/value without undefined/secrets
    const hudSession = await new BrowserSession({
      mode: 'auto',
      backgroundSilent: true,
    }).start();
    try {
      const hudTools = new AtomicBrowserToolset(hudSession, path.join(artifactDir, 'hud-fixture'));
      const hudNav = await hudTools.navigate(`${srv.url}__hud-fixture.html`, 400);
      const els = hudNav.observation.interactiveElements;

      const linkEl = els.find((e) => e.label === 'Learn more');
      assert.ok(linkEl, 'Expected Learn more anchor in interactiveElements');
      assert.equal(linkEl.href, 'https://x.example/y');
      assert.equal(linkEl.title, 'External target');
      assert.ok(hudNav.llmSummary.includes('href=`https://x.example/y`'));

      const emailEl = els.find((e) => e.label === 'Email');
      assert.ok(emailEl, 'Expected Email input in interactiveElements');
      assert.equal(emailEl.value, 'abc');
      assert.ok(hudNav.llmSummary.includes('value="abc"'));

      const pwdEl = els.find((e) => e.label === 'Password');
      assert.ok(pwdEl, 'Expected Password input in interactiveElements');
      assert.equal(pwdEl.value, undefined, 'Password input values must never be exposed in HUD');
      assert.ok(!hudNav.llmSummary.includes('secret123'), 'HUD text must not leak password values');

      const btnEl = els.find((e) => e.label === 'Plain Action');
      assert.ok(btnEl, 'Expected Plain Action button in interactiveElements');
      assert.equal(btnEl.href, undefined);
      const btnLine = hudNav.llmSummary.split('\n').find((l) => l.includes('Plain Action')) ?? '';
      assert.ok(!btnLine.includes('href=') && !btnLine.includes('undefined'), `Unexpected attrs on plain button line: ${btnLine}`);

      const domLinkRes = await hudTools.inspectDom('a#ext-link');
      assert.equal(domLinkRes.count, 1);
      assert.equal(domLinkRes.samples[0]?.href, 'https://x.example/y');
      assert.equal(domLinkRes.samples[0]?.title, 'External target');

      const domInputRes = await hudTools.inspectDom('input#email-box');
      assert.equal(domInputRes.samples[0]?.value, 'abc');
      console.log('[Strict DSH 0.2 Contract] 5g Verified HUD & inspectDom() href/value exposure + password masking!');
    } finally {
      await hudSession.close();
    }

    // 5h. v1.2.2: Overlay root is pointer-events:none (popover="manual"), button is pointer-events:none during RUNNING and auto during PAUSED, F8 triggers USER_TAKEOVER & resumes
    const takeoverHost = createCordisStrictCtx({ validateSchemas: false });
    let takeoverPlannerCalls = 0;
    let capturedTakeoverSession: BrowserSession | null = null;
    let takeoverRes!: ReturnType<typeof apply>;
    takeoverRes = apply(takeoverHost.ctx, {
      mode: 'auto',
      windowMode: 'headless',
      keepWindowOpen: true,
      showTakeoverControl: true,
      takeoverHotkey: 'F8',
      artifactDir,
      customPlanner: async (ctx) => {
        takeoverPlannerCalls++;
        assert.ok(
          !ctx.latestObservation.interactiveElements.some(
            (e) =>
              e.label.includes('接管') ||
              e.selectorHint.includes('__dsh_vc_takeover_btn__')
          ),
          'Takeover overlay button must be excluded from interactiveElements HUD'
        );
        if (takeoverPlannerCalls === 1) {
          const activeSession = takeoverRes.runner.getSharedSession();
          assert.ok(activeSession, 'Expected shared session while runTask with keepWindowOpen is active');
          capturedTakeoverSession = activeSession;
          const runningStyles = await safeEvaluate(
            activeSession.page,
            () => {
              const root = document.getElementById('__dsh_vc_root__');
              const btn = document.getElementById('__dsh_vc_takeover_btn__');
              return {
                popover: root?.getAttribute('popover') ?? '',
                rootPointerEvents: root ? getComputedStyle(root).pointerEvents : '',
                btnPointerEvents: btn ? getComputedStyle(btn).pointerEvents : '',
              };
            },
            { popover: '', rootPointerEvents: '', btnPointerEvents: '' },
            0
          );
          assert.equal(runningStyles.popover, 'manual');
          assert.equal(runningStyles.rootPointerEvents, 'none');
          assert.equal(runningStyles.btnPointerEvents, 'none', 'Takeover button must be click-through during RUNNING');
          await activeSession.page.keyboard.press('F8');
          return { type: 'scroll', deltaY: 120, reason: 'Check F8 hotkey takeover signal' };
        }
        return { type: 'complete', report: 'RESUMED_AFTER_USER_TAKEOVER' };
      },
    });
    allDisposers.push(...takeoverHost.effectDisposers);
    const takeoverRunDef = takeoverHost.registeredTools.get('browser_subagent_run')!;
    const takeoverResumeDef = takeoverHost.registeredTools.get('browser_subagent_resume')!;
    try {
      const pauseVal: any = await takeoverRunDef.execute(
        {
          url: srv.url,
          role: 'Takeover Verifier',
          task_prompt: 'Verify live takeover button pointer-events, F8 hotkey pause & resume',
          max_steps: 4,
          window_mode: 'headless',
        },
        fakeExec
      );
      assert.equal(takeoverPlannerCalls, 1, 'Expected customPlanner to run step 1 before USER_TAKEOVER pause');
      assert.equal(pauseVal.status, 'PAUSED_FOR_TAKEOVER');
      assert.equal(pauseVal.approval_card?.reason, 'USER_TAKEOVER');
      assert.equal(takeoverRes.runner.getSharedSession(), null, 'Paused takeover session must detach from shared pool');
      assert.ok(capturedTakeoverSession);
      const pausedBtnPe = await safeEvaluate(
        capturedTakeoverSession.page,
        () => {
          const btn = document.getElementById('__dsh_vc_takeover_btn__');
          return btn ? getComputedStyle(btn).pointerEvents : '';
        },
        '',
        0
      );
      assert.equal(pausedBtnPe, 'auto', 'Takeover button must become pointer-events:auto in PAUSED state');

      const resumedVal: any = await takeoverResumeDef.execute(
        {
          subagent_id: pauseVal.subagent_id,
          resume_note: 'Manual verification completed',
        },
        fakeExec
      );
      assert.equal(takeoverPlannerCalls, 2, 'Expected customPlanner to resume at step 2 after USER_TAKEOVER');
      assert.equal(resumedVal.status, 'COMPLETED');
      assert.ok(String(resumedVal.subagent_report).includes('RESUMED_AFTER_USER_TAKEOVER'));
      console.log('[Strict DSH 0.2 Contract] 5h Verified pointer-events state machine, F8 takeover pause & resume!');
    } finally {
      await takeoverRes.runner.closeAllSessions();
    }

    // 5i. v1.2.0: Persistent reusable BrowserSession stays alive across keepWindowOpen runs and closes on closeAllSessions()
    const reuseRunner = new BrowserSubagentRunner();
    try {
      const r1 = await reuseRunner.runTask({
        startUrl: srv.url,
        role: 'Reuse-1',
        taskPrompt: 'First persistent session task',
        maxSteps: 1,
        artifactDir,
        keepWindowOpen: true,
        sessionOptions: { mode: 'auto', windowMode: 'headless', keepWindowOpen: true, showTakeoverControl: false },
        planner: async () => ({ type: 'complete', report: 'FIRST_REUSE_OK' }),
      });
      assert.equal(r1.status, 'COMPLETED');
      const firstSession = reuseRunner.getSharedSession();
      assert.ok(firstSession && firstSession.isAlive(), 'Expected shared session to remain alive after keepWindowOpen run');
      assert.equal(reuseRunner.isSharedSessionBusy(), false);

      const r2 = await reuseRunner.runTask({
        startUrl: `${srv.url}#reuse-2`,
        role: 'Reuse-2',
        taskPrompt: 'Second persistent session task',
        maxSteps: 1,
        artifactDir,
        keepWindowOpen: true,
        sessionOptions: { mode: 'auto', windowMode: 'headless', keepWindowOpen: true, showTakeoverControl: false },
        planner: async () => ({ type: 'complete', report: 'SECOND_REUSE_OK' }),
      });
      assert.equal(r2.status, 'COMPLETED');
      assert.equal(reuseRunner.getSharedSession(), firstSession, 'Expected exact same BrowserSession instance to be reused');
      assert.equal(firstSession.isAlive(), true);

      await reuseRunner.closeAllSessions();
      assert.equal(reuseRunner.getSharedSession(), null);
      assert.equal(firstSession.isAlive(), false);
      console.log('[Strict DSH 0.2 Contract] 5i Verified persistent BrowserSession reuse & clean closeAllSessions() teardown!');
    } finally {
      await reuseRunner.closeAllSessions();
    }

    // 5j. TASK-v1.2.2 P0/P0.5/P1/P3: Layer isolation hit-test blocks PLUGIN_UI_LAYER without mouse.click & allows click-through to Menu
    const layerSession = await new BrowserSession({
      mode: 'auto',
      windowMode: 'headless',
      showTakeoverControl: true,
      takeoverHotkey: 'F8',
    }).start();
    try {
      const layerTools = new AtomicBrowserToolset(layerSession, path.join(artifactDir, 'layer-fixture'));
      let mouseClickSpyCount = 0;
      const origMouseClick = layerSession.page.mouse.click.bind(layerSession.page.mouse);
      (layerSession.page.mouse as any).click = async (x: number, y: number, options?: any) => {
        mouseClickSpyCount++;
        return origMouseClick(x, y, options);
      };

      await layerTools.navigate(`${srv.url}__layer-fixture.html`, 400);
      const menuClickRes = await layerTools.click('a#menu-link', 120);
      assert.equal(menuClickRes.ok, true);
      assert.equal(menuClickRes.blocked, undefined);
      assert.equal(mouseClickSpyCount, 1, 'Expected real page.mouse.click once when clicking Menu beneath pill');
      const menuCount = await safeEvaluate(layerSession.page, () => Number((window as any).__menuClicked || 0), 0, 0);
      assert.equal(menuCount, 1, 'Expected Menu link beneath RUNNING pill to receive real click');
      assert.equal(await layerSession.checkHumanTakeoverRequested(), false);

      const shadowCenter = await safeEvaluate(
        layerSession.page,
        () => {
          const btn = document.getElementById('shadow-host')?.shadowRoot?.getElementById('shadow-btn');
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        },
        null,
        0
      );
      assert.ok(shadowCenter, 'Expected Shadow DOM button bounding box');
      const shadowHit = await layerSession.motion.hitTestAt(shadowCenter!.x, shadowCenter!.y);
      assert.equal(shadowHit.hitsPluginUi, false);
      assert.equal(shadowHit.inShadowRoot, true);

      const frameCenter = await safeEvaluate(
        layerSession.page,
        () => {
          const iframe = document.getElementById('same-origin-frame') as HTMLIFrameElement | null;
          const fBtn = iframe?.contentDocument?.getElementById('frame-btn');
          if (!iframe || !fBtn) return null;
          const ir = iframe.getBoundingClientRect();
          const br = fBtn.getBoundingClientRect();
          return { x: ir.left + br.left + br.width / 2, y: ir.top + br.top + br.height / 2 };
        },
        null,
        0
      );
      assert.ok(frameCenter, 'Expected same-origin iframe button coordinates');
      const frameHit = await layerSession.motion.hitTestAt(frameCenter!.x, frameCenter!.y);
      assert.equal(frameHit.hitsPluginUi, false);
      assert.equal(frameHit.inIframe, true);

      await layerTools.navigate(`${srv.url}__layer-fixture.html?__dsh_test_center_pill=1`, 400);
      mouseClickSpyCount = 0;
      const vpCenter = await safeEvaluate(
        layerSession.page,
        () => ({ x: Math.round(window.innerWidth / 2), y: Math.round(window.innerHeight / 2) }),
        { x: 720, y: 450 },
        0
      );
      const blockedTop = await layerTools.click(vpCenter, 100);
      assert.equal(blockedTop.ok, false);
      assert.equal(blockedTop.blocked, 'PLUGIN_UI_LAYER');
      assert.ok(String(blockedTop.hit ?? '').includes('#__dsh_vc_root__'), `Expected #__dsh_vc_root__ hit chain, got ${blockedTop.hit}`);
      assert.equal(mouseClickSpyCount, 0, 'page.mouse.click MUST NOT be called when blocked by PLUGIN_UI_LAYER');
      assert.equal(await layerSession.checkHumanTakeoverRequested(), false);

      await layerTools.scroll(600, 150);
      const blockedScrolled = await layerTools.click(vpCenter, 100);
      assert.equal(blockedScrolled.ok, false);
      assert.equal(blockedScrolled.blocked, 'PLUGIN_UI_LAYER');
      assert.equal(mouseClickSpyCount, 0, 'page.mouse.click MUST NOT be called after scroll when center pill overlaps');
    } finally {
      await layerSession.close();
    }

    const layerDiagHost = createCordisStrictCtx({ validateSchemas: false });
    let layerRunCalls = 0;
    const layerDiagRes = apply(layerDiagHost.ctx, {
      mode: 'auto',
      windowMode: 'headless',
      keepWindowOpen: false,
      showTakeoverControl: true,
      artifactDir,
      customPlanner: async (ctx) => {
        layerRunCalls++;
        if (layerRunCalls === 1) {
          const vw = ctx.latestObservation.scroll.viewportWidth || 1440;
          const vh = ctx.latestObservation.scroll.viewportHeight || 900;
          return {
            type: 'click',
            target: { x: Math.round(vw / 2), y: Math.round(vh / 2) },
            reason: 'Verify PLUGIN_UI_LAYER diagnostics persistence',
          };
        }
        return { type: 'complete', report: 'LAYER_DIAG_COMPLETED' };
      },
    });
    allDisposers.push(...layerDiagHost.effectDisposers);
    try {
      const layerRunDef = layerDiagHost.registeredTools.get('browser_subagent_run')!;
      const layerRunVal: any = await layerRunDef.execute(
        {
          url: `${srv.url}__layer-fixture.html?__dsh_test_center_pill=1`,
          role: 'Layer Verifier',
          task_prompt: 'Verify blocked PLUGIN_UI_LAYER action is recorded in diagnostics.json',
          max_steps: 3,
          window_mode: 'headless',
        },
        fakeExec
      );
      assert.equal(layerRunVal.status, 'COMPLETED');
      assert.ok(fs.existsSync(layerRunVal.diagnostics_path));
      const layerDiag = JSON.parse(fs.readFileSync(layerRunVal.diagnostics_path, 'utf8'));
      const step1Action = layerDiag?.planner_detail?.llm_steps?.[0]?.action;
      assert.equal(step1Action?.blocked, 'PLUGIN_UI_LAYER');
      assert.ok(String(step1Action?.hit ?? '').includes('#__dsh_vc_root__'));
      console.log('[Strict DSH 0.2 Contract] 5j Verified Top-Layer hit-test (Menu pass-through, Shadow/iframe, center-pill refusal & diagnostics)!');
    } finally {
      await layerDiagRes.runner.closeAllSessions();
    }

    // 5k. v1.2.2: Verify custom pointer shapes, image URL sanitization, & live settings/document-updated hot sync
    const badStyle = resolveCursorStyle({
      preset: 'custom',
      pointerShape: 'custom-image',
      customPointerImageUrl: 'javascript:alert(1)',
    });
    assert.equal(badStyle.customPointerImageUrl, '', 'Malicious javascript: cursor URL must be stripped');

    let settingsUpdatedHandler: ((ns?: string) => void) | undefined;
    let volatileStyleState: any = { preset: 'cyber-neon', pointerShape: 'arrow', badgeTextPrefix: 'DSH' };
    const liveHostCtx: DshCordisContext = {
      tools: { register: (t) => liveTools.set(t.name, t) },
      on(event, listener) {
        if (event === 'settings/document-updated') {
          settingsUpdatedHandler = listener;
        }
      },
      effect: (fn) => {
        const d = fn();
        if (typeof d === 'function') allDisposers.push(d);
      },
      get: () => undefined,
      inject: () => {},
    };
    const liveTools = new Map<string, ToolDefinition>();
    const liveRes = apply(liveHostCtx, {
      mode: 'auto',
      windowMode: 'headless',
      keepWindowOpen: true,
      artifactDir,
      cursorStyle: { get: () => volatileStyleState },
      takeoverHotkey: { get: () => 'F9' },
      customPlanner: async () => ({ type: 'complete', report: 'LIVE_STYLE_OK' }),
    });
    try {
      const liveRun = liveTools.get('browser_subagent_run')!;
      await liveRun.execute(
        { url: srv.url, role: 'Cursor Sync', task_prompt: 'Keep session open for style sync', max_steps: 1, window_mode: 'headless' },
        fakeExec
      );
      const shared = liveRes.runner.getSharedSession();
      assert.ok(shared && shared.isAlive(), 'Expected persistent shared session for live cursor sync check');

      await shared.motion.setCursorStyle({ preset: 'custom', pointerShape: 'crosshair', pointerColor: '#22c55e' });
      const crosshairState = await safeEvaluate(
        shared.page,
        () => ({
          d: document.getElementById('__dsh_vc_arrow_path__')?.getAttribute('d') ?? '',
          fill: document.getElementById('__dsh_vc_arrow_path__')?.getAttribute('fill') ?? '',
        }),
        { d: '', fill: '' },
        0
      );
      assert.equal(crosshairState.d, POINTER_SHAPE_SVG_PATHS.crosshair);
      assert.equal(crosshairState.fill, 'none');

      const safeSvgUri = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle cx="12" cy="12" r="10" fill="red"/></svg>');
      await shared.motion.setCursorStyle({ preset: 'custom', pointerShape: 'custom-image', customPointerImageUrl: safeSvgUri });
      const imgState = await safeEvaluate(
        shared.page,
        () => {
          const img = document.getElementById('__dsh_vc_custom_img__') as HTMLImageElement | null;
          return { display: img?.style.display ?? '', src: img?.getAttribute('src') ?? '' };
        },
        { display: '', src: '' },
        0
      );
      assert.equal(imgState.display, 'block');
      assert.ok(imgState.src.startsWith('data:image/svg+xml'));

      volatileStyleState = {
        preset: 'comet-gold',
        pointerShape: 'star',
        badgeTextPrefix: 'VIP',
      };
      assert.ok(settingsUpdatedHandler, 'Expected settings/document-updated listener to register');
      settingsUpdatedHandler!('dsh-plugin-visual-browser');
      await new Promise((r) => setTimeout(r, 150));

      const syncedState = await safeEvaluate(
        shared.page,
        () => (window as any).__dshCursorAPI?.getState?.()?.style ?? null,
        null as any,
        0
      );
      assert.equal(syncedState?.pointerShape, 'star');
      assert.equal(syncedState?.badgeTextPrefix, 'VIP');
      console.log('[Strict DSH 0.2 Contract] 5k Verified custom shapes, URL sanitization & settings/document-updated live sync!');
    } finally {
      await liveRes.runner.closeAllSessions();
    }

    // 5l. TASK-v1.2.4: HUD badge viewport boundary flip & 8px clamping + resize re-clamp
    const badgeSession = await new BrowserSession({
      mode: 'auto',
      windowMode: 'headless',
    }).start();
    try {
      await badgeSession.page.setViewportSize({ width: 754, height: 751 });
      await badgeSession.navigate(`${srv.url}__layer-fixture.html`, 'domcontentloaded');

      const evalBadge = async (x: number, y: number, label: string) =>
        safeEvaluate(
          badgeSession.page,
          ({ px, py, lbl }) => {
            (window as any).__dshCursorAPI.update(px, py, lbl);
            const badge = document.getElementById('__dsh_vc_badge__')!;
            const r = badge.getBoundingClientRect();
            return {
              vw: window.innerWidth,
              vh: window.innerHeight,
              left: Math.round(r.left),
              top: Math.round(r.top),
              right: Math.round(r.right),
              bottom: Math.round(r.bottom),
            };
          },
          { vw: 0, vh: 0, left: 0, top: 0, right: 0, bottom: 0 },
          { arg: { px: x, py: y, lbl: label }, retries: 0 }
        );

      const br = await evalBadge(748, 742, 'NEAR-CORNER');
      assert.ok(br.right <= 754 - 8, `Expected right <= 746, got ${br.right}`);
      assert.ok(br.bottom <= 751 - 8, `Expected bottom <= 743, got ${br.bottom}`);

      const tr = await evalBadge(690, 40, 'CLICK #2');
      assert.ok(tr.right <= 754 - 8 && tr.left < 690 && tr.top >= 8);

      const tl = await evalBadge(2, 2, 'TOP-LEFT');
      assert.ok(tl.left >= 8 && tl.top >= 8);

      const mid = await evalBadge(300, 300, 'CENTER');
      assert.ok(mid.left > 300 && mid.top > 300);

      await badgeSession.page.setViewportSize({ width: 500, height: 400 });
      const rsz = await evalBadge(494, 392, 'RESIZED');
      assert.ok(rsz.right <= 500 - 8 && rsz.bottom <= 400 - 8);
      console.log('[Strict DSH 0.2 Contract] 5l Verified HUD badge viewport flip, 8px clamping & resize re-clamp!');
    } finally {
      await badgeSession.close();
    }

    // 0k / B2: settings.json persistence, restart-survival over cordis.yml, browser_set_cursor_trail write + HTTP endpoint
    const persistArtDir = path.join(artifactDir, 'persist-settings-check');
    fs.rmSync(persistArtDir, { recursive: true, force: true });
    fs.mkdirSync(persistArtDir, { recursive: true });
    const settingsPath = resolveSettingsFilePath(persistArtDir);

    const persistHost1 = createCordisStrictCtx({ validateSchemas: false });
    const persistRes1 = apply(persistHost1.ctx, {
      mode: 'auto',
      windowMode: 'headless',
      artifactDir: persistArtDir,
      cursorStyle: { preset: 'cyber-neon', pointerShape: 'arrow' },
    });
    allDisposers.push(...persistHost1.effectDisposers);
    assert.ok(persistRes1.bridge, 'Expected LiveVisualBrowserSettingsBridge on apply() return');

    // Verify HTTP settings endpoint GET + POST + OPTIONS against real Node http.Server
    const handler = createSettingsHttpHandler(persistRes1.bridge!);
    const RESTRICTED_FETCH_PORTS = new Set([
      1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080,
    ]);
    const httpSrv = http.createServer((req, res) => {
      void handler(req, res);
    });
    let port = 0;
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise<void>((r) => httpSrv.listen(0, '127.0.0.1', () => r()));
      port = (httpSrv.address() as { port: number }).port;
      if (!RESTRICTED_FETCH_PORTS.has(port)) break;
      await new Promise<void>((r) => httpSrv.close(() => r()));
    }
    try {
      const endpoint = `http://127.0.0.1:${port}/__dsh_visual_browser/settings`;
      const optRes = await fetch(endpoint, { method: 'OPTIONS' });
      assert.equal(optRes.status, 204);

      const getRes1 = await (await fetch(endpoint)).json();
      assert.equal(getRes1.ok, true);
      assert.equal(getRes1.cursorStyle.pointerShape, 'arrow');

      const postRes = await (
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            persist: true,
            cursorStyle: {
              preset: 'custom',
              pointerShape: 'star',
              pointerColor: '#00f0ff',
              pointerScale: 1.4,
            },
            takeoverHotkey: 'F7',
          }),
        })
      ).json();
      assert.equal(postRes.ok, true);
      assert.equal(postRes.persisted, true);
      assert.equal(postRes.cursorStyle.pointerShape, 'star');
      assert.equal(postRes.takeoverHotkey, 'F7');
      assert.ok(fs.existsSync(settingsPath), 'Expected settings.json to be written on disk');

      // Simulate full DSH restart: fresh apply() with default cordis.yml config MUST load settings.json override!
      const persistHost2 = createCordisStrictCtx({ validateSchemas: false });
      const persistRes2 = apply(persistHost2.ctx, {
        mode: 'auto',
        windowMode: 'headless',
        artifactDir: persistArtDir,
        cursorStyle: { preset: 'cyber-neon', pointerShape: 'arrow' },
      });
      allDisposers.push(...persistHost2.effectDisposers);
      const restartedEffective = persistRes2.bridge!.getEffectiveSettings();
      assert.equal(restartedEffective.cursorStyle.pointerShape, 'star');
      assert.equal(restartedEffective.cursorStyle.pointerColor, '#00f0ff');
      assert.equal(restartedEffective.cursorStyle.pointerScale, 1.4);
      assert.equal(restartedEffective.takeoverHotkey, 'F7');

      const trailTool = persistHost2.registeredTools.get('browser_set_cursor_trail')!;
      const trailSaveRes: any = await trailTool.execute(
        { preset: 'comet-gold', pointer_shape: 'ring' },
        fakeExec
      );
      assert.equal(trailSaveRes.persisted, true);
      const reloadedDisk = loadPersistedSettings(settingsPath);
      assert.equal(reloadedDisk?.cursorStyle?.preset, 'comet-gold');
      assert.equal(reloadedDisk?.cursorStyle?.pointerShape, 'ring');
      savePersistedSettings(settingsPath, { cursorStyle: { pointerShape: 'dot' } });
      assert.equal(loadPersistedSettings(settingsPath)?.cursorStyle?.pointerShape, 'dot');
    } finally {
      await new Promise<void>((r) => httpSrv.close(() => r()));
      await persistRes1.runner.closeAllSessions();
    }
    console.log('[Strict DSH 0.2 Contract] 0k Verified settings.json persistence, restart survival & HTTP settings API!');

    // 5m. TASK-v1.2.5 A1/A2/A3: beforeunload guard, browser.on('disconnected') cleanup, and graceful SESSION_LOST / SESSION_NOT_FOUND resume
    const guardSession = await new BrowserSession({
      mode: 'auto',
      windowMode: 'headless',
    }).start();
    try {
      await guardSession.navigate(`${srv.url}__layer-fixture.html`, 'domcontentloaded');
      await guardSession.motion.setUnloadGuard(true);
      const preventedOn = await safeEvaluate(
        guardSession.page,
        () => {
          const ev = new Event('beforeunload', { cancelable: true });
          window.dispatchEvent(ev);
          return {
            defaultPrevented: ev.defaultPrevented,
            active: (window as any).__dshCursorAPI?.isUnloadGuardActive?.(),
          };
        },
        { defaultPrevented: false, active: false },
        0
      );
      assert.equal(preventedOn.defaultPrevented, true, 'beforeunload must be prevented when unloadGuard is ON');
      assert.equal(preventedOn.active, true);

      // Navigating while unloadGuard is enabled must NOT hang or block programmatic navigation
      await guardSession.navigate(`${srv.url}__layer-fixture.html?nav2=1`, 'domcontentloaded');
      await guardSession.motion.setUnloadGuard(false);
      const preventedOff = await safeEvaluate(
        guardSession.page,
        () => {
          const ev = new Event('beforeunload', { cancelable: true });
          window.dispatchEvent(ev);
          return {
            defaultPrevented: ev.defaultPrevented,
            active: (window as any).__dshCursorAPI?.isUnloadGuardActive?.(),
          };
        },
        { defaultPrevented: true, active: true },
        0
      );
      assert.equal(preventedOff.defaultPrevented, false, 'beforeunload must NOT be prevented after setUnloadGuard(false)');
      assert.equal(preventedOff.active, false);
    } finally {
      await guardSession.close();
    }

    // Simulated browser.emit('disconnected') while PAUSED -> clears pausedSessions, sharedSession, updates diagnostics.json, and resume returns SESSION_LOST
    const lossArtifactDir = path.join(artifactDir, 'session-loss-check');
    fs.rmSync(lossArtifactDir, { recursive: true, force: true });
    fs.mkdirSync(lossArtifactDir, { recursive: true });
    const lossHost = createCordisStrictCtx({ validateSchemas: false });
    let lossSessionCaptured: BrowserSession | null = null;
    const lossRes = apply(lossHost.ctx, {
      mode: 'auto',
      windowMode: 'headless',
      keepWindowOpen: true,
      artifactDir: lossArtifactDir,
      customPlanner: async () => {
        lossSessionCaptured = lossRes.runner.getSharedSession();
        return {
          type: 'pause_for_takeover',
          blockReason: 'USER_TAKEOVER',
          message: 'Pause to test browser disconnect handling',
        };
      },
    });
    allDisposers.push(...lossHost.effectDisposers);
    const lossRunDef = lossHost.registeredTools.get('browser_subagent_run')!;
    const lossResumeDef = lossHost.registeredTools.get('browser_subagent_resume')!;
    try {
      const pausedRun: any = await lossRunDef.execute(
        { url: srv.url, role: 'Disconnect QA', task_prompt: 'Pause then simulate close', max_steps: 3, window_mode: 'headless' },
        fakeExec
      );
      assert.equal(pausedRun.status, 'PAUSED_FOR_TAKEOVER');
      assert.equal(lossRes.runner.getPausedSessionCount(), 1);
      assert.ok(lossSessionCaptured);

      // Guard must be active during PAUSED state
      const pausedGuardActive = await safeEvaluate(
        lossSessionCaptured!.page,
        () => Boolean((window as any).__dshCursorAPI?.isUnloadGuardActive?.()),
        false,
        0
      );
      assert.equal(pausedGuardActive, true, 'Unload guard must be active while PAUSED_FOR_TAKEOVER');

      // Disable guard before test disconnects synthetic event and emit 'disconnected' on real browser EventEmitter
      await lossSessionCaptured!.motion.setUnloadGuard(false);
      (lossSessionCaptured!.browser as any).emit('disconnected');

      assert.equal(lossRes.runner.getPausedSessionCount(), 0, 'pausedSessions must clear on browser disconnected');
      assert.equal(lossRes.runner.getSharedSession(), null, 'sharedSession must clear on browser disconnected');

      const lostDiagPath = path.join(lossArtifactDir, pausedRun.subagent_id, 'diagnostics.json');
      assert.ok(fs.existsSync(lostDiagPath), 'diagnostics.json must exist after disconnect');
      const lostDiag = JSON.parse(fs.readFileSync(lostDiagPath, 'utf8'));
      assert.equal(lostDiag.status, 'SESSION_LOST');
      assert.ok(
        Array.isArray(lostDiag.events) &&
          lostDiag.events.some((e: any) => e.event === 'browser_disconnected' && e.reason === 'user_closed_window'),
        'Expected browser_disconnected event inside diagnostics.json'
      );

      // Resume after disconnect must NOT throw and must pass output schema validation
      const lostResumeVal: any = await lossResumeDef.execute({ subagent_id: pausedRun.subagent_id }, fakeExec);
      assert.equal(validateJsonSchemaValue(lossResumeDef.output.schema, lostResumeVal).length, 0);
      assert.equal(lostResumeVal.status, 'SESSION_LOST');
      assert.equal(lostResumeVal.reason, 'browser_window_closed');
      assert.ok(String(lostResumeVal.hint || '').includes('已关闭'));

      // Direct paused entry with dead session (isAlive() === false) must also return SESSION_LOST cleanly
      const fakeDeadSubId = 'subagent-dead-unit';
      (lossRes.runner as any).pausedSessions.set(fakeDeadSubId, {
        subagentId: fakeDeadSubId,
        req: { role: 'Dead Stub', artifactDir: lossArtifactDir },
        session: { isAlive: () => false },
        tools: {},
        hostFacts: {
          getFacts: () => ({
            subagentId: fakeDeadSubId,
            role: 'Dead Stub',
            visitedOrigins: [],
            blockedOrigins: [],
            screenshots: [],
            latestScreenshot: null,
            totalStepsExecuted: 0,
            consoleErrorsCount: 0,
            failedRequestsCount: 0,
          }),
          formatHostFactsBlock: () => '[BROWSER_HOST_FACTS]',
        },
        history: {
          getStats: () => ({
            maxRecentImages: 3,
            totalSteps: 0,
            totalImagesCaptured: 0,
            activeImagesInContext: 0,
            evictedImagesCount: 0,
            totalImageBytesCaptured: 0,
            activeImageBytesInContext: 0,
            savedImageBytes: 0,
            savingsPercent: 0,
          }),
        },
        planner: async () => ({ type: 'complete', report: 'x' }),
        nextStep: 1,
        maxSteps: 3,
      });
      const deadResumeVal: any = await lossResumeDef.execute({ subagent_id: fakeDeadSubId }, fakeExec);
      assert.equal(deadResumeVal.status, 'SESSION_LOST');
      assert.equal(validateJsonSchemaValue(lossResumeDef.output.schema, deadResumeVal).length, 0);

      // Unknown subagent_id must return SESSION_NOT_FOUND without throwing
      const notFoundVal: any = await lossResumeDef.execute({ subagent_id: 'subagent-does-not-exist' }, fakeExec);
      assert.equal(notFoundVal.status, 'SESSION_NOT_FOUND');
      assert.equal(validateJsonSchemaValue(lossResumeDef.output.schema, notFoundVal).length, 0);
      console.log('[Strict DSH 0.2 Contract] 5m Verified beforeunload guard, disconnect cleanup & SESSION_LOST/SESSION_NOT_FOUND!');
    } finally {
      await lossSessionCaptured?.browser.close().catch(() => {});
      await lossRes.runner.closeAllSessions();
    }

    // 5n. B1 + B7: Runtime setStyle() persists across navigate() and HUD Virtual Cursor syncs with page badge on navigation
    const styleSyncSession = await new BrowserSession({
      mode: 'auto',
      windowMode: 'headless',
    }).start();
    try {
      await styleSyncSession.navigate(`${srv.url}__layer-fixture.html`, 'domcontentloaded');
      await safeEvaluate(
        styleSyncSession.page,
        () => {
          (window as any).__dshCursorAPI.setStyle({
            pointerShape: 'star',
            pointerColor: '#00f0ff',
            pointerScale: 1.4,
          });
          (window as any).__dshCursorAPI.update(700, 80, 'PRE-NAV');
        },
        undefined,
        0
      );
      await styleSyncSession.motion.setPosition(700, 80);

      // Navigate to a different page -> star shape MUST persist and HUD coordinates MUST reset to match badge (120, 120)
      await styleSyncSession.navigate(`${srv.url}__layer-fixture.html?page=2`, 'domcontentloaded');
      const postNavState = await safeEvaluate(
        styleSyncSession.page,
        () => ({
          d: document.getElementById('__dsh_vc_arrow_path__')?.getAttribute('d') ?? '',
          badgeText: document.getElementById('__dsh_vc_badge__')?.textContent ?? '',
          st: (window as any).__dshCursorAPI?.getState?.() ?? null,
        }),
        { d: '', badgeText: '', st: null as any },
        0
      );
      assert.ok(postNavState.d.startsWith('M14 2 L17.2'), `Expected star path to survive navigation, got ${postNavState.d}`);
      const sampler = new PageSnapshotSampler(styleSyncSession, path.join(artifactDir, 'hud-sync'));
      const obs = await sampler.captureSnapshot('after_nav_sync');
      assert.ok(
        Math.abs(obs.cursorPosition.x - Math.round(postNavState.st.x)) <= 2 &&
          Math.abs(obs.cursorPosition.y - Math.round(postNavState.st.y)) <= 2,
        `HUD cursorPosition (${obs.cursorPosition.x},${obs.cursorPosition.y}) must match page cursor (${postNavState.st.x},${postNavState.st.y})`
      );
      assert.ok(postNavState.badgeText.includes(`(${obs.cursorPosition.x}, ${obs.cursorPosition.y})`), `Badge "${postNavState.badgeText}" must match synced coordinates`);
      console.log('[Strict DSH 0.2 Contract] 5n Verified cross-navigation cursor style persistence & HUD/badge coordinate sync!');
    } finally {
      await styleSyncSession.close();
    }

    // 5o. B5 + B6: drag 3-state visuals + subagent drag execution & scroll ↕ pulse indicator + auto-restore
    const motionVisSession = await new BrowserSession({
      mode: 'auto',
      windowMode: 'headless',
    }).start();
    try {
      await motionVisSession.navigate(`${srv.url}__layer-fixture.html`, 'domcontentloaded');
      await safeEvaluate(
        motionVisSession.page,
        () => {
          (window as any).__dragEvents = { down: 0, move: 0, up: 0 };
          window.addEventListener('mousedown', () => { (window as any).__dragEvents.down++; });
          window.addEventListener('mousemove', () => { (window as any).__dragEvents.move++; });
          window.addEventListener('mouseup', () => { (window as any).__dragEvents.up++; });
        },
        undefined,
        0
      );

      let downState: any = null;
      let draggingState: any = null;
      let upState: any = null;
      const readVisualState = async () =>
        safeEvaluate(
          motionVisSession.page,
          () => {
            const ptr = document.getElementById('__dsh_vc_pointer__');
            const anchor = document.getElementById('__dsh_vc_anchor__');
            const badge = document.getElementById('__dsh_vc_badge__');
            const trail = document.getElementById('__dsh_vc_trail__');
            return {
              transform: ptr?.style.transform ?? '',
              hasAnchor: Boolean(anchor),
              anchorOpacity: anchor ? getComputedStyle(anchor).opacity : '',
              badge: badge?.textContent ?? '',
              trailStroke: trail?.getAttribute('stroke') ?? '',
              trailWidth: trail?.getAttribute('stroke-width') ?? '',
            };
          },
          { transform: '', hasAnchor: false, anchorOpacity: '', badge: '', trailStroke: '', trailWidth: '' },
          0
        );

      const dragOut = await motionVisSession.motion.drag(
        { x: 360, y: 300 },
        { x: 760, y: 460 },
        {
          steps: 8,
          durationMs: 140,
          onPhase: async (phase) => {
            const snap = await readVisualState();
            if (phase === 'down') downState = snap;
            else if (phase === 'dragging') draggingState = snap;
            else if (phase === 'up') upState = snap;
          },
        }
      );
      assert.equal(dragOut.ok, true);
      assert.ok(downState?.transform.includes('scale(0.86'), `Expected scale(0.86 on mousedown, got ${downState?.transform}`);
      assert.equal(downState?.hasAnchor, true, 'Expected #__dsh_vc_anchor__ during drag down');
      assert.ok(draggingState?.transform.includes('scale(0.86'), `Expected scale(0.86 during drag, got ${draggingState?.transform}`);
      assert.equal(draggingState?.hasAnchor, true);
      assert.ok(draggingState?.badge.includes('DRAG'), `Expected DRAG badge during drag, got ${draggingState?.badge}`);
      assert.ok(String(draggingState?.trailStroke).includes('__dsh_drag_grad__'), 'Expected reversed drag gradient');
      assert.ok(upState?.badge.includes('DROP'), `Expected DROP badge after drag release, got ${upState?.badge}`);
      assert.ok(!upState?.transform.includes('scale(0.86'), 'Scale must restore after drag release');

      // Wait for anchor fade-out cleanup (> 420ms)
      await motionVisSession.page.waitForTimeout(480);
      const afterAnchorFade = await readVisualState();
      assert.equal(afterAnchorFade.hasAnchor, false, 'Expected #__dsh_vc_anchor__ to remove after fade-out');

      const dragEvents = await safeEvaluate(
        motionVisSession.page,
        () => {
          const sel = window.getSelection?.();
          return {
            events: (window as any).__dragEvents,
            isCollapsed: sel ? sel.isCollapsed : true,
            selectedText: sel ? sel.toString() : '',
            hasNoSelectStyle: Boolean(document.getElementById('__dsh_vc_drag_noselect__')),
            hasDragStartHandler: typeof document.ondragstart === 'function',
          };
        },
        {
          events: { down: 0, move: 0, up: 0 },
          isCollapsed: false,
          selectedText: 'err',
          hasNoSelectStyle: true,
          hasDragStartHandler: true,
        },
        0
      );
      assert.ok(dragEvents.events.down >= 1 && dragEvents.events.move >= 6 && dragEvents.events.up >= 1, `Expected real mouse drag events, got ${JSON.stringify(dragEvents.events)}`);
      assert.equal(dragEvents.isCollapsed, true, `Expected collapsed selection after default drag, got text=${JSON.stringify(dragEvents.selectedText)}`);
      assert.equal(dragEvents.selectedText, '', 'Expected empty selection text after default drag');
      assert.equal(dragEvents.hasNoSelectStyle, false, 'Expected temporary user-select style removed after drag');
      assert.equal(dragEvents.hasDragStartHandler, false, 'Expected document.ondragstart restored after drag');

      // Ensure click immediately after drag succeeds on first try without getting swallowed
      const motionTools = new AtomicBrowserToolset(motionVisSession, path.join(artifactDir, 'motion-vis'));
      const postDragClick = await motionTools.click('#post-drag-btn', 80);
      assert.equal(postDragClick.ok, true);
      const postDragClicks = await safeEvaluate(
        motionVisSession.page,
        () => Number((window as any).__postDragClicks || 0),
        0,
        0
      );
      assert.equal(postDragClicks, 1, 'Expected immediate post-drag click to succeed on first attempt');

      // Opt-in keepSelection: true preserves selected text across selectable copy
      const keepSelDrag = await motionVisSession.motion.drag(
        { x: 344, y: 298 },
        { x: 640, y: 315 },
        { steps: 6, durationMs: 100, keepSelection: true }
      );
      assert.equal(keepSelDrag.ok, true);
      const preservedText = await safeEvaluate(
        motionVisSession.page,
        () => window.getSelection?.()?.toString?.() ?? '',
        '',
        0
      );
      assert.ok(preservedText.trim().length > 0, 'Expected keepSelection: true to preserve selected text');
      await safeEvaluate(motionVisSession.page, () => window.getSelection?.()?.removeAllRanges?.(), undefined, 0);

      // Test scroll directional indicator (.up/.down SVG highlight) & vertical pulse + 400ms auto-restore
      const scrollResDown = await motionTools.scroll(400, 60);
      assert.ok(scrollResDown.action.includes('Scrolled by 400'));
      const duringScrollDown = await safeEvaluate(
        motionVisSession.page,
        () => {
          const ind = document.getElementById('__dsh_vc_scroll_ind__') as HTMLElement | null;
          const up = ind?.querySelector('.up') as HTMLElement | null;
          const down = ind?.querySelector('.down') as HTMLElement | null;
          const pulse = document.getElementById('__dsh_vc_scroll_pulse__');
          const badge = document.getElementById('__dsh_vc_badge__');
          const rect = ind?.getBoundingClientRect();
          return {
            indDisplay: ind ? getComputedStyle(ind).display : 'none',
            flexDir: ind ? getComputedStyle(ind).flexDirection : '',
            width: rect ? Math.round(rect.width) : 0,
            height: rect ? Math.round(rect.height) : 0,
            upSvgPaths: up ? up.querySelectorAll('svg path').length : 0,
            downSvgPaths: down ? down.querySelectorAll('svg path').length : 0,
            upOpacity: up ? Number(getComputedStyle(up).opacity) : -1,
            downOpacity: down ? Number(getComputedStyle(down).opacity) : -1,
            upTransform: up?.style.transform ?? '',
            downTransform: down?.style.transform ?? '',
            upFilter: up?.style.filter ?? '',
            downFilter: down?.style.filter ?? '',
            pulseLines: pulse ? pulse.querySelectorAll('line').length : 0,
            badge: badge?.textContent ?? '',
          };
        },
        {
          indDisplay: 'none',
          flexDir: '',
          width: 0,
          height: 0,
          upSvgPaths: 0,
          downSvgPaths: 0,
          upOpacity: -1,
          downOpacity: -1,
          upTransform: '',
          downTransform: '',
          upFilter: '',
          downFilter: '',
          pulseLines: 0,
          badge: '',
        },
        0
      );
      assert.equal(duringScrollDown.indDisplay, 'flex', 'Expected scroll indicator visible during scroll down');
      assert.equal(duringScrollDown.flexDir, 'column');
      assert.equal(duringScrollDown.width, 18);
      assert.equal(duringScrollDown.height, 26);
      assert.equal(duringScrollDown.upSvgPaths, 1);
      assert.equal(duringScrollDown.downSvgPaths, 1);
      assert.ok(duringScrollDown.downOpacity > 0.9, `Expected .down highlighted on scroll(+400), got opacity=${duringScrollDown.downOpacity}`);
      assert.ok(duringScrollDown.upOpacity < 0.4, `Expected .up dimmed on scroll(+400), got opacity=${duringScrollDown.upOpacity}`);
      assert.ok(duringScrollDown.downTransform.includes('scale(1.15)'), `Expected .down scale(1.15), got ${duringScrollDown.downTransform}`);
      assert.ok(duringScrollDown.downFilter.includes('drop-shadow('), `Expected .down drop-shadow, got ${duringScrollDown.downFilter}`);
      assert.equal(duringScrollDown.upTransform, 'scale(1)');
      assert.equal(duringScrollDown.upFilter, 'none');
      assert.ok(duringScrollDown.pulseLines >= 3, `Expected vertical scroll pulse lines, got ${duringScrollDown.pulseLines}`);
      assert.ok(duringScrollDown.badge.includes('SCROLL'), `Expected SCROLL badge, got ${duringScrollDown.badge}`);

      const scrollResUp = await motionTools.scroll(-200, 60);
      assert.ok(scrollResUp.action.includes('Scrolled by -200'));
      const duringScrollUp = await safeEvaluate(
        motionVisSession.page,
        () => {
          const ind = document.getElementById('__dsh_vc_scroll_ind__') as HTMLElement | null;
          const up = ind?.querySelector('.up') as HTMLElement | null;
          const down = ind?.querySelector('.down') as HTMLElement | null;
          const pulse = document.getElementById('__dsh_vc_scroll_pulse__');
          return {
            indDisplay: ind ? getComputedStyle(ind).display : 'none',
            upOpacity: up ? Number(getComputedStyle(up).opacity) : -1,
            downOpacity: down ? Number(getComputedStyle(down).opacity) : -1,
            upTransform: up?.style.transform ?? '',
            downTransform: down?.style.transform ?? '',
            upFilter: up?.style.filter ?? '',
            downFilter: down?.style.filter ?? '',
            pulseLines: pulse ? pulse.querySelectorAll('line').length : 0,
          };
        },
        {
          indDisplay: 'none',
          upOpacity: -1,
          downOpacity: -1,
          upTransform: '',
          downTransform: '',
          upFilter: '',
          downFilter: '',
          pulseLines: 0,
        },
        0
      );
      assert.equal(duringScrollUp.indDisplay, 'flex', 'Expected scroll indicator visible during scroll up');
      assert.ok(duringScrollUp.upOpacity > 0.9, `Expected .up highlighted on scroll(-200), got opacity=${duringScrollUp.upOpacity}`);
      assert.ok(duringScrollUp.downOpacity < 0.4, `Expected .down dimmed on scroll(-200), got opacity=${duringScrollUp.downOpacity}`);
      assert.ok(duringScrollUp.upTransform.includes('scale(1.15)'), `Expected .up scale(1.15), got ${duringScrollUp.upTransform}`);
      assert.ok(duringScrollUp.upFilter.includes('drop-shadow('), `Expected .up drop-shadow, got ${duringScrollUp.upFilter}`);
      assert.equal(duringScrollUp.downTransform, 'scale(1)');
      assert.equal(duringScrollUp.downFilter, 'none');
      assert.ok(duringScrollUp.pulseLines >= 3, `Expected vertical scroll pulse lines on scroll up, got ${duringScrollUp.pulseLines}`);

      await motionVisSession.page.waitForTimeout(450);
      const afterScrollRestore = await safeEvaluate(
        motionVisSession.page,
        () => {
          const ind = document.getElementById('__dsh_vc_scroll_ind__') as HTMLElement | null;
          const up = ind?.querySelector('.up') as HTMLElement | null;
          const down = ind?.querySelector('.down') as HTMLElement | null;
          const pulse = document.getElementById('__dsh_vc_scroll_pulse__');
          return {
            indDisplay: ind ? getComputedStyle(ind).display : 'none',
            pulseLines: pulse ? pulse.querySelectorAll('line').length : 0,
            upOpacity: up?.style.opacity ?? '',
            downOpacity: down?.style.opacity ?? '',
            upTransform: up?.style.transform ?? '',
            downTransform: down?.style.transform ?? '',
            upFilter: up?.style.filter ?? '',
            downFilter: down?.style.filter ?? '',
          };
        },
        {
          indDisplay: 'none',
          pulseLines: 0,
          upOpacity: '',
          downOpacity: '',
          upTransform: '',
          downTransform: '',
          upFilter: '',
          downFilter: '',
        },
        0
      );
      assert.equal(afterScrollRestore.indDisplay, 'none', 'Expected scroll indicator hidden after 400ms');
      assert.equal(afterScrollRestore.pulseLines, 0, 'Expected scroll pulse cleared after 400ms');
      assert.equal(afterScrollRestore.upOpacity, '0.28', 'Expected .up opacity reset on hide');
      assert.equal(afterScrollRestore.downOpacity, '0.28', 'Expected .down opacity reset on hide');
      assert.equal(afterScrollRestore.upTransform, 'scale(1)');
      assert.equal(afterScrollRestore.downTransform, 'scale(1)');
      assert.equal(afterScrollRestore.upFilter, 'none');
      assert.equal(afterScrollRestore.downFilter, 'none');

      // Ensure next scroll starts cleanly with the new direction and does not inherit previous highlight
      await motionTools.scroll(300, 60);
      const afterNextScroll = await safeEvaluate(
        motionVisSession.page,
        () => {
          const ind = document.getElementById('__dsh_vc_scroll_ind__') as HTMLElement | null;
          const up = ind?.querySelector('.up') as HTMLElement | null;
          const down = ind?.querySelector('.down') as HTMLElement | null;
          return {
            upOpacity: up ? Number(getComputedStyle(up).opacity) : -1,
            downOpacity: down ? Number(getComputedStyle(down).opacity) : -1,
          };
        },
        { upOpacity: -1, downOpacity: -1 },
        0
      );
      assert.ok(afterNextScroll.downOpacity > 0.9 && afterNextScroll.upOpacity < 0.4, `Expected fresh downward highlight after prior upward scroll, got ${JSON.stringify(afterNextScroll)}`);

      // Subagent runner end-to-end with { type: 'drag' } + A2 mid_frame diagnostics verification
      const dragMidHost = createCordisStrictCtx({ validateSchemas: false });
      let dragSubStep = 0;
      apply(dragMidHost.ctx, {
        mode: 'auto',
        windowMode: 'headless',
        artifactDir,
        customPlanner: async () => {
          dragSubStep++;
          if (dragSubStep === 1) {
            return {
              type: 'drag',
              from: { x: 350, y: 300 },
              to: { x: 700, y: 325 },
              steps: 6,
              reason: 'Test subagent drag action with mid_frame & clean selection',
            };
          }
          return { type: 'complete', report: 'DRAG_SUBAGENT_OK' };
        },
      });
      allDisposers.push(...dragMidHost.effectDisposers);
      const dragSubRunDef = dragMidHost.registeredTools.get('browser_subagent_run')!;
      const subDragVal: any = await dragSubRunDef.execute(
        {
          url: `${srv.url}__layer-fixture.html`,
          role: 'Drag Subagent',
          task_prompt: 'Execute drag decision then complete',
          max_steps: 3,
          window_mode: 'headless',
        },
        fakeExec
      );
      assert.equal(subDragVal.status, 'COMPLETED');
      assert.ok(String(subDragVal.subagent_report ?? '').includes('DRAG_SUBAGENT_OK'));
      assert.ok(subDragVal.diagnostics_path && fs.existsSync(subDragVal.diagnostics_path), 'Expected drag diagnostics.json');
      const dragDiagJson = JSON.parse(fs.readFileSync(subDragVal.diagnostics_path, 'utf8'));
      const dragDiagStep = (dragDiagJson.planner_detail?.llm_steps ?? []).find((s: any) => s.action?.type === 'drag');
      assert.ok(dragDiagStep?.action?.mid_frame, `Expected mid_frame in drag step diagnostics, got ${JSON.stringify(dragDiagStep)}`);
      assert.match(String(dragDiagStep.action.mid_frame), /^step_\d+_drag_mid\.png$/);
      const midFrameDiskPath = path.join(artifactDir, subDragVal.subagent_id, dragDiagStep.action.mid_frame);
      assert.ok(fs.existsSync(midFrameDiskPath) && fs.statSync(midFrameDiskPath).size > 1000, `Expected non-empty mid-drag screenshot at ${midFrameDiskPath}`);
      assert.equal(dragDiagJson.steps?.totalSteps, 2, `mid_frame must not inflate totalSteps (expected 2, got ${dragDiagJson.steps?.totalSteps})`);
    console.log('[Strict DSH 0.2 Contract] 5o Verified drag selection cleanup, *_drag_mid.png, preview drag, subagent drag action & scroll pulse!');
    } finally {
      await motionVisSession.close();
    }

    // 5p. TASK-v1.3.2: domcontentloaded default + settle, non-fatal goto timeout, wait_until/timeout_ms tools params, navigation diagnostics & WebGL canvas HUD notice
    const navHost = createCordisStrictCtx({ validateSchemas: true });
    let navPlannerCalls = 0;
    apply(navHost.ctx, {
      mode: 'auto',
      windowMode: 'headless',
      artifactDir,
      customPlanner: async () => {
        navPlannerCalls++;
        return { type: 'complete', report: `NAV_STEP_${navPlannerCalls}_OK` };
      },
    });
    allDisposers.push(...navHost.effectDisposers);
    const navQuickDef = navHost.registeredTools.get('browser_quick_snapshot')!;
    const navRunDef = navHost.registeredTools.get('browser_subagent_run')!;

    assert.ok((navQuickDef.parameters as any)?.properties?.wait_until, 'Expected wait_until schema parameter on browser_quick_snapshot');
    assert.ok((navQuickDef.parameters as any)?.properties?.timeout_ms, 'Expected timeout_ms schema parameter on browser_quick_snapshot');
    assert.ok((navRunDef.parameters as any)?.properties?.wait_until, 'Expected wait_until schema parameter on browser_subagent_run');
    assert.ok((navRunDef.parameters as any)?.properties?.timeout_ms, 'Expected timeout_ms schema parameter on browser_subagent_run');

    // 1) Default wait_until ('domcontentloaded') returns fast on persistent-stream WebGL canvas fixture with WebGL canvas notice
    const slowUrl = `${srv.url}__slow-stream-fixture.html`;
    const t0Default = Date.now();
    const fastSnap: any = await navQuickDef.execute({ url: slowUrl }, fakeExec);
    const fastElapsed = Date.now() - t0Default;
    assert.ok(fastElapsed < 8000, `Expected default domcontentloaded snapshot < 8000ms on persistent stream, got ${fastElapsed}ms`);
    assert.equal(fastSnap.navigation?.wait_until, 'domcontentloaded');
    assert.equal(fastSnap.navigation?.timed_out, false);
    assert.ok(String(fastSnap.navigation?.final_url ?? '').includes('__slow-stream-fixture.html'));
    assert.ok(fs.existsSync(fastSnap.screenshot_path) && fs.statSync(fastSnap.screenshot_path).size > 1000);
    assert.ok(String(fastSnap.hud_summary).includes('**Navigation**: wait_until=domcontentloaded, timed_out=false'));
    assert.ok(
      String(fastSnap.hud_summary).includes('tech: WebGL canvas — interactive content may live inside <canvas> and is not addressable by #ref'),
      `Expected WebGL canvas notice in HUD, got:\n${fastSnap.hud_summary}`
    );

    // 2) Explicit wait_until='networkidle' + timeout_ms=1500 MUST NOT throw on committed persistent stream; returns screenshot + timed_out=true
    const timedSnap: any = await navQuickDef.execute(
      { url: slowUrl, wait_until: 'networkidle', timeout_ms: 1500 },
      fakeExec
    );
    assert.equal(timedSnap.navigation?.wait_until, 'networkidle');
    assert.equal(timedSnap.navigation?.timed_out, true);
    assert.ok(fs.existsSync(timedSnap.screenshot_path) && fs.statSync(timedSnap.screenshot_path).size > 1000);
    assert.ok(String(timedSnap.hud_summary).includes('timed_out=true'));

    // 3) browser_subagent_run with networkidle + 1500ms timeout completes cleanly and persists navigation.timed_out=true in diagnostics.json
    const slowSubRes: any = await navRunDef.execute(
      {
        url: slowUrl,
        role: 'Stream Surveyor',
        task_prompt: 'Inspect streaming canvas page',
        max_steps: 2,
        wait_until: 'networkidle',
        timeout_ms: 1500,
        window_mode: 'headless',
      },
      fakeExec
    );
    assert.equal(slowSubRes.status, 'COMPLETED');
    assert.equal(slowSubRes.navigation?.wait_until, 'networkidle');
    assert.equal(slowSubRes.navigation?.timed_out, true);
    assert.ok(slowSubRes.diagnostics_path && fs.existsSync(slowSubRes.diagnostics_path));
    const slowSubDiag = JSON.parse(fs.readFileSync(slowSubRes.diagnostics_path, 'utf8'));
    assert.equal(slowSubDiag.navigation?.wait_until, 'networkidle');
    assert.equal(slowSubDiag.navigation?.timed_out, true);
    assert.ok(Number.isFinite(slowSubDiag.navigation?.elapsed_ms));

    // 4) Non-canvas fixture with default wait_until records timed_out=false and omits WebGL canvas notice
    const hudSubRes: any = await navRunDef.execute(
      {
        url: `${srv.url}__layer-iframe.html`,
        role: 'HUD Check',
        task_prompt: 'Verify normal non-canvas navigation diagnostics',
        max_steps: 2,
        window_mode: 'headless',
      },
      fakeExec
    );
    assert.equal(hudSubRes.status, 'COMPLETED');
    assert.equal(hudSubRes.navigation?.wait_until, 'domcontentloaded');
    assert.equal(hudSubRes.navigation?.timed_out, false);
    const hudSubDiag = JSON.parse(fs.readFileSync(hudSubRes.diagnostics_path, 'utf8'));
    assert.equal(hudSubDiag.navigation?.wait_until, 'domcontentloaded');
    assert.equal(hudSubDiag.navigation?.timed_out, false);
    const hudCheckSnap: any = await navQuickDef.execute({ url: `${srv.url}__layer-iframe.html` }, fakeExec);
    assert.ok(!String(hudCheckSnap.hud_summary).includes('WebGL canvas'), 'Non-canvas page must not emit WebGL canvas notice');
    console.log('[Strict DSH 0.2 Contract] 5p Verified non-fatal goto timeout, domcontentloaded default + settle, navigation diagnostics & WebGL canvas HUD notice!');

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
