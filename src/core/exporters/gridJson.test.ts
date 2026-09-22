import { describe, expect, it } from 'vitest';

import { makePalette, BLUE, RED, WHITE } from '@/core/__testing__/fixtures';
import { createGrid, type PixelGrid } from '@/core/types';
import { buildGridJson, needsAlpha, serializeGridJson } from './gridJson';

const PALETTE = makePalette('test', [RED, WHITE, BLUE]);

/** 造网格：indices 循环取模，alpha 默认全不透明 */
function makeGrid(w: number, h: number, alphas?: number[]): PixelGrid {
  const grid = createGrid(w, h);
  for (let i = 0; i < grid.indices.length; i += 1) {
    grid.indices[i] = i % 3;
    grid.alpha[i] = alphas ? (alphas[i] ?? 255) : 255;
  }
  return grid;
}

describe('needsAlpha', () => {
  it('全不透明且没强制要求时为 false', () => {
    expect(needsAlpha(makeGrid(4, 4), false)).toBe(false);
  });

  it('有一格不是 255 就必须写 —— 丢了等于丢掉半透明边缘', () => {
    const grid = makeGrid(2, 2, [255, 255, 255, 128]);
    expect(needsAlpha(grid, false)).toBe(true);
  });

  it('全透明（alpha 0）也算需要', () => {
    expect(needsAlpha(makeGrid(1, 1, [0]), false)).toBe(true);
  });

  it('强制开关为真时始终写', () => {
    expect(needsAlpha(makeGrid(4, 4), true)).toBe(true);
  });
});

describe('buildGridJson', () => {
  it('结构包含 w / h / palette / indices', () => {
    const json = buildGridJson(makeGrid(3, 2), PALETTE, 'hero.png', {
      alwaysAlpha: false,
      includePalette: true,
    });
    expect(json.w).toBe(3);
    expect(json.h).toBe(2);
    expect(json.name).toBe('hero.png');
    expect(json.indices).toEqual([0, 1, 2, 0, 1, 2]);
    expect(json.palette?.colors).toEqual(['#ff0000', '#ffffff', '#0000ff']);
    expect(json.palette?.id).toBe('test');
  });

  it('全不透明时省略 alpha 字段', () => {
    const json = buildGridJson(makeGrid(2, 2), PALETTE, 'a', { alwaysAlpha: false, includePalette: true });
    expect(json.alpha).toBeUndefined();
    expect('alpha' in json).toBe(false);
  });

  it('有半透明像素时带上 alpha', () => {
    const json = buildGridJson(makeGrid(2, 2, [255, 255, 255, 64]), PALETTE, 'a', {
      alwaysAlpha: false,
      includePalette: true,
    });
    expect(json.alpha).toEqual([255, 255, 255, 64]);
  });

  it('关掉调色板时 palette 为 null，但 indices 仍在', () => {
    const json = buildGridJson(makeGrid(2, 2), PALETTE, 'a', { alwaysAlpha: false, includePalette: false });
    expect(json.palette).toBeNull();
    expect(json.indices).toHaveLength(4);
  });

  it('indices 是普通数组而不是 TypedArray —— 否则 JSON.stringify 会变成对象', () => {
    const json = buildGridJson(makeGrid(2, 2), PALETTE, 'a', { alwaysAlpha: false, includePalette: true });
    expect(Array.isArray(json.indices)).toBe(true);
  });
});

describe('serializeGridJson', () => {
  it('缩进两格并以换行结尾', () => {
    const json = buildGridJson(makeGrid(1, 1), PALETTE, 'a', { alwaysAlpha: false, includePalette: true });
    const text = serializeGridJson(json);
    expect(text.endsWith('\n')).toBe(true);
    expect(text).toContain('\n  "w": 1');
  });

  it('能被 JSON.parse 原样读回', () => {
    const json = buildGridJson(makeGrid(3, 3, [255, 0, 255, 255, 255, 255, 255, 255, 255]), PALETTE, 'hero', {
      alwaysAlpha: true,
      includePalette: true,
    });
    const back = JSON.parse(serializeGridJson(json)) as typeof json;
    expect(back.indices).toEqual(json.indices);
    expect(back.alpha).toEqual(json.alpha);
  });
});