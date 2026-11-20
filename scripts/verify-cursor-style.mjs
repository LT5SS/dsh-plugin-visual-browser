#!/usr/bin/env node
/**
 * verify-cursor-style.mjs — Automated regression test for B1 (cursor style persistence across navigations).
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { BrowserSession } from '../dist/driver/browser-session.js';
import { safeEvaluate } from '../dist/sampler/page-snapshot.js';

function startLocalFixtureServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Cursor Style Fixture ${req.url || '/'}</title>
  <style>
    body { font: 16px/1.6 system-ui, sans-serif; margin: 0; padding: 24px; }
    svg { display: block; margin: -2.75em auto 0; opacity: .55; }
  </style>
</head>
<body>
  <h1>Cursor Style Persistence Fixture (${req.url || '/'})</h1>
  <a id="next" href="/page-2">Next Page</a>
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

let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`    ${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
};

const srv = await startLocalFixtureServer();
const s = new BrowserSession({ mode: 'auto', windowMode: 'headless', backgroundSilent: true });

try {
  await s.start();
  await s.page.setViewportSize({ width: 754, height: 751 });
  await s.navigate(`${srv.url}page-1`, 'domcontentloaded');
  await s.page.waitForTimeout(200);

  const readShape = () =>
    safeEvaluate(
      s.page,
      () => {
        const p = document.getElementById('__dsh_vc_arrow_path__');
        const svg = document.getElementById('__dsh_vc_arrow_svg__');
        return {
          d: (p?.getAttribute('d') || '').slice(0, 28),
          fill: p?.getAttribute('fill') || null,
          transform: svg?.style.transform || '',
        };
      },
      { d: '', fill: null, transform: '' },
      0
    );

  // A. Switch cursor style at runtime
  await safeEvaluate(
    s.page,
    () =>
      window.__dshCursorAPI.setStyle({
        pointerShape: 'star',
        pointerColor: '#00f0ff',
        pointerScale: 1.4,
      }),
    undefined,
    0
  );
  const star = await readShape();
  check('A 运行时切换为 star 生效', star.d.startsWith('M14 2 L17.2'), `d=${star.d} fill=${star.fill}`);

  // B. Navigate to another URL -> style MUST persist
  await s.navigate(`${srv.url}page-2`, 'domcontentloaded');
  await s.page.waitForTimeout(300);
  const after = await readShape();
  check(
    'B 导航后仍保持 star',
    after.d.startsWith('M14 2 L17.2') && after.fill === '#00f0ff' && after.transform.includes('1.4'),
    `导航后 d=${after.d} fill=${after.fill} transform=${after.transform}`
  );
} finally {
  await s.close().catch(() => {});
  await srv.close();
}

console.log(failures === 0 ? '\n✅ 光标样式契约通过' : `\n❌ ${failures} 项失败`);
assert.equal(failures, 0);
process.exit(0);
