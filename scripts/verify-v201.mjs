#!/usr/bin/env node
/**
 * verify-v201.mjs — Standalone runtime verification for v2.0.1 hotfixes + Benchmark A'.
 * Covers:
 *  1. Strict CSP (`Content-Security-Policy: default-src 'self'; style-src 'none';`):
 *     overlay capsule & badge keep full fixed/dark CSSOM styles with 0 console CSP errors.
 *  2. Visible-background `set_viewport(1440, 900)`:
 *     defaults to DPR 1.5, computes `scale < 1` so 1440px fits inside ~754px window,
 *     captures 2160x1350 PNG, and keeps CSS click coordinates & paused emulation capsule accurate.
 *  3. Chinese challenge page (`请稍候...` / `正在验证您的请求`):
 *     `detectPageGate` + `BrowserSubagentRunner` trigger `PAUSED_FOR_TAKEOVER` (`CAPTCHA_DETECTED`) even under `style-src 'none'`.
 *  4. Benchmark A' local equivalent:
 *     4-bar intro loader + letter-split `<h1>` + 10px mono tags + <canvas> + 6000px height ->
 *     `set_viewport(1440, 900)` + `wait_for` clears loader cleanly and samples Design HUD accurately.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BrowserSession } from '../dist/driver/browser-session.js';
import { detectPageGate } from '../dist/guardrails/takeover.js';
import { safeEvaluate } from '../dist/sampler/page-snapshot.js';
import { BrowserSubagentRunner } from '../dist/subagent/runner.js';
import { AtomicBrowserToolset } from '../dist/tools/atomic-tools.js';

function readPngDimensions(buf) {
  assert.ok(buf.length >= 24, 'PNG buffer too short');
  assert.equal(buf.toString('ascii', 1, 4), 'PNG');
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqPath = (req.url || '/').split('?')[0];
      if (reqPath === '/strict-csp') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'self'; style-src 'none'; script-src 'unsafe-inline';",
        });
        res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Strict CSP Target</title></head>
<body>
  <h1>Strict CSP Page</h1>
  <button id="csp-btn" type="button" onclick="window.__cspBtnClicks=(window.__cspBtnClicks||0)+1;">Click Target</button>
</body>
</html>`);
        return;
      }

      if (reqPath === '/cn-challenge') {
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Content-Security-Policy': "default-src 'self'; style-src 'none';",
        });
        res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>请稍候...</title></head>
<body>
  <main>
    <p>正在验证您的请求，请稍候...</p>
  </main>
</body>
</html>`);
        return;
      }

      // Benchmark A': local equivalent of 4-bar loader + letter-split H1 + 10px mono + canvas + 6000px scroll
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>22334L — Creative Developer</title>
<style>
  html, body { margin: 0; padding: 0; background: #0d0d0f; color: #f4f4f6; font-family: system-ui, sans-serif; }
  .intro-loader {
    position: fixed; inset: 0; background: #e11d48; display: flex; gap: 18px;
    align-items: center; justify-content: center; z-index: 50; transition: opacity 0.15s ease;
  }
  .intro-loader.done { opacity: 0; pointer-events: none; }
  .intro-bar { width: 18px; height: 96px; background: #111; }
  section { min-height: 1500px; padding: 72px 80px; box-sizing: border-box; position: relative; }
  .mono-badge { font-family: monospace; font-size: 10px; letter-spacing: 0.12em; color: #f8fafc; }
  .split-h1 { font-size: 64px; margin: 16px 0; display: flex; gap: 8px; }
  .split-h1 span { display: inline-block; }
</style>
</head>
<body>
  <div class="intro-loader" id="intro-loader">
    <div class="intro-bar"></div><div class="intro-bar"></div><div class="intro-bar"></div><div class="intro-bar"></div>
  </div>
  <section>
    <div class="mono-badge">(SOTD × 4) · LIGHTING</div>
    <canvas width="1200" height="420" style="display:block;max-width:100%;"></canvas>
    <div id="hero-slot"></div>
  </section>
  <section><h2>WORK</h2></section>
  <section><h2>PLAY</h2></section>
  <section><h2>CONTACT</h2></section>
  <script>
    setTimeout(() => {
      document.getElementById('intro-loader')?.classList.add('done');
      const host = document.getElementById('hero-slot');
      if (host) {
        host.innerHTML =
          '<h1 class="split-h1">' +
          '<span>C</span><span>R</span><span>E</span><span>A</span><span>T</span><span>I</span><span>V</span><span>E</span>' +
          '</h1>';
      }
    }, 650);
  </script>
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

async function testStrictCspCssom(srv, outDir) {
  const sess = new BrowserSession({
    mode: 'auto',
    windowMode: 'headless',
    showTakeoverControl: true,
    activeSession: true,
  });
  await sess.start();
  try {
    const tools = new AtomicBrowserToolset(sess, path.join(outDir, 'csp'));
    const nav = await tools.navigate(`${srv.url}/strict-csp`, 250);
    assert.equal(nav.observation.health.consoleErrorsCount, 0, 'Zero CSP console errors expected');

    const css = await safeEvaluate(
      sess.page,
      () => {
        const panel = document.getElementById('__dsh_vc_panel__');
        const dot = document.getElementById('__dsh_vc_status_dot__');
        const btn = document.getElementById('__dsh_vc_takeover_btn__');
        const badge = document.getElementById('__dsh_vc_badge__');
        return {
          panelPos: panel ? getComputedStyle(panel).position : '',
          panelBg: panel ? getComputedStyle(panel).backgroundColor : '',
          panelRadius: panel ? getComputedStyle(panel).borderRadius : '',
          panelDisplay: panel ? getComputedStyle(panel).display : '',
          dotBg: dot ? getComputedStyle(dot).backgroundColor : '',
          btnBg: btn ? getComputedStyle(btn).backgroundColor : '',
          btnDisplay: btn ? getComputedStyle(btn).display : '',
          badgePos: badge ? getComputedStyle(badge).position : '',
          badgeBg: badge ? getComputedStyle(badge).backgroundColor : '',
        };
      },
      null,
      0
    );
    assert.ok(css);
    assert.equal(css.panelPos, 'fixed');
    assert.equal(css.panelDisplay, 'flex');
    assert.equal(css.panelRadius, '999px');
    assert.notEqual(css.panelBg, 'rgba(0, 0, 0, 0)');
    assert.notEqual(css.dotBg, 'rgba(0, 0, 0, 0)');
    assert.notEqual(css.btnBg, 'rgba(0, 0, 0, 0)');
    assert.notEqual(css.btnDisplay, 'none');
    assert.equal(css.badgePos, 'absolute');
    assert.notEqual(css.badgeBg, 'rgba(0, 0, 0, 0)');

    const clickRes = await tools.click('#csp-btn', 80);
    assert.equal(clickRes.ok, true);
    assert.equal(await safeEvaluate(sess.page, () => Number(window.__cspBtnClicks || 0), 0, 0), 1);
  } finally {
    await sess.close();
  }
}

async function testVisibleBackgroundEmulationAndPanelClamp(srv, outDir) {
  if (process.platform !== 'win32') {
    console.log('[v2.0.1] Skipping visible-background capsule clamp test (non-win32)');
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
    const tools = new AtomicBrowserToolset(sess, path.join(outDir, 'panel-clamp'));
    await tools.navigate(`${srv.url}/strict-csp`, 250);
    const sv = await tools.setViewport({ width: 1440, height: 900 });
    const emu = sess.getViewportEmulation();
    assert.ok(emu?.active);
    assert.equal(emu.deviceScaleFactor, 1.5, 'Default emulated DPR must be 1.5');
    assert.ok((emu.physicalWidth ?? 0) > 0 && (emu.physicalWidth ?? 0) < 1440);
    assert.equal(sv.observation.viewport?.deviceScaleFactor, 1.5);

    const dims = readPngDimensions(fs.readFileSync(sv.observation.screenshotPath));
    assert.equal(dims.width, 2160);
    assert.equal(dims.height, 1350);

    // Clicking target must work cleanly in CSS coordinates (mobile:false, scale:1)
    const clickRes = await tools.click('#csp-btn', 80);
    assert.equal(clickRes.ok, true);
    assert.equal(await safeEvaluate(sess.page, () => Number(window.__cspBtnClicks || 0), 0, 0), 1);

    // Takeover capsule stays clamped inside the physical visible window strip when emulated width > physicalWidth
    await sess.motion.setTakeoverState('paused', 'ClampCheck');
    const panelRight = await safeEvaluate(
      sess.page,
      () => Math.round(document.getElementById('__dsh_vc_panel__')?.getBoundingClientRect().right ?? 9999),
      9999,
      0
    );
    assert.ok(
      panelRight <= (emu.physicalWidth ?? 1440) - 10,
      `Expected capsule right (${panelRight}) <= physicalWidth - 10 (${(emu.physicalWidth ?? 1440) - 10})`
    );
  } finally {
    await sess.close();
  }
}

async function testChineseChallengeGate(srv, outDir) {
  const runner = new BrowserSubagentRunner();
  try {
    const res = await runner.runTask({
      role: 'Challenge QA',
      taskPrompt: 'Verify immediate pause on Chinese challenge page under strict CSP',
      startUrl: `${srv.url}/cn-challenge`,
      artifactDir: outDir,
      maxSteps: 3,
      sessionOptions: { windowMode: 'headless', showTakeoverControl: true },
      planner: async () => ({ type: 'complete', report: 'SHOULD_NOT_COMPLETE' }),
    });
    assert.equal(res.status, 'PAUSED_FOR_TAKEOVER');
    assert.equal(res.approvalCard?.reason, 'CAPTCHA_DETECTED');
  } finally {
    await runner.closeAllSessions();
  }

  // Also test detectPageGate directly
  const sess = new BrowserSession({ mode: 'auto', windowMode: 'headless' });
  await sess.start();
  try {
    await sess.navigate(`${srv.url}/cn-challenge`);
    const gate = await detectPageGate(sess.page);
    assert.equal(gate.detected, true);
    assert.equal(gate.reason, 'CAPTCHA_DETECTED');
  } finally {
    await sess.close();
  }
}

async function testBenchmarkAPrime(srv, outDir) {
  const sess = new BrowserSession({
    mode: 'auto',
    windowMode: 'headless',
    showTakeoverControl: true,
    activeSession: true,
  });
  await sess.start();
  try {
    const tools = new AtomicBrowserToolset(sess, path.join(outDir, 'bench-a-prime'));
    await tools.navigate(`${srv.url}/bench-a`, 100);
    await tools.setViewport({ width: 1440, height: 900 });
    const wRes = await tools.waitFor({
      selector: 'h1',
      goneSelector: '.intro-loader',
      animationsSettled: true,
      timeoutMs: 4000,
    });
    assert.equal(wRes.ok, true);
    assert.equal(wRes.observation.viewport?.deviceScaleFactor, 1.5);
    assert.equal(wRes.observation.design?.sections?.length, 4);
    assert.ok(wRes.observation.scroll.scrollHeight >= 6000);
    assert.ok(
      wRes.observation.design?.headings.some((h) => h.text === 'CREATIVE'),
      `Expected CREATIVE heading, got ${JSON.stringify(wRes.observation.design?.headings)}`
    );
  } finally {
    await sess.close();
  }
}

async function main() {
  const srv = await startFixtureServer();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vb-v201-'));
  try {
    await testStrictCspCssom(srv, outDir);
    await testVisibleBackgroundEmulationAndPanelClamp(srv, outDir);
    await testChineseChallengeGate(srv, outDir);
    await testBenchmarkAPrime(srv, outDir);
    console.log('✅ verify-v201: All CSP, capsule clamp/DPR 1.5, Chinese challenge & Benchmark A-prime checks PASSED!');
  } finally {
    await srv.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
