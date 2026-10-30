import { describe, expect, it } from 'vitest';

import { labToRgb, rgbToLab, relativeLuminance } from './space';
import { buildLightnessLadder, nearestLadderIndex, type LadderOptions } from './ladder';
import type { RGBA } from '@/core/types';

const BLUE: RGBA = [64, 96, 200, 255];
const GRAY: RGBA = [128, 128, 128, 255];
const WHITE: RGBA = [255, 255, 255, 255];
const BLACK: RGBA = [0, 0, 0, 255];

const opts = (over: Partial<LadderOptions> = {}): LadderOptions => ({ steps: 5, ...over });

/** 取某个颜色的 L* */
function lOf(color: RGBA): number {
  const out = [0, 0, 0];
  rgbToLab(color[0], color[1], color[2], out);
  return out[0] as number;
}

describe('labToRgb', () => {
  it('与 rgbToLab 往返基本无损（同一组白点常量）', () => {
    const cases: RGBA[] = [BLUE, GRAY, [200, 40, 90, 255], [30, 180, 120, 255], WHITE, BLACK];
    for (const color of cases) {
      const lab = [0, 0, 0];
      rgbToLab(color[0], color[1], color[2], lab);
      const back = [0, 0, 0];
      labToRgb(lab[0] as number, lab[1] as number, lab[2] as number, back);
      // 8bit 往返允许 ±2 的舍入误差
      expect(Math.abs((back[0] as number) - color[0])).toBeLessThanOrEqual(2);
      expect(Math.abs((back[1] as number) - color[1])).toBeLessThanOrEqual(2);
      expect(Math.abs((back[2] as number) - color[2])).toBeLessThanOrEqual(2);
    }
  });

  it('白色 L*=100、黑色 L*=0', () => {
    expect(lOf(WHITE)).toBeCloseTo(100, 1);
    expect(lOf(BLACK)).toBeCloseTo(0, 0);
  });

  it('超色域的值被钳制在 0-255，不产生负数或溢出', () => {
    const out = [0, 0, 0];
    // 极鲜艳的绿：sRGB 画不出来，必须钳制
    labToRgb(50, -128, 128, out);
    for (const v of out) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of out) expect(v).toBeLessThanOrEqual(255);
  });
});

describe('buildLightnessLadder', () => {
  it('档数正确，且由暗到亮', () => {
    const ladder = buildLightnessLadder(BLUE, opts());
    expect(ladder).toHaveLength(5);
    for (let i = 1; i < ladder.length; i += 1) {
      expect(relativeLuminance(ladder[i][0], ladder[i][1], ladder[i][2])).toBeGreaterThan(
        relativeLuminance(ladder[i - 1][0], ladder[i - 1][1], ladder[i - 1][2]),
      );
    }
  });

  it('两端的 L* 落在默认区间 18-94 附近', () => {
    const ladder = buildLightnessLadder(BLUE, opts({ steps: 3 }));
    expect(lOf(ladder[0])).toBeGreaterThan(15);
    expect(lOf(ladder[0])).toBeLessThan(21);
    expect(lOf(ladder[2])).toBeGreaterThan(90);
    expect(lOf(ladder[2])).toBeLessThan(97);
  });

  it('各档 L* 等间隔 —— 这是用 LAB 而不是 RGB 乘系数的理由', () => {
    const ladder = buildLightnessLadder(BLUE, opts({ steps: 5 }));
    const ls = ladder.map(lOf);
    const gaps = [1, 2, 3, 4].map((i) => (ls[i] as number) - (ls[i - 1] as number));
    const first = gaps[0] as number;
    /*
     * 容差放到 4 而不是 1.5：生成时 L 是严格等间隔的，但落回 8bit RGB
     * 再量回来会有量化误差，两端还可能被色域钳制。测「大致等间隔」就够了 ——
     * 真正的判据是肉眼看上去明暗层次是否均匀，不是小数点后两位。
     */
    for (const gap of gaps) {
      expect(Math.abs(gap - first)).toBeLessThan(4);
    }
  });

  it('色相大体保持 —— 蓝色阶梯的每一档都仍然是「蓝」', () => {
    for (const color of buildLightnessLadder(BLUE, opts())) {
      expect(color[2]).toBeGreaterThan(color[0]); // b 通道始终高于 r
    }
  });

  it('灰色阶梯保持中性，不染色', () => {
    for (const color of buildLightnessLadder(GRAY, opts())) {
      const spread = Math.max(...color.slice(0, 3)) - Math.min(...color.slice(0, 3));
      expect(spread).toBeLessThanOrEqual(2);
    }
  });

  it('alpha 跟着原色走', () => {
    const semi: RGBA = [64, 96, 200, 128];
    for (const color of buildLightnessLadder(semi, opts())) {
      expect(color[3]).toBe(128);
    }
  });

  it('档数越界时被钳到 2-9', () => {
    expect(buildLightnessLadder(BLUE, opts({ steps: 1 }))).toHaveLength(2);
    expect(buildLightnessLadder(BLUE, opts({ steps: 99 }))).toHaveLength(9);
    expect(buildLightnessLadder(BLUE, opts({ steps: Number.NaN }))).toHaveLength(5);
  });

  it('自定义明度区间生效', () => {
    const ladder = buildLightnessLadder(BLUE, opts({ steps: 3, dark: 40, light: 60 }));
    const ls = ladder.map(lOf);
    expect(ls[0]).toBeCloseTo(40, 0);
    expect(ls[2]).toBeCloseTo(60, 0);
  });

  it('区间参数越界时钳到 0-100', () => {
    // L*=0 时 a/b 仍非零，算回 RGB 后分量可能是个极小的灰（量化到 8bit 后
    // 量回来的 L 会差几度），所以只断言「接近黑 / 接近白」
    const ladder = buildLightnessLadder(BLUE, opts({ steps: 2, dark: -50, light: 400 }));
    expect(lOf(ladder[0])).toBeLessThan(12);
    expect(lOf(ladder[1])).toBeGreaterThan(88);
  });

  it('纯白与纯黑也能生成（不会除零或崩）', () => {
    for (const base of [WHITE, BLACK]) {
      const ladder = buildLightnessLadder(base, opts({ steps: 3 }));
      expect(ladder).toHaveLength(3);
      // 纯色的 a/b 为 0，各档应该都是灰阶
      for (const color of ladder) {
        expect(color[0]).toBe(color[1]);
        expect(color[1]).toBe(color[2]);
      }
    }
  });
});

describe('nearestLadderIndex', () => {
  it('找出最接近原色的那一档', () => {
    const ladder = buildLightnessLadder(BLUE, opts());
    // 原色在中段，最接近的不该是最暗或最亮
    expect(nearestLadderIndex(ladder, BLUE)).toBeGreaterThan(0);
    expect(nearestLadderIndex(ladder, BLUE)).toBeLessThan(4);
  });

  it('完全命中时返回该档', () => {
    const ladder: RGBA[] = [
      [0, 0, 0, 255],
      [128, 128, 128, 255],
      [255, 255, 255, 255],
    ];
    expect(nearestLadderIndex(ladder, [128, 128, 128, 255])).toBe(1);
  });
});