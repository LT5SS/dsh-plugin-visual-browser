import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BrowserSession } from '../dist/driver/browser-session.js';
import { MAX_DESIGN_BLOCK_CHARS } from '../dist/sampler/page-snapshot.js';
import { decodePngRgba, extractVisualPaletteFromPng } from '../dist/sampler/png-pixels.js';
import { AtomicBrowserToolset } from '../dist/tools/atomic-tools.js';
import {
  BrowserSubagentRunner,
  classifyJsonDecision,
  createDshHostLlmPlanner,
} from '../dist/subagent/runner.js';

function startV142FixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const cleanUrl = (req.url || '/').split('?')[0];
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

      if (cleanUrl === '/canvas-interactive') {
        res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><style>
  html, body { margin: 0; height: 2200px; background: #ffffff; font-family: sans-serif; }
  canvas#gl { position: fixed; inset: 0; width: 100vw; height: 100vh; display: block; z-index: 1; }
  .row { position: relative; z-index: 2; width: 260px; height: 48px; margin: 20px; background: #0a0a0a; color: #f7f2ec; border: 0; }
  .row:hover { background: #e8352f; color: #ffffff; }
  .sr-clip { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0px, 0px, 0px, 0px); }
</style></head>
<body>
  <canvas id="gl" width="1280" height="800"></canvas>
  <button class="row" id="row-btn">Featured Project</button>
  <button style="display:none">HiddenBtn</button>
  <button style="width:0;height:0;padding:0;border:0;">ZeroBtn</button>
  <a href="#clipped" class="sr-clip">SrOnly</a>
  <a href="#offscreen" style="position:absolute;top:1800px;left:24px;">BelowFold</a>
  <script>
    const cv = document.getElementById('gl');
    const ctx2 = cv.getContext('2d');
    function paint(mx, my) {
      ctx2.fillStyle = '#f7f2ec';
      ctx2.fillRect(0, 0, cv.width, cv.height);
      ctx2.fillStyle = '#e8352f';
      ctx2.fillRect(180, 120, 480, 340);
      if (mx >= 0 && my >= 0) {
        ctx2.fillStyle = '#1188ff';
        ctx2.fillRect(mx - 60, my - 60, 120, 120);
      }
    }
    paint(-1, -1);
    cv.addEventListener('mousemove', (e) => paint(e.clientX, e.clientY));
  </script>
</body></html>`);
        return;
      }

      if (cleanUrl === '/example-copy') {
        res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Example Domain</title></head>
<body><div><h1>Example Domain</h1><p>This domain is for use in documentation examples without needing permission.</p><a href="https://iana.org/domains/example">More information...</a></div></body></html>`);
        return;
      }

      res.end('<!doctype html><html><head><meta charset="utf-8"><title>Blank</title></head><body></body></html>');
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const srv = await startV142FixtureServer();
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v142-verify-'));
const session = new BrowserSession({
  mode: 'auto',
  windowMode: 'headless',
  backgroundSilent: true,
});
const runner = new BrowserSubagentRunner();

try {
  // 1. Unit tests for classifyJsonDecision
  assert.equal(
    classifyJsonDecision('{"type":"complete","report":"css .hero { color: #f40c3f; } ' + 'X'.repeat(80)).reason,
    'TRUNCATED_JSON'
  );
  assert.equal(classifyJsonDecision('```json\n{"type":"complete","report":"cut').reason, 'TRUNCATED_JSON');
  assert.equal(classifyJsonDecision('Plain text reply').reason, 'NOT_JSON');
  assert.equal(classifyJsonDecision('{"type":"click"}').reason, 'SCHEMA_MISMATCH');
  const flatMotion = classifyJsonDecision('{"type":"inspect_motion","x":640,"y":380,"reason":"Canvas"}');
  assert.equal(flatMotion.decision?.type, 'inspect_motion');
  assert.deepEqual(flatMotion.decision?.target, { x: 640, y: 380 });
  console.log('[v1.4.2] 1/6 classifyJsonDecision unit tests passed!');

  await session.start();
  await session.page.setViewportSize({ width: 1280, height: 800 });
  const tools = new AtomicBrowserToolset(session, outDir);

  // 2. Coordinate inspect_motion({ x, y }) on canvas vs .row vs blank
  const canvasNav = await tools.navigate(`${srv.url}/canvas-interactive`, 120);
  const canvasMotion = await tools.inspectMotion({ x: 640, y: 380 });
  assert.ok(canvasMotion.motion?.ok);
  assert.equal(canvasMotion.motion?.topElement, 'CANVAS#gl');
  assert.equal(canvasMotion.motion?.pixelChanged, true);
  assert.ok((canvasMotion.motion?.pixelDiffMean ?? 0) > 10);
  assert.deepEqual(canvasMotion.motion?.cssChanged, []);
  assert.ok(canvasMotion.llmSummary.includes('topElement=CANVAS#gl'));
  assert.ok(canvasMotion.llmSummary.includes('pixelChanged=true'));

  const rowBox = await session.page.locator('#row-btn').boundingBox();
  assert.ok(rowBox);
  const rowMotion = await tools.inspectMotion({
    x: Math.round(rowBox.x + rowBox.width / 2),
    y: Math.round(rowBox.y + rowBox.height / 2),
  });
  assert.ok(rowMotion.motion?.ok);
  assert.ok(rowMotion.motion?.cssChanged?.includes('backgroundColor'));
  assert.ok(rowMotion.motion?.cssChanged?.includes('color'));

  console.log('[v1.4.2] 2/6 inspectMotion({ x, y }) on canvas & .row passed!');

  // 3 & 4. Controls filtered stats & screenshot visualPalette
  assert.equal(canvasNav.observation.design?.canvasCoversViewport, true);
  assert.ok((canvasNav.observation.design?.visualPalette?.length ?? 0) >= 2);
  assert.ok(canvasNav.llmSummary.includes('- visualPalette: #'));
  assert.ok(canvasNav.llmSummary.includes('Controls filtered: hidden=1 · zero-size=1 · clipped=1 · offscreen=1'));
  const designPart = canvasNav.llmSummary.slice(canvasNav.llmSummary.indexOf('## Design'));
  assert.ok(designPart.length <= MAX_DESIGN_BLOCK_CHARS);

  const decodedPng = decodePngRgba(fs.readFileSync(canvasNav.observation.screenshotPath));
  assert.ok(decodedPng && decodedPng.width === 1280 && decodedPng.height === 800);
  assert.ok(extractVisualPaletteFromPng(fs.readFileSync(canvasNav.observation.screenshotPath)).length >= 2);

  const exCopy = await tools.navigate(`${srv.url}/example-copy`, 80);
  assert.ok(!exCopy.llmSummary.includes('visualPalette:'));
  assert.ok(!exCopy.llmSummary.includes('Controls filtered:'));
  const blankMotion = await tools.inspectMotion({ x: 1180, y: 740 });
  assert.ok(blankMotion.motion?.ok);
  assert.equal(blankMotion.motion?.pixelChanged, false);
  console.log('[v1.4.2] 3/6 & 4/6 Controls filtered, visualPalette & blank-area pixelChanged=false passed!');

  // 5. Subagent E2E: >2000-char TRUNCATED_JSON retry succeeds with temperature=0 & <= 600 hint
  const retryDiags = [];
  let retryCalls = 0;
  const truncRetryPlanner = createDshHostLlmPlanner({
    llm: {
      async *stream(params) {
        retryCalls++;
        if (retryCalls === 1) {
          yield { type: 'text-delta', delta: '{"type":"complete","report":"' + 'R'.repeat(2100) };
          yield { type: 'usage', input_tokens: 100, output_tokens: 512, total_tokens: 612 };
          yield { type: 'finish', reason: { kind: 'length' } };
          return;
        }
        assert.equal(params?.temperature, 0);
        yield { type: 'text-delta', delta: JSON.stringify({ type: 'complete', report: 'TRUNCATED_RECOVERED_OK' }) };
        yield { type: 'usage', input_tokens: 120, output_tokens: 38, total_tokens: 158 };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    provider: 'mock',
    model: 'mock',
    maxTokens: 512,
    onStepDiagnostic: (d) => retryDiags.push(d),
  });
  const retryRes = await runner.runTask({
    subagentId: 'v142-trunc-retry',
    role: 'v1.4.2 Trunc Retry',
    taskPrompt: 'Verify truncated JSON recovery',
    startUrl: `${srv.url}/example-copy`,
    artifactDir: outDir,
    maxSteps: 2,
    sessionOptions: { mode: 'auto', windowMode: 'headless', backgroundSilent: true },
    planner: truncRetryPlanner,
  });
  assert.equal(retryRes.status, 'COMPLETED');
  assert.deepEqual(retryDiags[0]?.decision_parse, {
    ok: true,
    retried: true,
    initial_reason: 'TRUNCATED_JSON',
  });
  assert.equal(retryDiags[0]?.max_tokens, 512);
  assert.equal(retryDiags[0]?.usage?.output_tokens, 38);
  console.log('[v1.4.2] 5/6 TRUNCATED_JSON retry recovery passed!');

  // 6. Persistent TRUNCATED_JSON fallback sets reason='TRUNCATED_JSON' + decision_parse.ok=false + usage est
  const persistDiags = [];
  const truncFailPlanner = createDshHostLlmPlanner({
    llm: {
      async *stream() {
        yield { type: 'text-delta', delta: '{"type":"complete","report":"' + 'Z'.repeat(2100) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    provider: 'mock',
    model: 'mock',
    onStepDiagnostic: (d) => persistDiags.push(d),
  });
  await runner.runTask({
    subagentId: 'v142-trunc-fail',
    role: 'v1.4.2 Trunc Fallback',
    taskPrompt: 'Verify persistent truncated fallback',
    startUrl: `${srv.url}/example-copy`,
    artifactDir: outDir,
    maxSteps: 1,
    sessionOptions: { mode: 'auto', windowMode: 'headless', backgroundSilent: true },
    planner: truncFailPlanner,
  });
  assert.equal(persistDiags[0]?.fallback_reason, 'TRUNCATED_JSON');
  assert.equal(persistDiags[0]?.decision_parse?.ok, false);
  assert.equal(persistDiags[0]?.decision_parse?.reason, 'TRUNCATED_JSON');
  assert.ok((persistDiags[0]?.usage?.output_tokens_est ?? 0) > 400);
  console.log('[v1.4.2] 6/6 Persistent TRUNCATED_JSON fallback diagnostics passed!');

  // 7. Optional --live verification on wodniack.dev, unseen.co, and example.com
  if (process.argv.includes('--live')) {
    await session.page.setViewportSize({ width: 1440, height: 900 });

    // 7a. wodniack.dev
    await tools.navigate('https://wodniack.dev/', 1500);
    await session.page
      .waitForFunction(() => !document.documentElement.classList.contains('is-scroll-blocked'), { timeout: 12000 })
      .catch(() => {});
    await session.page.waitForTimeout(300);
    const wodReady = await tools.sampler.captureSnapshot('wod_live_ready');
    const wodPalette = wodReady.design?.visualPalette ?? [];
    console.log('[Live wodniack.dev] visualPalette:', JSON.stringify(wodPalette));
    assert.ok(wodPalette.length >= 2, `Expected wodniack.dev visualPalette >= 2 colors, got ${JSON.stringify(wodPalette)}`);
    for (const hex of wodPalette) {
      assert.match(hex, /^#[0-9a-f]{6}$/);
    }

    const wodCanvasMotion = await tools.inspectMotion({ x: 640, y: 380 });
    console.log('[Live wodniack.dev] inspectMotion({x:640,y:380}):', JSON.stringify({
      topElement: wodCanvasMotion.motion?.topElement,
      pixelChanged: wodCanvasMotion.motion?.pixelChanged,
      pixelDiffMean: wodCanvasMotion.motion?.pixelDiffMean,
      cssChanged: wodCanvasMotion.motion?.cssChanged,
    }));
    assert.ok(wodCanvasMotion.motion?.ok);
    assert.equal(typeof wodCanvasMotion.motion?.pixelChanged, 'boolean');

    const wodScroll = await tools.scroll(800, 350);
    console.log('[Live wodniack.dev] controlsFilterStats after scroll:', JSON.stringify(wodScroll.observation.controlsFilterStats));
    assert.ok(wodScroll.llmSummary.includes('Controls filtered:'));
    const cfWod = wodScroll.observation.controlsFilterStats;
    assert.ok((cfWod?.offscreen ?? 0) > 0 || (cfWod?.hidden ?? 0) > 0);

    // 7b. unseen.co
    const unseenLive = await tools.navigate('https://unseen.co/', 1200);
    console.log('[Live unseen.co] controlsFilterStats:', JSON.stringify(unseenLive.observation.controlsFilterStats), 'visualPalette:', JSON.stringify(unseenLive.observation.design?.visualPalette));
    assert.ok(unseenLive.llmSummary.includes('Controls filtered:'));
    const cfUnseen = unseenLive.observation.controlsFilterStats;
    assert.ok((cfUnseen?.hidden ?? 0) > 0 || (cfUnseen?.offscreen ?? 0) > 0);

    // 7c. example.com
    const exLive = await tools.navigate('https://example.com/', 600);
    assert.ok(!exLive.llmSummary.includes('visualPalette:'));
    assert.ok(!exLive.llmSummary.includes('Controls filtered:'));
    console.log('[Live example.com] omitted visualPalette & Controls filtered cleanly!');
  }

  console.log('✅ verify-v142 passed!');
} finally {
  await runner.closeAllSessions().catch(() => {});
  await session.close().catch(() => {});
  await srv.close();
  fs.rmSync(outDir, { recursive: true, force: true });
}
