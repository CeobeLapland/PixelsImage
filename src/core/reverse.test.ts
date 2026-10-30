/**
 * 反向解析的测试。
 *
 * 锁两件事：
 * 1. **整倍数放大要被识别出来**（否则会把一张 4× 放大的 8×8 素材还原成 32×32 废网格）；
 * 2. **像素一位都不能改**（颜色、alpha、顺序都要原样回来）。
 */

import { describe, expect, it } from 'vitest';

import { CLEAR, BLUE, GREEN, RED, WHITE } from '@/core/__testing__/fixtures';
import type { RGBAImage } from '@/core/types';
import { detectPixelScale, reversePixelImage } from './reverse';

/** 把 gw×gh 的像素格按 k 倍放大成一张图 */
function scaledImage(
  gw: number,
  gh: number,
  k: number,
  cells: readonly (readonly number[])[],
): RGBAImage {
  const w = gw * k;
  const h = gh * k;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let gy = 0; gy < gh; gy += 1) {
    for (let gx = 0; gx < gw; gx += 1) {
      const cell = cells[gy * gw + gx] as number[];
      for (let dy = 0; dy < k; dy += 1) {
        for (let dx = 0; dx < k; dx += 1) {
          const o = ((gy * k + dy) * w + gx * k + dx) * 4;
          data[o] = cell[0] as number;
          data[o + 1] = cell[1] as number;
          data[o + 2] = cell[2] as number;
          data[o + 3] = cell[3] as number;
        }
      }
    }
  }
  return { width: w, height: h, data };
}

/** 1×1 像素格，便于逐个写 */
function image1x(pixels: readonly (readonly number[])[]): RGBAImage {
  return scaledImage(pixels.length, 1, 1, pixels);
}

describe('detectPixelScale', () => {
  it('识别 4× 放大', () => {
    const img = scaledImage(2, 2, 4, [RED, BLUE, GREEN, WHITE]);
    expect(detectPixelScale(img)).toBe(4);
  });

  it('原图就是 1× 时返回 1', () => {
    expect(detectPixelScale(image1x([RED, BLUE]))).toBe(1);
  });

  it('相邻同色块把连续段拉长时仍能认出块大小', () => {
    // 3×1 格，前两格同色 → 横向连续段是 8 和 4，gcd 仍是 4
    const img = scaledImage(3, 1, 4, [RED, RED, BLUE]);
    expect(detectPixelScale(img)).toBe(4);
  });

  it('抗锯齿 / 噪声图不硬猜，返回 1', () => {
    const data = new Uint8ClampedArray(3 * 3 * 4);
    for (let i = 0; i < 9; i += 1) {
      data[i * 4] = i * 20;
      data[i * 4 + 3] = 255;
    }
    expect(detectPixelScale({ width: 3, height: 3, data })).toBe(1);
  });

  it('整张单色时不会退化成 1×1 网格', () => {
    const img = scaledImage(2, 2, 4, [RED, RED, RED, RED]);
    expect(detectPixelScale(img)).toBe(4);
  });
});

describe('reversePixelImage', () => {
  it('颜色与索引原样还原，调色板按首次出现顺序', () => {
    const img = scaledImage(2, 2, 4, [RED, BLUE, GREEN, RED]);
    const result = reversePixelImage(img);

    expect(result.scale).toBe(4);
    expect(result.grid.w).toBe(2);
    expect(result.grid.h).toBe(2);
    expect(Array.from(result.grid.indices)).toEqual([0, 1, 2, 0]);
    expect(result.grid.alpha.every((a) => a === 255)).toBe(true);
    expect(result.palette.colors.map((c) => [c[0], c[1], c[2]])).toEqual([
      [255, 0, 0],
      [0, 0, 255],
      [0, 255, 0],
    ]);
    expect(result.quantized).toBe(false);
    expect(result.sourceColors).toBe(3);
  });

  it('透明格保留 alpha 且不占调色板', () => {
    const img = scaledImage(2, 1, 2, [RED, CLEAR]);
    const result = reversePixelImage(img);

    expect(result.palette.colors).toHaveLength(1);
    expect(result.grid.alpha[0]).toBe(255);
    expect(result.grid.alpha[1]).toBe(0);
  });

  it('半透明 alpha 逐格保留', () => {
    const semi = [255, 0, 0, 128];
    const img = scaledImage(2, 1, 3, [RED, semi]);
    const result = reversePixelImage(img);
    expect(result.grid.alpha[1]).toBe(128);
    expect(result.palette.colors).toHaveLength(1);
  });

  it('1× 原图按像素建网格', () => {
    const img = image1x([RED, BLUE, GREEN]);
    const result = reversePixelImage(img);
    expect(result.scale).toBe(1);
    expect(result.grid.w).toBe(3);
    expect(Array.from(result.grid.indices)).toEqual([0, 1, 2]);
  });

  it('全透明图也给出一块合法调色板', () => {
    const img = scaledImage(2, 2, 2, [CLEAR, CLEAR, CLEAR, CLEAR]);
    const result = reversePixelImage(img);
    expect(result.palette.colors.length).toBeGreaterThan(0);
    expect(result.grid.alpha.every((a) => a === 0)).toBe(true);
  });

  it('颜色超过上限时量化，并如实标记 quantized', () => {
    // 300 个不同颜色
    const cells = Array.from({ length: 300 }, (_, i) => [i % 256, (i * 3) % 256, (i * 7) % 256, 255]);
    const img = image1x(cells);
    const result = reversePixelImage(img, { maxColors: 16 });

    expect(result.quantized).toBe(true);
    expect(result.sourceColors).toBeGreaterThan(16);
    expect(result.palette.colors.length).toBeLessThanOrEqual(16);
    for (const index of result.grid.indices) {
      expect(index).toBeLessThan(result.palette.colors.length);
    }
  });

  it('颜色数不超过上限时不量化（哪怕刚好等于上限）', () => {
    const cells = Array.from({ length: 16 }, (_, i) => [i, i, i, 255]);
    const img = image1x(cells);
    const result = reversePixelImage(img, { maxColors: 16 });
    expect(result.quantized).toBe(false);
    expect(result.palette.colors.length).toBe(16);
  });

  it('强制倍数不能整除时报错', () => {
    const img = image1x([RED, BLUE, GREEN]);
    expect(() => reversePixelImage(img, { scale: 2 })).toThrow(/整除/);
  });

  it('超过格数上限时报错（照片被误拖进来）', () => {
    const w = 1200;
    const h = 900;
    const data = new Uint8ClampedArray(w * h * 4);
    // 相邻像素必须不同，否则会被识别成「超大块」而缩小网格
    for (let i = 0; i < w * h; i += 1) {
      data[i * 4] = i % 251;
      data[i * 4 + 1] = (i * 3) % 251;
      data[i * 4 + 2] = (i * 7) % 251;
      data[i * 4 + 3] = 255;
    }
    expect(() => reversePixelImage({ width: w, height: h, data })).toThrow(/上限/);
  });

  it('1×1 的图也能反解析', () => {
    const img = image1x([BLUE]);
    const result = reversePixelImage(img);
    expect(result.grid.w).toBe(1);
    expect(result.grid.h).toBe(1);
  });
});
