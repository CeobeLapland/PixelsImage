import { describe, expect, it } from 'vitest';

import type { GridPoint } from '../types';
import {
  clampPoint,
  ellipseFillPoints,
  ellipseOutlinePoints,
  floodFillPoints,
  linePoints,
  rectFillPoints,
  rectOutlinePoints,
  shapePoints,
} from './geometry';

function key(x: number, y: number): string {
  return `${x},${y}`;
}

function asSet(points: readonly GridPoint[]): Set<string> {
  return new Set(points.map((p) => key(p.x, p.y)));
}

describe('linePoints（Bresenham）', () => {
  it('水平线含两端点且无断点', () => {
    const pts = linePoints({ x: 0, y: 0 }, { x: 3, y: 0 });
    expect(pts.map((p) => key(p.x, p.y))).toEqual(['0,0', '1,0', '2,0', '3,0']);
  });

  it('对角线逐格推进', () => {
    const pts = linePoints({ x: 0, y: 0 }, { x: 2, y: 2 });
    expect(pts.map((p) => key(p.x, p.y))).toEqual(['0,0', '1,1', '2,2']);
  });

  it('反向拖拽与正向得到同一组格子', () => {
    const a = asSet(linePoints({ x: 1, y: 1 }, { x: 7, y: 3 }));
    const b = asSet(linePoints({ x: 7, y: 3 }, { x: 1, y: 1 }));
    expect(a).toEqual(b);
  });

  it('陡峭的线每行都有格子（不会漏行出现虚线）', () => {
    const pts = linePoints({ x: 0, y: 0 }, { x: 2, y: 9 });
    const rows = new Set(pts.map((p) => p.y));
    expect(rows.size).toBe(10);
  });

  it('起点等于终点时只有一格', () => {
    expect(linePoints({ x: 4, y: 4 }, { x: 4, y: 4 })).toHaveLength(1);
  });
});

describe('rectOutlinePoints / rectFillPoints', () => {
  it('2×2 的轮廓就是四格，且不重复', () => {
    const pts = rectOutlinePoints({ x: 0, y: 0 }, { x: 1, y: 1 });
    expect(pts).toHaveLength(4);
    expect(asSet(pts).size).toBe(4);
  });

  it('3×3 的轮廓是 8 格，中心不属于轮廓', () => {
    const pts = rectOutlinePoints({ x: 0, y: 0 }, { x: 2, y: 2 });
    expect(pts).toHaveLength(8);
    expect(asSet(pts).has('1,1')).toBe(false);
  });

  it('退化成一条线时不重复输出', () => {
    const pts = rectOutlinePoints({ x: 0, y: 0 }, { x: 0, y: 3 });
    expect(pts).toHaveLength(4);
    expect(asSet(pts).size).toBe(4);
  });

  it('填充覆盖整个包围盒', () => {
    const pts = rectFillPoints({ x: 1, y: 1 }, { x: 3, y: 2 });
    expect(pts).toHaveLength(6);
    expect(asSet(pts).has('3,2')).toBe(true);
  });

  it('反向拖拽等价于正向', () => {
    expect(asSet(rectFillPoints({ x: 3, y: 3 }, { x: 0, y: 0 }))).toEqual(
      asSet(rectFillPoints({ x: 0, y: 0 }, { x: 3, y: 3 })),
    );
  });
});

