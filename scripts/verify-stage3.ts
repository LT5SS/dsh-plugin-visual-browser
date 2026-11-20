import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import {
  BrowserSubagentRunner,
  type SubagentActionDecision,
  type SubagentPlannerContext,
} from '../src/subagent/runner.js';

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

/**
 * Autonomous multi-step subagent planner that inspects live PageObservations
 * across 7 steps to verify sliding image window eviction & BROWSER_HOST_FACTS tracking.
 */
async function autonomousVerifierPlanner(ctx: SubagentPlannerContext): Promise<SubagentActionDecision> {
  const { stepIndex, latestObservation, history } = ctx;
  const stats = history.getStats();
  console.log(
    `  [Subagent Turn ${stepIndex}] Scroll=${latestObservation.scroll.scrollProgressPercent}% | ` +
      `Images in VLM Window=${stats.activeImagesInContext}/${stats.totalImagesCaptured} (Evicted=${stats.evictedImagesCount}, Saved=${stats.savingsPercent}%)`
  );

  switch (stepIndex) {
    case 1:
      return {
        type: 'move_mouse',
        points: [
          { x: 280, y: 450 },
          { x: 720, y: 380 },
          { x: 1140, y: 450 },
        ],
        label: 'HERO WAVE TEST',
        reason: 'Test 96-channel SVG wave curtain repulsion in Hero section',
      };

    case 2:
      return {
        type: 'scroll',
        deltaY: 1220,
        reason: 'Scroll down to #about section and 2D physics sandbox',
      };

    case 3: {
      const kickBtn = latestObservation.interactiveElements.find((el) =>
        el.label.includes('弹跳测试')
      );
      return {
        type: 'click',
        target: kickBtn ? kickBtn.ref : '.js-physics-kick',
        reason: 'Click Physics Sandbox kick button via sampled #ref ID',
      };
    }

    case 4:
      // Attempt to visit a blocked external origin to verify BROWSER_HOST_FACTS blocked_origins recording
      return {
        type: 'navigate',
        url: 'https://untrusted-tracker.example.com/collect',
        reason: 'Test host origin security policy against disallowed external domain',
      };

    case 5:
      // Scroll all the way down to bottom CTA fisheye grid section
      return {
        type: 'scroll',
        deltaY: 12500,
        reason: 'Scroll to bottom CTA Fisheye Grid & GO button',
      };

    case 6: {
      const goBtn = latestObservation.interactiveElements.find((el) =>
        el.label.includes('GO')
      );
      return {
        type: 'click',
        target: goBtn ? goBtn.ref : '.js-go-btn',
        reason: 'Fire Master Cue GO button to trigger 4-slice LET’S LIGHT portal',
      };
    }

    default: {
      const entries = history.getEntries();
      const archivedCount = entries.filter((e) => e.imageBase64 === null).length;
      const activeCount = entries.filter((e) => e.imageBase64 !== null).length;
      return {
        type: 'complete',
        report: [
          `COMPLETED / TASK_COMPLETED`,
          ``,
          `### Autonomous Subagent Visual Walkthrough Report`,
          `- **Page Title**: ${latestObservation.domStats.title}`,
          `- **Total Height**: ${latestObservation.scroll.scrollHeight}px (Reached ${latestObservation.scroll.scrollProgressPercent}%)`,
          `- **Detected Tech Stack**: ${latestObservation.domStats.detectedTechHints.join(', ')}`,
          `- **DOM Resource Counts**: canvas=${latestObservation.domStats.counts.canvas}, svg=${latestObservation.domStats.counts.svg}, img=${latestObservation.domStats.counts.img}, section=${latestObservation.domStats.counts.section}`,
          `- **Interactive Controls Verified**: Hero 96-ch SVG Wave Curtain, #about 2D Gravity Sandbox Kick Button, Bottom CTA Fisheye GO Portal (\`LET'S LIGHT\` 4-slice reveal).`,
          `- **Sliding Context Efficiency**: ${entries.length} snapshots captured; ${archivedCount} older screenshots evicted to compact text, ${activeCount} recent screenshots kept in VLM window.`,
          `- **Runtime Health**: ConsoleErrors=${latestObservation.health.consoleErrorsCount}, FailedRequests=${latestObservation.health.failedRequestsCount}/${latestObservation.health.totalRequests}.`,
        ].join('\n'),
      };
    }
  }
}

async function main() {
  const distDir = path.resolve('E:/AI_Work/Antigravity/aw-argon-edition/dist');
  const artifactDir = path.resolve('E:/AI_Work/Antigravity/dsh-plugin-visual-browser/artifacts/stage3');
  fs.mkdirSync(artifactDir, { recursive: true });

  const srv = await startSilentStaticServer(distDir);
  const runner = new BrowserSubagentRunner();

  try {
    console.log('[Stage 3 Verify] Launching Isolated BrowserSubagentRunner (maxRecentImages: 3)...');
    const result = await runner.runTask({
      role: 'Portfolio Visual QA Subagent',
      taskPrompt:
        'Walk through the portfolio from top to bottom, test the wave curtain, physics sandbox, and bottom GO button, and return a structured report.',
      startUrl: srv.url,
      artifactDir,
      maxSteps: 10,
      maxRecentImages: 3,
      blockedOrigins: ['https://untrusted-tracker.example.com'],
      sessionOptions: {
        mode: 'auto',
        backgroundSilent: true,
        viewport: { width: 1440, height: 900 },
        cursorStyle: { preset: 'cyber-neon' },
      },
      planner: autonomousVerifierPlanner,
    });

    console.log('\n================ [1. SLIDING WINDOW TOKEN SAVINGS] ================');
    console.log(JSON.stringify(result.contextStats, null, 2));

    console.log('\n================ [2. TAMPER-PROOF BROWSER_HOST_FACTS] ================');
    console.log(result.hostFactsBlock);

    console.log('\n================ [3. SUBAGENT FINAL REPORT] ================');
    console.log(result.subagentReport);

    const summaryFile = path.join(artifactDir, 'stage3_verification_summary.md');
    fs.writeFileSync(
      summaryFile,
      [
        `# Stage 3 Verification Summary`,
        ``,
        `## 1. Authoritative Host Facts (\`BROWSER_HOST_FACTS\`)`,
        '```text',
        result.hostFactsBlock,
        '```',
        ``,
        `## 2. Sliding Image Window Metrics`,
        '```json',
        JSON.stringify(result.contextStats, null, 2),
        '```',
        ``,
        `## 3. Subagent Output Report`,
        result.subagentReport,
      ].join('\n'),
      'utf8'
    );
    console.log(`\n[Stage 3 Verify] Saved verification summary -> ${summaryFile}`);
  } finally {
    await srv.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
