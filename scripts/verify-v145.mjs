#!/usr/bin/env node
/**
 * verify-v145.mjs — Standalone runtime verification for TASK-v1.4.5.md.
 * Uses real `page.mouse.click(x, y)` (never element.click() shortcuts) to verify
 * hit-testing, click absorption on the visible capsule, clickable red pause button,
 * `PLUGIN_UI_LAYER` guard for raw coordinates, and `paused_by: 'button'` -> `resumed_by: 'button'`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BrowserSession } from '../dist/driver/browser-session.js';
import { safeEvaluate } from '../dist/sampler/page-snapshot.js';
import { BrowserSubagentRunner } from '../dist/subagent/runner.js';
import { AtomicBrowserToolset } from '../dist/tools/atomic-tools.js';

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>v1.4.5 Real Mouse Click Fixture</title></head>
<body style="margin:0;padding:24px;height:2000px;font-family:sans-serif;">
  <a id="top-hire" class="top__hire" href="#contact" style="position:fixed;top:14px;right:14px;width:380px;height:44px;display:flex;align-items:center;justify-content:center;background:#111827;color:#ffffff;text-decoration:none;font-size:13px;z-index:10;" onclick="window.__topHireClicks=(window.__topHireClicks||0)+1;return false;">top__hire #contact</a>
  <h1>v1.4.5 Capsule Click Isolation</h1>
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

function readDiagnostics(artifactDir, subagentId) {
  const file = path.join(artifactDir, subagentId, 'diagnostics.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

async function waitUntil(fn, timeoutMs = 6000, intervalMs = 40) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const val = await fn();
    if (val) return val;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return await fn();
}

async function readGeometryAndFlags(page) {
  return await safeEvaluate(
    page,
    () => {
      const panel = document.getElementById('__dsh_vc_panel__');
      const txt = document.getElementById('__dsh_vc_status_text__');
      const btn = document.getElementById('__dsh_vc_takeover_btn__');
      const pRect = panel?.getBoundingClientRect();
      const tRect = txt?.getBoundingClientRect();
      const bRect = btn?.getBoundingClientRect();
      const pMid = pRect ? { x: Math.round(pRect.left + pRect.width / 2), y: Math.round(pRect.top + pRect.height / 2) } : null;
      const tMid = tRect ? { x: Math.round(tRect.left + Math.min(28, tRect.width / 2)), y: Math.round(tRect.top + tRect.height / 2) } : null;
      const bMid = bRect && bRect.width > 0 ? { x: Math.round(bRect.left + bRect.width / 2), y: Math.round(bRect.top + bRect.height / 2) } : null;
      const hitPanel = pMid ? document.elementFromPoint(pMid.x, pMid.y) : null;
      const hitTxt = tMid ? document.elementFromPoint(tMid.x, tMid.y) : null;
      const hitBtn = bMid ? document.elementFromPoint(bMid.x, bMid.y) : null;
      return {
        mode: window.__dshCursorAPI?.getState?.()?.takeoverMode ?? '',
        panelPe: panel ? getComputedStyle(panel).pointerEvents : '',
        btnPe: btn ? getComputedStyle(btn).pointerEvents : '',
        btnCursor: btn ? getComputedStyle(btn).cursor : '',
        btnDisplay: btn ? getComputedStyle(btn).display : '',
        btnText: btn?.textContent?.trim() ?? '',
        btnTitle: btn?.getAttribute('title') ?? '',
        txtText: txt?.textContent?.trim() ?? '',
        pMid,
        tMid,
        bMid,
        hitPanelId: hitPanel?.id ?? '',
        hitPanelInVcRoot: Boolean(hitPanel?.closest?.('#__dsh_vc_root__')),
        hitTxtId: hitTxt?.id ?? '',
        hitTxtInVcRoot: Boolean(hitTxt?.closest?.('#__dsh_vc_root__')),
        hitBtnId: hitBtn?.id ?? '',
        topHireClicks: Number(window.__topHireClicks || 0),
        takeoverRequested: Boolean(window.__dshTakeoverRequested),
        takeoverSource: String(window.__dshTakeoverSource || ''),
        resumeRequested: Boolean(window.__dshResumeRequested),
      };
    },
    null,
    0
  );
}

const srv = await startFixtureServer();
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v145-'));

try {
  // 1-4. Direct real-mouse hit testing across running / paused / idle + underlying click protection
  const session = new BrowserSession({
    mode: 'auto',
    windowMode: 'headless',
    showTakeoverControl: true,
    takeoverHotkey: 'F8',
  });
  await session.start();
  try {
    await session.page.setViewportSize({ width: 1000, height: 700 });
    await session.navigate(srv.url, 'domcontentloaded');

    // A) running state: click status text area -> absorbed (never leaks); click red button -> triggers takeover ('button')
    await session.motion.setTakeoverState('running', 'RealClick');
    await safeEvaluate(session.page, () => {
      window.__topHireClicks = 0;
      window.__dshTakeoverRequested = false;
      window.__dshTakeoverSource = '';
    }, undefined, 0);

    const runGeo = await readGeometryAndFlags(session.page);
    assert.equal(runGeo.mode, 'running');
    assert.equal(runGeo.panelPe, 'auto');
    assert.equal(runGeo.btnPe, 'auto');
    assert.equal(runGeo.btnCursor, 'pointer');
    assert.equal(runGeo.btnText, '暂停并接管');
    assert.ok(runGeo.btnTitle.includes('F8'));
    assert.equal(runGeo.hitTxtInVcRoot, true, `Text point hit outside #__dsh_vc_root__: ${runGeo.hitTxtId}`);
    assert.equal(runGeo.hitBtnId, '__dsh_vc_takeover_btn__');

    // Real mouse click on pill status text -> absorbed, zero leak to #top-hire
    await session.page.mouse.click(runGeo.tMid.x, runGeo.tMid.y);
    const afterTxtClick = await readGeometryAndFlags(session.page);
    assert.equal(afterTxtClick.topHireClicks, 0, 'Running pill text area must NOT leak clicks to #top-hire');
    assert.equal(afterTxtClick.takeoverRequested, false, 'Clicking pill status text must NOT trigger takeover');

    // Real mouse click on red button center -> triggers takeover ('button') and zero leak to #top-hire
    await session.page.mouse.click(runGeo.bMid.x, runGeo.bMid.y);
    const afterBtnClick = await readGeometryAndFlags(session.page);
    assert.equal(afterBtnClick.takeoverRequested, true, 'Real mouse click on running red button must set __dshTakeoverRequested');
    assert.equal(afterBtnClick.takeoverSource, 'button');
    assert.equal(afterBtnClick.topHireClicks, 0, 'Running red button must NOT leak click to #top-hire');

    // B) paused state: click text area -> absorbed; click '继续执行' -> __dshResumeRequested = true & zero leak
    await session.motion.setTakeoverState('paused', 'RealClick');
    await safeEvaluate(session.page, () => {
      window.__topHireClicks = 0;
      window.__dshResumeRequested = false;
    }, undefined, 0);
    const pauseGeo = await readGeometryAndFlags(session.page);
    assert.equal(pauseGeo.mode, 'paused');
    assert.equal(pauseGeo.btnText, '继续执行');
    assert.equal(pauseGeo.hitTxtInVcRoot, true);
    assert.equal(pauseGeo.hitBtnId, '__dsh_vc_takeover_btn__');

    await session.page.mouse.click(pauseGeo.tMid.x, pauseGeo.tMid.y);
    const afterPauseTxt = await readGeometryAndFlags(session.page);
    assert.equal(afterPauseTxt.topHireClicks, 0);
    assert.equal(afterPauseTxt.resumeRequested, false);

    await session.page.mouse.click(pauseGeo.bMid.x, pauseGeo.bMid.y);
    const afterPauseBtn = await readGeometryAndFlags(session.page);
    assert.equal(afterPauseBtn.resumeRequested, true);
    assert.equal(afterPauseBtn.topHireClicks, 0);

    // C) idle state: click capsule -> absorbed, zero leak, zero takeover/resume
    await session.motion.setTakeoverState('idle');
    await safeEvaluate(session.page, () => {
      window.__topHireClicks = 0;
      window.__dshTakeoverRequested = false;
      window.__dshResumeRequested = false;
    }, undefined, 0);
    const idleGeo = await readGeometryAndFlags(session.page);
    assert.equal(idleGeo.mode, 'idle');
    assert.equal(idleGeo.btnDisplay, 'none');
    assert.equal(idleGeo.panelPe, 'auto');
    assert.equal(idleGeo.hitPanelInVcRoot, true);

    await session.page.mouse.click(idleGeo.pMid.x, idleGeo.pMid.y);
    const afterIdleClick = await readGeometryAndFlags(session.page);
    assert.equal(afterIdleClick.topHireClicks, 0);
    assert.equal(afterIdleClick.takeoverRequested, false);
    assert.equal(afterIdleClick.resumeRequested, false);

    // D) Raw coordinate click on pill is still blocked as PLUGIN_UI_LAYER, while verified page selector click succeeds & restores auto
    const tools = new AtomicBrowserToolset(session, path.join(outDir, 'layer-tools'));
    await session.motion.setTakeoverState('running', 'LayerGuard');
    await safeEvaluate(session.page, () => {
      window.__topHireClicks = 0;
      window.__dshTakeoverRequested = false;
    }, undefined, 0);
    const curRun = await readGeometryAndFlags(session.page);
    const blockedCoord = await tools.click({ x: curRun.bMid.x, y: curRun.bMid.y }, 60);
    assert.equal(blockedCoord.ok, false);
    assert.equal(blockedCoord.blocked, 'PLUGIN_UI_LAYER');
    const blockedSel = await tools.click('#__dsh_vc_takeover_btn__', 60);
    assert.equal(blockedSel.ok, false);
    assert.equal(blockedSel.blocked, 'PLUGIN_UI_LAYER');
    const safePageSel = await tools.click('a#top-hire', 60);
    assert.equal(safePageSel.ok, true, `Expected page selector click under pill to pass through safely, got ${JSON.stringify(safePageSel)}`);
    const afterTools = await readGeometryAndFlags(session.page);
    assert.equal(afterTools.topHireClicks, 1);
    assert.equal(afterTools.takeoverRequested, false);
    assert.equal(afterTools.panelPe, 'auto');
    assert.equal(afterTools.btnPe, 'auto');
  } finally {
    await session.close().catch(() => {});
  }
  console.log('[v1.4.5] 1/2 Real mouse clicks across running/paused/idle & PLUGIN_UI_LAYER isolation passed!');

  // 5. Full E2E: runTask -> real mouse click on red button -> paused_by:'button' -> real mouse click '继续执行' -> resumed_by:'button' -> COMPLETED
  const runner = new BrowserSubagentRunner();
  try {
    let e2eSteps = 0;
    let capturedPauseSession = null;
    const subId = 'v145-real-btn-pause-resume';
    const pausedRes = await runner.runTask({
      subagentId: subId,
      startUrl: srv.url,
      role: 'v1.4.5 E2E',
      taskPrompt: 'Pause by clicking red button then resume by clicking continue',
      maxSteps: 4,
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
        e2eSteps++;
        const s = runner.getSharedSession();
        if (e2eSteps === 1) {
          capturedPauseSession = s;
          const geo = await readGeometryAndFlags(s.page);
          await s.page.mouse.click(geo.bMid.x, geo.bMid.y);
          return { type: 'scroll', deltaY: 120, reason: 'Trigger button pause during step 1' };
        }
        await new Promise((r) => setTimeout(r, 200));
        return { type: 'complete', report: 'V145_BTN_PAUSE_RESUME_OK' };
      },
    });

    assert.equal(pausedRes.status, 'PAUSED_FOR_TAKEOVER');
    assert.equal(pausedRes.pausedBy, 'button', `Expected pausedBy==='button', got ${pausedRes.pausedBy}`);
    const pausedDiag = readDiagnostics(outDir, subId);
    assert.equal(pausedDiag?.status, 'PAUSED_FOR_TAKEOVER');
    assert.equal(pausedDiag?.paused_by, 'button');
    assert.ok(pausedDiag?.paused_at);

    const pauseGeo2 = await readGeometryAndFlags(capturedPauseSession.page);
    assert.equal(pauseGeo2.topHireClicks, 0, 'Pausing via red button must not click underlying link');
    assert.equal(pauseGeo2.mode, 'paused');
    assert.equal(pauseGeo2.btnText, '继续执行');

    await capturedPauseSession.page.mouse.click(pauseGeo2.bMid.x, pauseGeo2.bMid.y);
    const doneDiag = await waitUntil(
      () => {
        const d = readDiagnostics(outDir, subId);
        return d && d.status === 'COMPLETED' ? d : null;
      },
      6000,
      40
    );
    assert.ok(doneDiag, 'Expected diagnostics.json to reach COMPLETED after clicking 继续执行');
    assert.equal(doneDiag.paused_by, 'button');
    assert.equal(doneDiag.resumed_by, 'button');
    assert.equal(e2eSteps, 2);
    const afterAllGeo = await readGeometryAndFlags(capturedPauseSession.page);
    assert.equal(afterAllGeo.topHireClicks, 0);
    assert.equal(afterAllGeo.mode, 'idle');
  } finally {
    await runner.closeAllSessions().catch(() => {});
  }
  console.log('[v1.4.5] 2/2 Full E2E real-mouse pause (paused_by=button) -> continue (resumed_by=button) -> COMPLETED passed!');
  console.log('✅ verify-v145 passed!');
} finally {
  await srv.close();
  fs.rmSync(outDir, { recursive: true, force: true });
}
