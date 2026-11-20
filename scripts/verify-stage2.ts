import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { BrowserSession } from '../src/driver/browser-session.js';
import { AtomicBrowserToolset } from '../src/tools/atomic-tools.js';

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
  const outDir = path.resolve('E:/AI_Work/Antigravity/dsh-plugin-visual-browser/artifacts/stage2');
  fs.mkdirSync(outDir, { recursive: true });

  const srv = await startSilentStaticServer(distDir);

  // Initialize session with customizable 'comet-gold' trail preset
  const session = await new BrowserSession({
    mode: 'auto',
    backgroundSilent: true,
    viewport: { width: 1440, height: 900 },
    cursorStyle: { preset: 'comet-gold' },
  }).start();

  const tools = new AtomicBrowserToolset(session, outDir);
  const reportLogs: string[] = [];

  try {
    console.log('[Stage 2 Verify] 1. Navigating with preset="comet-gold" & capturing initial snapshot...');
    const navRes = await tools.navigate(srv.url, 2300);
    reportLogs.push(navRes.llmSummary);

    console.log('[Stage 2 Verify] 2. Sweeping wave curtain with Comet-Gold trail...');
    const sweepRes = await tools.moveMouse(
      [
        { x: 260, y: 450 },
        { x: 660, y: 370 },
        { x: 1080, y: 460 },
      ],
      'COMET-GOLD TRAIL'
    );
    reportLogs.push(sweepRes.llmSummary);

    console.log('[Stage 2 Verify] 3. Switching trail to "laser-dots" (particle dot trail) & scrolling to #about...');
    await tools.setCursorStyle({ preset: 'laser-dots' });
    const scrollRes = await tools.scroll(1150, 350);
    reportLogs.push(scrollRes.llmSummary);

    // Find the "在线试玩：北辰青年 3 个网页原型" button by its sampled #ref ID!
    const demoBtnNode = scrollRes.observation.interactiveElements.find((el) =>
      el.label.includes('北辰青年 3 个网页原型')
    );
    const targetRef = demoBtnNode ? demoBtnNode.ref : '.js-open-demos';
    console.log(`[Stage 2 Verify] 4. Clicking interactive control by sampled Ref ID: ${targetRef} ("${demoBtnNode?.label}")...`);
    const clickModalRes = await tools.click(targetRef, 500);
    reportLogs.push(clickModalRes.llmSummary);

    // Now switch to a 100% user-defined custom Emerald-Cyan Solid Ribbon trail!
    console.log('[Stage 2 Verify] 5. Applying custom user-defined trail (Emerald-Cyan Solid Ribbon) & clicking Certificate tab by #ref...');
    await tools.setCursorStyle({
      trailVariant: 'solid',
      pointerColor: '#10b981',
      pointerBorderColor: '#ffffff',
      trailColorStart: '#06b6d4',
      trailColorEnd: '#10b981',
      trailWidth: 4.2,
      trailLength: 32,
      trailGlow: true,
      rippleColor: '#34d399',
      showBadge: true,
    });

    const certTabNode = clickModalRes.observation.interactiveElements.find((el) =>
      el.label.includes('圆满结项实习证书')
    );
    const certRef = certTabNode ? certTabNode.ref : '[data-tab="cert"]';
    const clickCertRes = await tools.click(certRef, 450);
    reportLogs.push(clickCertRes.llmSummary);

    // 6. Test read-only DOM inspection tool
    const domCheck = await tools.inspectDom('.swiss-modal[open]');
    console.log(`[Stage 2 Verify] 6. Read-only inspectDom('.swiss-modal[open]') count: ${domCheck.count}`);

    const reportPath = path.join(outDir, 'observation_report.md');
    fs.writeFileSync(reportPath, reportLogs.join('\n\n---\n\n'), 'utf8');
    console.log(`[Stage 2 Verify] Saved full multimodal observation HUD log -> ${reportPath}`);
    console.log('\n' + clickCertRes.llmSummary);
  } finally {
    await session.close();
    await srv.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
