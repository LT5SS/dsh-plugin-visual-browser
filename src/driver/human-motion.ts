import type { Page } from 'playwright-core';
import type { MotionOptions, Point2D, VirtualCursorStyleConfig } from './types.js';
import { buildVirtualCursorInitScript } from '../injected/virtual-cursor.js';

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function cubicBezier(p0: Point2D, p1: Point2D, p2: Point2D, p3: Point2D, t: number): Point2D {
  const u = 1 - t;
  const tt = t * t;
  const uu = u * u;
  const uuu = uu * u;
  const ttt = tt * t;

  return {
    x: uuu * p0.x + 3 * uu * t * p1.x + 3 * u * tt * p2.x + ttt * p3.x,
    y: uuu * p0.y + 3 * uu * t * p1.y + 3 * u * tt * p2.y + ttt * p3.y,
  };
}

export class HumanMotionController {
  private page: Page;
  private pos: Point2D = { x: 120, y: 120 };
  private cursorStyle: VirtualCursorStyleConfig;

  constructor(page: Page, initialStyle: VirtualCursorStyleConfig = {}) {
    this.page = page;
    this.cursorStyle = initialStyle;
  }

  public getPosition(): Point2D {
    return { ...this.pos };
  }

  public getCursorStyle(): VirtualCursorStyleConfig {
    return { ...this.cursorStyle };
  }

  public async ensureCursorHUD(): Promise<void> {
    const initScript = buildVirtualCursorInitScript(this.cursorStyle);
    await this.page.evaluate((script) => {
      if (!(window as any).__dshVirtualCursorInstalled) {
        (0, eval)(script);
      }
    }, initScript);
  }

  /**
   * Dynamically updates the virtual cursor & trail style (preset or custom colors/width/length/variant).
   */
  public async setCursorStyle(style: VirtualCursorStyleConfig): Promise<void> {
    this.cursorStyle = { ...this.cursorStyle, ...style };
    await this.ensureCursorHUD();
    await this.page.evaluate((cfg) => {
      (window as any).__dshCursorAPI?.setStyle(cfg);
    }, style);
  }

  public async clearTrail(): Promise<void> {
    await this.ensureCursorHUD();
    await this.page.evaluate(() => {
      (window as any).__dshCursorAPI?.clearTrail();
    });
  }

  /**
   * Moves the virtual mouse along a cubic Bezier arc with human-like acceleration/deceleration.
   */
  public async moveTo(targetX: number, targetY: number, opts: MotionOptions = {}): Promise<Point2D> {
    await this.ensureCursorHUD();

    const steps = opts.steps ?? 24;
    const durationMs = opts.durationMs ?? 340;
    const curvature = opts.arcCurvature ?? 0.16;
    const label = opts.label ?? 'MOVE';

    const p0 = { ...this.pos };
    const p3 = { x: targetX, y: targetY };
    const dx = p3.x - p0.x;
    const dy = p3.y - p0.y;
    const dist = Math.hypot(dx, dy);

    if (dist < 1) {
      await this.syncHUD(p3.x, p3.y, label);
      return p3;
    }

    const nx = -dy / dist;
    const ny = dx / dist;
    const arcOffset = dist * curvature;

    const p1: Point2D = {
      x: p0.x + dx * 0.3 + nx * arcOffset,
      y: p0.y + dy * 0.3 + ny * arcOffset,
    };
    const p2: Point2D = {
      x: p0.x + dx * 0.72 + nx * (arcOffset * 0.55),
      y: p0.y + dy * 0.72 + ny * (arcOffset * 0.55),
    };

    const stepDelay = Math.max(4, Math.round(durationMs / steps));

    for (let i = 1; i <= steps; i++) {
      const progress = easeInOutCubic(i / steps);
      const pt = cubicBezier(p0, p1, p2, p3, progress);
      this.pos = pt;

      await this.page.mouse.move(pt.x, pt.y);
      await this.syncHUD(pt.x, pt.y, i === steps ? label : 'MOVING');
      await this.page.waitForTimeout(stepDelay);
    }

    return { ...this.pos };
  }

  public async sweepPath(waypoints: Point2D[], opts: MotionOptions = {}): Promise<Point2D> {
    for (let i = 0; i < waypoints.length; i++) {
      const wp = waypoints[i];
      await this.moveTo(wp.x, wp.y, {
        steps: opts.steps ?? 16,
        durationMs: opts.durationMs ?? 200,
        arcCurvature: opts.arcCurvature ?? 0.12,
        label: opts.label ?? `SWEEP ${i + 1}/${waypoints.length}`,
      });
    }
    return { ...this.pos };
  }

  public async hoverSelector(selector: string, opts: MotionOptions = {}): Promise<Point2D> {
    const loc = this.page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout: 8000 });
    const box = await loc.boundingBox();
    if (!box) {
      throw new Error(`Cannot resolve boundingBox for selector: ${selector}`);
    }
    const cx = box.x + box.width * 0.5;
    const cy = box.y + box.height * 0.5;
    return this.moveTo(cx, cy, {
      ...opts,
      label: opts.label ?? `HOVER ${selector}`,
    });
  }

  public async clickAt(x: number, y: number, opts: MotionOptions = {}): Promise<Point2D> {
    await this.moveTo(x, y, { ...opts, label: opts.label ?? 'AIM' });
    await this.page.mouse.down();
    await this.page.evaluate(
      ({ px, py, lbl }) => {
        (window as any).__dshCursorAPI?.clickEffect(px, py, lbl);
      },
      { px: x, py: y, lbl: opts.label ?? 'CLICK' }
    );
    await this.page.waitForTimeout(55);
    await this.page.mouse.up();
    await this.page.waitForTimeout(80);
    return { ...this.pos };
  }

  public async clickSelector(selector: string, opts: MotionOptions = {}): Promise<Point2D> {
    const pt = await this.hoverSelector(selector, {
      ...opts,
      label: `AIM ${selector}`,
    });
    return this.clickAt(pt.x, pt.y, {
      ...opts,
      steps: 2,
      durationMs: 20,
      label: opts.label ?? `CLICK ${selector}`,
    });
  }

  public async smoothScroll(deltaY: number, frames = 16, durationMs = 360): Promise<void> {
    await this.ensureCursorHUD();
    const delay = Math.max(8, Math.round(durationMs / frames));
    let accumulated = 0;

    for (let i = 1; i <= frames; i++) {
      const targetNow = deltaY * easeInOutCubic(i / frames);
      const stepDelta = targetNow - accumulated;
      accumulated = targetNow;

      await this.page.mouse.wheel(0, stepDelta);
      const dirSign = deltaY >= 0 ? '+' : '';
      await this.syncHUD(this.pos.x, this.pos.y, `SCROLL ${dirSign}${Math.round(accumulated)}px`);
      await this.page.waitForTimeout(delay);
    }
  }

  private async syncHUD(x: number, y: number, label: string): Promise<void> {
    await this.page.evaluate(
      ({ px, py, lbl }) => {
        (window as any).__dshCursorAPI?.update(px, py, lbl);
      },
      { px: x, py: y, lbl: label }
    );
  }
}
