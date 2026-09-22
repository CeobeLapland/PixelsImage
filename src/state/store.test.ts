import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makePalette, BLACK, BLUE, RED, WHITE } from '@/core/__testing__/fixtures';
import { changesToEdits, countEdits, readCell, writeCell, type Changes } from '@/core/edit';
import { createGrid, type PixelGrid } from '@/core/types';
import { useApp, type ConvertInfo } from './store';

const PALETTE = makePalette('test', [RED, WHITE, BLUE, BLACK]);

/** 造一份「转换结果」：索引按 (i+seed)%4，全部不透明 */
function makeGrid(w: number, h: number, seed = 0): PixelGrid {
  const grid = createGrid(w, h);
  for (let i = 0; i < grid.indices.length; i += 1) {
    grid.indices[i] = (i + seed) % 4;
    grid.alpha[i] = 255;
  }
  return grid;
}

function info(w: number, h: number): ConvertInfo {
  return { targetW: w, targetH: h, usedColors: 4, trimmed: false, ms: 1, fallback: false };
}

function apply(w: number, h: number, seed = 0): void {
  useApp.getState().applyResult(makeGrid(w, h, seed), PALETTE, info(w, h));
}

/** 模拟一次落笔：写若干格并结算成一条撤销记录 */
function paint(cells: { x: number; y: number; index: number }[], w: number): void {
  const layer = useApp.getState().editLayer;
  if (!layer) throw new Error('还没有编辑层');
  const changes: Changes = new Map();
  for (const c of cells) {
    writeCell(layer, c.y * w + c.x, { index: c.index, alpha: 255 }, changes);
  }
  useApp.getState().commitEdits('铅笔', changesToEdits(changes, layer));
}

beforeEach(() => {
  vi.useFakeTimers();
  useApp.getState().clearResult();
});

describe('转换结果与编辑层的关系', () => {
  it('首次拿到结果时创建与网格同尺寸的空编辑层', () => {
    apply(8, 6);
    const state = useApp.getState();
    expect(state.editLayer?.w).toBe(8);
    expect(state.editLayer?.h).toBe(6);
    expect(state.editLayer?.cells).toHaveLength(48);
    expect(state.editedCount).toBe(0);
  });

  it('调整转换参数不清空手工修改 —— M2 核心验收', () => {
    apply(8, 8);
    paint([{ x: 0, y: 0, index: 2 }], 8);
    const layerBefore = useApp.getState().editLayer;

    // 换一套抖动参数重新转换（尺寸不变）
    apply(8, 8, 3);

    const state = useApp.getState();
    expect(state.editLayer).toBe(layerBefore); // 连对象都没换
    expect(state.editedCount).toBe(1);
    expect(readCell(state.baseGrid, state.editLayer, 0, 0)).toEqual({ index: 2, alpha: 255 });
  });

  it('转换结果变更不进撤销栈（改参数改的是底层，不是可撤销的操作）', () => {
    apply(8, 8);
    paint([{ x: 0, y: 0, index: 2 }], 8);
    expect(useApp.getState().history.cursor).toBe(1);

    apply(8, 8, 2);
    apply(8, 8, 1);
    expect(useApp.getState().history.cursor).toBe(1);
  });

  it('网格尺寸变化时按比例重采样手工修改', () => {
    apply(8, 8);
    paint([{ x: 0, y: 0, index: 2 }], 8);

    apply(16, 16);
    const state = useApp.getState();
    expect(state.editLayer?.w).toBe(16);
    expect(state.editedCount).toBe(1);
  });

  it('尺寸来回变化不会累积失真（始终从原始尺寸的那一份重采样）', () => {
    apply(8, 8);
    // 相邻两格：在 4×4 下会合并成一格
    paint(
      [
        { x: 0, y: 0, index: 2 },
        { x: 1, y: 0, index: 2 },
      ],
      8,
    );

    apply(4, 4);
    expect(useApp.getState().editedCount).toBe(1); // 合并是必然的

    apply(8, 8);
    // 关键：回到 8×8 时两格都在。若在 4×4 的结果上再采样，这里就只剩一格了
    expect(useApp.getState().editedCount).toBe(2);
  });

  it('尺寸变化时发出提示，且不与选区状态打架', () => {
    apply(8, 8);
    paint([{ x: 0, y: 0, index: 2 }], 8);
    useApp.getState().setSelection({ x: 0, y: 0, w: 2, h: 2 });

    apply(6, 6);
    expect(useApp.getState().selection).toBeNull();
    expect(useApp.getState().toasts.some((t) => t.text.includes('重采样'))).toBe(true);
  });
});

