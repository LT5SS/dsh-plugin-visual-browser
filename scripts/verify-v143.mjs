#!/usr/bin/env node
/**
 * verify-v143.mjs — Standalone runtime verification for TASK-v1.4.3.md.
 * Imports ONLY built dist subpath modules (no @deepseek-ai/dsh-tools dependency)
 * so it runs cleanly after `npm ci --omit=dev --omit=peer`.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { BrowserSession, findLocalBrowserExecutable } from '../dist/driver/browser-session.js';
import { buildVirtualCursorInitScript } from '../dist/injected/virtual-cursor.js';
import { safeEvaluate } from '../dist/sampler/page-snapshot.js';
import { BrowserSubagentRunner } from '../dist/subagent/runner.js';
import { AtomicBrowserToolset } from '../dist/tools/atomic-tools.js';

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>v1.4.3 Takeover State Fixture</title></head>
<body style="margin:0;padding:24px;font-family:sans-serif;">
  <h1>DSH v1.4.3 Takeover Pill Verification</h1>
  <button id="action-btn" type="button">Action</button>
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

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function waitForCdpReady(port, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Timed out waiting for CDP endpoint on port ${port}`);
}

async function readPillState(page) {
  return await safeEvaluate(
    page,
    () => {
      const api = window.__dshCursorAPI;
      const st = api?.getState?.() ?? null;
      const panel = document.getElementById('__dsh_vc_panel__');
      const txt = document.getElementById('__dsh_vc_status_text__');
      const btn = document.getElementById('__dsh_vc_takeover_btn__');
      return {
        takeoverMode: st?.takeoverMode ?? '',
        text: txt?.textContent ?? '',
        panelDisplay: panel ? getComputedStyle(panel).display : '',
        btnDisplay: btn ? getComputedStyle(btn).display : '',
        btnText: btn?.textContent ?? '',
        btnPointerEvents: btn ? getComputedStyle(btn).pointerEvents : '',
        unloadGuard: api?.isUnloadGuardActive?.() ?? false,
      };
    },
    null,
    0
  );
}

const srv = await startFixtureServer();
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v143-'));
const runner = new BrowserSubagentRunner();

try {
  // 1. Fresh BrowserSession without active task -> idle + hidden button; re-inject & reload stay idle; F8 ignored when idle
  const idleSession = await new BrowserSession({
    mode: 'auto',
    windowMode: 'headless',
    showTakeoverControl: true,
    takeoverHotkey: 'F8',
  }).start();
  try {
    await idleSession.navigate(srv.url, 'domcontentloaded');
    const p1 = await readPillState(idleSession.page);
    assert.equal(p1.takeoverMode, 'idle');
    assert.equal(p1.text, 'DSH 待命 · 窗口保持打开（无任务）');
    assert.equal(p1.panelDisplay, 'flex');
    assert.equal(p1.btnDisplay, 'none');

    await idleSession.page.keyboard.press('F8');
    assert.equal(await idleSession.checkHumanTakeoverRequested(), false, 'F8 must not trigger takeover when idle');

    // Simulate stale 'running' then re-inject default initScript (as happens on style/HUD re-inject)
    await safeEvaluate(
      idleSession.page,
      (scriptStr) => {
        window.__dshCursorAPI?.setTakeoverState?.('running', 'OldTask');
        (0, eval)(scriptStr);
      },
      undefined,
      { arg: buildVirtualCursorInitScript({}, { showTakeoverControl: true }), retries: 0 }
    );
    const pAfterReinject = await readPillState(idleSession.page);
    assert.equal(pAfterReinject.takeoverMode, 'idle');
    assert.equal(pAfterReinject.text, 'DSH 待命 · 窗口保持打开（无任务）');
    assert.equal(pAfterReinject.btnDisplay, 'none');

    // Simulate user manual page reload
    await idleSession.page.reload({ waitUntil: 'domcontentloaded' });
    await idleSession.motion.ensureCursorHUD(true);
    const pAfterReload = await readPillState(idleSession.page);
    assert.equal(pAfterReload.takeoverMode, 'idle');
    assert.equal(pAfterReload.text, 'DSH 待命 · 窗口保持打开（无任务）');
    assert.equal(pAfterReload.btnDisplay, 'none');
  } finally {
    await idleSession.close().catch(() => {});
  }
  console.log('[v1.4.3] 1/5 Fresh inject, re-inject, F8-when-idle & reload stay idle cleanly!');

  // 2. quick_snapshot-equivalent acquireReusableSession + releaseReusableSession keeps idle & style sync preserves idle
  const snapAcq = await runner.acquireReusableSession(
    {
      mode: 'auto',
      windowMode: 'headless',
      keepWindowOpen: true,
      showTakeoverControl: true,
      takeoverHotkey: 'F8',
    },
    true
  );
  const snapTools = new AtomicBrowserToolset(snapAcq.session, path.join(outDir, 'quick-snap'));
  await snapTools.navigate(srv.url, 200);
  const snapDuring = await readPillState(snapAcq.session.page);
  assert.equal(snapDuring.takeoverMode, 'idle');
  assert.equal(snapDuring.text, 'DSH 待命 · 窗口保持打开（无任务）');
  assert.equal(snapDuring.btnDisplay, 'none');
  await runner.releaseReusableSession(snapAcq.session, true);
  await snapAcq.session.motion.setCursorStyle({ preset: 'comet-gold' });
  const snapAfterStyle = await readPillState(snapAcq.session.page);
  assert.equal(snapAfterStyle.takeoverMode, 'idle');
  assert.equal(snapAfterStyle.text, 'DSH 待命 · 窗口保持打开（无任务）');
  assert.equal(snapAfterStyle.btnDisplay, 'none');
  console.log('[v1.4.3] 2/5 Quick snapshot reuse & setCursorStyle keep shared session idle!');

  // 3. Subagent run transitions shared session -> running (red button shown) -> completed idle (button hidden)
  let duringTaskPill = null;
  const runRes = await runner.runTask({
    startUrl: srv.url,
    role: 'Inspector',
    taskPrompt: 'Verify running -> idle pill transition',
    maxSteps: 2,
    artifactDir: outDir,
    keepWindowOpen: true,
    sessionOptions: {
      mode: 'auto',
      windowMode: 'headless',
      keepWindowOpen: true,
      showTakeoverControl: true,
      takeoverHotkey: 'F8',
    },
    planner: async () => {
      const s = runner.getSharedSession();
      assert.ok(s);
      duringTaskPill = await readPillState(s.page);
      return { type: 'complete', report: 'V143_RUN_COMPLETE' };
    },
  });
  assert.equal(runRes.status, 'COMPLETED');
  assert.ok(duringTaskPill);
  assert.equal(duringTaskPill.takeoverMode, 'running');
  assert.ok(duringTaskPill.text.includes('DSH Agent 运行中'));
  assert.ok(duringTaskPill.text.includes('按 F8 接管'));
  assert.notEqual(duringTaskPill.btnDisplay, 'none');
  assert.equal(duringTaskPill.btnText, '按 F8 接管');

  const sharedAfterRun = runner.getSharedSession();
  assert.ok(sharedAfterRun);
  const afterRunPill = await readPillState(sharedAfterRun.page);
  assert.equal(afterRunPill.takeoverMode, 'idle');
  assert.equal(afterRunPill.text, 'DSH 待命 · 窗口保持打开（无任务）');
  assert.equal(afterRunPill.btnDisplay, 'none');
  console.log('[v1.4.3] 3/5 Subagent run -> running (with button) -> completed idle (hidden button)!');

  // 4. F8 pause shows '已暂停 · 等待人工接管' and button '继续执行' with pointer-events:auto
  let pauseStepCalls = 0;
  let capturedPauseSession = null;
  const pauseRes = await runner.runTask({
    startUrl: srv.url,
    role: 'Takeover Check',
    taskPrompt: 'Verify paused copy and resume button text',
    maxSteps: 3,
    artifactDir: outDir,
    keepWindowOpen: true,
    sessionOptions: {
      mode: 'auto',
      windowMode: 'headless',
      keepWindowOpen: true,
      showTakeoverControl: true,
      takeoverHotkey: 'F8',
    },
    planner: async () => {
      pauseStepCalls++;
      if (pauseStepCalls === 1) {
        capturedPauseSession = runner.getSharedSession();
        assert.ok(capturedPauseSession);
        await capturedPauseSession.page.keyboard.press('F8');
        return { type: 'scroll', deltaY: 100, reason: 'Trigger F8 pause' };
      }
      return { type: 'complete', report: 'RESUMED' };
    },
  });
  assert.equal(pauseRes.status, 'PAUSED_FOR_TAKEOVER');
  assert.ok(capturedPauseSession);
  const pausedPill = await readPillState(capturedPauseSession.page);
  assert.equal(pausedPill.takeoverMode, 'paused');
  assert.ok(pausedPill.text.startsWith('已暂停 · 等待人工接管'), `Unexpected paused text: ${pausedPill.text}`);
  assert.notEqual(pausedPill.btnDisplay, 'none');
  assert.equal(pausedPill.btnText, '继续执行');
  assert.equal(pausedPill.btnPointerEvents, 'auto');
  console.log('[v1.4.3] 4/5 F8 pause copy & 继续执行 button passed!');

  // 5. Real CDP-attach restart cleanup + runner.closeAllSessions() proactive idle reset
  const cdpPort = await getFreePort();
  const cdpProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v143-cdp-'));
  const chromeExe = findLocalBrowserExecutable();
  const child = spawn(
    chromeExe,
    [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--mute-audio',
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${cdpProfile}`,
      srv.url,
    ],
    { stdio: 'ignore', windowsHide: true }
  );
  let extBrowser = null;
  try {
    await waitForCdpReady(cdpPort, 10000);
    extBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const extPage = extBrowser.contexts()[0].pages()[0];
    await extPage.waitForLoadState('domcontentloaded');

    // Inject stale running pill as left over by an ungraceful previous DSH process
    await safeEvaluate(
      extPage,
      (scriptStr) => {
        (0, eval)(scriptStr);
      },
      undefined,
      {
        arg: buildVirtualCursorInitScript({}, { showTakeoverControl: true, activeSession: true, takeoverHotkey: 'F8' }),
        retries: 0,
      }
    );
    const staleBefore = await readPillState(extPage);
    assert.equal(staleBefore.takeoverMode, 'running');
    assert.ok(staleBefore.text.includes('DSH Agent 运行中'));

    // Attaching a fresh idle CDP BrowserSession immediately clears stale running -> idle
    const restartAttached = await new BrowserSession({
      mode: 'cdp-attach',
      cdpEndpoint: `http://127.0.0.1:${cdpPort}`,
      showTakeoverControl: true,
      takeoverHotkey: 'F8',
    }).start();
    await restartAttached.close();
    const afterRestartAttach = await readPillState(extPage);
    assert.equal(afterRestartAttach.takeoverMode, 'idle');
    assert.equal(afterRestartAttach.text, 'DSH 待命 · 窗口保持打开（无任务）');
    assert.equal(afterRestartAttach.btnDisplay, 'none');

    // Simulate active running state on CDP session then unload plugin via runner.closeAllSessions()
    const cdpRunner = new BrowserSubagentRunner();
    const acqCdp = await cdpRunner.acquireReusableSession(
      {
        mode: 'cdp-attach',
        cdpEndpoint: `http://127.0.0.1:${cdpPort}`,
        showTakeoverControl: true,
        takeoverHotkey: 'F8',
      },
      true
    );
    await acqCdp.session.motion.setUnloadGuard(true);
    await acqCdp.session.motion.setTakeoverState('running', 'ExitingTask');
    const beforeCloseAll = await readPillState(extPage);
    assert.equal(beforeCloseAll.takeoverMode, 'running');
    assert.equal(beforeCloseAll.unloadGuard, true);

    await cdpRunner.closeAllSessions();
    const afterCloseAll = await readPillState(extPage);
    assert.equal(afterCloseAll.takeoverMode, 'idle');
    assert.equal(afterCloseAll.text, 'DSH 待命 · 窗口保持打开（无任务）');
    assert.equal(afterCloseAll.btnDisplay, 'none');
    assert.equal(afterCloseAll.unloadGuard, false);
    console.log('[v1.4.3] 5/5 Real CDP attach restart & closeAllSessions() proactive idle cleanup passed!');
  } finally {
    await extBrowser?.close().catch(() => {});
    try {
      child.kill();
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(cdpProfile, { recursive: true, force: true });
  }

  console.log('✅ verify-v143 passed!');
} finally {
  await runner.closeAllSessions().catch(() => {});
  await srv.close();
  fs.rmSync(outDir, { recursive: true, force: true });
}
