import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makePalette, BLACK, BLUE, RED, WHITE } from '@/core/__testing__/fixtures';
import { readCell } from '@/core/edit';
import { createGrid, type PixelGrid, type RGBA } from '@/core/types';
import { MC_DYE_PALETTE, resolvePalette } from '@/palettes/builtin';
import { toHex } from '@/core/color/space';
import { useApp } from './store';

const PALETTE = makePalette('test', [RED, WHITE, BLUE, BLACK]);

function makeGrid(w: number, h: number, indices?: number[]): PixelGrid {
  const grid = createGrid(w, h);
  grid.alpha.fill(255);
  if (indices) grid.indices.set(indices);
  return grid;
}

function apply(grid: PixelGrid, palette = PALETTE): void {
  useApp.getState().applyResult(grid, palette, {
    targetW: grid.w,
    targetH: grid.h,
    usedColors: 4,
    trimmed: false,
    ms: 1,
    fallback: false,
  });
}

/** 每格当前生效的索引 */
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

beforeEach(() => {
  vi.useFakeTimers();
  useApp.setState({
    customPalettes: {},
    palette: resolvePalette(MC_DYE_PALETTE.id),
    settings: { ...useApp.getState().settings, paletteId: MC_DYE_PALETTE.id, quantize: 'palette' },
  });
  useApp.getState().clearResult();
});

describe('全局换色 replaceColor', () => {
  it('把全图中该索引的格子换成目标索引，并写进编辑层', () => {
    apply(makeGrid(4, 1, [0, 1, 0, 2]));
    useApp.getState().replaceColor(0, 3);

    expect(effectiveIndices()).toEqual([3, 1, 3, 2]);
    // 底图本身不动：它由参数重算得出，改它会在下次转换时白改
    expect(Array.from(useApp.getState().baseGrid?.indices ?? [])).toEqual([0, 1, 0, 2]);
    expect(useApp.getState().history.entries).toHaveLength(1);
  });

  it('手改过的格子也会被一起换掉', () => {
    apply(makeGrid(4, 1, [0, 1, 2, 3]));
    // 手改第 0 格为 1
    const layer = useApp.getState().editLayer;
    if (!layer) throw new Error('缺少编辑层');
    layer.cells[0] = { index: 1, alpha: 255 };
    useApp.getState().commitEdits('铅笔', [{ index: 0, before: null, after: { index: 1, alpha: 255 } }]);

    useApp.getState().replaceColor(1, 2);

    expect(effectiveIndices()).toEqual([2, 2, 2, 3]);
  });

  it('可以一键撤销', () => {
    apply(makeGrid(3, 1, [0, 0, 0]));
    const before = effectiveIndices();
    useApp.getState().replaceColor(0, 2);
    expect(effectiveIndices()).toEqual([2, 2, 2]);

    useApp.getState().undo();
    expect(effectiveIndices()).toEqual(before);
    expect(useApp.getState().editedCount).toBe(0);
  });

  it('图里没有该颜色时只提示，不入栈', () => {
    apply(makeGrid(2, 1, [0, 1]));
    useApp.getState().replaceColor(3, 2);
    expect(useApp.getState().history.entries).toHaveLength(0);
    expect(useApp.getState().toasts.some((t) => t.text.includes('#3'))).toBe(true);
  });

  it('没有像素图时给出提示而不报错', () => {
    useApp.getState().replaceColor(0, 1);
    expect(useApp.getState().toasts.some((t) => t.text.includes('还没有像素图'))).toBe(true);
  });
});

describe('改色 editPaletteColor', () => {
  it('改内置板会分叉出自定义板，且不污染内置数据', () => {
    const original = toHex(
      MC_DYE_PALETTE.colors[0]?.[0] ?? 0,
      MC_DYE_PALETTE.colors[0]?.[1] ?? 0,
      MC_DYE_PALETTE.colors[0]?.[2] ?? 0,
    );

    useApp.getState().editPaletteColor(0, [1, 2, 3, 255] as unknown as RGBA);

    const after = useApp.getState();
    expect(after.palette.builtin).toBe(false);
    expect(after.palette.colors[0]).toEqual([1, 2, 3, 255]);
    expect(after.settings.paletteId).toBe(after.palette.id);
    expect(Object.keys(after.customPalettes)).toHaveLength(1);

    // 内置板必须原样不动 —— 它是共享常量，改了会让所有用它的地方一起变色
    expect(
      toHex(
        MC_DYE_PALETTE.colors[0]?.[0] ?? 0,
        MC_DYE_PALETTE.colors[0]?.[1] ?? 0,
        MC_DYE_PALETTE.colors[0]?.[2] ?? 0,
      ),
    ).toBe(original);
  });

  it('在自定义板上连续改色不会反复分叉', () => {
    useApp.getState().editPaletteColor(0, [1, 2, 3, 255] as unknown as RGBA);
    const id = useApp.getState().palette.id;

    useApp.getState().editPaletteColor(1, [4, 5, 6, 255] as unknown as RGBA);

    const after = useApp.getState();
    expect(after.palette.id).toBe(id);
    expect(Object.keys(after.customPalettes)).toHaveLength(1);
    expect(after.palette.colors[1]).toEqual([4, 5, 6, 255]);
  });

  it('越界索引被忽略', () => {
    const before = useApp.getState().palette;
    useApp.getState().editPaletteColor(999, [1, 2, 3, 255] as unknown as RGBA);
    expect(useApp.getState().palette).toBe(before);
  });
});

