import { describe, expect, it } from 'vitest';

import { makePalette, BLUE, CLEAR, RED, WHITE } from '@/core/__testing__/fixtures';
import { createGrid, type PixelGrid } from '@/core/types';
import {
  buildSheetManifest,
  planSpritesheet,
  renderSpritesheet,
  type SheetTile,
  type SpritesheetOptions,
} from './spritesheet';

const PALETTE = makePalette('test', [RED, WHITE, BLUE, CLEAR]);

const OPTIONS: SpritesheetOptions = {
  columns: 0,
  padding: 0,
  trim: false,
  background: 'transparent',
};

function solid(w: number, h: number, index: number): PixelGrid {
  const grid = createGrid(w, h);
  grid.indices.fill(index);
  grid.alpha.fill(255);
  return grid;
}

function tile(grid: PixelGrid, name: string): SheetTile {
  return { grid, palette: PALETTE, name };
}

/** 读图集上某点的 RGBA */
function pixelAt(data: ImageData, x: number, y: number): number[] {
  const o = (y * data.width + x) * 4;
  return [data.data[o], data.data[o + 1], data.data[o + 2], data.data[o + 3]];
}

describe('planSpritesheet', () => {
  it('自动列数接近正方形', () => {
    const tiles = Array.from({ length: 9 }, (_, i) => tile(solid(4, 4, 0), `t${i}`));
    const layout = planSpritesheet(tiles, OPTIONS);
    expect(layout.columns).toBe(3);
    expect(layout.rows).toBe(3);
  });

  it('3 张图自动排成 2 列 2 行（不能是一条横线）', () => {
    const tiles = Array.from({ length: 3 }, (_, i) => tile(solid(4, 4, 0), `t${i}`));
    const layout = planSpritesheet(tiles, OPTIONS);
    expect(layout.columns).toBe(2);
    expect(layout.rows).toBe(2);
  });

  it('指定列数时按指定值排，且不超过图数', () => {
    const tiles = Array.from({ length: 4 }, (_, i) => tile(solid(4, 4, 0), `t${i}`));
    expect(planSpritesheet(tiles, { ...OPTIONS, columns: 4 }).columns).toBe(4);
    // 只有 2 张图却要求 8 列，不该排出 8 列的空位
    expect(planSpritesheet(tiles.slice(0, 2), { ...OPTIONS, columns: 8 }).columns).toBe(2);
  });

  it('槽位取所有图中最大的尺寸，保证每格等大', () => {
    const layout = planSpritesheet(
      [tile(solid(4, 4, 0), 'a'), tile(solid(8, 2, 0), 'b')],
      { ...OPTIONS, columns: 2 },
    );
    expect(layout.cellW).toBe(8);
    expect(layout.cellH).toBe(4);
    expect(layout.w).toBe(16);
    expect(layout.h).toBe(4);
  });

  it('留白计入画布尺寸，且四周各留一份', () => {
    const layout = planSpritesheet(
      [tile(solid(4, 4, 0), 'a'), tile(solid(4, 4, 0), 'b')],
      { ...OPTIONS, columns: 2, padding: 2 },
    );
    // 2 + 4 + 2 + 4 + 2 = 14
    expect(layout.w).toBe(14);
    expect(layout.h).toBe(8);
    expect(layout.placements[0]).toMatchObject({ x: 2, y: 2 });
    expect(layout.placements[1]).toMatchObject({ x: 8, y: 2 });
  });

  it('裁剪开启时按裁剪后的尺寸算槽位', () => {
    // 4×4 里只有中间 2×2 不透明
    const grid = createGrid(4, 4);
    grid.indices.fill(0);
    grid.alpha.fill(0);
    grid.alpha[1 * 4 + 1] = 255;
    grid.alpha[1 * 4 + 2] = 255;
    grid.alpha[2 * 4 + 1] = 255;
    grid.alpha[2 * 4 + 2] = 255;

    const layout = planSpritesheet([tile(grid, 'a')], { ...OPTIONS, trim: true });
    expect(layout.cellW).toBe(2);
    expect(layout.cellH).toBe(2);
    expect(layout.w).toBe(2);
  });

  it('空列表返回合法尺寸，不产出 0 宽高', () => {
    const layout = planSpritesheet([], OPTIONS);
    expect(layout.w).toBeGreaterThan(0);
    expect(layout.h).toBeGreaterThan(0);
    expect(layout.placements).toEqual([]);
  });

  it('placement 顺序与入参一致，名字跟着走', () => {
    const layout = planSpritesheet(
      [tile(solid(2, 2, 0), 'hero'), tile(solid(2, 2, 0), 'foe')],
      OPTIONS,
    );
    expect(layout.placements.map((p) => p.name)).toEqual(['hero', 'foe']);
  });
});

