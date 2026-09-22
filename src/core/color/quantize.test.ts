import { describe, expect, it } from 'vitest';

import {
  BLACK,
  BLUE,
  CLEAR,
  GREEN,
  RED,
  WHITE,
  fillImage,
  makeGradient,
  makeImage,
  makePalette,
} from '@/core/__testing__/fixtures';
import type { RGBAImage } from '@/core/types';
import { countUsedColors, quantizeInto, type QuantizeTarget } from './quantize';

function run(
  src: RGBAImage,
  palette: readonly (readonly number[])[],
  opts: Partial<Parameters<typeof quantizeInto>[1]> = {},
): QuantizeTarget {
  const out: QuantizeTarget = {
    indices: new Uint8Array(src.width * src.height),
    alpha: new Uint8Array(src.width * src.height),
  };
  quantizeInto(
    src,
    {
      palette: palette as never,
      distance: 'rgb',
      dither: 'none',
      ditherStrength: 1,
      ...opts,
    },
    out,
  );
  return out;
}

const TRI = makePalette('tri', [RED, GREEN, BLUE]).colors;
const BW = makePalette('bw', [BLACK, WHITE]).colors;

describe('quantizeInto / 基础映射', () => {
  it('精确等于调色板颜色时映射到对应索引', () => {
    const src = makeImage(3, 1, [RED, GREEN, BLUE]);
    const out = run(src, TRI);
    expect(Array.from(out.indices)).toEqual([0, 1, 2]);
  });

  it('索引始终落在调色板范围内', () => {
    const palette = makePalette('two', [BLACK, WHITE]).colors;
    const out = run(makeGradient(32, 32), palette);
    for (const idx of out.indices) {
      expect(idx).toBeLessThan(palette.length);
    }
  });

  it('调色板为空时抛错', () => {
    expect(() => run(fillImage(2, 2, RED), [])).toThrow(/调色板为空/);
  });
});

describe('quantizeInto / alpha 处理', () => {
  it('不透明像素的 alpha 原样保留', () => {
    const src = fillImage(4, 1, RED);
    const out = run(src, TRI);
    expect(Array.from(out.alpha)).toEqual([255, 255, 255, 255]);
  });

  it('全透明像素 alpha 归零、索引归零', () => {
    const src = makeImage(2, 1, [CLEAR, RED]);
    const out = run(src, TRI);
    expect(out.alpha[0]).toBe(0);
    expect(out.indices[0]).toBe(0);
    expect(out.alpha[1]).toBe(255);
    expect(out.indices[1]).toBe(0); // 红 → 索引 0
  });

  it('半透明像素保持其 alpha 值', () => {
    const src = fillImage(2, 1, [255, 0, 0, 77]);
    const out = run(src, TRI);
    expect(Array.from(out.alpha)).toEqual([77, 77]);
  });

  it('透明像素不参与误差扩散（不会把误差推进透明区）', () => {
    // 左半是渐变（会产生误差），右半全透明。
    // 若把误差扩散进透明区，透明像素的 alpha 会被改写。
    const w = 16;
    const pixels: (readonly [number, number, number, number])[] = [];
    for (let i = 0; i < w; i += 1) {
      pixels.push(i < 8 ? [i * 30, i * 30, i * 30, 255] : CLEAR);
    }
    const src = makeImage(w, 1, pixels);
    const out = run(src, makePalette('bw', [BLACK, WHITE]).colors, {
      dither: 'atkinson',
    });
    for (let x = 8; x < w; x += 1) {
      expect(out.alpha[x]).toBe(0);
      expect(out.indices[x]).toBe(0);
    }
  });
});

