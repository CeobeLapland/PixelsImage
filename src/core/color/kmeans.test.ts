import { describe, expect, it } from 'vitest';

import { kmeansPalette, strideSamples, uniqueSamples, type RgbSamples } from './kmeans';

/** 由 RGB 三元组数组构造样本 */
function samples(colors: readonly (readonly [number, number, number])[]): RgbSamples {
  const data = new Uint8Array(colors.length * 3);
  colors.forEach((c, i) => {
    data[i * 3] = c[0];
    data[i * 3 + 1] = c[1];
    data[i * 3 + 2] = c[2];
  });
  return { data, count: colors.length };
}

const RED = [255, 0, 0] as const;
const GREEN = [0, 255, 0] as const;
const BLUE = [0, 0, 255] as const;
const BLACK = [0, 0, 0] as const;
const WHITE = [255, 255, 255] as const;

describe('uniqueSamples / strideSamples', () => {
  it('去掉完全重复的颜色，保持首次出现顺序', () => {
    const out = uniqueSamples(samples([RED, GREEN, RED, BLUE, GREEN]));
    expect(out.count).toBe(3);
    expect(Array.from(out.data)).toEqual([255, 0, 0, 0, 255, 0, 0, 0, 255]);
  });

  it('抽稀后样本数不超过上限', () => {
    const many = samples(Array.from({ length: 100 }, (_, i) => [i, i, i] as const));
    const out = strideSamples(many, 10);
    expect(out.count).toBeLessThanOrEqual(10);
    expect(out.data.length).toBe(out.count * 3);
  });

  it('样本数不超上限时原样返回（不拷贝）', () => {
    const input = samples([RED, GREEN]);
    expect(strideSamples(input, 10)).toBe(input);
  });
});

describe('kmeansPalette', () => {
  it('三簇分离良好的颜色会被完整还原', () => {
    const input = samples([RED, RED, RED, GREEN, GREEN, GREEN, BLUE, BLUE, BLUE]);
    const out = kmeansPalette(input, 3);
    expect(out).toHaveLength(3);
    const keys = out.map((c) => `${c[0]},${c[1]},${c[2]}`);
    expect(new Set(keys)).toEqual(new Set(['255,0,0', '0,255,0', '0,0,255']));
  });

  it('同一输入两次结果完全一致（确定性）', () => {
    // 抖动与手改都依赖这一点：调色板每帧都在变的话，用户会以为工具坏了
    const input = samples([
      [10, 20, 30],
      [40, 50, 60],
      [200, 210, 220],
      [190, 200, 210],
      [120, 30, 200],
      [130, 20, 190],
    ]);
    const a = kmeansPalette(input, 3);
    const b = kmeansPalette(input, 3);
    expect(a).toEqual(b);
  });

  it('不同颜色少于 k 时只返回实际存在的颜色（不补重复色）', () => {
    const out = kmeansPalette(samples([RED, GREEN]), 8);
    expect(out).toHaveLength(2);
  });

  it('全透明图（无样本）返回空数组', () => {
    expect(kmeansPalette({ data: new Uint8Array(0), count: 0 }, 8)).toEqual([]);
  });

  it('k 被钳在 1-256', () => {
    expect(kmeansPalette(samples([RED]), 0)).toHaveLength(1);
    const many = samples(Array.from({ length: 300 }, (_, i) => [i % 256, (i * 7) % 256, (i * 13) % 256] as const));
    expect(kmeansPalette(many, 999).length).toBeLessThanOrEqual(256);
  });

  it('返回的颜色都是合法的 0-255 整数且不透明', () => {
    const input = samples([BLACK, WHITE, [12, 200, 90], [200, 12, 90]]);
    for (const c of kmeansPalette(input, 4)) {
      expect(c).toHaveLength(4);
      for (const v of c) {
        expect(Number.isInteger(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(255);
      }
      expect(c[3]).toBe(255);
    }
  });

  it('主色排在前面（按占样数降序）', () => {
    // 大量红 + 少量绿：红的簇应排在第一个
    const input = samples([...Array.from({ length: 20 }, () => RED), GREEN]);
    const out = kmeansPalette(input, 2);
    expect(out[0]?.[0]).toBe(255);
    expect(out[0]?.[1]).toBe(0);
  });

  it('迭代不改变簇的数量，也不会产出 NaN', () => {
    const input = samples([BLACK, WHITE, BLACK, WHITE, BLACK]);
    for (const c of kmeansPalette(input, 2, { iterations: 12 })) {
      expect(Number.isFinite(c[0] + c[1] + c[2])).toBe(true);
    }
  });
});