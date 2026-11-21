#!/usr/bin/env node
/**
 * verify-design-hud.mjs — Automated verification for TASK-v1.4.0 §1 & §5.1 (## Design HUD block).
 * Runs headless Chromium against 3 deterministic local fixtures (/editorial, /canvas-only, /blank)
 * and optionally against live targets (https://wodniack.dev/, https://unseen.co/) when `--live` is passed.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { BrowserSession } from '../dist/driver/browser-session.js';
import {
  MAX_DESIGN_BLOCK_CHARS,
  PageSnapshotSampler,
  formatDesignBlock,
} from '../dist/sampler/page-snapshot.js';

function startLocalDesignFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const cleanUrl = (req.url || '/').split('?')[0];
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });

      if (cleanUrl === '/editorial') {
        res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Editorial Brutalist Study — 22334L</title>
  <style>
    :root {
      --red: #f00d18;
      --ink: #0a0a0a;
      --orange: #ff9f1a;
      --grid-gap: 16px;
      --font-display: Impact, Haettenschweiler, sans-serif;
      --font-mono: Consolas, monospace;
    }
    @media (prefers-reduced-motion: reduce) {
      * { animation: none !important; transition: none !important; }
    }
    body {
      margin: 0;
      background-color: var(--red);
      color: var(--ink);
      font-family: "Bookman Old Style", Georgia, serif;
      font-size: 18px;
    }
    header {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      display: flex;
      justify-content: space-between;
      padding: 12px 24px;
      background: #f00d18;
      border-bottom: 1px solid #0a0a0a;
    }
    h1 {
      font-family: Haettenschweiler, Impact, sans-serif;
      font-weight: 400;
      font-size: 96px;
      line-height: 0.9;
      margin: 64px 0 16px;
      transition: transform 0.3s ease;
    }
    h2 {
      font-family: "Bookman Old Style", Georgia, serif;
      font-weight: 400;
      font-size: 26px;
    }
    .mono {
      font-family: Consolas, monospace;
      font-size: 12px;
    }
    .grid-wrap {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      padding: 24px;
    }
    .accent-btn {
      display: inline-block;
      background-color: #ff9f1a;
      color: #0a0a0a;
      padding: 10px 18px;
      text-decoration: none;
      transition: background-color 0.25s ease;
    }
    section {
      min-height: 760px;
      padding: 24px;
      border-top: 1px solid #0a0a0a;
    }
  </style>
</head>
<body>
  <header>
    <a href="#top" class="mono">22334L</a>
    <a id="work-link" href="https://example.org/work" class="accent-btn">Selected Work</a>
  </header>
  <main>
    <section id="s1">
      <h1>CREATIVE DEVELOPER</h1>
      <p>从台侧学会的光与节奏，落到网页与多模态交互里。这里是一段用于检验正文采样的真实中文排版段落。</p>
      <canvas id="c1" width="600" height="320" style="width:600px;height:320px;border:1px solid #0a0a0a;"></canvas>
    </section>
    <section id="s2">
      <h2>Selected Projects</h2>
      <div class="grid-wrap">
        <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1200' height='800'%3E%3Crect width='1200' height='800' fill='%23ff9f1a'/%3E%3C/svg%3E" style="width:400px;height:260px;object-fit:cover;" alt="Poster">
        <canvas id="c2" width="300" height="180" style="width:300px;height:180px;"></canvas>
      </div>
      <svg width="40" height="40" viewBox="0 0 40 40"><circle cx="20" cy="20" r="18" fill="#0a0a0a"/></svg>
      <svg width="24" height="24" viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" fill="#ff9f1a"/></svg>
    </section>
    <section id="s3"><h2>Our 2025 Wrapped</h2><p>Section three copy.</p></section>
    <section id="s4"><h2>Contact</h2><p>Section four copy.</p></section>
  </main>
</body>
</html>`);
        return;
      }

      if (cleanUrl === '/canvas-only') {
        res.end(`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Unseen Canvas Study</title>
  <style>
    html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #faf6f4; }
    canvas { display: block; width: 100vw; height: 100vh; }
    .hidden-menu { display: none; }
  </style>
</head>
<body>
  <canvas id="gl" width="1440" height="900"></canvas>
  <div class="hidden-menu">Should never appear in bodyText</div>
  <a href="#enter" style="position:fixed;bottom:24px;left:50%;transform:translateX(-50%);padding:8px 14px;background:#212121;color:#fff;">Enter</a>
</body>
</html>`);
        return;
      }

      // /blank
      res.end('<!doctype html><html><head><meta charset="utf-8"><title></title></head><body></body></html>');
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

function extractDesignBlock(hudText) {
  const idx = hudText.indexOf('## Design');
  assert.ok(idx >= 0, 'Expected ## Design block in HUD');
  return hudText.slice(idx);
}

const srv = await startLocalDesignFixtureServer();
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-v140-design-'));
const session = new BrowserSession({
  mode: 'auto',
  windowMode: 'headless',
  backgroundSilent: true,
});

try {
  await session.start();
  await session.page.setViewportSize({ width: 1280, height: 800 });
  const sampler = new PageSnapshotSampler(session, outDir);

  // 1) Editorial fixture (wodniack-like)
  await session.navigate(`${srv.url}/editorial`, 'domcontentloaded');
  await session.page.waitForTimeout(150);
  const obsEd = await sampler.captureSnapshot('editorial');
  const hudEd = sampler.formatObservationForLLM(obsEd);

  const controlsIdx = hudEd.indexOf('#### Visible Interactive Controls');
  const designIdx = hudEd.indexOf('## Design');
  assert.ok(controlsIdx >= 0 && designIdx > controlsIdx, '## Design MUST be appended after existing HUD sections');
  assert.ok(
    hudEd.includes('href=`https://example.org/work`'),
    'Existing HUD href formatting must remain completely unchanged'
  );

  const designEd = extractDesignBlock(hudEd);
  assert.ok(
    designEd.length <= MAX_DESIGN_BLOCK_CHARS,
    `## Design must be <= ${MAX_DESIGN_BLOCK_CHARS} chars, got ${designEd.length}`
  );
  assert.ok((obsEd.design?.sectionsTotal ?? 0) >= 3, `Expected >= 3 sections, got ${obsEd.design?.sectionsTotal}`);
  assert.ok((obsEd.design?.fonts.length ?? 0) >= 2, `Expected >= 2 font groups, got ${JSON.stringify(obsEd.design?.fonts)}`);
  assert.equal(obsEd.design?.palette?.bg, '#f00d18', `Expected non-B/W bg #f00d18, got ${JSON.stringify(obsEd.design?.palette)}`);
  assert.equal(obsEd.design?.palette?.accent, '#ff9f1a', `Expected accent #ff9f1a, got ${JSON.stringify(obsEd.design?.palette)}`);
  assert.ok(!obsEd.design?.canvasCoversViewport, 'Editorial page should not set canvasCoversViewport');
  assert.ok(designEd.includes('palette: bg #f00d18 · text #0a0a0a · accent #ff9f1a'));
  assert.equal(obsEd.design?.media?.canvas, obsEd.domStats.counts.canvas, 'Canvas count in Design must match HUD');
  assert.equal(obsEd.design?.cssVarsTotal, 6, `Expected 6 CSS vars, got ${obsEd.design?.cssVarsTotal}`);
  assert.ok((obsEd.design?.cssVarsSample.length ?? 0) <= 5, 'cssVarsSample must list at most 5');
  assert.equal(obsEd.design?.motion?.reducedMotion, '支持', 'Expected prefers-reduced-motion detected as 支持');
  assert.ok(designEd.includes('transition ') && !designEd.includes('transition 0 '), 'Expected non-zero transition count');
  console.log('[Design HUD] 1/3 /editorial passed:\n' + designEd + '\n');

  // 2) Canvas-only fixture (unseen-like)
  await session.navigate(`${srv.url}/canvas-only`, 'domcontentloaded');
  await session.page.waitForTimeout(150);
  const obsCanvas = await sampler.captureSnapshot('canvas_only');
  const hudCanvas = sampler.formatObservationForLLM(obsCanvas);
  const designCanvas = extractDesignBlock(hudCanvas);
  assert.ok((obsCanvas.design?.media?.canvas ?? 0) >= 1, 'Expected canvas >= 1');
  assert.equal(obsCanvas.design?.canvasCoversViewport, true, 'Expected canvasCoversViewport=true on full-viewport canvas');
  assert.ok(
    designCanvas.includes('⚠️ DOM 背景为 #faf6f4，但视口被 <canvas> 覆盖 → 实际视觉配色请以截图为依据'),
    `Expected canvas palette warning, got:\n${designCanvas}`
  );
  assert.ok(!designCanvas.includes('- palette: bg '), 'Full-canvas palette must NOT print unqualified DOM bg');
  assert.ok((obsCanvas.design?.bodyText ?? '').length < 40, `Expected short bodyText (<40), got "${obsCanvas.design?.bodyText}"`);
  assert.ok(!hudCanvas.includes('Should never appear'), 'Hidden menu text must NOT leak into bodyText');
  assert.ok(designCanvas.includes('主体可能在 <canvas> 内'), 'Expected <canvas> warning in bodyText line');
  assert.ok(designCanvas.length <= MAX_DESIGN_BLOCK_CHARS);
  console.log('[Design HUD] 2/3 /canvas-only passed:\n' + designCanvas + '\n');

  // 3) Blank fixture (/blank)
  await session.navigate(`${srv.url}/blank`, 'domcontentloaded');
  await session.page.waitForTimeout(100);
  const obsBlank = await sampler.captureSnapshot('blank');
  const hudBlank = sampler.formatObservationForLLM(obsBlank);
  const designBlank = extractDesignBlock(hudBlank);
  assert.ok(designBlank.includes('- headings: n/a'), `Expected headings: n/a on blank page, got:\n${designBlank}`);
  assert.ok(designBlank.includes('- bodyText: （几乎为空，主体可能在 <canvas> 内）'), `Expected empty bodyText notice on blank page`);
  assert.ok(designBlank.length <= MAX_DESIGN_BLOCK_CHARS);
  console.log('[Design HUD] 3/3 /blank passed:\n' + designBlank + '\n');

  // 4) Budget truncation priority unit check (headings/vars/sections trimmed BEFORE bodyText)
  const longBlock = formatDesignBlock({
    title: 'Very Long Title '.repeat(4),
    headings: Array.from({ length: 5 }, (_, i) => ({ tag: 'h2', text: `Heading ${i} ` + 'A'.repeat(50) })),
    headingsTotal: 12,
    sections: [0, 900, 1800, 2700, 3600, 4500],
    sectionsTotal: 10,
    palette: { bg: '#f00d18', text: '#0a0a0a', accent: '#ff9f1a' },
    fonts: [
      { family: 'SuperLongCustomDisplayFontFamilyOne', weight: '700', maxPx: 240 },
      { family: 'SuperLongCustomEditorialSerifFontTwo', weight: '400', maxPx: 42 },
      { family: 'SuperLongCustomMonospaceFontThree', weight: '500', maxPx: 14 },
    ],
    cssVarsTotal: 42,
    cssVarsSample: Array.from({ length: 5 }, (_, i) => ({
      name: `--very-long-design-token-name-${i}`,
      value: 'rgba(255, 159, 26, 0.92)'.padEnd(38, ' '),
    })),
    layout: { grid: 12, flex: 34, fixed: 3, sticky: 2 },
    media: {
      img: 19,
      video: 34,
      canvas: 2,
      svg: 19,
      largest: { kind: 'video', width: 1280, height: 720, objectFit: 'cover' },
      largestCanvas: { width: 1280, height: 800 },
    },
    motion: { transition: 88, animation: 24, willChange: 16, reducedMotion: '支持' },
    bodyText: 'KEEP_TAIL_BODY_TEXT_INTACT_' + '内容摘要'.repeat(30),
  });
  assert.ok(longBlock.length <= MAX_DESIGN_BLOCK_CHARS, `Truncated block must be <= ${MAX_DESIGN_BLOCK_CHARS}, got ${longBlock.length}`);
  assert.ok(longBlock.includes('KEEP_TAIL_BODY_TEXT_INTACT_'), 'bodyText must be preserved ahead of headings/cssVars/sections');
  console.log(`[Design HUD] Budget truncation priority passed (${longBlock.length} chars)`);

  // 5) Optional live checks against real wodniack.dev & unseen.co when --live is passed
  if (process.argv.includes('--live')) {
    await session.page.setViewportSize({ width: 1440, height: 900 });

    await session.navigate('https://wodniack.dev/', 'domcontentloaded', 30000);
    await session.page.waitForTimeout(1200);
    const liveWod = await sampler.captureSnapshot('live_wodniack');
    const liveWodHud = sampler.formatObservationForLLM(liveWod);
    const liveWodDesign = extractDesignBlock(liveWodHud);
    assert.ok(liveWodDesign.length <= MAX_DESIGN_BLOCK_CHARS);
    assert.ok((liveWod.design?.sectionsTotal ?? 0) >= 3, `wodniack.dev sections expected >=3, got ${liveWod.design?.sectionsTotal}`);
    assert.ok((liveWod.design?.fonts.length ?? 0) >= 2, `wodniack.dev fonts expected >=2, got ${JSON.stringify(liveWod.design?.fonts)}`);
    const wodPalette = liveWod.design?.palette;
    assert.ok(
      wodPalette && (wodPalette.bg !== '#ffffff' && wodPalette.bg !== '#000000' || wodPalette.accent !== '#000000'),
      `wodniack.dev palette expected non-B/W primary color, got ${JSON.stringify(wodPalette)}`
    );
    assert.equal(liveWod.design?.media?.canvas, liveWod.domStats.counts.canvas);
    console.log('[Live Design HUD] https://wodniack.dev/ passed:\n' + liveWodDesign + '\n');

    await session.navigate('https://unseen.co/', 'domcontentloaded', 30000);
    await session.page.waitForTimeout(1200);
    const liveUnseen = await sampler.captureSnapshot('live_unseen');
    const liveUnseenHud = sampler.formatObservationForLLM(liveUnseen);
    const liveUnseenDesign = extractDesignBlock(liveUnseenHud);
    assert.ok(liveUnseenDesign.length <= MAX_DESIGN_BLOCK_CHARS);
    assert.ok((liveUnseen.design?.media?.canvas ?? 0) >= 1, `unseen.co expected canvas >= 1, got ${liveUnseen.design?.media?.canvas}`);
    assert.equal(liveUnseen.design?.canvasCoversViewport, true, 'unseen.co expected canvasCoversViewport=true');
    assert.ok(
      liveUnseenDesign.includes('被 <canvas> 覆盖 → 实际视觉配色请以截图为依据'),
      `unseen.co expected canvas palette guard warning, got:\n${liveUnseenDesign}`
    );
    assert.ok((liveUnseen.design?.bodyText ?? '').length < 40, `unseen.co expected bodyText < 40, got "${liveUnseen.design?.bodyText}"`);
    assert.ok(liveUnseenDesign.includes('主体可能在 <canvas> 内'));
    console.log('[Live Design HUD] https://unseen.co/ passed:\n' + liveUnseenDesign + '\n');
  }

  console.log('✅ verify-design-hud passed!');
} finally {
  await session.close().catch(() => {});
  await srv.close();
  fs.rmSync(outDir, { recursive: true, force: true });
}
