/**
 * 网格线绘制（M7 补测）。
 *
 * 这一支的规则是「宁可没有网格，也不要一片灰」：格太小、线太多时**直接不画**。
 * 那种情况下画面只是「没有网格」，看起来完全正常 —— 所以两条早退分支必须被锁住，
 * 否则哪天阈值写错，用户会看到一片灰蒙蒙的摩尔纹，还以为是显示器的问题。
 */

import { describe, expect, it } from 'vitest';

import { drawGrid, GRID_MIN_CELL, type GridSpec } from './canvasDraw';

interface StrokeCall {
  from: [number, number];
  to: [number, number];
  style: string;
}

class FakeCtx {
  strokeStyle = '';
  lineWidth = 1;
  strokes: StrokeCall[] = [];
  clipped: { x: number; y: number; w: number; h: number } | null = null;
  private pending: { from: [number, number]; to: [number, number] } | null = null;

  save(): void {}
  restore(): void {}
  beginPath(): void {
    this.pending = null;
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.clipped = { x, y, w, h };
  }
  clip(): void {}
  moveTo(x: number, y: number): void {
    this.pending = { from: [x, y], to: [x, y] };
  }
  lineTo(x: number, y: number): void {
    if (this.pending) this.pending.to = [x, y];
  }
  stroke(): void {
    if (this.pending) {
      this.strokes.push({ ...this.pending, style: this.strokeStyle });
      this.pending = null;
    }
  }
}

/** 测试里 ctx 是替身，故意用 unknown 转一次，避免给 FakeCtx 补一堆用不到的方法 */
function run(spec: GridSpec, viewW = 800, viewH = 600): FakeCtx {
  const ctx = new FakeCtx();
  drawGrid(ctx as unknown as CanvasRenderingContext2D, spec, viewW, viewH);
  return ctx;
}

const BASE: GridSpec = {
  ox: 100,
  oy: 50,
  cols: 8,
  rows: 6,
  cellW: 20,
  cellH: 20,
  step: 1,
  majorEvery: 8,
};

describe('drawGrid 的早退条件', () => {
  it('格边长小于阈值时一条不画（否则会糊成一片摩尔纹）', () => {
    const ctx = run({ ...BASE, cellW: GRID_MIN_CELL - 1, cellH: GRID_MIN_CELL - 1 });
    expect(ctx.strokes).toHaveLength(0);
  });

  it('刚好等于阈值时照画 —— 边界值不能算成「太小」', () => {
    const ctx = run({ ...BASE, cellW: GRID_MIN_CELL, cellH: GRID_MIN_CELL });
    expect(ctx.strokes.length).toBeGreaterThan(0);
  });

  it('线数超过上限时整体放弃', () => {
    // 上限是按**可见**线数算的（不是网格总列数）：一张 1000 列的图放大后
    // 屏上只有几十条线，那没问题；真正要防的是「又大又密又缩得很小」这一种。
    // 这里 400 列 + 300 行、格边长 4px、视口铺满 → 700 条可见线，超过 600。
    const ctx = run({ ...BASE, ox: 0, oy: 0, cols: 400, rows: 300, cellW: 4, cellH: 4 }, 1600, 1200);
    expect(ctx.strokes).toHaveLength(0);
  });

  it('大网格只要当前屏幕上格子够大，网格线照画', () => {
    // 同样的 400×300 网格，放大到每格 20px：屏上只有几十条线，应该照画
    const ctx = run({ ...BASE, ox: 0, oy: 0, cols: 400, rows: 300, cellW: 20, cellH: 20 }, 1600, 1200);
    expect(ctx.strokes.length).toBeGreaterThan(0);
  });

  it('完全在视口外时不画', () => {
    const ctx = run({ ...BASE, ox: -5000, oy: -5000 });
    expect(ctx.strokes).toHaveLength(0);
  });
});

describe('drawGrid 的坐标', () => {
  it('竖线走的是整条可见高度，横线走整条可见宽度', () => {
    const ctx = run(BASE);
    const vertical = ctx.strokes.filter((s) => s.from[0] === s.to[0]);
    const horizontal = ctx.strokes.filter((s) => s.from[1] === s.to[1]);
    expect(vertical.length).toBeGreaterThan(0);
    expect(horizontal.length).toBeGreaterThan(0);
    // 竖线：x 相同，y 从视口上沿到下沿
    expect(vertical[0].from[1]).toBe(50);
    expect(vertical[0].to[1]).toBe(170);
    // 横线：y 相同，x 从视口左沿到右沿
    expect(horizontal[0].from[0]).toBe(100);
    expect(horizontal[0].to[0]).toBe(260);
  });

  it('线画在格边界上，并且取半像素对齐（否则 1px 线会糊成 2px）', () => {
    const ctx = run(BASE);
    const xs = ctx.strokes.filter((s) => s.from[0] === s.to[0]).map((s) => s.from[0]);
    // ox=100、cellW=20 → 100.5 / 120.5 / 140.5 …
    expect(xs).toContain(100.5);
    expect(xs).toContain(120.5);
    expect(xs.every((x) => Number.isInteger((x - 0.5) / 1))).toBe(true);
  });

  it('每隔 majorEvery 条换成强调色', () => {
    const ctx = run(BASE);
    const styles = new Set(ctx.strokes.map((s) => s.style));
    expect(styles.size).toBe(2);
  });

  it('裁剪区就是整张网格的范围', () => {
    const ctx = run(BASE);
    expect(ctx.clipped).toEqual({ x: 100, y: 50, w: 160, h: 120 });
  });

  it('step 降采样时只画每 step 条线里的一条', () => {
    const dense = run({ ...BASE, step: 1 });
    const sparse = run({ ...BASE, step: 4 });
    expect(sparse.strokes.length).toBeLessThan(dense.strokes.length);
    // 8 列 / step 4 → i = 0, 4, 8 → 3 条竖线；6 行 → j = 0, 4 → 2 条横线
    expect(sparse.strokes.filter((s) => s.from[0] === s.to[0])).toHaveLength(3);
    expect(sparse.strokes.filter((s) => s.from[1] === s.to[1])).toHaveLength(2);
  });
});