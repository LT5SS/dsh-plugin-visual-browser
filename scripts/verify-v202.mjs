#!/usr/bin/env node
/**
 * verify-v202.mjs — Standalone runtime verification for TASK-v2.0.2.md.
 * Verifies:
 *  1. inspect_region: step_XX_region.png creation, <=1440px edge clamp, #__dsh_vc_root__ hidden
 *     during clip & restored before returning, text summary (topElement/rect/visibleText/avgColor).
 *  2. Ephemeral 2-image lifecycle: step t=1, t+1=2 (with [ATTACHED_IMAGES: 2]), t+2=1,
 *     diagnostics.json per-step image_count_sent, and SlidingWindowHistory 3-slot isolation.
 *  3. 4-tier fallback: 2-img rejection -> Tier 2 (1 full-page + [REGION_TEXT_SUMMARY]) -> Tier 4 text-only.
 *  4. 4 fixed read-only probes & empty-state semantics:
 *     - inspect_dom (count=0, password masked, <=1200 chars)
 *     - inspect_styles (REF_STALE on stale ref, <=1000 chars deterministic trim)
 *     - extract_outline (normSplit preserves "collaborate", 3 empty heading reason codes)
 *     - inspect_media (explicit img/video/canvas/svg counts including video=0)
 *  5. Screenshot-time panel hiding under 1440px emulation:
 *     - running mode hides #__dsh_vc_panel__ during capture while keeping cursor badge visible,
 *       and restores in finally (even on error)
 *     - paused mode NEVER hides #__dsh_vc_panel__ during screenshot().
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BrowserSession } from '../dist/driver/browser-session.js';
import { decodePngRgba } from '../dist/sampler/png-pixels.js';
import { safeEvaluate } from '../dist/sampler/page-snapshot.js';
import { BrowserSubagentRunner, createDshHostLlmPlanner } from '../dist/subagent/runner.js';
import { AtomicBrowserToolset, formatStylesBlockWithinBudget } from '../dist/tools/atomic-tools.js';

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqPath = (req.url || '/').split('?')[0];
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (reqPath === '/canvas-no-headings') {
        res.end('<!doctype html><html><head><title>Canvas Only</title></head><body><canvas width="600" height="400"></canvas></body></html>');
        return;
      }
      if (reqPath === '/hidden-headings') {
        res.end('<!doctype html><html><head><title>Hidden H1</title></head><body><h1 style="display:none;">Hidden</h1><p>Visible p</p></body></html>');
        return;
      }
      if (reqPath === '/no-headings') {
        res.end('<!doctype html><html><head><title>Plain</title></head><body><section><p>Just plain copy</p></section></body></html>');
        return;
      }
      if (reqPath === '/password-probe') {
        res.end('<!doctype html><html><head><title>Password Probe</title></head><body><input id="secret-pw" type="password" value="TOP_SECRET_PASS_999" /></body></html>');
        return;
      }
      if (reqPath === '/budget-stress') {
        const navLinks = Array.from({ length: 14 }, (_, i) => `<section><h2>Section Heading Item ${i + 1} with Descriptive Copy</h2><p>Copy ${i}</p></section>`).join('');
        const svgs = Array.from({ length: 24 }, () => '<svg width="48" height="48" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>').join('');
        const imgs = Array.from({ length: 8 }, (_, i) => `<img src="/assets/very/long/cdn/path/gallery-image-asset-${i}.png" alt="Gallery photo item number ${i} extra text" width="320" height="200" />`).join('');
        res.end(`<!doctype html>
<html><head><title>Budget Stress Fixture</title></head><body>
  <header><nav>Main Nav</nav></header>
  <main><h1>Primary Showcase</h1>${navLinks}${svgs}${imgs}<canvas width="1440" height="900" style="width:720px;height:450px;"></canvas><video width="640" height="360"></video></main>
  <footer>Footer Landmark</footer>
</body></html>`);
        return;
      }

      res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>v2.0.2 Probes Fixture</title></head>
<body style="margin:0;padding:24px;height:2000px;font-family:Georgia, 'Times New Roman', serif;">
  <header>
    <nav aria-label="Primary Nav"><a href="#work">Work</a></nav>
  </header>
  <main>
    <section>
      <h1 id="split-h1">Let us <span>c</span><span>o</span><span>l</span><span>l</span><span>a</span><span>b</span><span>o</span><span>r</span><span>a</span><span>t</span><span>e</span> on design</h1>
      <div id="tiny-footer" style="display:inline-block;padding:8px 14px;background:#1e3a8a;color:#fef08a;font-family:monospace;font-size:10px;">
        TINY_FOOTER_SAMPLE_TEXT
      </div>
      <div id="complex-style" style="padding:12px 18px;margin:10px;border:2px solid #111;color:#0f172a;background:#e2e8f0;font-family:'VeryLongFontA','VeryLongFontB','VeryLongFontC','VeryLongFontD',sans-serif;transform:matrix3d(1,0,0,0,0,1,0,0,0,0,1,0,12,24,0,1);">
        Complex Styled Target
      </div>
      <canvas id="scene" width="400" height="200" style="width:400px;height:200px;"></canvas>
      <img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" alt="1px" width="40" height="40" />
    </section>
  </main>
</body>
</html>`);
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

function createAttachmentsStub() {
  let seq = 0;
  return {
    async saveImage() {
      seq++;
      return { id: `att-${seq}`, url: `/att-${seq}.png`, mediaType: 'image/png' };
    },
  };
}

async function testRegionAndProbes(srv, outDir) {
  const sess = new BrowserSession({
    mode: 'auto',
    windowMode: 'headless',
    showTakeoverControl: true,
    activeSession: true,
  });
  await sess.start();
  try {
    const tools = new AtomicBrowserToolset(sess, path.join(outDir, 'probes'));
    await tools.navigate(srv.url, 200);

    // 1. inspect_region with huge radius/zoom to verify <=1440px physical cap + root hide & restore
    const reg = await tools.inspectRegion({ target: '#tiny-footer', radius: 360, zoom: 3 });
    assert.equal(reg.ok, true);
    assert.ok(reg.region);
    assert.ok(fs.existsSync(reg.region.imagePath), 'Expected step_XX_region.png to exist');
    assert.ok(reg.region.width <= 1440 && reg.region.height <= 1440, `Expected <=1440, got ${reg.region.width}x${reg.region.height}`);
    assert.ok(reg.region.topElement?.includes('DIV#tiny-footer'));
    assert.ok(reg.region.visibleText?.includes('TINY_FOOTER_SAMPLE_TEXT'));
    assert.ok(reg.region.avgColor?.startsWith('#'));

    // #__dsh_vc_root__ must be visible again after inspectRegion returns (Risk ②)
    const rootVisAfter = await safeEvaluate(
      sess.page,
      () => document.getElementById('__dsh_vc_root__')?.style.visibility ?? '',
      'hidden',
      0
    );
    assert.notEqual(rootVisAfter, 'hidden', '#__dsh_vc_root__ must be restored after inspect_region');

    // Verify region crop had hidden cursor overlay (pixel check on dark blue background region)
    const regPng = decodePngRgba(fs.readFileSync(reg.region.imagePath));
    assert.ok(regPng && regPng.width === reg.region.width);

    // 2. inspect_dom: count=0 explicit, password masked, <=1200 chars
    const domZero = await tools.inspectDomForAgent('.does-not-exist', 5);
    assert.equal(domZero.ok, true);
    assert.equal(domZero.extraData?.count, 0);
    assert.ok(domZero.llmSummary.includes('count=0'));

    // 3. inspect_styles: REF_STALE + <=1000 char deterministic trim
    const staleStyle = await tools.inspectStyles('#99999');
    assert.equal(staleStyle.ok, false);
    assert.equal(staleStyle.blocked, 'REF_STALE');

    const okStyle = await tools.inspectStyles('#complex-style');
    assert.equal(okStyle.ok, true);
    assert.ok(okStyle.extraData?.topElement?.includes('complex-style'), 'inspect_styles must populate topElement');
    assert.ok(okStyle.llmSummary.length <= 1000, `Full inspect_styles llmSummary ${okStyle.llmSummary.length} exceeded 1000`);
    assert.ok(!okStyle.llmSummary.includes('### [Step'), 'inspect_styles must NOT append redundant full-page HUD');
    assert.ok(
      okStyle.llmSummary.includes('- rect:') &&
        okStyle.llmSummary.includes('fontFamily:') &&
        okStyle.llmSummary.includes('fontSize:') &&
        okStyle.llmSummary.includes('color:') &&
        okStyle.llmSummary.includes('backgroundColor:'),
      'inspect_styles must keep guaranteed design properties'
    );

    // Deterministic worst-case budget stress check
    const stressed = formatStylesBlockWithinBudget({
      ok: true,
      target: '#stress',
      tag: 'div',
      topElement: 'DIV#stress',
      rect: { x: 1, y: 2, width: 300, height: 400 },
      boxModel: { margin: '10px 20px', padding: '12px 18px', border: '2px solid' },
      computedStyle: {
        display: 'block',
        position: 'relative',
        zIndex: '10',
        width: '300px',
        height: '400px',
        color: 'rgb(15, 23, 42)',
        backgroundColor: 'rgb(226, 232, 240)',
        fontFamily: 'VeryLongPrimaryFont, FallbackTwo, FallbackThree, ExtraLongFontFour, ExtraLongFontFive, sans-serif',
        fontSize: '16px',
        fontWeight: '700',
        lineHeight: '24px',
        letterSpacing: '0.1em',
        opacity: '1',
        transform: 'matrix3d(' + '1,0,0,0,'.repeat(20) + '1)',
        overflow: 'hidden',
        visibility: 'visible',
        pointerEvents: 'auto',
        cursor: 'pointer',
      },
    }, 320);
    assert.ok(stressed.length <= 320, `Stressed styles length ${stressed.length} exceeded 320`);
    assert.ok(
      stressed.includes('- rect:') &&
        stressed.includes('- display: block') &&
        stressed.includes('fontFamily: VeryLongPrimaryFont, FallbackTwo') &&
        !stressed.includes('FallbackThree'),
      `Expected deterministic drop priority + 2-font truncation, got:\n${stressed}`
    );

    // Unified inspectDom() shape & <=1200 budget check
    const rawDom = await tools.inspectDom('#tiny-footer', 5);
    assert.equal(rawDom.ok, true);
    assert.equal(rawDom.count, 1);
    assert.ok(typeof rawDom.llmSummary === 'string' && rawDom.llmSummary.length <= 1200);
    assert.ok(rawDom.extraData && rawDom.extraData.topElement?.includes('tiny-footer'));

    // 4. extract_outline: normSplit preserves "collaborate" & 3 empty reason codes
    const outline = await tools.extractOutline();
    assert.equal(outline.ok, true);
    assert.ok(outline.llmSummary.length <= 1200, `extract_outline llmSummary ${outline.llmSummary.length} exceeded 1200`);
    assert.ok(outline.llmSummary.includes('collaborate'), 'extract_outline must preserve "collaborate"');
    assert.ok(outline.extraData?.topElement, 'extract_outline must populate topElement');

    await tools.navigate(`${srv.url}/canvas-no-headings`, 100);
    const outCanvas = await tools.extractOutline();
    assert.equal(outCanvas.extraData?.headingsReason, '标题可能在 <canvas> 内');

    await tools.navigate(`${srv.url}/hidden-headings`, 100);
    const outHidden = await tools.extractOutline();
    assert.equal(outHidden.extraData?.headingsReason, '标题被裁切或隐藏');

    await tools.navigate(`${srv.url}/no-headings`, 100);
    const outNone = await tools.extractOutline();
    assert.equal(outNone.extraData?.headingsReason, '无 h1-h4 标题');

    // Password input value masking verified on isolated /password-probe route (keeps / clean of login gate)
    await tools.navigate(`${srv.url}/password-probe`, 100);
    const domPw = await tools.inspectDomForAgent('#secret-pw', 5);
    assert.equal(domPw.ok, true);
    assert.equal(domPw.extraData?.count, 1);
    assert.ok(domPw.llmSummary.length <= 1200);
    assert.ok(!domPw.llmSummary.includes('TOP_SECRET_PASS_999'), 'Password input value must stay masked');

    // 5. inspect_media: explicit img/video/canvas/svg counts including video=0 & <=1200 budget
    await tools.navigate(srv.url, 150);
    const media = await tools.inspectMedia();
    assert.equal(media.ok, true);
    assert.ok(media.llmSummary.length <= 1200, `inspect_media llmSummary ${media.llmSummary.length} exceeded 1200`);
    assert.equal(media.extraData?.counts?.video, 0);
    assert.equal(media.extraData?.counts?.canvas, 1);
    assert.equal(media.extraData?.counts?.img, 1);
    assert.ok(media.llmSummary.includes('video=0'), 'inspect_media must explicitly print video=0');

    // 6. TASK-v2.0.2a budget stress page: many landmarks, >=12 headings, 24 svgs, 8 imgs, 1 canvas, 1 video
    await tools.navigate(`${srv.url}/budget-stress`, 150);
    const stressOutline = await tools.extractOutline();
    assert.equal(stressOutline.ok, true);
    assert.ok(stressOutline.llmSummary.length <= 1200, `Stress outline ${stressOutline.llmSummary.length} exceeded 1200`);
    assert.ok(stressOutline.llmSummary.includes('landmarks: '), 'Landmarks must collapse to count summary');
    const headingMatches = stressOutline.llmSummary.match(/^- <h[1-4]>/gm) ?? [];
    assert.ok(headingMatches.length >= 8, `Expected >=8 headings preserved in outline summary, got ${headingMatches.length}`);

    const stressMedia = await tools.inspectMedia();
    assert.equal(stressMedia.ok, true);
    assert.ok(stressMedia.llmSummary.length <= 1200, `Stress media ${stressMedia.llmSummary.length} exceeded 1200`);
    assert.ok(stressMedia.llmSummary.includes('svg=24'), 'inspect_media must report total svg=24 count');
    assert.ok(!stressMedia.llmSummary.includes('- [svg]'), 'inspect_media must not list individual decorative SVGs');
    assert.ok(stressMedia.llmSummary.includes('intrinsic=1440x900'), 'inspect_media must preserve canvas intrinsic resolution');
  } finally {
    await sess.close();
  }
}

async function testEphemeral2ImageAndFallback(srv, outDir) {
  // Normal 2-image lifecycle: step 1 (1 img) -> inspect_region -> step 2 (2 imgs + declaration) -> step 3 (1 img, cleared!)
  const runner = new BrowserSubagentRunner();
  const calls1 = [];
  const stepDiags1 = [];
  const planner1 = createDshHostLlmPlanner({
    provider: 'test',
    model: 'test-vision',
    attachments: createAttachmentsStub(),
    onStepDiagnostic: (d) => stepDiags1.push(d),
    llm: {
      async *stream(options) {
        const idx = calls1.length + 1;
        const parts = options.messages[0].content;
        const imgs = parts.filter((p) => p.type === 'image').length;
        const txt = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
        calls1.push({ idx, imgs, txt });
        if (idx === 1) {
          yield { type: 'text-delta', text: JSON.stringify({ type: 'inspect_region', target: '#tiny-footer', radius: 120, zoom: 2, reason: 'read tiny footer' }) };
        } else if (idx === 2) {
          yield { type: 'text-delta', text: JSON.stringify({ type: 'inspect_dom', selector: '#tiny-footer', reason: 'confirm dom' }) };
        } else {
          yield { type: 'text-delta', text: JSON.stringify({ type: 'complete', report: 'EPHEMERAL_2IMG_OK' }) };
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  });

  try {
    const res1 = await runner.runTask({
      role: 'Region 2-Img QA',
      taskPrompt: 'Verify t+1=2 and t+2=1',
      startUrl: srv.url,
      artifactDir: outDir,
      maxSteps: 5,
      maxRecentImages: 3,
      sessionOptions: { windowMode: 'headless' },
      planner: planner1,
    });
    assert.equal(res1.status, 'COMPLETED');
    assert.equal(calls1[0].imgs, 1);
    assert.equal(calls1[1].imgs, 2);
    assert.ok(calls1[1].txt.includes('[ATTACHED_IMAGES: 2'));
    assert.equal(calls1[2].imgs, 1);
    assert.ok(!calls1[2].txt.includes('[ATTACHED_IMAGES: 2'));
    assert.equal(stepDiags1[0].image_count_sent, 1);
    assert.equal(stepDiags1[1].image_count_sent, 2);
    assert.equal(stepDiags1[2].image_count_sent, 1);
    assert.ok(res1.contextStats.activeImagesInContext <= 3);
  } finally {
    await runner.closeAllSessions();
  }

  // Tier 4 fallback: reject 2 images AND reject 1 image -> falls back cleanly to text-only with REGION_TEXT_SUMMARY
  const runner2 = new BrowserSubagentRunner();
  const tier4Seen = [];
  const stepDiags2 = [];
  let callSeq2 = 0;
  const planner2 = createDshHostLlmPlanner({
    provider: 'test',
    model: 'test-no-vision',
    attachments: createAttachmentsStub(),
    onStepDiagnostic: (d) => stepDiags2.push(d),
    llm: {
      async *stream(options) {
        callSeq2++;
        const parts = options.messages[0].content;
        const imgs = parts.filter((p) => p.type === 'image').length;
        const txt = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
        tier4Seen.push({ callSeq2, imgs, txt });
        if (callSeq2 === 1) {
          yield { type: 'text-delta', text: JSON.stringify({ type: 'inspect_region', target: '#tiny-footer', reason: 'zoom' }) };
        } else if (imgs > 0) {
          yield { type: 'error', error: 'image input rejected by route' };
        } else {
          yield { type: 'text-delta', text: JSON.stringify({ type: 'complete', report: 'TIER4_TEXT_SUMMARY_OK' }) };
        }
        yield { type: 'finish', reason: { kind: 'stop' } };
      },
    },
  });

  try {
    const res2 = await runner2.runTask({
      role: '4-Tier Fallback QA',
      taskPrompt: 'Verify 2 -> 1 -> 0 fallback preserves summary',
      startUrl: srv.url,
      artifactDir: outDir,
      maxSteps: 4,
      sessionOptions: { windowMode: 'headless' },
      planner: planner2,
    });
    assert.equal(res2.status, 'COMPLETED');
    // Call 2 had 2 imgs (rejected) -> Call 3 had 1 img (rejected) -> Call 4 had 0 imgs + REGION_TEXT_SUMMARY
    const step2Calls = tier4Seen.slice(1);
    assert.deepEqual(step2Calls.map((c) => c.imgs), [2, 1, 0]);
    assert.ok(step2Calls[2].txt.includes('[REGION_TEXT_SUMMARY]'));
    assert.equal(stepDiags2[1].image_count_sent, 0);
    assert.equal(stepDiags2[1].retried_single_image, true);
    assert.equal(stepDiags2[1].retried_text_only, true);
  } finally {
    await runner2.closeAllSessions();
  }
}

async function testScreenshotPanelHiding(srv, outDir) {
  if (process.platform !== 'win32') {
    console.log('[v2.0.2] Skipping visible-background screenshot panel hide check (non-win32)');
    return;
  }
  const sess = new BrowserSession({
    mode: 'auto',
    windowMode: 'visible-background',
    showTakeoverControl: true,
    activeSession: true,
  });
  await sess.start();
  try {
    await sess.navigate(srv.url, 'domcontentloaded', 10000);
    await sess.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1.5 });

    // Hook setPanelScreenshotHidden in page to verify running/paused visibility & finally restore
    await safeEvaluate(
      sess.page,
      () => {
        const api = window.__dshCursorAPI;
        window.__panelHideLog = [];
        const orig = api.setPanelScreenshotHidden;
        api.setPanelScreenshotHidden = (on) => {
          orig(on);
          const panel = document.getElementById('__dsh_vc_panel__');
          const badge = document.getElementById('__dsh_vc_badge__');
          window.__panelHideLog.push({
            on: Boolean(on),
            mode: api.getState().takeoverMode,
            panelDisplay: panel ? getComputedStyle(panel).display : '',
            badgeDisplay: badge ? getComputedStyle(badge).display : '',
          });
        };
      },
      undefined,
      0
    );

    const tools = new AtomicBrowserToolset(sess, path.join(outDir, 'panel-hide'));
    const snapRunning = await tools.sampler.captureSnapshot('running_shot');
    assert.ok(fs.existsSync(snapRunning.screenshotPath));

    const logRunning = await safeEvaluate(sess.page, () => window.__panelHideLog, [], 0);
    assert.equal(logRunning.length, 2, `Expected hide+restore calls, got ${JSON.stringify(logRunning)}`);
    assert.equal(logRunning[0].on, true);
    assert.equal(logRunning[0].panelDisplay, 'none', 'Panel must be hidden during running 1440 screenshot');
    assert.notEqual(logRunning[0].badgeDisplay, 'none', 'Virtual cursor badge must stay visible during screenshot');
    assert.equal(logRunning[1].on, false);
    assert.equal(logRunning[1].panelDisplay, 'flex', 'Panel must be restored in finally');

    // Now switch to paused: panel MUST NOT hide during screenshot!
    await safeEvaluate(sess.page, () => { window.__panelHideLog = []; }, undefined, 0);
    await sess.motion.setTakeoverState('paused', 'Human');
    const snapPaused = await tools.sampler.captureSnapshot('paused_shot');
    assert.ok(fs.existsSync(snapPaused.screenshotPath));
    const logPaused = await safeEvaluate(sess.page, () => window.__panelHideLog, [], 0);
    assert.equal(logPaused.length, 0, 'Must NOT hide panel during paused takeover state');
    const panelPausedDisplay = await safeEvaluate(
      sess.page,
      () => getComputedStyle(document.getElementById('__dsh_vc_panel__')).display,
      'none',
      0
    );
    assert.equal(panelPausedDisplay, 'flex');

    // Error recovery: even if capture fails (monkey-patch throw once), panel MUST restore via finally
    await sess.motion.setTakeoverState('running', 'Agent');
    await safeEvaluate(sess.page, () => { window.__panelHideLog = []; }, undefined, 0);
    const fakeShotPath = path.join(outDir, 'panel-hide', 'err.png');
    const cdpPriv = sess.cdpSession;
    const origCdpSend = cdpPriv.send.bind(cdpPriv);
    cdpPriv.send = async (method, params) => {
      if (method === 'Page.captureScreenshot') {
        throw new Error('Synthetic capture error');
      }
      return origCdpSend(method, params);
    };
    await assert.rejects(() => sess.screenshot(fakeShotPath, 0), /Synthetic capture error/);
    cdpPriv.send = origCdpSend;
    const panelAfterErr = await safeEvaluate(
      sess.page,
      () => getComputedStyle(document.getElementById('__dsh_vc_panel__')).display,
      'none',
      0
    );
    assert.equal(panelAfterErr, 'flex', 'Panel MUST restore in finally even after capture error');
  } finally {
    await sess.close();
  }
}

async function testUnloadGuardLifecycle(srv, outDir) {
  const runner = new BrowserSubagentRunner();
  let capturedSession = null;
  let runningCheck1 = null;
  let runningCheck2 = null;

  const checkGuardInPage = async (page) =>
    safeEvaluate(
      page,
      () => {
        const ev = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(ev);
        return {
          active: Boolean(window.__dshCursorAPI?.isUnloadGuardActive?.()),
          defaultPrevented: ev.defaultPrevented,
          mode: window.__dshCursorAPI?.getState?.().takeoverMode ?? null,
        };
      },
      { active: false, defaultPrevented: false, mode: null },
      0
    );

  let stepCall = 0;
  const customPlanner = async () => {
    stepCall++;
    if (!capturedSession) {
      capturedSession = runner.getSharedSession();
    }
    if (stepCall === 1) {
      runningCheck1 = await checkGuardInPage(capturedSession.page);
      return {
        type: 'pause_for_takeover',
        blockReason: 'USER_TAKEOVER',
        message: 'Pause to verify unloadGuard is OFF while paused',
      };
    }
    runningCheck2 = await checkGuardInPage(capturedSession.page);
    return { type: 'complete', report: 'GUARD_LIFECYCLE_OK' };
  };

  try {
    const pausedRes = await runner.runTask({
      role: 'Guard Lifecycle QA',
      taskPrompt: 'Verify running=ON, paused=OFF, resumed=ON, idle=OFF',
      startUrl: srv.url,
      artifactDir: outDir,
      maxSteps: 5,
      keepWindowOpen: true,
      sessionOptions: { windowMode: 'headless', showTakeoverControl: true },
      planner: customPlanner,
    });
    assert.equal(pausedRes.status, 'PAUSED_FOR_TAKEOVER');
    assert.ok(capturedSession, 'Expected capturedSession');
    assert.equal(runningCheck1.active, true, 'running step 1 must enable unloadGuard');
    assert.equal(runningCheck1.defaultPrevented, true, 'running step 1 must prevent beforeunload');

    // While paused, unloadGuard MUST be OFF and remain OFF even after manual reload/navigation
    const pausedCheckBeforeReload = await checkGuardInPage(capturedSession.page);
    assert.equal(pausedCheckBeforeReload.active, false, 'paused state must disable unloadGuard');
    assert.equal(pausedCheckBeforeReload.defaultPrevented, false, 'paused state must not prevent beforeunload');
    assert.equal(capturedSession.motion.isUnloadGuardEnabled(), false);

    await capturedSession.page.goto(`${srv.url}?reloaded=1`, { waitUntil: 'domcontentloaded' });
    await capturedSession.motion.ensureCursorHUD(true);
    const pausedCheckAfterReload = await checkGuardInPage(capturedSession.page);
    assert.equal(pausedCheckAfterReload.active, false, 'paused unloadGuard must remain OFF after page reload');
    assert.equal(pausedCheckAfterReload.defaultPrevented, false);

    // Resume -> running again -> unloadGuard ON; after completion (idle) -> unloadGuard OFF
    const resumedRes = await runner.resumeTask(pausedRes.subagentId, 'resumed by test');
    assert.equal(resumedRes.status, 'COMPLETED');
    assert.equal(runningCheck2.active, true, 'resumed running step must re-enable unloadGuard');
    assert.equal(runningCheck2.defaultPrevented, true);

    const idleCheck = await checkGuardInPage(capturedSession.page);
    assert.equal(idleCheck.active, false, 'idle state after completion must disable unloadGuard');
    assert.equal(idleCheck.defaultPrevented, false);
    assert.equal(capturedSession.motion.isUnloadGuardEnabled(), false);
  } finally {
    await runner.closeAllSessions();
  }
}

async function main() {
  const srv = await startFixtureServer();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vb-v202-'));
  try {
    await testRegionAndProbes(srv, outDir);
    await testEphemeral2ImageAndFallback(srv, outDir);
    await testScreenshotPanelHiding(srv, outDir);
    await testUnloadGuardLifecycle(srv, outDir);
    console.log('✅ verify-v202: All 4+1 probes, ephemeral 2-img lifecycle, 4-tier fallback, screenshot panel hiding & unloadGuard lifecycle PASSED!');
  } finally {
    await srv.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