describe('排序与合并', () => {
  it('排序后底图与编辑层的索引一起被重映射，画面不变', () => {
    apply(makeGrid(4, 1, [0, 1, 2, 3]));
    const layer = useApp.getState().editLayer;
    if (!layer) throw new Error('缺少编辑层');
    layer.cells[1] = { index: 3, alpha: 255 };

    // 渲染出的颜色（索引 → 调色板色）
    const colorBefore = effectiveIndices().map((i) => useApp.getState().palette.colors[i]);

    useApp.getState().sortPalette('luminance');

    const after = useApp.getState();
    const colorAfter = effectiveIndices().map((i) => after.palette.colors[i]);
    expect(colorAfter).toEqual(colorBefore);
    // 索引本身变了（说明确实重排了）
    expect(effectiveIndices()).not.toEqual([0, 3, 2, 3]);
  });

  it('排序内置板会分叉出自定义板', () => {
    useApp.getState().sortPalette('hue');
    expect(useApp.getState().palette.builtin).toBe(false);
    expect(useApp.getState().palette.colors).toHaveLength(MC_DYE_PALETTE.colors.length);
  });

  it('合并近似色：容差为 0 时无可合并，只提示', () => {
    apply(makeGrid(2, 1, [0, 1]));
    const before = useApp.getState().palette.colors;
    useApp.getState().mergePaletteColors(0);
    // 板里没有完全重复的色，所以什么都不该发生（也不会分叉出新板）
    expect(useApp.getState().palette.colors).toEqual(before);
    expect(useApp.getState().toasts.some((t) => t.text.includes('没有距离在容差内'))).toBe(true);
  });

  it('容差足够大时合并成功并重映射索引', () => {
    // 造一块有两个近似红的板（红 + 微调红）
    const near = makePalette('near', [RED, [250, 6, 6, 255] as const, BLUE]);
    apply(makeGrid(3, 1, [0, 1, 2]), near);

    useApp.getState().mergePaletteColors(40);

    const after = useApp.getState();
    expect(after.palette.colors).toHaveLength(2);
    expect(effectiveIndices()).toEqual([0, 0, 1]);
  });
});