describe('quantizeInto / 抖动', () => {
  it('不抖动时同一片纯色区域内索引完全一致', () => {
    const out = run(fillImage(16, 16, [128, 128, 128, 255]), BW);
    const first = out.indices[0];
    for (const idx of out.indices) expect(idx).toBe(first);
  });

  it('误差扩散在渐变上产生两种色的交织', () => {
    const out = run(makeGradient(32, 32), BW, { dither: 'atkinson' });
    const used = countUsedColors(out.indices, out.alpha);
    expect(used).toBe(2);
  });

  it('有序抖动同样产生交织', () => {
    const out = run(makeGradient(32, 32), BW, { dither: 'bayer4' });
    expect(countUsedColors(out.indices, out.alpha)).toBe(2);
  });

  it('强度为 0 时与「不抖动」结果完全一致', () => {
    const src = makeGradient(24, 24);
    const none = run(src, BW, { dither: 'none' });
    for (const mode of ['atkinson', 'floyd', 'sierra', 'bayer2', 'bayer4', 'bayer8'] as const) {
      const zero = run(src, BW, { dither: mode, ditherStrength: 0 });
      expect(Array.from(zero.indices), `${mode} 强度 0 应等同于不抖动`).toEqual(
        Array.from(none.indices),
      );
    }
  });

  it('抖动确实改变输出（与不抖动不同）', () => {
    const src = makeGradient(32, 32);
    const none = run(src, BW, { dither: 'none' });
    for (const mode of ['atkinson', 'floyd', 'sierra', 'bayer2', 'bayer4', 'bayer8'] as const) {
      const dithered = run(src, BW, { dither: mode });
      expect(Array.from(dithered.indices), `${mode} 应产生不同结果`).not.toEqual(
        Array.from(none.indices),
      );
    }
  });

  it('所有抖动模式都不会越界', () => {
    const src = makeGradient(40, 30);
    const palette = TRI;
    for (const dither of [
      'none',
      'atkinson',
      'floyd',
      'sierra',
      'bayer2',
      'bayer4',
      'bayer8',
    ] as const) {
      const out = run(src, palette, { dither });
      for (const idx of out.indices) {
        expect(idx, `${dither} 产生越界索引`).toBeLessThan(palette.length);
      }
    }
  });
});

describe('quantizeInto / 确定性', () => {
  it('同样的输入两次得到完全相同的结果', () => {
    const src = makeGradient(48, 36);
    for (const dither of ['atkinson', 'floyd', 'bayer8', 'none'] as const) {
      const a = run(src, TRI, { dither });
      const b = run(src, TRI, { dither });
      expect(Array.from(a.indices), dither).toEqual(Array.from(b.indices));
      expect(Array.from(a.alpha), dither).toEqual(Array.from(b.alpha));
    }
  });

  it('连续使用不同大小的调色板互不影响（回归：缓存不跨调色板复用）', () => {
    const src = makeGradient(64, 48);

    // 先用 16 色板
    const big = makePalette(
      'big16',
      Array.from({ length: 16 }, (_, i) => [i * 16, 255 - i * 16, i * 8, 255] as const),
    ).colors;
    const first = run(src, big, { dither: 'none' });
    for (const idx of first.indices) expect(idx).toBeLessThan(16);

    // 再用 2 色板：旧实现会取到缓存里的高索引并抛错
    const second = run(src, BW, { dither: 'none' });
    for (const idx of second.indices) expect(idx).toBeLessThan(2);

    // 再用 3 色板
    const third = run(src, TRI, { dither: 'none' });
    for (const idx of third.indices) expect(idx).toBeLessThan(3);
  });
});

describe('countUsedColors', () => {
  it('统计不重复且忽略透明像素', () => {
    const indices = new Uint8Array([0, 0, 1, 2, 2, 3]);
    const alpha = new Uint8Array([255, 255, 255, 0, 255, 255]);
    // 索引 2 的两个像素里有一个是透明的，但索引仍被算作使用过
    expect(countUsedColors(indices, alpha)).toBe(4);
  });

  it('全透明时返回 0', () => {
    expect(countUsedColors(new Uint8Array([0, 1, 2]), new Uint8Array([0, 0, 0]))).toBe(0);
  });
});