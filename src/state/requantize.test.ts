/**
 * 局部换板的 store 层测试。
 *
 * core 的算法已有自己的测试；这里锁的是**接线**：
 * 新颜色要真的追加进当前板、写入要进撤销栈、选区外的索引一位都不能变。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makePalette, BLACK, BLUE, RED, WHITE } from '@/core/__testing__/fixtures';
import { readCell } from '@/core/edit';
import { createGrid, type PixelGrid } from '@/core/types';
import { useApp } from './store';

const PALETTE = makePalette('test', [RED, WHITE, BLUE]);
const BW = makePalette('bw', [BLACK, WHITE]);

function makeGrid(w: number, h: number, indices: number[]): PixelGrid {
  const grid = createGrid(w, h);
  grid.alpha.fill(255);
  grid.indices.set(indices);
  return grid;
}

function apply(grid: PixelGrid): void {
  useApp.getState().applyResult(grid, PALETTE, {
    targetW: grid.w,
    targetH: grid.h,
    usedColors: PALETTE.colors.length,
    trimmed: false,
    ms: 1,
    fallback: false,
  });
}

function effectiveIndices(): number[] {
  const s = useApp.getState();
  const out: number[] = [];
  for (let y = 0; y < (s.baseGrid?.h ?? 0); y += 1) {
    for (let x = 0; x < (s.baseGrid?.w ?? 0); x += 1) {
      out.push(readCell(s.baseGrid, s.editLayer, x, y).index);
    }
  }
  return out;
}

function run(palette = BW, region = { x: 0, y: 0, w: 2, h: 2 }): void {
  useApp.getState().setSelection(region);
  useApp.getState().requantizeSelection({
    palette,
    distance: 'weighted',
    dither: 'none',
    ditherStrength: 1,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  useApp.setState({
    customPalettes: {},
    palette: PALETTE,
    settings: { ...useApp.getState().settings, paletteId: 'test', quantize: 'palette' },
  });
  useApp.getState().clearResult();
});

describe('局部换板', () => {
  it('选区内换色、新色追加到板尾，且可撤销', () => {
    apply(makeGrid(2, 2, [0, 0, 0, 0])); // 全红
    run();

    // 红在黑白板里最接近黑；黑不在当前板里 → 追加成第 4 色（索引 3）
    expect(effectiveIndices()).toEqual([3, 3, 3, 3]);
    const palette = useApp.getState().palette;
    expect(palette.colors).toHaveLength(4);
    expect(palette.colors[3]).toEqual(BLACK);
    expect(useApp.getState().history.entries).toHaveLength(1);
    expect(useApp.getState().toasts.at(-1)?.text).toContain('局部换板');

    useApp.getState().undo();
    expect(effectiveIndices()).toEqual([0, 0, 0, 0]);
    // 追加的色不会因为撤销而退回：撤销的是格子，不是调色板（文档里写明了）
    expect(useApp.getState().palette.colors).toHaveLength(4);
  });

  it('选区外一格都不动', () => {
    apply(makeGrid(2, 2, [0, 0, 0, 0]));
    run(BW, { x: 0, y: 0, w: 1, h: 1 });
    expect(effectiveIndices()).toEqual([3, 0, 0, 0]);
  });

  it('目标色已在当前板里时直接复用槽位，不追加', () => {
    // 当前板 [红, 白, 蓝]，目标 [黑, 白]：红→黑不在板里……
    // 用目标 [蓝, 白] → 红变蓝（索引 2），白已在板里（索引 1）
    apply(makeGrid(2, 1, [0, 2]));
    useApp.getState().setSelection({ x: 0, y: 0, w: 2, h: 1 });
    useApp.getState().requantizeSelection({
      palette: makePalette('blue-white', [BLUE, WHITE]),
      distance: 'weighted',
      dither: 'none',
      ditherStrength: 1,
    });

    expect(effectiveIndices()).toEqual([2, 2]);
    expect(useApp.getState().palette.colors).toHaveLength(3);
  });

  it('没有选区时只提示，不写任何东西', () => {
    apply(makeGrid(2, 2, [0, 0, 0, 0]));
    useApp.getState().setSelection(null);
    useApp.getState().requantizeSelection({
      palette: BW,
      distance: 'weighted',
      dither: 'none',
      ditherStrength: 1,
    });

    expect(effectiveIndices()).toEqual([0, 0, 0, 0]);
    expect(useApp.getState().history.entries).toHaveLength(0);
    expect(useApp.getState().toasts.at(-1)?.text).toContain('选区');
  });

  it('结果没变时不进撤销栈', () => {
    apply(makeGrid(2, 2, [0, 0, 0, 0]));
    run(PALETTE);
    expect(useApp.getState().history.entries).toHaveLength(0);
    expect(useApp.getState().tool).toBeDefined();
  });
});
