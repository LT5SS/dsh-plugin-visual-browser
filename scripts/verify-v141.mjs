#!/usr/bin/env node
/**
 * verify-v141.mjs — Automated verification for TASK-v1.4.1:
 *   1. normSplit unit tests (split-char, normal w/ double letters, marquee repeat fold, CJK+EN mixed)
 *   2. Geometric headings reconstruction (horizontal-gap + stacked two-line -> "CREATIVE DEVELOPER")
 *   3. headings: n/a 3 reason codes (无 h1-h3 / 被裁切 / 可能在 canvas 内)
 *   4. Zero-controls neutral HUD explanation
 *   5. ScrollDiagnostic.driver ('wheel' vs 'programmatic' Lenis interception)
 *   6. inspectMotion probe (hover transform card vs static button + subagent inspect_motion loop)
 *   7. INVALID_JSON_DECISION retry + fallback text_preview
 *   8. --live checks on https://wodniack.dev/, https://example.com/, and https://unseen.co/
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BrowserSession } from '../dist/driver/browser-session.js';
import { normSplit, safeEvaluate } from '../dist/sampler/page-snapshot.js';
import { AtomicBrowserToolset } from '../dist/tools/atomic-tools.js';
import { BrowserSubagentRunner, createDshHostLlmPlanner } from '../dist/subagent/runner.js';

// 1. Unit tests for normSplit (4 required cases)
assert.equal(normSplit('C R E A T I V E'), 'CREATIVE', 'Split-char single word');
assert.equal(
  normSplit('I collaborate with agencies and designers to craft websites'),
  'I collaborate with agencies and designers to craft websites',
  'Normal English sentence with double-letter words like collaborate must remain intact'
);
assert.equal(
  normSplit('I collaborate with agencies. W W W W W O O O O O O O R R R R R R R K K K K K K K'),
  'I collaborate with agencies. WORK',
  'Repeated single-letter marquee folded while collaborate stays intact'
);
assert.equal(
  normSplit('前端开发 C R E A T I V E 作品 collaborate 展示 W W W O O O R R R K K K'),
  '前端开发 CREATIVE 作品 collaborate 展示 WORK',
  'CJK + English mixed text preserves normal words and collapses split runs'
);
console.log('[v1.4.1] 1/7 normSplit 4-case unit tests passed!');

function startV141FixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const cleanUrl = (req.url || '/').split('?')[0];
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

      if (cleanUrl === '/wodniack-sim') {
        res.end(`<!doctype html>
<html lang="en" class="lenis">
<head>
  <meta charset="utf-8">
  <title>Wodniack Simulation — v1.4.1</title>
  <style>
    html, body { margin: 0; background: #f40c3f; color: #160000; font-family: Georgia, serif; }
    header { position: fixed; top: 0; left: 0; right: 0; padding: 14px 24px; transition: transform 0.2s ease; }
    header.is-hidden { transform: translateY(-90px); }
    h1 { text-transform: uppercase; margin: 90px 24px 24px; font-size: 64px; }
    h1 span { display: inline-block; width: 32px; height: 64px; }
    section { min-height: 900px; padding: 24px; border-top: 1px solid #160000; }
    .work-card { width: 220px; height: 70px; background: #160000; color: #fff0eb; display: flex; align-items: center; justify-content: center; transition: transform 0.22s ease; }
    .work-card:hover { transform: translateX(18px) scale(1.04); }
  </style>
</head>
<body>
  <header id="hdr"><a id="nav-work" href="#s2">Work</a></header>
  <main>
    <section id="s1">
      <h1>
        <span>C</span><span>r</span><span>e</span><span>a</span><span>t</span><span>i</span><span>v</span><span>e</span>
        <span style="margin-left:28px;">D</span><span>e</span><span>v</span><span>e</span><span>l</span><span>o</span><span>p</span><span>e</span><span>r</span>
      </h1>
      <p>I collaborate with agencies and designers. <span>W</span> <span>W</span> <span>W</span> <span>O</span> <span>O</span> <span>O</span> <span>R</span> <span>R</span> <span>R</span> <span>K</span> <span>K</span> <span>K</span></p>
      <div id="hover-card" class="work-card" role="button">Project Card</div>
      <button id="static-btn" style="margin-top:16px;padding:8px 14px;">Static Button</button>
    </section>
    <section id="s2"><p>Second section content without viewport controls when header hides.</p></section>
  </main>
  <script>
    window.lenis = true;
    window.scrollBy = () => {};
    window.addEventListener('scroll', () => {
      document.getElementById('hdr').classList.toggle('is-hidden', window.scrollY > 120);
    }, { passive: true });
  </script>
</body>
</html>`);
        return;
      }

      if (cleanUrl === '/stacked-h1') {
        res.end(`<!doctype html>
<html><head><meta charset="utf-8"><style>
  h1 { text-transform: uppercase; width: 220px; margin: 24px; }
  h1 span { display: inline-block; width: 24px; height: 32px; }
</style></head>
<body>
  <h1>
    <span>C</span><span>r</span><span>e</span><span>a</span><span>t</span><span>i</span><span>v</span><span>e</span>
    <br>
    <span>D</span><span>e</span><span>v</span><span>e</span><span>l</span><span>o</span><span>p</span><span>e</span><span>r</span>
  </h1>
</body></html>`);
        return;
      }

      if (cleanUrl === '/clipped-h1') {
        res.end(`<!doctype html>
<html><body style="margin:0;height:800px;">
  <div style="width:120px;height:40px;overflow:hidden;position:relative;">
    <h1 style="position:absolute;left:360px;top:0;">Hidden Heading</h1>
  </div>
</body></html>`);
        return;
      }

      if (cleanUrl === '/canvas-only') {
        res.end(`<!doctype html>
<html><body style="margin:0;overflow:hidden;height:100vh;">
  <canvas width="1440" height="900" style="width:100vw;height:100vh;display:block;"></canvas>
</body></html>`);
        return;
      }

      if (cleanUrl === '/example-copy') {
        res.end(`<!doctype html>
<html><head><meta charset="utf-8"><title>Example Domain</title></head>
<body><div><h1>Example Domain</h1><p>This domain is for use in illustrative examples in documents.</p><a href="https://iana.org/domains/example">More information...</a></div></body></html>`);
        return;
      }

      // /blank
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

const srv = await startV141FixtureServer();
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v141-verify-'));
const session = new BrowserSession({
  mode: 'auto',
  windowMode: 'headless',
  backgroundSilent: true,
});
const runner = new BrowserSubagentRunner();

try {
  await session.start();
  await session.page.setViewportSize({ width: 1280, height: 800 });
  const tools = new AtomicBrowserToolset(session, outDir);

  // 2. Geometric split-char h1 (horizontal-gap single line + stacked two-line)
  const simNav = await tools.navigate(`${srv.url}/wodniack-sim`, 120);
  assert.equal(simNav.observation.design?.headings[0]?.text, 'CREATIVE DEVELOPER');
  assert.ok(simNav.observation.design?.bodyText?.includes('collaborate'), 'collaborate must remain intact');
  assert.ok(simNav.observation.design?.bodyText?.includes('WORK'), 'marquee must fold to WORK');

  const stackedNav = await tools.navigate(`${srv.url}/stacked-h1`, 80);
  assert.equal(stackedNav.observation.design?.headings[0]?.text, 'CREATIVE DEVELOPER');
  console.log('[v1.4.1] 2/7 Geometric split-char headings (single-line gap & stacked) passed!');

  // 3. headings: n/a 3 reason codes
  const blankNav = await tools.navigate(`${srv.url}/blank`, 80);
  assert.ok(blankNav.llmSummary.includes('headings: n/a（视口内无 h1-h3）'));

  const clippedNav = await tools.navigate(`${srv.url}/clipped-h1`, 80);
  assert.ok(clippedNav.llmSummary.includes('headings: n/a（标题被裁切）'));

  const canvasNav = await tools.navigate(`${srv.url}/canvas-only`, 80);
  assert.ok(canvasNav.llmSummary.includes('headings: n/a（标题可能在 <canvas> 内）'));
  console.log('[v1.4.1] 3/7 headings: n/a 3 reason codes passed!');

  // 4. Scroll driver ('programmatic' blocked by Lenis vs 'wheel' works) + 0-controls neutral explanation
  await tools.navigate(`${srv.url}/wodniack-sim`, 120);
  const progScroll = await tools.scroll(500, 120, { driver: 'programmatic' });
  assert.equal(progScroll.scroll?.driver, 'programmatic');
  assert.equal(progScroll.scroll?.effective_dom_delta, 0);
  assert.ok(progScroll.llmSummary.includes('driver=programmatic'));
  assert.ok(progScroll.llmSummary.includes('拦截程序化滚动'));

  const wheelScroll = await tools.scroll(500, 180);
  assert.equal(wheelScroll.scroll?.driver, 'wheel');
  assert.ok((wheelScroll.scroll?.effective_dom_delta ?? 0) > 100);
  assert.equal(wheelScroll.observation.interactiveElements.length, 0);
  assert.ok(
    wheelScroll.llmSummary.includes('Visible Interactive Controls: 0 个（滚动后站点可能隐藏了固定导航；不代表页面没有控件）')
  );
  console.log('[v1.4.1] 4/7 Scroll driver diagnosis & 0-controls neutral explanation passed!');

  // 5. inspectMotion probe (hover card vs static button)
  await tools.navigate(`${srv.url}/wodniack-sim`, 120);
  const hoverProbe = await tools.inspectMotion('#hover-card');
  assert.ok(hoverProbe.motion?.ok);
  assert.ok(hoverProbe.motion?.changed.includes('transform'), `Expected transform change, got ${JSON.stringify(hoverProbe.motion)}`);
  assert.ok((hoverProbe.motion?.triggers.length ?? 0) > 0);
  assert.ok(hoverProbe.llmSummary.includes('Motion Probe'));

  const staticProbe = await tools.inspectMotion('#static-btn');
  assert.ok(staticProbe.motion?.ok);
  assert.deepEqual(staticProbe.motion?.changed, []);
  console.log('[v1.4.1] 5/7 inspectMotion probe passed (hover changed=[transform], static changed=[])!');

  // 6. Example.com non-regression check
  const exNav = await tools.navigate(`${srv.url}/example-copy`, 80);
  assert.equal(exNav.observation.design?.headings[0]?.text, 'Example Domain');
  assert.ok(exNav.observation.design?.bodyText?.includes('This domain is for use in illustrative examples in documents.'));
  console.log('[v1.4.1] 6/7 Example copy non-regression passed!');

  // 7. Subagent inspect_motion + INVALID_JSON_DECISION retry + fallback text_preview
  const retryDiags = [];
  let retryAttempt = 0;
  const retryPlanner = createDshHostLlmPlanner({
    llm: {
      async *stream(params) {
        retryAttempt++;
        if (retryAttempt === 1) {
          yield { type: 'text-delta', delta: '好的，接下来先用 inspect_motion 探测项目卡的动效：' };
        } else if (retryAttempt === 2) {
          assert.equal(params?.temperature, 0, 'Retry attempt must lower temperature to 0');
          yield { type: 'text-delta', delta: JSON.stringify({ type: 'inspect_motion', target: '#hover-card', reason: 'Probe hover transform' }) };
        } else {
          yield { type: 'text-delta', delta: JSON.stringify({ type: 'complete', report: 'SUBAGENT_V141_OK' }) };
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    provider: 'mock',
    model: 'mock',
    onStepDiagnostic: (d) => retryDiags.push(d),
  });

  const subRes = await runner.runTask({
    subagentId: 'v141-retry-sub',
    role: 'v1.4.1 Verifier',
    taskPrompt: 'Inspect hover motion on #hover-card',
    startUrl: `${srv.url}/wodniack-sim`,
    artifactDir: outDir,
    maxSteps: 4,
    sessionOptions: { mode: 'auto', windowMode: 'headless', backgroundSilent: true },
    planner: retryPlanner,
  });
  assert.equal(subRes.status, 'COMPLETED');
  assert.equal(retryDiags[0]?.retried_json_schema, true);
  assert.equal(retryDiags[0]?.decision_source, 'llm');
  assert.equal(retryDiags[0]?.fallback_reason, undefined);
  assert.equal(retryDiags[0]?.action?.type, 'inspect_motion');

  const failDiags = [];
  const failPlanner = createDshHostLlmPlanner({
    llm: {
      async *stream() {
        yield { type: 'text-delta', delta: 'NON_JSON_PROSE_DEBUG_PREVIEW_XYZ' };
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
    provider: 'mock',
    model: 'mock',
    onStepDiagnostic: (d) => failDiags.push(d),
  });
  await runner.runTask({
    subagentId: 'v141-fail-sub',
    role: 'v1.4.1 Fallback Verifier',
    taskPrompt: 'Verify fallback text_preview',
    startUrl: `${srv.url}/blank`,
    artifactDir: outDir,
    maxSteps: 1,
    sessionOptions: { mode: 'auto', windowMode: 'headless', backgroundSilent: true },
    planner: failPlanner,
  });
  assert.equal(failDiags[0]?.fallback_reason, 'INVALID_JSON_DECISION');
  assert.ok(String(failDiags[0]?.text_preview ?? '').includes('NON_JSON_PROSE_DEBUG_PREVIEW_XYZ'));
  console.log('[v1.4.1] 7/7 INVALID_JSON_DECISION retry & fallback preview passed!');

  // 8. Optional --live verification on real wodniack.dev, example.com, and unseen.co
  if (process.argv.includes('--live')) {
    await session.page.setViewportSize({ width: 1440, height: 900 });

    // 8a. wodniack.dev
    const wodInit = await tools.navigate('https://wodniack.dev/', 1500);
    // Wait for wodniack.dev's opening preloader scroll lock (html.is-scroll-blocked) to clear
    await session.page
      .waitForFunction(() => !document.documentElement.classList.contains('is-scroll-blocked'), { timeout: 12000 })
      .catch(() => {});
    await session.page.waitForTimeout(300);
    const wodReady = await tools.sampler.captureSnapshot('wod_ready');
    const wodHeadings = wodReady.design?.headings?.length
      ? wodReady.design.headings
      : (wodInit.observation.design?.headings ?? []);
    assert.ok(
      wodHeadings.some((h) => h.text.includes('CREATIVE DEVELOPER')),
      `wodniack.dev expected heading "CREATIVE DEVELOPER", got ${JSON.stringify(wodHeadings)}`
    );

    // Probe motion on the first visible interactive element before scrolling
    const firstBtnSel = wodReady.interactiveElements[0]?.ref ?? 'a';
    const wodMotion = await tools.inspectMotion(firstBtnSel);
    console.log('[Live wodniack.dev] inspectMotion:', JSON.stringify({
      target: wodMotion.motion?.target,
      ok: wodMotion.motion?.ok,
      changed: wodMotion.motion?.changed,
      animations: wodMotion.motion?.animations,
      triggers: wodMotion.motion?.triggers,
    }));
    assert.ok(wodMotion.motion?.ok);

    const wodProg = await tools.scroll(800, 200, { driver: 'programmatic' });
    assert.equal(wodProg.scroll?.driver, 'programmatic');

    const wodWheel1 = await tools.scroll(800, 350);
    assert.equal(wodWheel1.scroll?.driver, 'wheel');
    assert.ok((wodWheel1.scroll?.effective_dom_delta ?? 0) > 0, `wodniack.dev wheel scroll expected positive delta, got ${JSON.stringify(wodWheel1.scroll)}`);

    const wodWheel2 = await tools.scroll(800, 350);
    const wodBody2 = wodWheel2.observation.design?.bodyText ?? '';
    console.log('[Live wodniack.dev] headings:', JSON.stringify(wodHeadings));
    console.log('[Live wodniack.dev] scroll_prog:', JSON.stringify(wodProg.scroll));
    console.log('[Live wodniack.dev] scroll1:', JSON.stringify(wodWheel1.scroll));
    console.log('[Live wodniack.dev] scroll2 controls:', wodWheel2.observation.interactiveElements.length, 'bodyText:', wodBody2);
    assert.ok(!wodBody2.includes('colaborate'), 'collaborate must NOT be corrupted to colaborate');

    // 8b. example.com (modern IANA page has no <h1>, localized + English <p>; verify non-corruption)
    const exLive = await tools.navigate('https://example.com/', 600);
    assert.equal(exLive.observation.design?.title, 'Example Domain');
    assert.ok(
      exLive.observation.design?.headings[0]?.text === 'Example Domain' ||
        exLive.llmSummary.includes('headings: n/a（视口内无 h1-h3）'),
      `Unexpected example.com headings summary: ${exLive.llmSummary}`
    );
    assert.ok(
      exLive.observation.design?.bodyText?.includes('This domain is for use in documentation examples without needing permission') ||
        exLive.observation.design?.bodyText?.includes('This domain is for use in illustrative examples'),
      `Unexpected example.com bodyText: ${exLive.observation.design?.bodyText}`
    );
    console.log('[Live example.com] title, headings reason/text & CJK+EN bodyText verified intact!');

    // 8c. unseen.co
    const unseenLive = await tools.navigate('https://unseen.co/', 1200);
    assert.ok(unseenLive.llmSummary.includes('主体可能在 <canvas> 内'));
    assert.ok(unseenLive.llmSummary.includes('被 <canvas> 覆盖 → 实际视觉配色请以截图为依据'));
    console.log('[Live unseen.co] canvas bodyText & palette guard verified!');
  }

  console.log('✅ verify-v141 passed!');
} finally {
  await runner.closeAllSessions().catch(() => {});
  await session.close().catch(() => {});
  await srv.close();
  fs.rmSync(outDir, { recursive: true, force: true });
}