describe('椭圆', () => {
  it('5×5 实心椭圆对称、含中心、不含四角', () => {
    const pts = ellipseFillPoints({ x: 0, y: 0 }, { x: 4, y: 4 });
    const set = asSet(pts);

    expect(set.has('2,2')).toBe(true);
    expect(set.has('0,0')).toBe(false);
    expect(set.has('4,0')).toBe(false);
    // 左右 / 上下镜像都必须存在
    for (const p of pts) {
      expect(set.has(key(4 - p.x, p.y))).toBe(true);
      expect(set.has(key(p.x, 4 - p.y))).toBe(true);
    }
  });

  it('轮廓是闭合的：每一行都有格子，且不含中心', () => {
    const pts = ellipseOutlinePoints({ x: 0, y: 0 }, { x: 6, y: 6 });
    const rows = new Set(pts.map((p) => p.y));
    expect(rows.size).toBe(7);
    expect(asSet(pts).has('3,3')).toBe(false);
  });

  it('轮廓比实心少', () => {
    const outline = ellipseOutlinePoints({ x: 0, y: 0 }, { x: 7, y: 7 });
    const fill = ellipseFillPoints({ x: 0, y: 0 }, { x: 7, y: 7 });
    expect(outline.length).toBeLessThan(fill.length);
  });

  it('1×1 与 2×2 这类退化尺寸也能出格子', () => {
    expect(ellipseFillPoints({ x: 2, y: 2 }, { x: 2, y: 2 }).length).toBeGreaterThan(0);
    expect(ellipseFillPoints({ x: 0, y: 0 }, { x: 1, y: 1 }).length).toBeGreaterThan(0);
  });

  it('偏移的包围盒仍然落在正确的位置', () => {
    const pts = ellipseFillPoints({ x: 10, y: 20 }, { x: 14, y: 24 });
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(10);
      expect(p.x).toBeLessThanOrEqual(14);
      expect(p.y).toBeGreaterThanOrEqual(20);
      expect(p.y).toBeLessThanOrEqual(24);
    }
  });
});

describe('floodFillPoints', () => {
  /**
   * 3×3 的图，中间一竖列是另一种颜色：
   *   1 1 2
   *   1 1 2
   *   1 1 2
   */
  function keys(): { data: Uint32Array; w: number; h: number } {
    const w = 3;
    const h = 3;
    const data = new Uint32Array(w * h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) data[y * w + x] = x === 2 ? 2 : 1;
    }
    return { data, w, h };
  }

  it('只填连通的同值区域', () => {
    const { data, w, h } = keys();
    const pts = floodFillPoints(data, w, h, { x: 0, y: 0 });
    expect(pts).toHaveLength(6);
    expect(asSet(pts).has('2,0')).toBe(false);
  });

  it('从另一侧填充互不影响', () => {
    const { data, w, h } = keys();
    const pts = floodFillPoints(data, w, h, { x: 2, y: 1 });
    expect(pts).toHaveLength(3);
  });

  it('单色整图会被全部填充', () => {
    const w = 4;
    const h = 3;
    const data = new Uint32Array(w * h).fill(7);
    expect(floodFillPoints(data, w, h, { x: 0, y: 0 })).toHaveLength(12);
  });

  it('起点越界返回空，不抛错', () => {
    const { data, w, h } = keys();
    expect(floodFillPoints(data, w, h, { x: 9, y: 9 })).toHaveLength(0);
    expect(floodFillPoints(data, 0, 0, { x: 0, y: 0 })).toHaveLength(0);
  });

  it('目标值不同但索引相同、alpha 不同的格子不会连通', () => {
    // 打包值 = index<<8 | alpha，alpha 不同就是不同的键
    const data = new Uint32Array([(1 << 8) | 255, (1 << 8) | 128]);
    expect(floodFillPoints(data, 2, 1, { x: 0, y: 0 })).toHaveLength(1);
  });
});

describe('shapePoints 分发', () => {
  it('rect 按 fill 走轮廓或实心', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 2, y: 2 };
    expect(shapePoints(a, b, 'rect', false)).toHaveLength(8);
    expect(shapePoints(a, b, 'rect', true)).toHaveLength(9);
  });

  it('line 与 fill 无关', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 3, y: 0 };
    expect(shapePoints(a, b, 'line', true)).toEqual(shapePoints(a, b, 'line', false));
  });

  it('ellipse 按 fill 走轮廓或实心', () => {
    const a = { x: 0, y: 0 };
    const b = { x: 6, y: 6 };
    expect(shapePoints(a, b, 'ellipse', true).length).toBeGreaterThan(
      shapePoints(a, b, 'ellipse', false).length,
    );
  });
});

describe('clampPoint', () => {
  it('把远端的点收进网格，形状不会无限延伸', () => {
    expect(clampPoint({ x: -5, y: 100 }, 8, 8)).toEqual({ x: 0, y: 7 });
    expect(clampPoint({ x: 3, y: 3 }, 8, 8)).toEqual({ x: 3, y: 3 });
  });
});