describe('撤销 / 重做', () => {
  it('撤销回到改动前，重做再回来', () => {
    apply(4, 4);
    paint([{ x: 1, y: 1, index: 3 }], 4);
    expect(useApp.getState().editedCount).toBe(1);

    useApp.getState().undo();
    const afterUndo = useApp.getState();
    expect(afterUndo.editedCount).toBe(0);
    expect(readCell(afterUndo.baseGrid, afterUndo.editLayer, 1, 1)).toEqual(
      readCell(afterUndo.baseGrid, null, 1, 1), // 回到底层
    );

    useApp.getState().redo();
    expect(useApp.getState().editedCount).toBe(1);
  });

  it('连续撤销 100 步后栈底仍是空的', () => {
    apply(8, 8);
    for (let i = 0; i < 12; i += 1) paint([{ x: i, y: 0, index: 1 }], 8);
    expect(useApp.getState().history.cursor).toBe(12);

    for (let i = 0; i < 12; i += 1) useApp.getState().undo();

    const state = useApp.getState();
    expect(state.history.cursor).toBe(0);
    expect(state.editedCount).toBe(0);
  });

  it('没有可撤销的操作时给出提示而不报错', () => {
    apply(4, 4);
    useApp.getState().undo();
    expect(useApp.getState().toasts.some((t) => t.text.includes('没有可撤销'))).toBe(true);
  });

  it('擦除也能撤销回原来的颜色', () => {
    apply(4, 4);
    const layer = useApp.getState().editLayer;
    if (!layer) throw new Error('缺少编辑层');
    const changes: Changes = new Map();
    writeCell(layer, 0, { index: 0, alpha: 0 }, changes); // 橡皮
    useApp.getState().commitEdits('橡皮', changesToEdits(changes, layer));

    const base = useApp.getState().baseGrid;
    const original = readCell(base, null, 0, 0);
    expect(readCell(base, useApp.getState().editLayer, 0, 0)).toEqual({ index: 0, alpha: 0 });

    useApp.getState().undo();
    expect(readCell(base, useApp.getState().editLayer, 0, 0)).toEqual(original);
  });
});

describe('清空编辑层', () => {
  it('清空只动编辑层，且可以撤销', () => {
    apply(4, 4);
    paint(
      [
        { x: 0, y: 0, index: 2 },
        { x: 1, y: 1, index: 2 },
      ],
      4,
    );

    useApp.getState().clearEditLayer();
    expect(useApp.getState().editedCount).toBe(0);

    useApp.getState().undo();
    expect(useApp.getState().editedCount).toBe(2);
  });

  it('没有手改时清空只给提示，不入栈', () => {
    apply(4, 4);
    useApp.getState().clearEditLayer();
    expect(useApp.getState().history.entries).toHaveLength(0);
    expect(countEdits(useApp.getState().editLayer)).toBe(0);
  });
});

describe('清空结果', () => {
  it('清掉网格、编辑层、撤销栈与选区', () => {
    apply(4, 4);
    paint([{ x: 0, y: 0, index: 2 }], 4);
    useApp.getState().setSelection({ x: 0, y: 0, w: 1, h: 1 });

    useApp.getState().clearResult();

    const state = useApp.getState();
    expect(state.baseGrid).toBeNull();
    expect(state.editLayer).toBeNull();
    expect(state.editOrigin).toBeNull();
    expect(state.editedCount).toBe(0);
    expect(state.selection).toBeNull();
    expect(state.history.entries).toHaveLength(0);
  });
});