import { describe, expect, it } from 'vitest';

import { BLACK, BLUE, GREEN, RED, WHITE, makePalette } from '@/core/__testing__/fixtures';
import { createEditLayer, createGrid, type RGBA } from '@/core/types';
import { mergeSimilarColors, remapEditLayer, remapGridIndices, sortColors } from './ops';

const rgb = (r: number, g: number, b: number): RGBA => [r, g, b, 255] as unknown as RGBA;

function keysOf(colors: readonly RGBA[]): string[] {
  return colors.map((c) => `${c[0]},${c[1]},${c[2]}`);
}

describe('sortColors', () => {
  it('按明度排序：黑 → 灰 → 白', () => {
    const { colors, map } = sortColors([WHITE, BLACK, rgb(128, 128, 128)], 'luminance');
    expect(keysOf(colors)).toEqual(['0,0,0', '128,128,128', '255,255,255']);
    // WHITE 原本在 0 位，现在在 2 位
    expect(map[0]).toBe(2);
    expect(map[1]).toBe(0);
  });

  it('按色相排序：灰色排最前，其余按色相环', () => {
    const { colors } = sortColors([GREEN, RED, rgb(128, 128, 128)], 'hue');
    expect(keysOf(colors)).toEqual(['128,128,128', '255,0,0', '0,255,0']);
  });

  it('map 是双射：每个新位置恰好被一个旧索引占用', () => {
    const input = [RED, GREEN, BLUE, WHITE, BLACK];
    const { colors, map } = sortColors(input, 'luminance');
    expect(colors).toHaveLength(input.length);
    expect(new Set(map).size).toBe(input.length);
    // 映射后每个颜色都还在，只是位置变了
    expect(new Set(keysOf(colors))).toEqual(new Set(keysOf(input)));
  });

  it('空板与单色板不崩', () => {
    expect(sortColors([], 'hue').colors).toEqual([]);
    expect(sortColors([RED], 'luminance').map).toEqual([0]);
  });

  it('结果确定（同值颜色按下标定序）', () => {
    const input = [rgb(10, 10, 10), rgb(10, 10, 10), rgb(20, 20, 20)];
    expect(sortColors(input, 'luminance').map).toEqual(sortColors(input, 'luminance').map);
  });
});

describe('mergeSimilarColors', () => {
  it('容差为 0 只合并完全相同的颜色', () => {
    const { colors, map } = mergeSimilarColors([RED, RED, BLUE], 0);
    expect(colors).toHaveLength(2);
    expect(map).toEqual([0, 0, 1]);
  });

  it('容差足够大时把近似色归到先出现的槽位', () => {
    const near = rgb(250, 8, 8);
    const { colors, map } = mergeSimilarColors([RED, near], 40);
    expect(colors).toHaveLength(1);
    expect(keysOf(colors)).toEqual(['255,0,0']);
    expect(map).toEqual([0, 0]);
  });

  it('容差不够时不合并', () => {
    const { colors } = mergeSimilarColors([RED, BLUE], 8);
    expect(colors).toHaveLength(2);
  });

  it('保留原槽位顺序，不重排', () => {
    const { colors } = mergeSimilarColors([WHITE, RED, BLACK, rgb(252, 4, 4)], 30);
    expect(keysOf(colors)).toEqual(['255,255,255', '255,0,0', '0,0,0']);
  });

  it('空板与单色板不崩', () => {
    expect(mergeSimilarColors([], 10).colors).toEqual([]);
    expect(mergeSimilarColors([RED], 10).map).toEqual([0]);
  });
});

describe('remapGridIndices / remapEditLayer', () => {
  it('把底图索引按 map 改写', () => {
    const grid = createGrid(4, 1);
    grid.indices.set([0, 1, 2, 3]);
    // 反转映射：0↔3, 1↔2
    remapGridIndices(grid, [3, 2, 1, 0]);
    expect(Array.from(grid.indices)).toEqual([3, 2, 1, 0]);
  });

  it('越界索引（大于 map 长度）原样保留，不会写成 undefined', () => {
    const grid = createGrid(2, 1);
    grid.indices.set([9, 0]);
    remapGridIndices(grid, [1]);
    expect(Array.from(grid.indices)).toEqual([9, 1]);
  });

  it('编辑层的索引同样被改写，alpha 与覆盖关系不变', () => {
    const layer = createEditLayer(3, 1);
    layer.cells[0] = { index: 2, alpha: 128 };
    layer.cells[2] = { index: 0, alpha: 0 };

    remapEditLayer(layer, [1, 5, 7]);

    expect(layer.cells[0]).toEqual({ index: 7, alpha: 128 });
    expect(layer.cells[1]).toBeNull();
    expect(layer.cells[2]).toEqual({ index: 1, alpha: 0 });
  });

  it('排序 + 重映射后「视觉结果不变」——这是排序能安全生效的前提', () => {
    // 用调色板取色模拟渲染：排序前 index→color，排序后 map(index)→新palette[map(index)]
    const palette = makePalette('p', [RED, WHITE, BLUE, BLACK]);
    const grid = createGrid(4, 1);
    grid.indices.set([0, 1, 2, 3]);
    grid.alpha.fill(255);

    const before = Array.from(grid.indices).map((i) => keysOf([palette.colors[i] as RGBA])[0]);

    const { colors, map } = sortColors(palette.colors, 'luminance');
    remapGridIndices(grid, map);
    const after = Array.from(grid.indices).map((i) => keysOf([colors[i] as RGBA])[0]);

    expect(after).toEqual(before);
  });
});