#!/usr/bin/env node
/**
 * verify-v144.mjs — Standalone runtime verification for TASK-v1.4.4.md (Option C).
 * Imports ONLY built dist subpath modules (no @deepseek-ai/dsh-tools dependency)
 * so it runs cleanly after `npm ci --omit=dev --omit=peer`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { safeEvaluate } from '../dist/sampler/page-snapshot.js';
import { BrowserSubagentRunner } from '../dist/subagent/runner.js';

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>v1.4.4 Continue Button Resume Fixture</title></head>
<body style="margin:0;padding:24px;font-family:sans-serif;height:2000px;">
  <h1>DSH v1.4.4 Option C Verification</h1>
  <button id="page-btn" type="button">Page Action</button>
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

async function readPillState(page) {
  return await safeEvaluate(
    page,
    () => {
      const api = window.__dshCursorAPI;
      const st = api?.getState?.() ?? null;
      const txt = document.getElementById('__dsh_vc_status_text__');
      const btn = document.getElementById('__dsh_vc_takeover_btn__');
      return {
        takeoverMode: st?.takeoverMode ?? '',
        text: txt?.textContent ?? '',
        btnDisplay: btn ? getComputedStyle(btn).display : '',
        btnText: btn?.textContent ?? '',
        btnTitle: btn?.getAttribute?.('title') ?? '',
        btnPointerEvents: btn ? getComputedStyle(btn).pointerEvents : '',
      };
    },
    null,
    0
  );
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

const srv = await startFixtureServer();
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v144-'));
const runner = new BrowserSubagentRunner();

try {
  // 1 & 2 & 3. F8 pause -> real click on '继续执行' -> resumes < 1s -> completes & updates diagnostics.json
  let stepCount1 = 0;
  let capturedPauseSess = null;
  const subId1 = 'v144-btn-resume-1';
  const res1 = await runner.runTask({
    subagentId: subId1,
    startUrl: srv.url,
    role: 'Button Resume QA',
    taskPrompt: 'Pause with F8 then resume via button click',
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
      stepCount1++;
      const s = runner.getSharedSession();
      if (stepCount1 === 1) {
        capturedPauseSess = s;
        await s.page.keyboard.press('F8');
        return { type: 'scroll', deltaY: 120, reason: 'Step 1 before F8 pause' };
      }
      await new Promise((r) => setTimeout(r, 250));
      return { type: 'complete', report: 'BUTTON_CLICK_RESUMED_OK' };
    },
  });

  assert.equal(res1.status, 'PAUSED_FOR_TAKEOVER');
  assert.equal(res1.pausedBy, 'f8');
  assert.ok(res1.pausedAt);
  assert.equal(runner.getActiveResumeWatcherCount(), 1);
  assert.ok(capturedPauseSess);

  const pausedPill = await readPillState(capturedPauseSess.page);
  assert.equal(pausedPill.takeoverMode, 'paused');
  assert.ok(pausedPill.text.startsWith('已暂停 · 等待人工接管'));
  assert.ok(pausedPill.text.includes('再按 F8 无效果'));
  assert.equal(pausedPill.btnText, '继续执行');
  assert.equal(pausedPill.btnPointerEvents, 'auto');
  assert.equal(readDiagnostics(outDir, subId1)?.status, 'PAUSED_FOR_TAKEOVER');
  assert.equal(readDiagnostics(outDir, subId1)?.paused_by, 'f8');

  const clickT0 = Date.now();
  await capturedPauseSess.page.locator('#__dsh_vc_takeover_btn__').click();

  // Check fast transition out of PAUSED_FOR_TAKEOVER (< 1s)
  const leftPausedDiag = await waitUntil(
    () => {
      const d = readDiagnostics(outDir, subId1);
      return d && d.status !== 'PAUSED_FOR_TAKEOVER' ? d : null;
    },
    1000,
    25
  );
  const transitionMs = Date.now() - clickT0;
  assert.ok(leftPausedDiag, 'diagnostics.json must leave PAUSED_FOR_TAKEOVER within 1s');
  assert.ok(transitionMs < 1000, `Expected button resume transition < 1000ms, got ${transitionMs}ms`);

  const finishedDiag = await waitUntil(
    () => {
      const d = readDiagnostics(outDir, subId1);
      return d && d.status === 'COMPLETED' ? d : null;
    },
    6000,
    40
  );
  assert.ok(finishedDiag, 'Expected resumed run to reach COMPLETED');
  assert.equal(finishedDiag.resumed_by, 'button');
  assert.ok(finishedDiag.resumed_at);
  assert.equal(stepCount1, 2, 'Expected planner step 2 to execute after clicking 继续执行');
  assert.equal(runner.getActiveResumeWatcherCount(), 0);
  assert.equal(runner.getPausedSessionCount(), 0);

  // Shared session re-adopted and back to idle
  const sharedAfterBtn = runner.getSharedSession();
  assert.ok(sharedAfterBtn && sharedAfterBtn.isAlive());
  const idleAfterBtn = await readPillState(sharedAfterBtn.page);
  assert.equal(idleAfterBtn.takeoverMode, 'idle');
  assert.equal(idleAfterBtn.btnDisplay, 'none');

  // Tool call after button-completed resume returns the cached result cleanly
  const cachedToolRes = await runner.resumeTask(subId1);
  assert.equal(cachedToolRes.status, 'COMPLETED');
  assert.equal(cachedToolRes.resumedBy, 'button');
  console.log(`[v1.4.4] 1/4 Real click on 继续执行 resumed & completed in ${transitionMs}ms (diagnostics updated)!`);

  // 4. Direct resumeTask() tool call still works when user does NOT click button
  let stepCount2 = 0;
  const subId2 = 'v144-tool-resume-2';
  const res2Paused = await runner.runTask({
    subagentId: subId2,
    startUrl: srv.url,
    role: 'Tool Resume QA',
    taskPrompt: 'Pause with F8 then resume via resumeTask()',
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
      stepCount2++;
      if (stepCount2 === 1) {
        const s = runner.getSharedSession();
        await s.page.keyboard.press('F8');
        return { type: 'scroll', deltaY: 80, reason: 'Pause step 1' };
      }
      return { type: 'complete', report: 'TOOL_RESUMED_OK' };
    },
  });
  assert.equal(res2Paused.status, 'PAUSED_FOR_TAKEOVER');
  assert.equal(runner.getActiveResumeWatcherCount(), 1);
  const res2Done = await runner.resumeTask(subId2, 'Manual continue via tool');
  assert.equal(res2Done.status, 'COMPLETED');
  assert.equal(res2Done.resumedBy, 'tool');
  assert.equal(stepCount2, 2);
  assert.equal(runner.getActiveResumeWatcherCount(), 0);
  console.log('[v1.4.4] 2/4 Direct resumeTask() path passed cleanly & stopped watcher!');

  // 5. Pure 500ms interval polling fallback (flag set without calling __dshRequestResume) + closeAllSessions watcher cleanup
  let stepCount3 = 0;
  let capturedPollSess = null;
  const subId3 = 'v144-poll-fallback-3';
  const res3Paused = await runner.runTask({
    subagentId: subId3,
    startUrl: srv.url,
    role: 'Polling Fallback QA',
    taskPrompt: 'Verify 500ms watcher catches __dshResumeRequested without binding',
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
      stepCount3++;
      if (stepCount3 === 1) {
        capturedPollSess = runner.getSharedSession();
        await capturedPollSess.page.keyboard.press('F8');
        return { type: 'scroll', deltaY: 80, reason: 'Pause for poll fallback' };
      }
      return { type: 'complete', report: 'POLL_FALLBACK_OK' };
    },
  });
  assert.equal(res3Paused.status, 'PAUSED_FOR_TAKEOVER');
  assert.equal(runner.getActiveResumeWatcherCount(), 1);
  await safeEvaluate(
    capturedPollSess.page,
    () => {
      window.__dshResumeRequested = true;
    },
    undefined,
    0
  );
  const pollDone = await waitUntil(
    () => {
      const d = readDiagnostics(outDir, subId3);
      return d && d.status === 'COMPLETED' ? d : null;
    },
    2500,
    40
  );
  assert.ok(pollDone, '500ms watcher must catch __dshResumeRequested flag and complete');
  assert.equal(stepCount3, 2);
  assert.equal(runner.getActiveResumeWatcherCount(), 0);
  console.log('[v1.4.4] 3/4 500ms watcher fallback passed!');

  // Pause and unload -> closeAllSessions() must clear all resumeWatchers
  let pause4Sess = null;
  const res4Paused = await runner.runTask({
    subagentId: 'v144-unload-4',
    startUrl: srv.url,
    role: 'Unload Watcher QA',
    taskPrompt: 'Pause then unload',
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
      pause4Sess = runner.getSharedSession();
      await pause4Sess.page.keyboard.press('F8');
      return { type: 'scroll', deltaY: 50, reason: 'Pause for unload cleanup' };
    },
  });
  assert.equal(res4Paused.status, 'PAUSED_FOR_TAKEOVER');
  assert.equal(runner.getActiveResumeWatcherCount(), 1);
  await runner.closeAllSessions();
  assert.equal(runner.getActiveResumeWatcherCount(), 0);
  assert.equal(runner.getPausedSessionCount(), 0);
  console.log('[v1.4.4] 4/4 Unload / closeAllSessions() cleared all watchers & paused sessions!');

  console.log('✅ verify-v144 passed!');
} finally {
  await runner.closeAllSessions().catch(() => {});
  await srv.close();
  fs.rmSync(outDir, { recursive: true, force: true });
}
