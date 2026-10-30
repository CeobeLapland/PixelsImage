/**
 * 局部换板的测试。
 *
 * 这里锁三件事，全部属于「错了不会报错、只会静默多改东西」的那类：
 * 1. 选区外一个格子都不能动（换板必须把新色追加到板尾，不能改已有索引）；
 * 2. 透明格不能被写（否则边缘会被凭空染上颜色）；
 * 3. 颜色没变的格子不能写（否则一次局部操作会把整个选区记成「手改」）。
 */

import { describe, expect, it } from 'vitest';

import { makePalette, BLACK, BLUE, RED, WHITE } from '@/core/__testing__/fixtures';
import { createGrid, PALETTE_MAX_COLORS, type Palette, type PixelGrid } from '@/core/types';
import { clampRegion, planLocalRequantize, type LocalRequantizeRequest } from './requantize';

const SOURCE = makePalette('src', [RED, BLUE, WHITE]);
const BW = makePalette('bw', [BLACK, WHITE]);

function gridOf(w: number, h: number, indices: number[], alphas?: number[]): PixelGrid {
  const grid = createGrid(w, h);
  grid.indices.set(indices);
  grid.alpha.fill(255);
  if (alphas) grid.alpha.set(alphas);
  return grid;
}

function request(over: Partial<LocalRequantizeRequest> = {}): LocalRequantizeRequest {
  return { palette: BW, distance: 'weighted', dither: 'none', ditherStrength: 1, ...over };
}

describe('clampRegion', () => {
  it('与网格求交', () => {
    expect(clampRegion({ x: -2, y: -1, w: 6, h: 5 }, 4, 4)).toEqual({ x: 0, y: 0, w: 4, h: 4 });
    expect(clampRegion({ x: 2, y: 2, w: 10, h: 10 }, 4, 4)).toEqual({ x: 2, y: 2, w: 2, h: 2 });
  });

  it('完全在外时宽高为 0', () => {
    expect(clampRegion({ x: 9, y: 9, w: 2, h: 2 }, 4, 4)).toMatchObject({ w: 0, h: 0 });
  });
});

describe('planLocalRequantize', () => {
  it('选区内换成目标板的颜色，并把用到的颜色追加到板尾', () => {
    const grid = gridOf(4, 4, new Array(16).fill(0)); // 全红
    const result = planLocalRequantize(grid, SOURCE, {
      ...request(),
      region: { x: 1, y: 1, w: 2, h: 2 },
    });

    // 红在黑白板里最接近黑；黑不在当前板里 → 追加成第 4 个颜色（索引 3）
    expect(result.addedColors).toEqual([BLACK]);
    expect(result.usedColors).toBe(1);
    expect(result.writes).toHaveLength(4);
    for (const write of result.writes) {
      expect(write.cell).toEqual({ index: 3, alpha: 255 });
      expect([5, 6, 9, 10]).toContain(write.index);
    }
  });

  it('选区外一个格子都不动', () => {
    const grid = gridOf(4, 4, new Array(16).fill(0));
    const result = planLocalRequantize(grid, SOURCE, {
      ...request(),
      region: { x: 0, y: 0, w: 2, h: 1 },
    });
    expect(result.writes.map((w) => w.index).sort((a, b) => a - b)).toEqual([0, 1]);
  });

  it('透明格不写、也不改变 alpha', () => {
    const alphas = new Array(16).fill(255);
    alphas[0] = 0; // (0,0) 透明
    alphas[1] = 128; // (1,0) 半透明
    const grid = gridOf(4, 4, new Array(16).fill(0), alphas);

    const result = planLocalRequantize(grid, SOURCE, {
      ...request(),
      region: { x: 0, y: 0, w: 2, h: 1 },
    });

    expect(result.writes.map((w) => w.index)).toEqual([1]);
    expect(result.writes[0]?.cell?.alpha).toBe(128);
  });

  it('目标板里已有的颜色直接复用当前板的槽位，不追加', () => {
    // 当前板有蓝（1）与白（2）；目标板 [蓝, 白]
    const target = makePalette('bw', [BLUE, WHITE]);
    const grid = gridOf(2, 1, [0, 2]); // 红、白

    const result = planLocalRequantize(grid, SOURCE, {
      ...request({ palette: target }),
      region: { x: 0, y: 0, w: 2, h: 1 },
    });

    expect(result.addedColors).toEqual([]);
    // 红 → 蓝（索引 1）；白本来就是白 → 不写
    expect(result.writes.map((w) => [w.index, w.cell?.index])).toEqual([[0, 1]]);
  });

  it('颜色没变时一条写入都没有（目标板等于源板）', () => {
    const grid = gridOf(4, 4, new Array(16).fill(0));
    const result = planLocalRequantize(grid, SOURCE, {
      ...request({ palette: SOURCE }),
      region: { x: 0, y: 0, w: 4, h: 4 },
    });
    expect(result.writes).toEqual([]);
    expect(result.addedColors).toEqual([]);
  });

  it('抖动会在选区内产生多种颜色', () => {
    // 中灰在黑白板里落在中间，误差扩散能把它摊成黑/白两色
    const gray = makePalette('gray', [[128, 128, 128, 255]]);
    const grid = gridOf(8, 8, new Array(64).fill(0));

    const result = planLocalRequantize(grid, gray, {
      ...request({ dither: 'floyd' }),
      region: { x: 0, y: 0, w: 8, h: 8 },
    });

    const indices = new Set(result.writes.map((w) => w.cell?.index));
    expect(indices.size).toBe(2);
    expect(result.writes.length).toBeGreaterThan(2);
    // 黑白两色都要追加：当前板只有灰
    expect(result.addedColors).toHaveLength(2);
  });

  it('选区越界会被裁进网格', () => {
    const grid = gridOf(4, 4, new Array(16).fill(0));
    const result = planLocalRequantize(grid, SOURCE, {
      ...request(),
      region: { x: 3, y: 3, w: 10, h: 10 },
    });
    expect(result.writes.map((w) => w.index)).toEqual([15]);
  });

  it('空调色板不产生写入', () => {
    const grid = gridOf(2, 2, new Array(4).fill(0));
    const empty = makePalette('empty', []);
    const result = planLocalRequantize(grid, SOURCE, {
      ...request({ palette: empty }),
      region: { x: 0, y: 0, w: 2, h: 2 },
    });
    expect(result.writes).toEqual([]);
    expect(result.addedColors).toEqual([]);
  });

  it('追加后会超过 256 色时直接报错，而不是写出越界索引', () => {
    const colors = Array.from({ length: PALETTE_MAX_COLORS }, (_, i) => [i, 255 - i, i] as const);
    const full: Palette = {
      id: 'full',
      name: 'full',
      colors: colors.map((c) => [c[0], c[1], c[2], 255] as const),
    };
    const grid = gridOf(1, 1, [0]);
    const target = makePalette('new', [[250, 3, 7, 255]]);

    expect(() =>
      planLocalRequantize(grid, full, {
        ...request({ palette: target }),
        region: { x: 0, y: 0, w: 1, h: 1 },
      }),
    ).toThrow(/上限/);
  });
});
