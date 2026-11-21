#!/usr/bin/env node
/**
 * verify-findings.mjs — Automated verification for TASK-v1.4.0 §2 & §5.2 (Cumulative Findings Ledger).
 * Runs a 6-step BrowserSubagentRunner task via createDshHostLlmPlanner (mock host llm.stream)
 * capturing the prompt sent at each step, and verifies cross-step retention, early summary,
 * 1200-char budget, and sliding-window image eviction.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  BrowserSubagentRunner,
  FindingsLedger,
  MAX_FINDINGS_ENTRIES,
  MAX_FINDINGS_TOTAL_CHARS,
  MAX_FINDING_NOTE_CHARS,
  createDshHostLlmPlanner,
} from '../dist/subagent/runner.js';

function startMultiPageFixture() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Findings Fixture ${req.url || '/'}</title>
  <style>
    body { margin: 0; padding: 24px; height: 2800px; background: #f00d18; color: #0a0a0a; font-family: sans-serif; }
    section { height: 700px; border-top: 1px solid #0a0a0a; }
  </style>
</head>
<body>
  <section>
    <h1>CREATIVE DEVELOPER</h1>
    <button id="inspect-btn" onclick="window.__clicked=(window.__clicked||0)+1">Inspect Work</button>
    <a href="/next">Next Route</a>
  </section>
  <section><h2>Section Two</h2></section>
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

const srv = await startMultiPageFixture();
const artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v140-findings-'));
const runner = new BrowserSubagentRunner();

try {
  const capturedPrompts = [];
  let llmCallStep = 0;

  const mockLlm = {
    async stream(params) {
      llmCallStep++;
      const msg = params.messages?.[0];
      const textParts = Array.isArray(msg?.content)
        ? msg.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n')
        : String(msg?.content ?? '');
      capturedPrompts.push({ step: llmCallStep, promptText: textParts });

      let decision;
      if (llmCallStep === 1) {
        decision = {
          type: 'scroll',
          deltaY: 500,
          reason: 'Scroll past hero',
          note: '主色是红、字体是压缩无衬线',
        };
      } else if (llmCallStep === 2) {
        decision = {
          type: 'hover',
          target: '#1',
          reason: 'Hover button',
          note: '按钮为黑框文字反色',
        };
      } else if (llmCallStep === 3) {
        decision = { type: 'scroll', deltaY: 500, reason: 'Check section 2' };
      } else if (llmCallStep === 4) {
        decision = { type: 'scroll', deltaY: 400, reason: 'Check section 3', note: '多屏分界清晰' };
      } else if (llmCallStep === 5) {
        decision = { type: 'click', target: '#1', reason: 'Test interactive button' };
      } else {
        decision = { type: 'complete', report: 'COMPLETED / TASK_COMPLETED\n\nFindings verified.' };
      }

      async function* gen() {
        yield { type: 'text-delta', delta: JSON.stringify(decision) };
        yield { type: 'finish', reason: { kind: 'stop' } };
      }
      return gen();
    },
  };

  const planner = createDshHostLlmPlanner({
    llm: mockLlm,
    provider: 'mock-provider',
    model: 'mock-model',
  });

  const subagentId = 'verify-findings-run';
  const res = await runner.runTask({
    subagentId,
    role: 'Findings Verifier',
    taskPrompt: 'Inspect page design and scroll across sections.',
    startUrl: `${srv.url}/`,
    artifactDir,
    maxSteps: 8,
    maxRecentImages: 3,
    sessionOptions: {
      mode: 'auto',
      windowMode: 'headless',
      backgroundSilent: true,
    },
    planner,
  });

  // Persist diagnostics.json like index.ts does and verify
  const diagPath = path.join(artifactDir, subagentId, 'diagnostics.json');
  fs.mkdirSync(path.dirname(diagPath), { recursive: true });
  fs.writeFileSync(
    diagPath,
    JSON.stringify({ status: res.status, steps: res.contextStats, findings: res.findings ?? [] }, null, 2),
    'utf8'
  );
  const diagData = JSON.parse(fs.readFileSync(diagPath, 'utf8'));

  assert.equal(res.status, 'COMPLETED');
  assert.ok(Array.isArray(diagData.findings) && diagData.findings.length >= 4, `Expected findings.length >= 4, got ${diagData.findings?.length}`);
  assert.ok(diagData.findings.length <= MAX_FINDINGS_ENTRIES);

  let totalNoteChars = 0;
  for (const f of diagData.findings) {
    assert.ok(f.note.length <= MAX_FINDING_NOTE_CHARS, `Finding note exceeded ${MAX_FINDING_NOTE_CHARS} chars: ${f.note.length}`);
    totalNoteChars += f.note.length;
  }
  assert.ok(totalNoteChars <= MAX_FINDINGS_TOTAL_CHARS, `Total findings chars exceeded ${MAX_FINDINGS_TOTAL_CHARS}: ${totalNoteChars}`);

  // Step 5 prompt must include ## Findings so far, early summary, AND step 1's note
  const step5Prompt = capturedPrompts.find((p) => p.step === 5)?.promptText ?? '';
  assert.ok(step5Prompt.includes('## Findings so far'), 'Expected ## Findings so far in step 5 prompt');
  assert.ok(step5Prompt.includes('第1–3步：'), 'Expected 第1–3步： early summary in step 5 prompt');
  assert.ok(
    step5Prompt.includes('主色是红、字体是压缩无衬线'),
    `Expected step 1 note preserved in step 5 prompt, got:\n${step5Prompt.slice(step5Prompt.indexOf('## Findings so far'))}`
  );

  // Sliding window image eviction untouched
  assert.ok(
    res.contextStats.evictedImagesCount >= 2,
    `Expected sliding window to evict old images (>=2), got ${JSON.stringify(res.contextStats)}`
  );

  // Stress test FindingsLedger 15-step budget enforcement
  const stressLedger = new FindingsLedger();
  const fakeObs = {
    stepIndex: 1,
    timestamp: new Date().toISOString(),
    screenshotPath: '',
    cursorPosition: { x: 0, y: 0 },
    scroll: { scrollX: 0, scrollY: 0, scrollWidth: 1280, scrollHeight: 4000, viewportWidth: 1280, viewportHeight: 800, scrollProgressPercent: 50 },
    domStats: {
      title: 'Stress',
      url: 'https://example.com/very/long/route/path',
      htmlClasses: [],
      htmlDataAttributes: {},
      counts: { canvas: 1, video: 0, svg: 2, img: 3, section: 4, article: 0, button: 2, a: 3, openDialogs: 0 },
      detectedTechHints: [],
    },
    interactiveElements: [],
    health: { consoleErrorsCount: 0, consoleErrorsSample: [], failedRequestsCount: 0, failedRequestsSample: [], totalRequests: 1 },
  };
  for (let s = 1; s <= 15; s++) {
    stressLedger.record(s, fakeObs, `scroll +${s * 100}`, `步骤${s}的详细设计观察记录，包含颜色字体动效信息：`.padEnd(110, '字'));
  }
  const stressFindings = stressLedger.getFindings();
  assert.ok(stressFindings.length <= MAX_FINDINGS_ENTRIES, `Expected <= ${MAX_FINDINGS_ENTRIES} entries, got ${stressFindings.length}`);
  assert.ok(stressLedger.getTotalChars() <= MAX_FINDINGS_TOTAL_CHARS, `Expected total chars <= ${MAX_FINDINGS_TOTAL_CHARS}, got ${stressLedger.getTotalChars()}`);
  const stressPromptBlock = stressLedger.formatForPrompt(15);
  assert.ok(stressPromptBlock.length <= MAX_FINDINGS_TOTAL_CHARS, `Expected prompt block <= ${MAX_FINDINGS_TOTAL_CHARS}, got ${stressPromptBlock.length}`);

  console.log(`[Findings] 6-step run passed: ${diagData.findings.length} entries (${totalNoteChars} chars), evictedImages=${res.contextStats.evictedImagesCount}`);
  console.log(`[Findings] Stress 15-step passed: ${stressFindings.length} entries (${stressLedger.getTotalChars()} chars), promptBlock=${stressPromptBlock.length} chars`);
  console.log('✅ verify-findings passed!');
} finally {
  await runner.closeAllSessions().catch(() => {});
  await srv.close();
  fs.rmSync(artifactDir, { recursive: true, force: true });
}
