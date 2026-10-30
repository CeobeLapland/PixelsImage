/**
 * 色相偏移的测试。
 *
 * 重点在「转了之后，明暗关系不能乱、灰阶不能被染色」——
 * 这两条错了不会报错，只会让整套素材悄悄偏色。
 */

import { describe, expect, it } from 'vitest';

import { makePalette, BLUE, GREEN, RED, WHITE } from '@/core/__testing__/fixtures';
import { hueOf, rgbToLab } from './space';
import { rotateHue, rotatePaletteHue } from './hue';
import type { RGBA } from '@/core/types';

const GRAY: RGBA = [128, 128, 128, 255];
const BLACK: RGBA = [0, 0, 0, 255];

/** 取 LAB 的 L 与彩度 */
function labOf(color: RGBA): { l: number; chroma: number } {
  const lab = [0, 0, 0];
  rgbToLab(color[0], color[1], color[2], lab);
  return { l: lab[0] as number, chroma: Math.hypot(lab[1] as number, lab[2] as number) };
}

describe('rotateHue', () => {
  it('0° 原样返回', () => {
    expect(rotateHue(RED, 0)).toEqual(RED);
  });

  it('红 +120° 落到绿色区间', () => {
    const shifted = rotateHue(RED, 120);
    expect(shifted[1]).toBeGreaterThan(shifted[0]);
    expect(shifted[1]).toBeGreaterThan(shifted[2]);
  });

  it('红 -120° 落到蓝色区间', () => {
    const shifted = rotateHue(RED, -120);
    expect(shifted[2]).toBeGreaterThan(shifted[0]);
    expect(shifted[2]).toBeGreaterThan(shifted[1]);
  });

  it('360° 往返后基本回到原色（8bit 量化误差内）', () => {
    const back = rotateHue(RED, 360);
    expect(Math.abs(back[0] - RED[0])).toBeLessThanOrEqual(3);
    expect(Math.abs(back[1] - RED[1])).toBeLessThanOrEqual(3);
    expect(Math.abs(back[2] - RED[2])).toBeLessThanOrEqual(3);
  });

  it('明度 L* 与彩度基本不变（只改色相）', () => {
    // 用低饱和的色来测：纯蓝转 90° 会跑出 sRGB 色域，钳制本身就会改观感明度
    const muted: RGBA = [180, 120, 110, 255];
    const before = labOf(muted);
    const after = labOf(rotateHue(muted, 90));
    expect(Math.abs(after.l - before.l)).toBeLessThan(5);
    // 色域钳制会让彩度略有出入，但不该垮掉一半
    expect(after.chroma).toBeGreaterThan(before.chroma * 0.7);
  });

  it('灰阶 / 黑 / 白不被染色', () => {
    expect(rotateHue(GRAY, 120)).toEqual(GRAY);
    expect(rotateHue(BLACK, 90)).toEqual(BLACK);
    expect(rotateHue(WHITE, 45)).toEqual(WHITE);
  });

  it('alpha 原样保留', () => {
    const semi: RGBA = [255, 0, 0, 128];
    expect(rotateHue(semi, 90)[3]).toBe(128);
  });

  it('偏移角度影响的是色相角，不是亮度', () => {
    // 同样用低饱和色：高饱和色转出去会被色域钳制，色相角会跟着漂
    const muted: RGBA = [200, 130, 100, 255];
    const h0 = hueOf(muted[0], muted[1], muted[2]);
    const shifted = rotateHue(muted, 60);
    const h1 = hueOf(shifted[0], shifted[1], shifted[2]);
    // 取 0-360 的最短差值，应落在 60° 附近（允许 ±20° 的色域钳制偏差）
    const delta = ((h1 - h0 + 540) % 360) - 180;
    expect(Math.abs(delta - 60)).toBeLessThan(20);
  });
});

describe('rotatePaletteHue', () => {
  it('长度与顺序不变', () => {
    const palette = makePalette('p', [RED, GREEN, BLUE]);
    const shifted = rotatePaletteHue(palette.colors, 30);
    expect(shifted).toHaveLength(3);
    expect(shifted[0]?.[3]).toBe(255);
  });

  it('灰阶留在原地，彩色才转', () => {
    const colors: RGBA[] = [RED, GRAY, WHITE, BLACK];
    const shifted = rotatePaletteHue(colors, 90);
    expect(shifted[1]).toEqual(GRAY);
    expect(shifted[2]).toEqual(WHITE);
    expect(shifted[3]).toEqual(BLACK);
    expect(shifted[0]).not.toEqual(RED);
  });
});
