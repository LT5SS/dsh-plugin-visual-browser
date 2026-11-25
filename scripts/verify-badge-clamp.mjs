#!/usr/bin/env node
/**
 * verify-badge-clamp.mjs — Automated regression test for TASK-v1.2.4 HUD badge viewport clamping.
 * Verifies 4 corner/center/resize cases in headless Chromium against a self-contained local HTTP fixture.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { BrowserSession } from '../dist/driver/browser-session.js';
import { safeEvaluate } from '../dist/sampler/page-snapshot.js';

function startLocalFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
<head><meta charset="utf-8"><title>Badge Clamp Fixture</title></head>
<body style="margin:0;padding:24px;height:1600px;font-family:sans-serif;">
  <h1>Badge Clamp Regression Fixture</h1>
  <a id="menu" href="#studio" style="position:fixed;top:18px;right:20px;padding:8px 14px;background:#111;color:#fff;text-decoration:none;border-radius:6px;">Menu</a>
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

async function measureAt(page, x, y, action) {
  return safeEvaluate(
    page,
    ({ px, py, act }) => {
      const api = window.__dshCursorAPI;
      if (!api) return { err: 'no cursor api' };
      api.update(px, py, act);
      const badge = document.getElementById('__dsh_vc_badge__');
      if (!badge) return { err: 'no badge' };
      const r = badge.getBoundingClientRect();
      return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        cursor: { x: px, y: py },
        badge: {
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          right: Math.round(r.right),
          bottom: Math.round(r.bottom),
        },
        overflowRight: Math.round(r.right - window.innerWidth),
        overflowBottom: Math.round(r.bottom - window.innerHeight),
        text: (badge.textContent || '').slice(0, 60),
      };
    },
    { err: 'evaluate failed' },
    { arg: { px: x, py: y, act: action }, retries: 0 }
  );
}

async function measureBadgeOnly(page) {
  return safeEvaluate(
    page,
    () => {
      const badge = document.getElementById('__dsh_vc_badge__');
      if (!badge) return { err: 'no badge' };
      const r = badge.getBoundingClientRect();
      return {
        viewport: { w: window.innerWidth, h: window.innerHeight },
        badge: {
          x: Math.round(r.x),
          y: Math.round(r.y),
          w: Math.round(r.width),
          h: Math.round(r.height),
          right: Math.round(r.right),
          bottom: Math.round(r.bottom),
        },
        overflowRight: Math.round(r.right - window.innerWidth),
        overflowBottom: Math.round(r.bottom - window.innerHeight),
        text: (badge.textContent || '').slice(0, 60),
      };
    },
    { err: 'evaluate failed' },
    0
  );
}

const srv = await startLocalFixtureServer();
const session = new BrowserSession({
  mode: 'auto',
  windowMode: 'headless',
  backgroundSilent: true,
});

try {
  await session.start();
  await session.page.setViewportSize({ width: 754, height: 751 });
  await session.navigate(srv.url, 'domcontentloaded');
  await session.page.waitForTimeout(200);

  // Case 1: Bottom-right corner (748, 742) on 754x751
  const c1 = await measureAt(session.page, 748, 742, 'NEAR-CORNER');
  console.log('[Case 1 bottom-right (748,742) @ 754x751]', JSON.stringify(c1));
  assert.ok(!c1.err, c1.err);
  assert.ok(c1.badge.right <= c1.viewport.w - 8, `Expected badge.right (${c1.badge.right}) <= ${c1.viewport.w - 8}`);
  assert.ok(c1.badge.bottom <= c1.viewport.h - 8, `Expected badge.bottom (${c1.badge.bottom}) <= ${c1.viewport.h - 8}`);
  assert.ok(c1.overflowRight <= -8, `Expected overflowRight <= -8, got ${c1.overflowRight}`);
  assert.ok(c1.overflowBottom <= -8, `Expected overflowBottom <= -8, got ${c1.overflowBottom}`);

  // Case 1b: Top-right Menu corner (690, 40) on 754x751 -> flips left cleanly
  const c1b = await measureAt(session.page, 690, 40, 'CLICK #2');
  console.log('[Case 1b top-right (690,40) @ 754x751]', JSON.stringify(c1b));
  assert.ok(!c1b.err, c1b.err);
  assert.ok(c1b.badge.right <= c1b.viewport.w - 8, `Expected badge.right <= ${c1b.viewport.w - 8}`);
  assert.ok(c1b.badge.x < 690, `Expected badge to flip left of cursor x=690, got badge.x=${c1b.badge.x}`);
  assert.ok(c1b.badge.y >= 8, `Expected badge.y >= 8, got ${c1b.badge.y}`);

  // Case 2: Top-left corner (2, 2) -> stays inside >= 8px margin
  const c2 = await measureAt(session.page, 2, 2, 'TOP-LEFT');
  console.log('[Case 2 top-left (2,2) @ 754x751]', JSON.stringify(c2));
  assert.ok(!c2.err, c2.err);
  assert.ok(c2.badge.x >= 8, `Expected badge.left >= 8, got ${c2.badge.x}`);
  assert.ok(c2.badge.y >= 8, `Expected badge.top >= 8, got ${c2.badge.y}`);

  // Case 3: Center (300, 300) -> restores default bottom-right placement
  const c3 = await measureAt(session.page, 300, 300, 'CENTER-DEFAULT');
  console.log('[Case 3 center (300,300) @ 754x751]', JSON.stringify(c3));
  assert.ok(!c3.err, c3.err);
  assert.ok(c3.badge.x > 300 && c3.badge.y > 300, `Expected default bottom-right of (300,300), got (${c3.badge.x},${c3.badge.y})`);

  // Case 4: Resize to 500x400 -> push to corner AND verify resize re-clamp even from stale coords
  await measureAt(session.page, 748, 742, 'PRE-RESIZE');
  await session.page.setViewportSize({ width: 500, height: 400 });
  await session.page.waitForTimeout(300);
  const c4Resize = await measureBadgeOnly(session.page);
  console.log('[Case 4a resize while at stale (748,742) -> 500x400]', JSON.stringify(c4Resize));
  assert.ok(c4Resize.badge.right <= 500 - 8, `Resize must clamp right <= 492, got ${c4Resize.badge.right}`);
  assert.ok(c4Resize.badge.bottom <= 400 - 8, `Resize must clamp bottom <= 392, got ${c4Resize.badge.bottom}`);

  const c4 = await measureAt(session.page, 494, 392, 'RESIZED-CORNER');
  console.log('[Case 4b corner (494,392) @ 500x400]', JSON.stringify(c4));
  assert.ok(c4.badge.right <= 500 - 8, `Expected badge.right <= 492, got ${c4.badge.right}`);
  assert.ok(c4.badge.bottom <= 400 - 8, `Expected badge.bottom <= 392, got ${c4.badge.bottom}`);
  assert.ok(c4.badge.x >= 8 && c4.badge.y >= 8);

  console.log('\n✅ ALL BADGE VIEWPORT CLAMP CHECKS PASSED!');
} finally {
  await session.close().catch(() => {});
  await srv.close();
}