describe('renderSpritesheet', () => {
  it('每格的颜色落在自己的槽位里', () => {
    const layout = planSpritesheet(
      [tile(solid(2, 2, 0), 'a'), tile(solid(2, 2, 1), 'b')],
      { ...OPTIONS, columns: 2 },
    );
    const data = renderSpritesheet(
      layout,
      [tile(solid(2, 2, 0), 'a'), tile(solid(2, 2, 1), 'b')],
      { ...OPTIONS, columns: 2 },
    );

    expect(pixelAt(data, 0, 0)).toEqual([255, 0, 0, 255]); // RED
    expect(pixelAt(data, 2, 0)).toEqual([255, 255, 255, 255]); // WHITE
    expect(pixelAt(data, 3, 1)).toEqual([255, 255, 255, 255]);
  });

  it('图比槽位小时在槽内居中', () => {
    // 槽位由 4×4 决定，2×2 的图应居中于 (1,1)
    const big = solid(4, 4, 1); // WHITE
    const small = solid(2, 2, 0); // RED
    const tiles = [tile(big, 'big'), tile(small, 'small')];
    const layout = planSpritesheet(tiles, { ...OPTIONS, columns: 2 });
    const data = renderSpritesheet(layout, tiles, { ...OPTIONS, columns: 2 });

    const slotX = layout.placements[1].x;
    expect(pixelAt(data, slotX, 0)).toEqual([0, 0, 0, 0]); // 槽位左上角是空的
    expect(pixelAt(data, slotX + 1, 1)).toEqual([255, 0, 0, 255]); // 居中后的图
  });

  it('透明底时保留 alpha，不把透明区涂成黑色', () => {
    const grid = createGrid(2, 2);
    grid.indices.fill(0);
    grid.alpha.fill(0);
    const data = renderSpritesheet(
      planSpritesheet([tile(grid, 'a')], OPTIONS),
      [tile(grid, 'a')],
      OPTIONS,
    );
    expect(pixelAt(data, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('填白底后透明区变成不透明白色', () => {
    const grid = createGrid(2, 2);
    grid.indices.fill(0);
    grid.alpha.fill(0);
    const options: SpritesheetOptions = { ...OPTIONS, background: '#ffffff' };
    const data = renderSpritesheet(planSpritesheet([tile(grid, 'a')], options), [tile(grid, 'a')], options);
    expect(pixelAt(data, 0, 0)).toEqual([255, 255, 255, 255]);
  });

  it('半透明像素叠在不透明底上会被混合（不是直接覆盖）', () => {
    const grid = createGrid(1, 1);
    grid.indices.fill(0); // RED
    grid.alpha.fill(128);
    const options: SpritesheetOptions = { ...OPTIONS, background: '#ffffff' };
    const data = renderSpritesheet(planSpritesheet([tile(grid, 'a')], options), [tile(grid, 'a')], options);
    const [r, g, b, a] = pixelAt(data, 0, 0);
    expect(a).toBe(255);
    expect(r).toBe(255);
    // 红叠白：绿色通道应是中间值，说明做了混合
    expect(g).toBeGreaterThan(100);
    expect(g).toBeLessThan(160);
    expect(b).toBeGreaterThan(100);
  });

  it('输出尺寸与布局一致', () => {
    const tiles = [tile(solid(3, 3, 0), 'a'), tile(solid(3, 3, 0), 'b')];
    const layout = planSpritesheet(tiles, { ...OPTIONS, columns: 2, padding: 1 });
    const data = renderSpritesheet(layout, tiles, { ...OPTIONS, columns: 2, padding: 1 });
    expect(data.width).toBe(layout.w);
    expect(data.height).toBe(layout.h);
  });

  it('索引越界时钳到末位色，不会画出黑块', () => {
    // 用一块末位是蓝色的板：越界时应该落在蓝上，而不是黑
    const palette = makePalette('clamp', [RED, WHITE, BLUE]);
    const grid = createGrid(1, 1);
    grid.indices.fill(99);
    grid.alpha.fill(255);
    const clamped: SheetTile = { grid, palette, name: 'a' };

    const data = renderSpritesheet(planSpritesheet([clamped], OPTIONS), [clamped], OPTIONS);
    expect(pixelAt(data, 0, 0)).toEqual([0, 0, 255, 255]);
  });
});

describe('buildSheetManifest', () => {
  it('帧坐标与布局一致，可直接给引擎用', () => {
    const layout = planSpritesheet(
      [tile(solid(4, 4, 0), 'a'), tile(solid(4, 4, 0), 'b')],
      { ...OPTIONS, columns: 2, padding: 1 },
    );
    const manifest = buildSheetManifest(layout);
    expect(manifest.sheet).toEqual({ w: layout.w, h: layout.h, columns: 2, rows: 1 });
    expect(manifest.frames[0]).toEqual({ name: 'a', x: 1, y: 1, w: 4, h: 4 });
    expect(manifest.frames[1]).toEqual({ name: 'b', x: 6, y: 1, w: 4, h: 4 });
  });
});