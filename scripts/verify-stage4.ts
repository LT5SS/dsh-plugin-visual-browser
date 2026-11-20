import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { ToolDefinition } from '@deepseek-ai/dsh-tools';
import {
  apply,
  type DshCordisContext,
  type SubagentActionDecision,
  type SubagentPlannerContext,
} from '../src/index.js';

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
  const artifactDir = path.resolve('E:/AI_Work/Antigravity/dsh-plugin-visual-browser/artifacts/stage4');
  fs.mkdirSync(artifactDir, { recursive: true });

  const srv = await startSilentStaticServer(distDir);

  // 1. Mock a DSH Cordis Context & mount our plugin via apply(ctx, config)
  const registeredTools = new Map<string, ToolDefinition>();
  const disposeCallbacks: Array<() => Promise<void>> = [];

  const mockDshCtx: DshCordisContext = {
    tools: {
      register(tool) {
        registeredTools.set(tool.name, tool);
        console.log(`[DSH Cordis Host] Registered tool: ${tool.name}`);
      },
    },
    on(event, fn) {
      if (event === 'dispose') disposeCallbacks.push(fn as any);
    },
  };

  let simulatedGateInjected = false;

  const stage4Planner = async (ctx: SubagentPlannerContext): Promise<SubagentActionDecision> => {
    if (ctx.stepIndex === 1) {
      return {
        type: 'move_mouse',
        points: [
          { x: 300, y: 440 },
          { x: 750, y: 390 },
          { x: 1050, y: 450 },
        ],
        label: 'STAGE4 SWEEP',
        reason: 'Sweep hero wave curtain with custom trail',
      };
    }

    if (ctx.stepIndex === 2 && !simulatedGateInjected) {
      simulatedGateInjected = true;
      return {
        type: 'pause_for_takeover',
        blockReason: 'LOGIN_REQUIRED',
        message: 'Encountered backstage VIP login gate. Pausing in-place for human authentication.',
      };
    }

    if (ctx.stepIndex === 3) {
      return {
        type: 'scroll',
        deltaY: 1200,
        reason: 'After human takeover resume, scroll down to #about section',
      };
    }

    return {
      type: 'complete',
      report:
        'COMPLETED / TASK_COMPLETED\n\nStage 4 Full DSH Plugin Lifecycle (Custom Trail -> Run -> Pause & Approval Card -> In-Place Resume -> Complete) verified!',
    };
  };

  const { runner } = apply(mockDshCtx, {
    mode: 'auto',
    backgroundSilent: true,
    artifactDir,
    maxSteps: 8,
    maxRecentImages: 3,
    customPlanner: stage4Planner,
  });

  try {
    const fakeExec: any = { signal: new AbortController().signal };
    // 2. Call `browser_set_cursor_trail` tool
    const trailTool = registeredTools.get('browser_set_cursor_trail')!;
    const trailRes = await trailTool.execute({
      preset: 'comet-gold',
      trail_width: 4.5,
      trail_length: 28,
    }, fakeExec);
    console.log('\n[Stage 4 Verify] Tool 1 (`browser_set_cursor_trail`) result:', JSON.stringify(trailRes));

    // 3. Call `browser_subagent_run` -> Will pause at Step 2 with a DSH_BROWSER_TAKEOVER_CARD!
    const runTool = registeredTools.get('browser_subagent_run')!;
    console.log('\n[Stage 4 Verify] Tool 2 (`browser_subagent_run`) launching...');
    const runRes: any = await runTool.execute({
      url: srv.url,
      role: 'Stage 4 DSH Lifecycle Tester',
      task_prompt: 'Sweep hero waves, pause at login gate for human takeover, then scroll to #about.',
    }, fakeExec);

    console.log(`[Stage 4 Verify] Subagent paused status: ${runRes.status}`);
    console.log('[Stage 4 Verify] Generated DSH Approval / Takeover Card:');
    console.log(JSON.stringify(runRes.approval_card, null, 2));

    // 4. Call `browser_subagent_resume` with the paused `subagent_id` to continue in the SAME open tab!
    const resumeTool = registeredTools.get('browser_subagent_resume')!;
    console.log(`\n[Stage 4 Verify] Tool 3 (\`browser_subagent_resume\`) resuming ${runRes.subagent_id} in-place...`);
    const resumeRes: any = await resumeTool.execute({
      subagent_id: runRes.subagent_id,
      user_note: 'User completed login in the paused browser tab. Please continue scrolling to #about.',
    }, fakeExec);

    console.log(`[Stage 4 Verify] Resumed subagent final status: ${resumeRes.status}`);
    console.log('\n' + resumeRes.host_facts_block);
    console.log('\n' + resumeRes.subagent_report);
  } finally {
    await runner.closeAllPausedSessions();
    await srv.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
