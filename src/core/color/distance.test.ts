import { describe, expect, it } from 'vitest';

import {
  BLACK,
  BLUE,
  CLEAR,
  GREEN,
  RED,
  WHITE,
  makePalette,
  pixelAt,
} from '@/core/__testing__/fixtures';
import { makeImage } from '@/core/__testing__/fixtures';
import { createNearestFinder } from './distance';
import { paletteToLab } from './space';

const RGB_PALETTE = makePalette('rgb3', [RED, GREEN, BLUE]).colors;

describe('createNearestFinder / 欧氏与加权距离', () => {
  it('精确命中调色板中的颜色', () => {
    const find = createNearestFinder(RGB_PALETTE, 'rgb', null);
    expect(find(255, 0, 0)).toBe(0);
    expect(find(0, 255, 0)).toBe(1);
    expect(find(0, 0, 255)).toBe(2);
  });

  it('取最近的色而不是第一个', () => {
    const find = createNearestFinder(RGB_PALETTE, 'rgb', null);
    expect(find(20, 20, 240)).toBe(2);
  });

  it('单色调色板恒返回 0', () => {
    const single = makePalette('one', [RED]).colors;
    const find = createNearestFinder(single, 'rgb', null);
    expect(find(0, 255, 0)).toBe(0);
    expect(find(255, 255, 255)).toBe(0);
  });

  it('遍历色彩空间时索引始终合法', () => {
    // 缓存按 5bit/通道 压缩，容易在桶边界出错，所以步长刻意取非 8 的倍数
    for (const mode of ['rgb', 'weighted'] as const) {
      const find = createNearestFinder(RGB_PALETTE, mode, null);
      for (let r = 0; r < 256; r += 7) {
        for (let g = 0; g < 256; g += 11) {
          for (let b = 0; b < 256; b += 13) {
            const idx = find(r, g, b);
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(idx).toBeLessThan(RGB_PALETTE.length);
          }
        }
      }
    }
  });
});

describe('createNearestFinder / CIELAB 距离', () => {
  const palette = makePalette('lab4', [RED, GREEN, BLUE, WHITE]).colors;
  const lab = paletteToLab(palette);

  it('缺少 LAB 表时直接报错，而不是静默退回欧氏距离', () => {
    expect(() => createNearestFinder(palette, 'lab', null)).toThrow(/LAB/);
  });

  it('给定 LAB 表时正常工作', () => {
    const find = createNearestFinder(palette, 'lab', lab);
    expect(find(255, 0, 0)).toBe(0);
    expect(find(0, 255, 0)).toBe(1);
    expect(find(0, 0, 255)).toBe(2);
    expect(find(250, 250, 250)).toBe(3);
  });

  it('索引始终合法', () => {
    const find = createNearestFinder(palette, 'lab', lab);
    for (let i = 0; i < 512; i += 1) {
      const idx = find((i * 7) % 256, (i * 3) % 256, (i * 11) % 256);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(palette.length);
    }
  });
});

describe('缓存不跨调色板复用', () => {
  /**
   * 回归测试。
   * 之前缓存是模块级单例，用 16 色板填满后再用 2 色板，会取到越界的旧索引并崩溃。
   * 现在缓存由 finder 内部持有，两个调色板的 finder 天然隔离。
   */
  it('先用大板再用小板，小板的结果仍在小板范围内', () => {
    const big = makePalette('big', [RED, GREEN, BLUE, WHITE, CLEAR]).colors;
    const small = makePalette('small', [BLACK, WHITE]).colors;

    const findBig = createNearestFinder(big, 'rgb', null);
    // 把大板的缓存填满，含只有大板才有的高索引
    expect(findBig(255, 0, 0)).toBe(0);
    expect(findBig(0, 0, 0)).toBe(4);
    expect(findBig(0, 0, 255)).toBe(2);

    const findSmall = createNearestFinder(small, 'rgb', null);
    for (let v = 0; v < 256; v += 5) {
      const idx = findSmall(v, v, v);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(small.length);
    }
  });
});

describe('fixtures 自身正确性', () => {
  it('makeImage 按行优先排布', () => {
    const img = makeImage(2, 2, [RED, GREEN, BLUE, WHITE]);
    expect(pixelAt(img, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(img, 1, 0)).toEqual([0, 255, 0, 255]);
    expect(pixelAt(img, 0, 1)).toEqual([0, 0, 255, 255]);
    expect(pixelAt(img, 1, 1)).toEqual([255, 255, 255, 255]);
  });

  it('像素数量不匹配时抛错', () => {
    expect(() => makeImage(2, 2, [RED])).toThrow();
  });
});