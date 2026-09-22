import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makePalette, BLACK, BLUE, RED, WHITE } from '@/core/__testing__/fixtures';
import { readCell } from '@/core/edit';
import { createGrid, type PixelGrid } from '@/core/types';
import { beginStroke, cancelStroke, endStroke, isStroking, moveStroke, strokePreview } from './paint';
import { useApp } from './store';

const PALETTE = makePalette('test', [RED, WHITE, BLUE, BLACK]);

function makeGrid(w: number, h: number): PixelGrid {
  const grid = createGrid(w, h);
  grid.alpha.fill(255);
  return grid; // 全部索引 0，无边界的单色块
}

function apply(w: number, h: number): void {
  useApp.getState().applyResult(makeGrid(w, h), PALETTE, {
    targetW: w,
    targetH: h,
    usedColors: 1,
    trimmed: false,
    ms: 1,
    fallback: false,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  if (isStroking()) cancelStroke();
  useApp.getState().clearResult();
  // store 在同文件内是共享的，逐项复位以免上一条用例的工具串味
  useApp.getState().setTool('pencil');
  useApp.getState().setBrushSize(1);
  useApp.getState().setSymmetry('none');
});

describe('笔画生命周期', () => {
  it('没有转换结果时无法落笔，并返回 false', () => {
    expect(beginStroke({ x: 0, y: 0 }, false)).toBe(false);
    expect(isStroking()).toBe(false);
  });

  it('一次拖拽只产生一条撤销记录', () => {
    apply(8, 8);
    useApp.getState().setForeground(2);

    beginStroke({ x: 0, y: 0 }, false);
    expect(isStroking()).toBe(true);
    moveStroke({ x: 1, y: 0 });
    moveStroke({ x: 2, y: 0 });
    moveStroke({ x: 3, y: 0 });
    endStroke();

    const state = useApp.getState();
    expect(state.history.entries).toHaveLength(1);
    expect(state.editedCount).toBe(4);
    expect(isStroking()).toBe(false);
  });

  it('拖拽过程中编辑层就已经更新（所见即所得）', () => {
    apply(8, 8);
    useApp.getState().setForeground(2);
    beginStroke({ x: 2, y: 2 }, false);
    moveStroke({ x: 3, y: 2 });

    const mid = useApp.getState();
    expect(readCell(mid.baseGrid, mid.editLayer, 3, 2)).toEqual({ index: 2, alpha: 255 });
    endStroke();
  });

  it('取消笔画把已写入的改动全部回滚', () => {
    apply(8, 8);
    useApp.getState().setForeground(2);
    beginStroke({ x: 0, y: 0 }, false);
    moveStroke({ x: 1, y: 0 });
    cancelStroke();

    const state = useApp.getState();
    expect(state.editedCount).toBe(0);
    expect(state.history.entries).toHaveLength(0);
    expect(readCell(state.baseGrid, state.editLayer, 0, 0)).toEqual({ index: 0, alpha: 255 });
  });

  it('用与底层相同的颜色落笔：视觉不变，但仍是一次可撤销的覆盖', () => {
    apply(4, 4);
    useApp.getState().setForeground(0); // 底层本来就是索引 0
    beginStroke({ x: 1, y: 1 }, false);
    endStroke();

    const state = useApp.getState();
    // 显式记下这一格，而不是「什么都不做」——consistent 的写入语义更好推理
    expect(readCell(state.baseGrid, state.editLayer, 1, 1)).toEqual({ index: 0, alpha: 255 });
    expect(state.editedCount).toBe(1);
    expect(state.history.entries).toHaveLength(1);

    useApp.getState().undo();
    expect(useApp.getState().editedCount).toBe(0);
  });

  it('画一笔再擦掉：两步都在栈里，可以逐步退回去', () => {
    apply(4, 4);
    useApp.getState().setForeground(2);
    useApp.getState().setTool('pencil');
    beginStroke({ x: 0, y: 0 }, false);
    endStroke();

    useApp.getState().setTool('eraser');
    beginStroke({ x: 0, y: 0 }, false);
    endStroke();

    // 两笔各自有记录（先画、再擦），但擦除那一笔之后格子的值与第一笔之前不同 → 都在栈里
    expect(useApp.getState().history.entries).toHaveLength(2);
    // 撤销一次回到画上去的状态，再撤销一次回到没改过的状态
    useApp.getState().undo();
    expect(readCell(useApp.getState().baseGrid, useApp.getState().editLayer, 0, 0)).toEqual({
      index: 2,
      alpha: 255,
    });
    useApp.getState().undo();
    expect(useApp.getState().editedCount).toBe(0);
  });

  it('越界的落笔被钳到网格内，不会写到数组外', () => {
    apply(4, 4);
    useApp.getState().setForeground(2);
    beginStroke({ x: -10, y: 99 }, false);
    endStroke();

    const layer = useApp.getState().editLayer;
    expect(layer?.cells).toHaveLength(16); // 没有越界扩容
    expect(layer?.cells[3 * 4 + 0]).toEqual({ index: 2, alpha: 255 });
  });
});

describe('形状工具：预览与落笔一致', () => {
  it('拖拽过程中不写数据，松手才落笔', () => {
    apply(8, 8);
    useApp.getState().setTool('line');
    useApp.getState().setForeground(3);

    beginStroke({ x: 0, y: 0 }, false);
    moveStroke({ x: 4, y: 0 });

    expect(useApp.getState().editedCount).toBe(0);
    const preview = strokePreview();
    expect(preview?.points).toHaveLength(5);

    endStroke();
    expect(useApp.getState().editedCount).toBe(5);
    expect(useApp.getState().history.entries[0]?.label).toBe('直线');
  });

  it('原地点击矩形只写入一格', () => {
    apply(8, 8);
    useApp.getState().setForeground(3);
    useApp.getState().setTool('rect');
    beginStroke({ x: 2, y: 2 }, false);
    endStroke();

    const state = useApp.getState();
    expect(state.editedCount).toBe(1);
    expect(readCell(state.baseGrid, state.editLayer, 2, 2)).toEqual({ index: 3, alpha: 255 });
  });
});

describe('吸管', () => {
  it('点击取色写入前景色，不写编辑层', () => {
    apply(4, 4);
    // 让 (2,0) 处显示索引 3
    useApp.getState().setForeground(3);
    useApp.getState().setTool('pencil');
    beginStroke({ x: 2, y: 0 }, false);
    endStroke();

    useApp.getState().setForeground(0);
    useApp.getState().setTool('eyedropper');
    beginStroke({ x: 2, y: 0 }, false);
    endStroke();

    const state = useApp.getState();
    expect(state.foreground).toBe(3);
    expect(state.history.entries).toHaveLength(1); // 只有那次铅笔
  });

  it('按住 Alt 临时取色，不改变当前工具', () => {
    apply(4, 4);
    useApp.getState().setForeground(2);
    useApp.getState().setTool('pencil');
    beginStroke({ x: 1, y: 1 }, false);
    endStroke();

    useApp.getState().setForeground(0);
    beginStroke({ x: 1, y: 1 }, true); // Alt
    endStroke();

    const state = useApp.getState();
    expect(state.foreground).toBe(2);
    expect(state.tool).toBe('pencil');
    expect(state.history.entries).toHaveLength(1);
  });
});

describe('选区', () => {
  it('在空白处拖拽会建立选区，不入撤销栈', () => {
    apply(8, 8);
    useApp.getState().setTool('select');

    beginStroke({ x: 1, y: 1 }, false);
    moveStroke({ x: 3, y: 4 });
    endStroke();

    const state = useApp.getState();
    expect(state.selection).toEqual({ x: 1, y: 1, w: 3, h: 4 });
    expect(state.history.entries).toHaveLength(0);
    expect(state.editedCount).toBe(0);
  });

  it('在选区内拖拽则搬运内容', () => {
    apply(8, 8);
    useApp.getState().setTool('pencil');
    useApp.getState().setForeground(2);
    beginStroke({ x: 0, y: 0 }, false);
    endStroke();

    useApp.getState().setTool('select');
    useApp.getState().setSelection({ x: 0, y: 0, w: 2, h: 2 });
    beginStroke({ x: 0, y: 0 }, false);
    moveStroke({ x: 3, y: 0 });

    const preview = strokePreview();
    expect(preview?.rect).toEqual({ x: 3, y: 0, w: 2, h: 2 });

    endStroke();
    const state = useApp.getState();
    expect(state.editedCount).toBeGreaterThan(0);
    expect(state.history.entries[state.history.entries.length - 1]?.label).toBe('选区搬运');
    // 选区跟着内容一起移动
    expect(state.selection).toEqual({ x: 3, y: 0, w: 2, h: 2 });
  });
});