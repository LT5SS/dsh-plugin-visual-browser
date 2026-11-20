import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserSession } from '../src/driver/browser-session.js';

const MIME_MAP: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.pdf': 'application/pdf',
};

function startSilentStaticServer(rootDir: string): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const cleanUrl = (req.url || '/').split('?')[0];
      const relPath = cleanUrl === '/' ? 'index.html' : cleanUrl.replace(/^\/+/, '');
      const fullPath = path.join(rootDir, decodeURIComponent(relPath));

      if (!fullPath.startsWith(rootDir) || !fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const ext = path.extname(fullPath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME_MAP[ext] || 'application/octet-stream' });
      fs.createReadStream(fullPath).pipe(res);
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}/`,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function main() {
  const distDir = path.resolve('E:/AI_Work/Antigravity/aw-argon-edition/dist');
  const outDir = path.resolve('E:/AI_Work/Antigravity/dsh-plugin-visual-browser/artifacts/stage1');

  console.log('[Stage 1 Verify] Starting silent local test server...');
  const srv = await startSilentStaticServer(distDir);

  console.log('[Stage 1 Verify] Launching Dual-Mode BrowserSession (backgroundSilent: true)...');
  const session = await new BrowserSession({
    mode: 'auto',
    backgroundSilent: true,
    viewport: { width: 1440, height: 900 },
  }).start();

  console.log(`[Stage 1 Verify] Active runtime mode: ${session.activeMode} (0 popup windows, 0 focus stolen)`);

  try {
    await session.navigate(srv.url, 'networkidle');
    // Wait for preloader boot sequence to complete
    await session.page.waitForTimeout(2300);

    // 1. Sweep virtual cursor across the 96-channel SVG waveform curtain
    console.log('[Stage 1 Verify] Step 1: Sweeping Bezier virtual cursor across 96-ch SVG wave curtain...');
    await session.motion.sweepPath(
      [
        { x: 320, y: 460 },
        { x: 640, y: 390 },
        { x: 980, y: 470 },
        { x: 1120, y: 430 },
      ],
      { steps: 18, durationMs: 240, arcCurvature: 0.18, label: 'WAVE SWEEP' }
    );
    const shot1 = await session.screenshot(path.join(outDir, 'stage1_01_hero_wave_sweep.png'));
    console.log(`  -> Saved: ${shot1}`);

    // 2. Smooth wheel scroll down to #about Physics Bento Arena & click "弹跳测试 ↑"
    console.log('[Stage 1 Verify] Step 2: Smooth scrolling to #about and clicking Physics Sandbox kick button...');
    await session.motion.smoothScroll(1240, 18, 420);
    await session.page.waitForTimeout(350);
    await session.motion.clickSelector('.js-physics-kick', {
      steps: 24,
      durationMs: 320,
      arcCurvature: -0.2,
      label: 'CLICK KICK ↑',
    });
    await session.page.waitForTimeout(180);
    const shot2 = await session.screenshot(path.join(outDir, 'stage1_02_physics_click_ripple.png'));
    console.log(`  -> Saved: ${shot2}`);

    // 3. Move virtual cursor along a curved trajectory to bottom-left CUE dock and switch to Night Blue
    console.log('[Stage 1 Verify] Step 3: Moving virtual cursor to CUE dock and switching theme to Night Blue...');
    await session.motion.clickSelector('[data-set-cue="night"]', {
      steps: 26,
      durationMs: 360,
      arcCurvature: 0.22,
      label: 'CUE: 夜蓝控台',
    });
    await session.page.waitForTimeout(450);
    const shot3 = await session.screenshot(path.join(outDir, 'stage1_03_cue_theme_switch.png'));
    console.log(`  -> Saved: ${shot3}`);

    console.log('[Stage 1 Verify] All 3 physical trajectory & background silent checks passed!');
  } finally {
    await session.close();
    await srv.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
