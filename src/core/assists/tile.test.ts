import { describe, expect, it } from 'vitest';

import { createEditLayer, createGrid, type PixelGrid } from '@/core/types';
import { checkSeams } from './tile';

/** 用一组「索引」构造网格，alpha 全为 255 */
function gridOf(w: number, h: number, indices: number[]): PixelGrid {
  const grid = createGrid(w, h);
  grid.indices.set(indices);
  grid.alpha.fill(255);
  return grid;
}

describe('checkSeams', () => {
  it('全同色图没有任何接缝', () => {
    const report = checkSeams(gridOf(4, 3, new Array(12).fill(1)), null);
    expect(report.mismatches).toBe(0);
    expect(report.horizontal).toHaveLength(0);
    expect(report.vertical).toHaveLength(0);
    expect(report.total).toBe(3 + 4); // 左右 3 对 + 上下 4 对
  });

  it('左右两列不同时记为一处接缝，并给出成对的格', () => {
    // 4×1：0 1 1 2 → 左边 0 与右边 2 对不上
    const report = checkSeams(gridOf(4, 1, [0, 1, 1, 2]), null);
    expect(report.mismatches).toBe(1);
    expect(report.horizontal).toEqual([0, 3]); // 第 0 格与第 3 格
    expect(report.vertical).toHaveLength(0);
  });

  it('上下两行不同时记为竖向接缝', () => {
    // 2×3：第一行 0 0，最后一行 1 1 → 两列各一处缝
    const report = checkSeams(gridOf(2, 3, [0, 0, 0, 0, 1, 1]), null);
    expect(report.mismatches).toBe(2);
    // 每处缝记两个下标（上边一个、下边一个），所以两处缝 = 4 个下标
    expect(report.vertical).toHaveLength(4);
    expect(report.horizontal).toHaveLength(0);
  });

  it('颜色相同但 alpha 不同也算缝（半透明边缘对不齐看得出来）', () => {
    const grid = gridOf(2, 2, [1, 1, 1, 1]);
    grid.alpha.set([255, 255, 255, 128]); // 右侧两格的 alpha 不同
    const report = checkSeams(grid, null);
    expect(report.mismatches).toBeGreaterThan(0);
  });

  it('单行图没有左右接缝可言（左边就是右边）', () => {
    const report = checkSeams(gridOf(1, 4, [0, 1, 1, 0]), null);
    expect(report.horizontal).toHaveLength(0);
    // 上下仍然要查：第 0 行与第 3 行是同色 0 → 匹配
    expect(report.mismatches).toBe(0);
  });

  it('手工修改参与判定：把边界手改成一致后接缝消失', () => {
    const grid = gridOf(4, 1, [0, 1, 1, 2]);
    expect(checkSeams(grid, null).mismatches).toBe(1);

    const layer = createEditLayer(4, 1);
    layer.cells[3] = { index: 0, alpha: 255 }; // 把右下角改成与左上一致
    expect(checkSeams(grid, layer).mismatches).toBe(0);
  });

  it('手改出半透明边缘会被认出来', () => {
    const grid = gridOf(2, 1, [0, 0]);
    const layer = createEditLayer(2, 1);
    layer.cells[1] = { index: 0, alpha: 64 };
    expect(checkSeams(grid, layer).mismatches).toBe(1);
  });

  it('每处接缝都给出两端的位置，便于在画布上标注', () => {
    const report = checkSeams(gridOf(3, 2, [0, 1, 0, 1, 1, 1]), null);
    // 左右：第 0 行 0≠0? （0 与 0 相同）第 1 行 1 与 1 相同 → 无左右缝
    // 上下：列 0 是 0≠1 → 缝；列 1 是 1≠1 相同；列 2 是 0≠1 → 缝
    expect(report.vertical).toHaveLength(4);
    expect(report.horizontal).toHaveLength(0);
    expect(report.mismatches).toBe(2);
    // 每处缝都成对：上边与下边各一个下标
    expect(report.vertical).toEqual([0, 3, 2, 5]);
  });
});