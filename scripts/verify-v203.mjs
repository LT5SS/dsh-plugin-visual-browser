#!/usr/bin/env node
/**
 * verify-v203.mjs — Standalone runtime verification for TASK-v2.0.3.md.
 * Verifies:
 *  1. P0 Gate visibility & occlusion:
 *     - Hidden modal ancestor (display:none) wrapping input[type="password"] behind an 18+ age gate -> detected: false
 *     - Occluded visible input[type="password"] covered by full-screen overlay modal -> detected: false
 *     - Genuine visible unoccluded input[type="password"] -> detected: true (LOGIN_REQUIRED)
 *  2. P0 LOGIN_REQUIRED resume loop-breaker + security boundary:
 *     - Pausing on LOGIN_REQUIRED then calling resumeTask() skips re-pausing on the same URL so planner reads user_note and advances;
 *     - Navigating to a second page with real LOGIN_REQUIRED still pauses again;
 *     - pauseOnLoginWall: false skips LOGIN_REQUIRED cleanly;
 *     - CAPTCHA_DETECTED STILL pauses even after resumeTask() (never bypassed).
 *  3. P1 Declarative read-only list extraction + pagination dedupe + action_trace:
 *     - extract_list on page 1 + auto-extract on page 2 with dedupeBy: 'href'
 *     - Absolute URL resolution, password value '[REDACTED]', extracted.json persistence, count=0 empty state
 *     - actionTrace populated cleanly on SubagentRunResult.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { BrowserSession } from '../dist/driver/browser-session.js';
import { detectPageGate } from '../dist/guardrails/takeover.js';
import { BrowserSubagentRunner } from '../dist/subagent/runner.js';
import { AtomicBrowserToolset, parseExtractFieldsSpec } from '../dist/tools/atomic-tools.js';

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const reqUrl = new URL(req.url || '/', 'http://127.0.0.1');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

      if (reqUrl.pathname === '/age-gate') {
        // Simulates JavDB: 18+ two-button confirmation page + a hidden Bulma login modal with password input inside
        res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>請注意 — 年齡確認</title></head>
<body style="font-family:sans-serif;padding:32px;">
  <div class="age-modal">
    <h1>請注意</h1>
    <p>本站包含限制級內容。您已年滿 18 歲嗎?</p>
    <a id="confirm-age" href="/list?page=1" style="display:inline-block;padding:10px 18px;background:#16a34a;color:#fff;text-decoration:none;">是,我已滿18歲</a>
    <button id="deny-age" type="button">不,我未達法定年齡</button>
  </div>
  <div class="modal" style="display:none;">
    <form><input type="password" name="password" /></form>
  </div>
</body>
</html>`);
        return;
      }

      if (reqUrl.pathname === '/occluded-login') {
        res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Occluded Login</title></head>
<body style="margin:0;">
  <form style="padding:20px;">
    <input id="bg-pw" type="password" value="secret-behind-overlay" style="width:240px;height:36px;" />
  </form>
  <div id="overlay" style="position:fixed;inset:0;background:rgba(0,0,0,0.85);color:#fff;z-index:9999;display:flex;align-items:center;justify-content:center;">
    <button id="dismiss-overlay" type="button" style="padding:14px 24px;">是,我已滿18歲</button>
  </div>
</body>
</html>`);
        return;
      }

      if (reqUrl.pathname === '/real-login') {
        res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Sign In Required</title></head>
<body style="padding:32px;font-family:sans-serif;">
  <h1>Sign In</h1>
  <form>
    <input id="user" type="text" placeholder="Email" />
    <input id="pw" type="password" value="SECRET_RAW_PW" style="width:220px;height:32px;" />
    <a id="bypass-to-public" href="/list?page=1">Browse public catalog instead</a>
    <a id="next-real-login" href="/real-login-2">Go to page 2 login</a>
  </form>
</body>
</html>`);
        return;
      }

      if (reqUrl.pathname === '/real-login-2') {
        res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Account Verification Login</title></head>
<body style="padding:32px;font-family:sans-serif;">
  <form>
    <input id="pw2" type="password" style="width:220px;height:32px;" />
  </form>
</body>
</html>`);
        return;
      }

      if (reqUrl.pathname === '/captcha-challenge') {
        res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>请稍候…</title></head>
<body>
  <div class="cf-turnstile">正在验证您的请求，请稍候...</div>
</body>
</html>`);
        return;
      }

      if (reqUrl.pathname === '/list') {
        const pageNo = reqUrl.searchParams.get('page') || '1';
        if (pageNo === '2') {
          res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Catalog Page 2</title></head>
<body>
  <div class="movie-list">
    <div class="item">
      <a class="box" href="/v/ddk-237">
        <div class="video-title">DDK-237 Second Item</div>
        <div class="score">4.55</div>
        <div class="meta">2026-01-10</div>
      </a>
    </div>
    <div class="item">
      <a class="box" href="/v/ddk-238">
        <div class="video-title">DDK-238 Third Item</div>
        <div class="score">4.71</div>
        <div class="meta">2026-02-02</div>
      </a>
    </div>
  </div>
</body>
</html>`);
          return;
        }
        res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Catalog Page 1</title></head>
<body>
  <div class="movie-list">
    <div class="item">
      <a class="box" href="/v/ddk-236">
        <div class="video-title">DDK-236 First Item</div>
        <div class="score">4.43</div>
        <div class="meta">2025-12-15</div>
      </a>
    </div>
    <div class="item">
      <a class="box" href="/v/ddk-237">
        <div class="video-title">DDK-237 Duplicate Cross Page</div>
        <div class="score">4.55</div>
        <div class="meta">2026-01-10</div>
      </a>
    </div>
  </div>
  <a id="next-page" href="/list?page=2">Next Page</a>
</body>
</html>`);
        return;
      }

      res.end('<!doctype html><html><head><title>Blank</title></head><body>OK</body></html>');
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

async function testGateVisibilityAndOcclusion(srv) {
  const sess = new BrowserSession({ mode: 'auto', windowMode: 'headless' });
  await sess.start();
  try {
    await sess.navigate(`${srv.url}/age-gate`, 'domcontentloaded', 10000);
    const ageGate = await detectPageGate(sess.page);
    assert.equal(ageGate.detected, false, 'Hidden Bulma login modal behind age gate must NOT trigger LOGIN_REQUIRED');

    await sess.navigate(`${srv.url}/occluded-login`, 'domcontentloaded', 10000);
    const occludedGate = await detectPageGate(sess.page);
    assert.equal(occludedGate.detected, false, 'Occluded password field covered by modal must NOT trigger LOGIN_REQUIRED');

    await sess.navigate(`${srv.url}/real-login`, 'domcontentloaded', 10000);
    const realGate = await detectPageGate(sess.page);
    assert.equal(realGate.detected, true, 'Visible unoccluded password input must trigger gate');
    assert.equal(realGate.reason, 'LOGIN_REQUIRED');

    const disabledGate = await detectPageGate(sess.page, { pauseOnLoginWall: false });
    assert.equal(disabledGate.detected, false, 'pauseOnLoginWall=false must disable LOGIN_REQUIRED detection');
  } finally {
    await sess.close();
  }
}

async function testResumeLoopBreakerAndExtraction(srv, outDir) {
  // 1. Age gate + paginated declarative list extraction (page 1 explicit extract_list + page 2 auto finalize + dedupe)
  const runner1 = new BrowserSubagentRunner();
  const fields = parseExtractFieldsSpec(JSON.stringify({
    title: '.video-title',
    score: '.score',
    date: '.meta',
    href: { selector: 'a.box', attr: 'href' },
  }));
  let step1 = 0;
  const step1Events = [];
  try {
    const res1 = await runner1.runTask({
      role: 'Age Gate + Extractor QA',
      taskPrompt: 'Pass 18+ gate and extract paginated items',
      startUrl: `${srv.url}/age-gate`,
      artifactDir: outDir,
      maxSteps: 6,
      sessionOptions: { windowMode: 'headless' },
      extractSpec: {
        itemSelector: 'div.item',
        fields,
        maxItems: 50,
        dedupeBy: 'href',
      },
      onActionResult: (info) => step1Events.push({ step: info.stepIndex, type: info.decision.type, ok: info.ok, blocked: info.blocked, hit: info.hit, hint: info.hint }),
      planner: async (ctx) => {
        step1++;
        if (step1 === 1) {
          assert.ok(ctx.latestObservation.domStats.url.includes('/age-gate'));
          const confirmBtn = ctx.latestObservation.interactiveElements.find((c) => c.label.includes('已滿18'));
          assert.ok(confirmBtn, `Expected confirm button in interactiveElements, got: ${JSON.stringify(ctx.latestObservation.interactiveElements)}`);
          return { type: 'click', target: confirmBtn.ref, reason: 'Confirm 18+ age gate' };
        }
        if (step1 === 2) {
          assert.ok(
            ctx.latestObservation.domStats.url.includes('/list?page=1'),
            `Expected /list?page=1 at step 2, got ${ctx.latestObservation.domStats.url}; step1Events=${JSON.stringify(step1Events)}`
          );
          return { type: 'extract_list', reason: 'Extract page 1 before going to page 2' };
        }
        if (step1 === 3) {
          const nextLink = ctx.latestObservation.interactiveElements.find((c) => c.label.includes('Next Page'));
          assert.ok(nextLink, 'Expected Next Page control');
          return { type: 'click', target: nextLink.ref, reason: 'Navigate to page 2' };
        }
        assert.ok(ctx.latestObservation.domStats.url.includes('/list?page=2'));
        return { type: 'complete', report: 'PAGINATED_EXTRACTION_DONE' };
      },
    });
    assert.equal(res1.status, 'COMPLETED', `Expected COMPLETED (not paused by hidden login modal), got ${res1.status}`);
    assert.ok(res1.extractedData, 'Expected extractedData bundle on result');
    assert.equal(res1.extractedData.count, 3, `Expected 3 deduped items across 2 pages, got ${res1.extractedData.count}`);
    assert.deepEqual(
      res1.extractedData.items.map((x) => x.title),
      ['DDK-236 First Item', 'DDK-237 Duplicate Cross Page', 'DDK-238 Third Item']
    );
    assert.equal(res1.extractedData.items[0].score, '4.43');
    assert.equal(res1.extractedData.items[2].href, `${srv.url}/v/ddk-238`);
    assert.ok(res1.extractedData.path && fs.existsSync(res1.extractedData.path), 'extracted.json must exist on disk');
    const diskJson = JSON.parse(fs.readFileSync(res1.extractedData.path, 'utf8'));
    assert.equal(diskJson.count, 3);
    assert.ok(Array.isArray(res1.actionTrace) && res1.actionTrace.length >= 4, 'actionTrace must record steps');
    assert.ok(res1.actionTrace.some((t) => t.action === 'extract_list' && t.ok));
  } finally {
    await runner1.closeAllSessions();
  }

  // 2. Real LOGIN_REQUIRED -> pause -> resumeTask() does NOT infinite-loop on same URL,
  //    then navigating to /real-login-2 DOES pause again because URL changed!
  const runner2 = new BrowserSubagentRunner();
  let calls2 = 0;
  try {
    const paused = await runner2.runTask({
      role: 'Login Resume LoopBreaker QA',
      taskPrompt: 'Inspect site',
      startUrl: `${srv.url}/real-login`,
      artifactDir: outDir,
      maxSteps: 6,
      sessionOptions: { windowMode: 'headless' },
      planner: async (ctx) => {
        calls2++;
        if (calls2 === 1) {
          assert.ok(ctx.taskPrompt.includes('Click public link'), 'Planner must receive resumed user note');
          const link = ctx.latestObservation.interactiveElements.find((c) => c.label.includes('page 2 login'));
          assert.ok(link);
          return { type: 'click', target: link.ref, reason: 'Follow link to second login page' };
        }
        return { type: 'complete', report: 'SHOULD_PAUSE_ON_SECOND_LOGIN_URL' };
      },
    });
    assert.equal(paused.status, 'PAUSED_FOR_TAKEOVER');
    assert.equal(calls2, 0, 'Must pause before step 1 LLM on genuine login gate');

    const resumed = await runner2.resumeTask(paused.subagentId, 'Click public link instead');
    assert.equal(calls2, 1, 'After resumeTask, planner step MUST execute once instead of re-pausing in loop');
    assert.equal(resumed.status, 'PAUSED_FOR_TAKEOVER', 'Navigating to a different URL with real login gate must pause again');

    // Now test pauseOnLoginWall=false skipping genuine login gate cleanly
    const resBypass = await runner2.resumeTask(resumed.subagentId, 'Ignore login wall now', undefined, {
      pauseOnLoginWall: false,
    });
    assert.equal(resBypass.status, 'COMPLETED');
  } finally {
    await runner2.closeAllSessions();
  }

  // 3. CAPTCHA_DETECTED red line: resumeTask() MUST STILL pause on CAPTCHA page!
  const runner3 = new BrowserSubagentRunner();
  let calls3 = 0;
  try {
    const capPaused = await runner3.runTask({
      role: 'Captcha RedLine QA',
      taskPrompt: 'Open page',
      startUrl: `${srv.url}/captcha-challenge`,
      artifactDir: outDir,
      maxSteps: 4,
      pauseOnLoginWall: false,
      sessionOptions: { windowMode: 'headless' },
      planner: async () => {
        calls3++;
        return { type: 'complete', report: 'MUST_NOT_RUN' };
      },
    });
    assert.equal(capPaused.status, 'PAUSED_FOR_TAKEOVER');
    assert.equal(calls3, 0);
    const capResumed = await runner3.resumeTask(capPaused.subagentId, 'try anyway', undefined, {
      pauseOnLoginWall: false,
    });
    assert.equal(capResumed.status, 'PAUSED_FOR_TAKEOVER', 'CAPTCHA gate must NEVER be bypassed on resume');
    assert.equal(calls3, 0);
  } finally {
    await runner3.closeAllSessions();
  }

  // 4. AtomicBrowserToolset.extractList: password masking ([REDACTED]) & count=0 semantics
  const sess = new BrowserSession({ mode: 'auto', windowMode: 'headless' });
  await sess.start();
  try {
    const tools = new AtomicBrowserToolset(sess, path.join(outDir, 'extract-unit'));
    await tools.navigate(`${srv.url}/real-login`, 100);
    const pwRes = await tools.extractList({
      itemSelector: 'form',
      fields: {
        pwAttr: { selector: '#pw', attr: 'value' },
        pwHidden: { selector: '#pw', attr: 'attr:value' },
      },
    });
    assert.equal(pwRes.extractedCount, 1);
    assert.equal(pwRes.items[0].pwAttr, '[REDACTED]');
    assert.equal(pwRes.items[0].pwHidden, '[REDACTED]');

    const emptyRes = await tools.extractList({
      itemSelector: '.nonexistent-item',
    });
    assert.equal(emptyRes.ok, true);
    assert.equal(emptyRes.matchedCount, 0);
    assert.equal(emptyRes.extractedCount, 0);
    assert.deepEqual(emptyRes.items, []);
  } finally {
    await sess.close();
  }
}

async function main() {
  const srv = await startFixtureServer();
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vb-v203-'));
  try {
    await testGateVisibilityAndOcclusion(srv);
    await testResumeLoopBreakerAndExtraction(srv, outDir);
    console.log('verify-v203: All P0 gate visibility/occlusion, LOGIN_REQUIRED resume loop-breaker, CAPTCHA red-line & declarative structured extraction checks PASSED!');
  } finally {
    await srv.close();
    fs.rmSync(outDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
