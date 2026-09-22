import { describe, expect, it } from 'vitest';

import { BLACK, BLUE, RED, WHITE, makePalette } from '@/core/__testing__/fixtures';
import { composite, compositeInto, gridToImageData, gridToRgba, upscaleNearest } from './composite';
import { createEditLayer, createGrid, type PixelGrid } from './types';

const PALETTE = makePalette('p', [RED, WHITE, BLUE, BLACK]);

function pixelOf(data: ImageData, x: number, y: number): number[] {
  const o = (y * data.width + x) * 4;
  return [data.data[o], data.data[o + 1], data.data[o + 2], data.data[o + 3]];
}

describe('gridToImageData', () => {
  it('按索引取色并写入 alpha', () => {
    const grid = createGrid(2, 1);
    grid.indices[0] = 0; // 红
    grid.indices[1] = 2; // 蓝
    grid.alpha[0] = 255;
    grid.alpha[1] = 128;

    const data = gridToImageData(grid, PALETTE);

    expect(data.width).toBe(2);
    expect(data.height).toBe(1);
    expect(pixelOf(data, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelOf(data, 1, 0)).toEqual([0, 0, 255, 128]);
  });

  it('alpha 为 0 的格子保持全透明，RGB 归零', () => {
    // 若只写 alpha 而留下 RGB，半透明边缘会出现残留色
    const grid = createGrid(1, 1);
    grid.indices[0] = 0; // 索引指向红
    grid.alpha[0] = 0;

    const data = gridToImageData(grid, PALETTE);
    expect(pixelOf(data, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('索引越界时钳到最后一个色，不产出黑块', () => {
    const grid = createGrid(1, 1);
    grid.indices[0] = 200; // 调色板只有 4 色
    grid.alpha[0] = 255;

    const data = gridToImageData(grid, PALETTE);
    expect(pixelOf(data, 0, 0)).toEqual([0, 0, 0, 255]);
  });

  it('缓冲长度与尺寸一致', () => {
    const grid = createGrid(5, 3);
    const data = gridToImageData(grid, PALETTE);
    expect(data.data.length).toBe(5 * 3 * 4);
  });

  it('所有 alpha=255 的格子都是不透明的', () => {
    const grid = createGrid(8, 8);
    grid.alpha.fill(255);
    for (let i = 0; i < grid.indices.length; i += 1) grid.indices[i] = i % 4;

    const data = gridToImageData(grid, PALETTE);
    for (let i = 3; i < data.data.length; i += 4) {
      expect(data.data[i]).toBe(255);
    }
  });
});

describe('upscaleNearest（按倍数放大）', () => {
  function twoByTwo(): ImageData {
    const grid = createGrid(2, 2);
    grid.indices.set([0, 1, 2, 3]); // 红 白 蓝 黑
    grid.alpha.fill(255);
    return gridToImageData(grid, PALETTE);
  }

  it('每个像素精确变成 k×k 的方块，不做插值', () => {
    const src = twoByTwo();
    const out = upscaleNearest(src, 4);

    expect(out.width).toBe(8);
    expect(out.height).toBe(8);

    // 左上角 4×4 应完全等于源像素 (0,0)
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        expect(pixelOf(out, x, y)).toEqual([255, 0, 0, 255]);
      }
    }
    // 右下角 4×4 应是黑
    for (let y = 4; y < 8; y += 1) {
      for (let x = 4; x < 8; x += 1) {
        expect(pixelOf(out, x, y)).toEqual([0, 0, 0, 255]);
      }
    }
  });

  it('放大后不存在源图里没有的颜色（验证没有插值）', () => {
    const src = twoByTwo();
    const out = upscaleNearest(src, 8);

    const allowed = new Set(['255,0,0', '255,255,255', '0,0,255', '0,0,0']);
    for (let i = 0; i < out.data.length; i += 4) {
      const key = `${out.data[i]},${out.data[i + 1]},${out.data[i + 2]}`;
      expect(allowed.has(key), `出现插值产生的颜色 ${key}`).toBe(true);
    }
  });

  it('保留 alpha', () => {
    const grid = createGrid(1, 1);
    grid.indices[0] = 0;
    grid.alpha[0] = 100;
    const out = upscaleNearest(gridToImageData(grid, PALETTE), 3);

    expect(out.width).toBe(3);
    for (let i = 3; i < out.data.length; i += 4) {
      expect(out.data[i]).toBe(100);
    }
  });

  it('k=1 时原样返回同一个对象', () => {
    const src = twoByTwo();
    expect(upscaleNearest(src, 1)).toBe(src);
  });

  it('导出尺寸 = 原尺寸 × 倍数', () => {
    const grid = createGrid(7, 5);
    grid.alpha.fill(255);
    const out = upscaleNearest(gridToImageData(grid, PALETTE), 6);
    expect(out.width).toBe(42);
    expect(out.height).toBe(30);
  });
});

describe('composite 与渲染的配合', () => {
  it('编辑层覆盖后渲染出来的是覆盖色', () => {
    const base = createGrid(2, 1);
    base.indices[0] = 0; // 红
    base.indices[1] = 0;
    base.alpha.fill(255);

    const edit = {
      w: 2,
      h: 1,
      cells: [null, { index: 2, alpha: 255 }], // 第二格改成蓝
    };

    const merged = composite(base, edit);
    const data = gridToImageData(merged, PALETTE);

    expect(pixelOf(data, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelOf(data, 1, 0)).toEqual([0, 0, 255, 255]);
  });

  it('编辑层把格子改成透明后该格渲染为全透明', () => {
    const base: PixelGrid = createGrid(1, 1);
    base.indices[0] = 0;
    base.alpha[0] = 255;

    const merged = composite(base, { w: 1, h: 1, cells: [{ index: 0, alpha: 0 }] });
    expect(pixelOf(gridToImageData(merged, PALETTE), 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('没有编辑层时返回底层本身，不复制一份', () => {
    const base = createGrid(2, 2);
    expect(composite(base, null)).toBe(base);
  });
});

describe('compositeInto（复用缓冲的合成）', () => {
  it('结果与 composite 完全一致', () => {
    const base = createGrid(3, 2);
    for (let i = 0; i < base.indices.length; i += 1) {
      base.indices[i] = i % 4;
      base.alpha[i] = 200;
    }
    const edit = createEditLayer(3, 2);
    edit.cells[0] = { index: 2, alpha: 255 };
    edit.cells[4] = { index: 0, alpha: 0 };

    const out = createGrid(3, 2);
    compositeInto(base, edit, out);
    const reference = composite(base, edit);

    expect(Array.from(out.indices)).toEqual(Array.from(reference.indices));
    expect(Array.from(out.alpha)).toEqual(Array.from(reference.alpha));
  });

  it('反复复用同一个 out 不会残留上一次的结果', () => {
    const base = createGrid(2, 1);
    base.indices[0] = 0;
    base.alpha.fill(255);
    const edit = createEditLayer(2, 1);
    edit.cells[0] = { index: 3, alpha: 255 };

    const out = createGrid(2, 1);
    compositeInto(base, edit, out);
    expect(out.indices[0]).toBe(3);

    // 换成没有编辑层的合成：上一轮写进去的 3 必须被覆盖回底层的 0
    compositeInto(base, null, out);
    expect(out.indices[0]).toBe(0);
    expect(out.alpha[1]).toBe(255);
  });

  it('编辑层尺寸不一致时忽略它，而不是越界读取', () => {
    const base = createGrid(4, 4);
    base.indices.fill(1);
    const stale = createEditLayer(2, 2);
    stale.cells[0] = { index: 3, alpha: 255 };

    const out = createGrid(4, 4);
    compositeInto(base, stale, out);
    expect(out.indices[0]).toBe(1);
  });
});

describe('gridToRgba', () => {
  it('写入调用方提供的缓冲，长度不足时不越界', () => {
    const grid = createGrid(2, 1);
    grid.indices.set([0, 2]);
    grid.alpha.fill(255);

    const out = new Uint8ClampedArray(2 * 1 * 4);
    gridToRgba(grid, PALETTE, out);
    expect(Array.from(out)).toEqual([255, 0, 0, 255, 0, 0, 255, 255]);
  });

  it('与 gridToImageData 的像素完全一致', () => {
    const grid = createGrid(4, 3);
    for (let i = 0; i < grid.indices.length; i += 1) {
      grid.indices[i] = i % 5; // 含越界索引
      grid.alpha[i] = i % 3 === 0 ? 0 : 180;
    }
    const data = gridToImageData(grid, PALETTE);
    const out = new Uint8ClampedArray(data.data.length);
    gridToRgba(grid, PALETTE, out);
    expect(Array.from(out)).toEqual(Array.from(data.data));
  });
});