describe('重命名与重名处理', () => {
  it('新增同名调色板会自动加序号', () => {
    useApp.getState().addCustomPalette(makePalette('x', [RED, BLUE]));
    const first = useApp.getState().palette.name;
    useApp.getState().addCustomPalette(makePalette('x', [RED, BLUE]));
    const second = useApp.getState().palette.name;

    expect(first).toBe('x');
    expect(second).toBe('x (2)');
  });

  it('重命名生效', () => {
    useApp.getState().addCustomPalette(makePalette('x', [RED, BLUE]));
    const id = useApp.getState().palette.id;

    useApp.getState().renamePalette(id, '  夕阳配色  ');

    expect(useApp.getState().palette.name).toBe('夕阳配色');
    expect(useApp.getState().customPalettes[id]?.name).toBe('夕阳配色');
    expect(useApp.getState().toasts.some((t) => t.text.includes('重命名'))).toBe(false);
  });

  it('改成已存在的名字会被自动改号并提示', () => {
    useApp.getState().addCustomPalette(makePalette('a', [RED, BLUE]));
    const firstId = useApp.getState().palette.id;
    useApp.getState().addCustomPalette(makePalette('b', [WHITE, BLACK]));
    const secondId = useApp.getState().palette.id;

    useApp.getState().renamePalette(secondId, 'a');

    expect(useApp.getState().customPalettes[secondId]?.name).toBe('a (2)');
    expect(useApp.getState().customPalettes[firstId]?.name).toBe('a');
    expect(useApp.getState().toasts.some((t) => t.text.includes('已有同名调色板'))).toBe(true);
  });

  it('不能改成内置板已有的名字（防止认不出来哪块是内置板）', () => {
    useApp.getState().addCustomPalette(makePalette('x', [RED, BLUE]));
    const id = useApp.getState().palette.id;

    useApp.getState().renamePalette(id, MC_DYE_PALETTE.name);

    expect(useApp.getState().customPalettes[id]?.name).toBe(`${MC_DYE_PALETTE.name} (2)`);
  });

  it('改回自己的原名不会被当成重名', () => {
    useApp.getState().addCustomPalette(makePalette('甲', [RED, BLUE]));
    const id = useApp.getState().palette.id;
    useApp.getState().renamePalette(id, '甲乙');

    useApp.getState().renamePalette(id, '甲');
    expect(useApp.getState().customPalettes[id]?.name).toBe('甲');
  });

  it('空名字被忽略，不会把板名清空', () => {
    useApp.getState().addCustomPalette(makePalette('x', [RED, BLUE]));
    const id = useApp.getState().palette.id;
    useApp.getState().renamePalette(id, '   ');
    expect(useApp.getState().customPalettes[id]?.name).toBe('x');
  });

  it('内置板不能重命名（没有对应的自定义板时静默忽略）', () => {
    useApp.getState().renamePalette(MC_DYE_PALETTE.id, '乱改');
    expect(useApp.getState().palette.name).toBe(MC_DYE_PALETTE.name);
  });

  it('反复分叉内置板不会滚出「（已编辑）（已编辑）」', () => {
    useApp.getState().editPaletteColor(0, [1, 2, 3, 255] as unknown as RGBA);
    expect(useApp.getState().palette.name).toBe(`${MC_DYE_PALETTE.name}（已编辑）`);

    // 切回原版内置板再改一次
    useApp.setState({ palette: MC_DYE_PALETTE });
    useApp.getState().editPaletteColor(1, [4, 5, 6, 255] as unknown as RGBA);
    expect(useApp.getState().palette.name).toBe(`${MC_DYE_PALETTE.name}（已编辑） (2)`);
  });

  it('重命名未在使用的板不影响当前板', () => {
    useApp.getState().addCustomPalette(makePalette('a', [RED, BLUE]));
    const firstId = useApp.getState().palette.id;
    useApp.getState().addCustomPalette(makePalette('b', [WHITE, BLACK]));
    const activeName = useApp.getState().palette.name;

    useApp.getState().renamePalette(firstId, '改的是另一块');

    expect(useApp.getState().palette.name).toBe(activeName);
    expect(useApp.getState().customPalettes[firstId]?.name).toBe('改的是另一块');
  });
});

describe('自定义板的注册与删除', () => {
  it('新增会切到新板并登记', () => {
    const custom = makePalette('x', [RED, BLUE]);
    useApp.getState().addCustomPalette({ ...custom, source: 'extracted' });

    const after = useApp.getState();
    expect(after.settings.paletteId).toBe(after.palette.id);
    expect(after.customPalettes[after.palette.id]?.colors).toHaveLength(2);
    expect(after.palette.builtin).toBeFalsy();
  });

  it('两次新增同一块板会得到两个不同 id（不会互相覆盖）', () => {
    const custom = makePalette('kmeans-8', [RED, BLUE]);
    useApp.getState().addCustomPalette(custom);
    const first = useApp.getState().palette.id;
    useApp.getState().addCustomPalette(custom);
    const second = useApp.getState().palette.id;

    expect(first).not.toBe(second);
    expect(Object.keys(useApp.getState().customPalettes)).toHaveLength(2);
  });

  it('删除正在使用的板会切回默认板', () => {
    const custom = makePalette('x', [RED, BLUE]);
    useApp.getState().addCustomPalette(custom);
    const id = useApp.getState().palette.id;

    useApp.getState().removeCustomPalette(id);

    const after = useApp.getState();
    expect(after.customPalettes[id]).toBeUndefined();
    expect(after.settings.paletteId).toBe(MC_DYE_PALETTE.id);
    expect(after.palette.colors.length).toBeGreaterThan(0);
  });

  it('删除未在使用的板不影响当前选择', () => {
    useApp.getState().addCustomPalette(makePalette('a', [RED, BLUE]));
    const active = useApp.getState().palette.id;
    useApp.getState().addCustomPalette(makePalette('b', [WHITE, BLACK]));
    const other = useApp.getState().palette.id;

    // 当前用的是 b，删掉 a
    useApp.getState().removeCustomPalette(other === active ? active : active);
    expect(useApp.getState().settings.paletteId).not.toBe(MC_DYE_PALETTE.id);
  });
});