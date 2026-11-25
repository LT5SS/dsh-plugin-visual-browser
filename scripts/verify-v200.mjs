#!/usr/bin/env node
/**
 * verify-v200.mjs — Comprehensive standalone runtime verification for TASK-v2.0.0.md.
 * Covers:
 *  1. Zero-side-effect baseline (without set_viewport / viewportOverride, identical to v1.4.5).
 *  2. set_viewport(1440, 900, 2) -> innerWidth=1440, dpr=2, PNG=2880x1800, inspect_motion DPR2,
 *     paused retention + pill text, and reset:true restore.
 *  3. DPR benchmark across @1, @1.5, @2 (PNG bytes & capture latency).
 *  4. wait_for with infinite CSS animation + 1.1s opacity loader + >=250ms text check + non-throwing timeout.
 *  5. press_key (Escape / Control+A), RESERVED_HOTKEY (F8, Control+F8, Alt+F4), select_option,
 *     go_back / go_forward / reload mandatory REF_STALE invalidation, and no_history.
 *  6. Win32 HWND_NOTOPMOST check via WS_EX_TOPMOST injection + ensureWindowNotTopmostWin32.
 *  7. mailto: / tel: -> EXTERNAL_PROTOCOL, javascript: -> JS_URL, paused pass-through.
 *  8. Native dialog visibility: alert/confirm accepted + logged in HUD, prompt dismissed + PROMPT_REQUIRES_HUMAN -> paused.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { BrowserSession } from '../dist/driver/browser-session.js';
import { ensureWindowNotTopmostWin32 } from '../dist/driver/window-manager.js';
import { safeEvaluate } from '../dist/sampler/page-snapshot.js';
import { BrowserSubagentRunner } from '../dist/subagent/runner.js';
import { AtomicBrowserToolset } from '../dist/tools/atomic-tools.js';

const execFileAsync = promisify(execFile);

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
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if (reqPath === '/page2') {
        res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>v2.0.0 Page 2</title></head>
<body style="margin:0;padding:32px;font-family:sans-serif;height:1200px;">
  <h1>Second Page</h1>
  <button id="p2-btn" type="button">Page Two Button</button>
  <a id="to-home" href="/">Back Home Link</a>
</body>
</html>`);
        return;
      }

      res.end(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>v2.0.0 Verification Fixture</title>
<style>
  @keyframes infinitePulse {
    0% { opacity: 0.4; }
    50% { opacity: 1; }
    100% { opacity: 0.4; }
  }
  .infinite-marquee {
    display: inline-block;
    animation: infinitePulse 1.2s ease-in-out infinite;
    font-family: monospace;
    font-size: 10px;
    letter-spacing: 0.08em;
  }
  .loader {
    position: fixed;
    inset: 0;
    background: #991b1b;
    color: #fff;
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 1;
    transition: opacity 0.15s ease;
    z-index: 20;
  }
  .loader.done {
    opacity: 0;
    pointer-events: none;
  }
  #hover-card {
    display: inline-block;
    padding: 12px 20px;
    background: #0f172a;
    color: #f8fafc;
    transition: transform 150ms ease;
  }
  #hover-card:hover {
    transform: translateY(-6px);
  }
  #modal {
    padding: 16px;
    border: 2px solid #0284c7;
    background: #f0f9ff;
    margin-top: 12px;
  }
  #modal.closed { display: none; }
</style>
</head>
<body style="margin:0;padding:24px;height:1800px;font-family:sans-serif;">
  <div class="loader" id="loader">LOADING</div>
  <h1 style="margin:0 0 8px;">v2.0.0 Fixture Ready</h1>
  <div class="infinite-marquee">(SOTD × 4) · LIGHTING</div>
  <div style="margin:12px 0;">
    <input id="txt-input" type="text" value="OLD_VALUE_123" />
    <select id="city-select">
      <option value="sh">Shanghai</option>
      <option value="bj">Beijing</option>
      <option value="sz">Shenzhen</option>
    </select>
    <a id="to-p2" href="/page2">Go Page 2</a>
    <button id="first-btn" type="button" onclick="window.__firstBtnClicks=(window.__firstBtnClicks||0)+1;">First Action</button>
    <div id="hover-card">Hover Motion Card</div>
  </div>
  <div style="margin:12px 0;">
    <a id="mailto-link" href="mailto:test@example.com">Email Us</a>
    <a id="tel-link" href="tel:+8613800138000">Call Us</a>
    <a id="js-link" href="javascript:void(window.__jsHrefRan=true)">Run JS Link</a>
  </div>
  <div style="margin:12px 0;">
    <button id="btn-alert" type="button" onclick="alert('Hello from alert dialog')">Trigger Alert</button>
    <button id="btn-confirm" type="button" onclick="window.__confirmChoice=confirm('Confirm action?')">Trigger Confirm</button>
    <button id="btn-prompt" type="button" onclick="window.__promptVal=prompt('Enter token')">Trigger Prompt</button>
  </div>
  <div id="modal">Modal Open (Press Escape to close)</div>
  <script>
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.getElementById('modal')?.classList.add('closed');
      }
    });
    if (window.location.search.includes('delayed=1')) {
      setTimeout(() => {
        const loader = document.getElementById('loader');
        if (loader) loader.classList.add('done');
        const ready = document.createElement('div');
        ready.id = 'delayed-text';
        ready.textContent = 'ASYNC_READY_MARKER';
        document.body.appendChild(ready);
      }, 950);
    } else {
      document.getElementById('loader')?.remove();
    }
  </script>
</body>
</html>`);
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        url: `http://127.0.0.1:${addr.port}/`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

async function testZeroSideEffectAndViewportDpr(srv, outDir) {
  // 1) Zero-side-effect baseline (visible-background without viewportOverride stays physical)
  const baseline = new BrowserSession({
    mode: 'auto',
    windowMode: 'headless',
    viewport: { width: 754, height: 751 },
    showTakeoverControl: true,
    activeSession: true,
  });
  await baseline.start();
  try {
    await baseline.navigate(srv.url);
    const bMetrics = await safeEvaluate(
      baseline.page,
      () => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }),
      { w: 0, h: 0, dpr: 0 },
      0
    );
    assert.equal(bMetrics.w, 754);
    assert.equal(bMetrics.h, 751);
    assert.equal(bMetrics.dpr, 1);
  } finally {
    await baseline.close();
  }

  // 2) set_viewport(1440, 900, 2) + PNG 2880x1800 + inspect_motion DPR2 + DPR benchmark + reset
  const sess = new BrowserSession({
    mode: 'auto',
    windowMode: 'headless',
    viewport: { width: 754, height: 751 },
    showTakeoverControl: true,
    activeSession: true,
  });
  await sess.start();
  const dprBenchmark = [];
  try {
    const tools = new AtomicBrowserToolset(sess, path.join(outDir, 'viewport'));
    await tools.navigate(srv.url, 300);

    for (const dpr of [1, 1.5, 2]) {
      const t0 = Date.now();
      const sv = await tools.setViewport({ width: 1440, height: 900, deviceScaleFactor: dpr });
      const elapsedMs = Date.now() - t0;
      const buf = fs.readFileSync(sv.observation.screenshotPath);
      const dims = readPngDimensions(buf);
      assert.equal(dims.width, Math.round(1440 * dpr), `Expected PNG width ${1440 * dpr}, got ${dims.width}`);
      assert.equal(dims.height, Math.round(900 * dpr), `Expected PNG height ${900 * dpr}, got ${dims.height}`);
      assert.equal(sv.observation.viewport?.deviceScaleFactor, dpr);
      dprBenchmark.push({ dpr, width: dims.width, height: dims.height, bytes: buf.length, elapsedMs });
    }

    // Verify inspect_motion works cleanly at DPR=2
    const motionRes = await tools.inspectMotion('#hover-card');
    assert.equal(motionRes.ok, true);
    assert.ok(motionRes.motion);

    // Paused state retains emulation & updates status pill
    await sess.motion.setTakeoverState('paused', 'QA');
    const pausedState = await safeEvaluate(
      sess.page,
      () => ({
        w: window.innerWidth,
        h: window.innerHeight,
        dpr: window.devicePixelRatio,
        pill: document.getElementById('__dsh_vc_status_text__')?.textContent ?? '',
      }),
      { w: 0, h: 0, dpr: 0, pill: '' },
      0
    );
    assert.equal(pausedState.w, 1440);
    assert.equal(pausedState.h, 900);
    assert.equal(pausedState.dpr, 2);
    assert.ok(pausedState.pill.includes('仿真 1440×900 @2x'), `Expected paused pill emulation hint, got: ${pausedState.pill}`);
    assert.ok(pausedState.pill.includes('物理窗口 754px'), `Expected physical window px hint, got: ${pausedState.pill}`);

    // Explicit reset restores 754x751 @1
    await sess.motion.setTakeoverState('running', 'QA');
    await tools.setViewport({ reset: true });
    const resetMetrics = await safeEvaluate(
      sess.page,
      () => ({ w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio }),
      { w: 0, h: 0, dpr: 0 },
      0
    );
    assert.equal(resetMetrics.w, 754);
    assert.equal(resetMetrics.h, 751);
    assert.equal(resetMetrics.dpr, 1);
  } finally {
    await sess.close();
  }
  console.log('[v2.0.0] DPR Benchmark (capture+snapshot):', JSON.stringify(dprBenchmark));
}

async function testWaitFor(srv, outDir) {
  const sess = new BrowserSession({
    mode: 'auto',
    windowMode: 'headless',
    showTakeoverControl: true,
    activeSession: true,
  });
  await sess.start();
  try {
    const tools = new AtomicBrowserToolset(sess, path.join(outDir, 'waitfor'));
    await tools.navigate(`${srv.url}?delayed=1`, 100);
    const waitOk = await tools.waitFor({
      selector: 'h1',
      goneSelector: '.loader',
      text: 'ASYNC_READY_MARKER',
      animationsSettled: true,
      timeoutMs: 5000,
    });
    assert.equal(waitOk.ok, true);
    assert.equal(waitOk.waitResult?.timed_out, false);
    assert.ok((waitOk.waitResult?.elapsed_ms ?? 9999) < 4000);
    assert.equal(waitOk.waitResult?.pending.length, 0);

    // Non-throwing timeout on missing selector & missing text
    const waitTimeout = await tools.waitFor({
      selector: '#never-appears',
      text: 'NON_EXISTENT_NEEDLE',
      timeoutMs: 650,
    });
    assert.equal(waitTimeout.ok, false);
    assert.equal(waitTimeout.waitResult?.timed_out, true);
    assert.ok((waitTimeout.waitResult?.pending.length ?? 0) >= 2);
  } finally {
    await sess.close();
  }
}

async function testPrimitivesRefStaleAndProtocols(srv, outDir) {
  const sess = new BrowserSession({
    mode: 'auto',
    windowMode: 'headless',
    showTakeoverControl: true,
    takeoverHotkey: 'F8',
    activeSession: true,
  });
  await sess.start();
  try {
    const tools = new AtomicBrowserToolset(sess, path.join(outDir, 'primitives'));
    await tools.navigate(srv.url, 200);

    // Reserved hotkeys must all be blocked
    for (const badKey of ['F8', 'Control+F8', 'Shift+f8', 'Alt+F4']) {
      const rk = await tools.pressKey(badKey);
      assert.equal(rk.ok, false, `Expected ${badKey} to be blocked`);
      assert.equal(rk.blocked, 'RESERVED_HOTKEY');
    }

    // press_key Escape closes modal
    const modalVisibleBefore = await safeEvaluate(
      sess.page,
      () => !document.getElementById('modal')?.classList.contains('closed'),
      false,
      0
    );
    assert.equal(modalVisibleBefore, true);
    const escRes = await tools.pressKey('Escape');
    assert.equal(escRes.ok, true);
    const modalVisibleAfter = await safeEvaluate(
      sess.page,
      () => !document.getElementById('modal')?.classList.contains('closed'),
      true,
      0
    );
    assert.equal(modalVisibleAfter, false);

    // Control+A selects all in input and overwrites
    await tools.click('#txt-input', 80);
    await tools.pressKey('Control+A');
    await sess.page.keyboard.type('NEW_VAL');
    const typedVal = await safeEvaluate(
      sess.page,
      () => document.getElementById('txt-input')?.value ?? '',
      '',
      0
    );
    assert.equal(typedVal, 'NEW_VAL');

    // select_option by label
    const selRes = await tools.selectOption('#city-select', { label: 'Shenzhen' });
    assert.equal(selRes.ok, true);
    assert.equal(selRes.extraData?.selectedValue, 'sz');
    assert.equal(selRes.extraData?.selectedLabel, 'Shenzhen');

    // mailto: / tel: -> EXTERNAL_PROTOCOL, javascript: -> JS_URL
    const mailtoRes = await tools.click('#mailto-link', 80);
    assert.equal(mailtoRes.ok, false);
    assert.equal(mailtoRes.blocked, 'EXTERNAL_PROTOCOL');
    assert.equal(mailtoRes.protocol, 'mailto:');
    assert.equal(mailtoRes.href, 'mailto:test@example.com');

    const telRes = await tools.click('#tel-link', 80);
    assert.equal(telRes.ok, false);
    assert.equal(telRes.blocked, 'EXTERNAL_PROTOCOL');
    assert.equal(telRes.protocol, 'tel:');
    assert.equal(telRes.href, 'tel:+8613800138000');

    const jsLinkRes = await tools.click('#js-link', 80);
    assert.equal(jsLinkRes.ok, false);
    assert.equal(jsLinkRes.blocked, 'JS_URL');
    assert.equal(jsLinkRes.protocol, 'javascript:');
    const jsExecuted = await safeEvaluate(sess.page, () => Boolean(window.__jsHrefRan), true, 0);
    assert.equal(jsExecuted, false, 'javascript: link script must NOT execute');

    const navJs = await tools.navigate('javascript:alert(1)', 50);
    assert.equal(navJs.ok, false);
    assert.equal(navJs.blocked, 'JS_URL');

    const navMailto = await tools.navigate('mailto:nav@example.com', 50);
    assert.equal(navMailto.ok, false);
    assert.equal(navMailto.blocked, 'EXTERNAL_PROTOCOL');

    // paused state disables capture interception so human can freely click external links
    await safeEvaluate(
      sess.page,
      () => {
        window.__dshCursorAPI?.setTakeoverState('paused', 'Human');
        const link = document.getElementById('js-link');
        link.click();
      },
      undefined,
      0
    );
    const jsInPaused = await safeEvaluate(sess.page, () => Boolean(window.__jsHrefRan), false, 0);
    assert.equal(jsInPaused, true, 'paused mode must not intercept human clicks');
    await safeEvaluate(sess.page, () => window.__dshCursorAPI?.setTakeoverState('running', 'Agent'), undefined, 0);

    // History navigation & mandatory REF_STALE invalidation
    const noHist = await tools.goBack();
    assert.equal(noHist.ok, false);
    assert.equal(noHist.no_history, true);

    const p1Snap = await tools.sampler.captureSnapshot('p1_refs');
    const firstBtnRef = p1Snap.interactiveElements.find((e) => e.label.includes('First Action'))?.ref;
    assert.ok(firstBtnRef, 'Expected First Action ref on page 1');

    await tools.navigate(`${srv.url}page2`, 150);
    const backRes = await tools.goBack();
    assert.equal(backRes.ok, true);
    assert.equal(backRes.navigation?.final_url, srv.url);

    // Old page1 ref clicked after go_back MUST return REF_STALE (never silent click)
    const staleAfterBack = await tools.click(firstBtnRef, 80);
    assert.equal(staleAfterBack.ok, false);
    assert.equal(staleAfterBack.blocked, 'REF_STALE');
    const clicksOnOldBtn = await safeEvaluate(sess.page, () => Number(window.__firstBtnClicks || 0), -1, 0);
    assert.equal(clicksOnOldBtn, 0);

    const fwdRes = await tools.goForward();
    assert.equal(fwdRes.ok, true);
    assert.ok(fwdRes.navigation?.final_url.includes('/page2'));

    const p2Snap = await tools.sampler.captureSnapshot('p2_refs');
    const p2BtnRef = p2Snap.interactiveElements.find((e) => e.label.includes('Page Two Button'))?.ref;
    assert.ok(p2BtnRef, 'Expected Page Two Button ref on page 2');

    const relRes = await tools.reload();
    assert.equal(relRes.ok, true);
    const staleAfterReload = await tools.click(p2BtnRef, 80);
    assert.equal(staleAfterReload.ok, false);
    assert.equal(staleAfterReload.blocked, 'REF_STALE');

    // Navigate forward after back to confirm REF_STALE after go_forward too
    await tools.goBack();
    const backBtnRef = (await tools.sampler.captureSnapshot('back_refs')).interactiveElements.find((e) =>
      e.label.includes('First Action')
    )?.ref;
    assert.ok(backBtnRef);
    await tools.goForward();
    const staleAfterFwd = await tools.click(backBtnRef, 80);
    assert.equal(staleAfterFwd.ok, false);
    assert.equal(staleAfterFwd.blocked, 'REF_STALE');
  } finally {
    await sess.close();
  }
}

async function testNativeDialogsAndSubagentPause(srv, outDir) {
  // Verify alert & confirm logged to HUD, and prompt triggers PROMPT_REQUIRES_HUMAN -> paused
  const runner = new BrowserSubagentRunner();
  let stepCount = 0;
  try {
    const res = await runner.runTask({
      role: 'Dialog QA',
      taskPrompt: 'Test alert, confirm, prompt handling',
      startUrl: srv.url,
      artifactDir: outDir,
      maxSteps: 6,
      sessionOptions: { windowMode: 'headless', showTakeoverControl: true },
      planner: async (ctx) => {
        stepCount++;
        if (stepCount === 1) {
          return { type: 'click', target: '#btn-alert', reason: 'Trigger alert' };
        }
        if (stepCount === 2) {
          const hasAlertText = ctx.history
            .getEntries()
            .some((e) => e.fullHudText.includes('Hello from alert dialog'));
          assert.equal(hasAlertText, true, 'Expected alert message in HUD history');
          return { type: 'click', target: '#btn-confirm', reason: 'Trigger confirm' };
        }
        if (stepCount === 3) {
          const hasConfirmText = ctx.history
            .getEntries()
            .some((e) => e.fullHudText.includes('Confirm action?'));
          assert.equal(hasConfirmText, true, 'Expected confirm message in HUD history');
          return { type: 'click', target: '#btn-prompt', reason: 'Trigger prompt -> pause' };
        }
        return { type: 'complete', report: 'SHOULD_NOT_REACH' };
      },
    });
    assert.equal(res.status, 'PAUSED_FOR_TAKEOVER');
    assert.equal(res.approvalCard?.reason, 'PROMPT_REQUIRES_HUMAN');
  } finally {
    await runner.closeAllSessions();
  }
}

async function testWin32NotTopmost(srv) {
  if (process.platform !== 'win32') {
    console.log('[v2.0.0] Skipping Win32 HWND_NOTOPMOST live test (non-win32)');
    return;
  }
  const sess = new BrowserSession({
    mode: 'auto',
    windowMode: 'visible-background',
    showTakeoverControl: true,
  });
  await sess.start();
  try {
    await sess.navigate(srv.url, 'domcontentloaded', 10000);
    const hwnd = sess.launchedHwnd ?? 0;
    assert.ok(hwnd > 0, `Expected positive launchedHwnd, got ${hwnd}`);

    // Artificially set HWND_TOPMOST (-1) then run ensureWindowNotTopmostWin32(hwnd)
    const psSetTopmost = `
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DshTestSetTopmost {
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
  [DllImport("user32.dll", EntryPoint = "GetWindowLong")] public static extern int GetWindowLong32(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr")] public static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);
  public static bool ForceTopmost(long h) {
    IntPtr hw = new IntPtr(h);
    SetWindowPos(hw, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0010);
    long ex = IntPtr.Size == 8 ? GetWindowLongPtr64(hw, -20).ToInt64() : (long)GetWindowLong32(hw, -20);
    return (ex & 0x00000008L) != 0;
  }
}
"@
Write-Output ([DshTestSetTopmost]::ForceTopmost(${hwnd}))
`;
    const encoded = Buffer.from(psSetTopmost, 'utf16le').toString('base64');
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
      { timeout: 8000, windowsHide: true }
    );
    assert.ok(stdout.trim().endsWith('True'), `Failed to force WS_EX_TOPMOST for test: ${stdout}`);

    const healed = await ensureWindowNotTopmostWin32(hwnd);
    assert.equal(healed.checked, true);
    assert.equal(healed.clearedTopmost, true);

    // Calling again should report already clean
    const secondCheck = await ensureWindowNotTopmostWin32(hwnd);
    assert.equal(secondCheck.checked, true);
    assert.equal(secondCheck.clearedTopmost, false);
  } finally {
    await sess.close();
  }
}

async function main() {
  const srv = await startFixtureServer();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vb-v200-'));
  try {
    await testZeroSideEffectAndViewportDpr(srv, outDir);
    await testWaitFor(srv, outDir);
    await testPrimitivesRefStaleAndProtocols(srv, outDir);
    await testNativeDialogsAndSubagentPause(srv, outDir);
    await testWin32NotTopmost(srv);
    console.log('✅ verify-v200: All v2.0.0 runtime assertions PASSED!');
  } finally {
    await srv.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
