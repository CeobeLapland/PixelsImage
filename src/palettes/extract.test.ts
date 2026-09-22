import { describe, expect, it } from 'vitest';

import { CLEAR, RED, GREEN, BLUE, BLACK, WHITE, fillImage, makeImage } from '@/core/__testing__/fixtures';
import type { RGBA } from '@/core/types';
import { extractPalette } from './extract';

/** 从结果里取出 "r,g,b" 的集合，便于断言「包含哪些颜色」 */
function keysOf(colors: readonly RGBA[]): Set<string> {
  return new Set(colors.map((c) => `${c[0]},${c[1]},${c[2]}`));
}

/** 4 个纯色块拼成的图：左上红、右上绿、左下蓝、右下白 */
function fourBlocks(): ReturnType<typeof makeImage> {
  const rows: (typeof RED)[] = [];
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      const top = y < 4;
      const left = x < 4;
      rows.push(top ? (left ? RED : GREEN) : left ? BLUE : WHITE);
    }
  }
  return makeImage(8, 8, rows);
}

describe('extractPalette · 中位切分', () => {
  it('色块数不超过要求，且能还原出图里的纯色', () => {
    const colors = extractPalette(fourBlocks(), { count: 4, method: 'medianCut' });
    expect(colors.length).toBeLessThanOrEqual(4);
    const keys = keysOf(colors);
    // 四个色块各占 1/4，应该能各自拿到一个中心
    expect(keys.has('255,0,0')).toBe(true);
    expect(keys.has('0,255,0')).toBe(true);
    expect(keys.has('0,0,255')).toBe(true);
    expect(keys.has('255,255,255')).toBe(true);
  });

  it('颜色数要求更少时给出混合色（而不是随便丢几块）', () => {
    const colors = extractPalette(fourBlocks(), { count: 2, method: 'medianCut' });
    expect(colors).toHaveLength(2);
    // 两个盒子的平均色都不该恰好等于四个源色中的某一个
    const keys = keysOf(colors);
    expect(keys.has('255,0,0')).toBe(false);
    expect(keys.has('0,255,0')).toBe(false);
  });

  it('结果是确定的：同一张图两次提取完全相同', () => {
    const a = extractPalette(fourBlocks(), { count: 3, method: 'medianCut' });
    const b = extractPalette(fourBlocks(), { count: 3, method: 'medianCut' });
    expect(a).toEqual(b);
  });

  it('颜色数超过实际色数时不会产出重复色', () => {
    const colors = extractPalette(fourBlocks(), { count: 40, method: 'medianCut' });
    // 分割到每个盒子只剩一种颜色就停
    expect(keysOf(colors).size).toBe(colors.length);
    expect(colors.length).toBeLessThanOrEqual(4);
  });
});

describe('extractPalette · 过滤器', () => {
  it('默认排除全透明像素：透明区的黑色不该被提出来', () => {
    // 左半红、右半全透明
    const rows: (typeof RED)[] = [];
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 8; x += 1) rows.push(x < 4 ? RED : CLEAR);
    }
    const image = makeImage(8, 4, rows);

    const withFilter = extractPalette(image, { count: 4 });
    expect(keysOf(withFilter).has('0,0,0')).toBe(false);
    expect(keysOf(withFilter).has('255,0,0')).toBe(true);

    const withoutFilter = extractPalette(image, { count: 2, alphaThreshold: 0 });
    // 阈值设为 0 时只排除 alpha 完全为 0 的像素，语义不变
    expect(keysOf(withoutFilter).has('255,0,0')).toBe(true);
  });

  it('限定明度区间后暗色不再参与统计', () => {
    // 左半黑、右半白
    const rows: (typeof BLACK)[] = [];
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 8; x += 1) rows.push(x < 4 ? BLACK : WHITE);
    }
    const image = makeImage(8, 4, rows);

    const all = extractPalette(image, { count: 4 });
    expect(keysOf(all).has('0,0,0')).toBe(true);

    const brightOnly = extractPalette(image, { count: 4, luminanceRange: [0.5, 1] });
    expect(keysOf(brightOnly).has('0,0,0')).toBe(false);
    expect(keysOf(brightOnly).has('255,255,255')).toBe(true);
  });

  it('过滤后没有任何像素时返回空数组', () => {
    const image = fillImage(4, 4, CLEAR);
    expect(extractPalette(image, { count: 8 })).toEqual([]);
  });
});

describe('extractPalette · k-means', () => {
  it('同样能还原出四个色块', () => {
    const colors = extractPalette(fourBlocks(), { count: 4, method: 'kmeans' });
    const keys = keysOf(colors);
    expect(keys.has('255,0,0')).toBe(true);
    expect(keys.has('0,0,255')).toBe(true);
  });

  it('结果确定', () => {
    const a = extractPalette(fourBlocks(), { count: 3, method: 'kmeans' });
    const b = extractPalette(fourBlocks(), { count: 3, method: 'kmeans' });
    expect(a).toEqual(b);
  });
});

describe('extractPalette · 边界', () => {
  it('颜色数被钳在 1-256', () => {
    expect(extractPalette(fourBlocks(), { count: 0 }).length).toBeGreaterThanOrEqual(1);
    expect(extractPalette(fourBlocks(), { count: 9999 }).length).toBeLessThanOrEqual(256);
  });

  it('单色图返回一个色', () => {
    const colors = extractPalette(fillImage(6, 6, BLUE), { count: 8 });
    expect(colors).toHaveLength(1);
    expect(colors[0]).toEqual([0, 0, 255, 255]);
  });

  it('零尺寸图不崩', () => {
    expect(extractPalette({ width: 0, height: 0, data: new Uint8ClampedArray(0) }, { count: 8 })).toEqual(
      [],
    );
  });

  it('返回的都是不透明色', () => {
    for (const c of extractPalette(fourBlocks(), { count: 6 })) {
      expect(c[3]).toBe(255);
    }
  });
});