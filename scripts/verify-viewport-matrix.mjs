#!/usr/bin/env node
/**
 * verify-viewport-matrix.mjs — Multi-resolution / multi-DPR alignment matrix (B3 + B4 + badge clamp).
 * Exercises all 9 viewport/DPR cases against:
 *   1. Exact `example.com`-style CSS (`svg{display:block;margin:-2.75em auto 0;opacity:.55}`)
 *   2. Aggressive global `div`/`button` CSS rules (`div{width:600px;margin:5em auto;padding:2em}`)
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { BrowserSession } from '../dist/driver/browser-session.js';
import { safeEvaluate } from '../dist/sampler/page-snapshot.js';

const CASES = [
  { name: '窄屏 400x700', w: 400, h: 700, dpr: 1 },
  { name: '当前真机 754x751', w: 754, h: 751, dpr: 1 },
  { name: '1024x768', w: 1024, h: 768, dpr: 1 },
  { name: '1440x900', w: 1440, h: 900, dpr: 1 },
  { name: '1920x1080', w: 1920, h: 1080, dpr: 1 },
  { name: '超宽 2560x1080', w: 2560, h: 1080, dpr: 1 },
  { name: '竖屏 900x1440', w: 900, h: 1440, dpr: 1 },
  { name: '125% 缩放 960x720@1.25', w: 960, h: 720, dpr: 1.25 },
  { name: '200% 缩放 640x480@2', w: 640, h: 480, dpr: 2 },
];

function startFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      if ((req.url || '').startsWith('/aggressive')) {
        res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Aggressive CSS Fixture</title>
  <style>
    html { font-size: 16px; }
    body { margin: 0; padding: 24px; font-family: sans-serif; }
    div { width: 600px; margin: 5em auto; padding: 2em; opacity: 0.45; border: 4px solid red; }
    svg { display: block; margin: -2.75em auto 0; opacity: .55; width: 99px; height: 99px; }
    button { margin: 12px; padding: 14px; width: 200px; }
  </style>
</head>
<body><div><h1>Aggressive Global CSS Test</h1></div></body>
</html>`);
        return;
      }
      res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Example-like CSS Fixture</title>
  <style>
    html { color-scheme: light dark; }
    body { font: 16px/1.6 system-ui, sans-serif; max-width: 26em; margin: auto; padding: 25vh 2em 2em; text-align: center; }
    svg { display: block; margin: -2.75em auto 0; opacity: .55; }
    p + p { font-size: .875em; opacity: .6; }
  </style>
</head>
<body><div><h1>Example Domain CSS Fixture</h1><p>Test</p></div></body>
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

async function runMatrixForUrl(targetUrl, label) {
  let failures = 0;
  const rows = [];
  const consoleErrors = [];
  const s = new BrowserSession({ mode: 'auto', windowMode: 'headless', backgroundSilent: true });
  try {
    await s.start();
    s.page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    s.page.on('pageerror', (err) => {
      consoleErrors.push(err.message);
    });

    await s.navigate(targetUrl, 'domcontentloaded');
    await s.page.waitForTimeout(250);
    const cdp = await s.page.context().newCDPSession(s.page);

    for (const c of CASES) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: c.w,
        height: c.h,
        deviceScaleFactor: c.dpr,
        mobile: false,
      });
      await s.page.waitForTimeout(150);

      const r = await safeEvaluate(
        s.page,
        ({ w, h }) => {
          const api = window.__dshCursorAPI;
          api.setTakeoverState('running', 'MATRIX');
          const ids = ['__dsh_vc_panel__', '__dsh_vc_badge__', '__dsh_vc_ring__', '__dsh_vc_arrow_svg__'];
          const readRect = (sel) => {
            const el = document.querySelector(sel);
            if (!el) return null;
            const b = el.getBoundingClientRect();
            return {
              t: Math.round(b.top),
              l: Math.round(b.left),
              r: Math.round(b.right),
              b: Math.round(b.bottom),
              w: Math.round(b.width),
              h: Math.round(b.height),
            };
          };
          const panel = readRect(ids[0] ? '#' + ids[0] : '');
          api.update(w - 6, h - 6, 'CORNER');
          const badgeCorner = readRect('#__dsh_vc_badge__');
          api.update(Math.round(w / 2), Math.round(h / 2), 'CENTER');
          const ring = readRect('#__dsh_vc_ring__');
          const arrow = readRect('#__dsh_vc_arrow_svg__');
          const arrowOpacity = getComputedStyle(document.getElementById('__dsh_vc_arrow_svg__')).opacity;
          return { panel, badgeCorner, ring, arrow, arrowOpacity, vw: innerWidth, vh: innerHeight };
        },
        null,
        { arg: { w: c.w, h: c.h }, retries: 0 }
      );

      const panelOk = Boolean(r?.panel && r.panel.t >= 0 && r.panel.l >= 0 && r.panel.r <= r.vw && r.panel.b <= r.vh);
      const badgeOk = Boolean(
        r?.badgeCorner &&
          r.badgeCorner.r <= r.vw - 7 &&
          r.badgeCorner.b <= r.vh - 7 &&
          r.badgeCorner.l >= 7 &&
          r.badgeCorner.t >= 7
      );
      const anchorX = Math.round(c.w / 2);
      const anchorY = Math.round(c.h / 2);
      const ringDX = r?.ring ? Math.round(r.ring.l + r.ring.w / 2 - anchorX) : 999;
      const ringDY = r?.ring ? Math.round(r.ring.t + r.ring.h / 2 - anchorY) : 999;
      const arrowDX = r?.arrow ? r.arrow.l - anchorX : 999;
      const arrowDY = r?.arrow ? r.arrow.t - anchorY : 999;

      const ringOk = Math.abs(ringDX) <= 1 && Math.abs(ringDY) <= 1;
      const arrowOk = Math.abs(arrowDX + 3) <= 4 && Math.abs(arrowDY + 3) <= 4 && r?.arrowOpacity === '1';

      if (!panelOk) failures++;
      if (!badgeOk) failures++;
      if (!ringOk) failures++;
      if (!arrowOk) failures++;

      rows.push({
        case: c.name,
        vw: r?.vw ?? 0,
        vh: r?.vh ?? 0,
        panel: panelOk ? 'ok' : `OUT ${JSON.stringify(r?.panel)}`,
        badge: badgeOk ? 'ok' : `OUT ${JSON.stringify(r?.badgeCorner)}`,
        ringOffset: `${ringDX},${ringDY}${ringOk ? '' : ' BAD'}`,
        arrowOffset: `${arrowDX},${arrowDY}${arrowOk ? '' : ' BAD'}`,
      });
    }
  } finally {
    await s.close().catch(() => {});
  }

  console.log(`\n=== Viewport Matrix [${label}] (consoleErrors=${consoleErrors.length}) ===`);
  console.log('用例'.padEnd(22) + '视口'.padEnd(12) + '状态条'.padEnd(10) + '徽标'.padEnd(10) + '光环偏移'.padEnd(12) + '箭头偏移(应≈-3,-3)');
  for (const r of rows) {
    console.log(
      `${r.case.padEnd(22)}${(r.vw + 'x' + r.vh).padEnd(12)}${String(r.panel).padEnd(10)}${String(r.badge).padEnd(10)}${String(r.ringOffset).padEnd(12)}${r.arrowOffset}`
    );
  }
  assert.equal(consoleErrors.length, 0, `Expected 0 console errors, got: ${consoleErrors.join('; ')}`);
  return failures;
}

const srv = await startFixtureServer();
let totalFailures = 0;
try {
  totalFailures += await runMatrixForUrl(`${srv.url}example`, 'Example-style SVG CSS');
  totalFailures += await runMatrixForUrl(`${srv.url}aggressive`, 'Aggressive div/svg/button CSS');
} finally {
  await srv.close();
}

console.log(
  totalFailures === 0
    ? '\n✅ 全部 9 组尺寸 / DPR 矩阵对齐与边界检查均通过！'
    : `\n❌ 发现 ${totalFailures} 项矩阵失败`
);
assert.equal(totalFailures, 0);
process.exit(0);
