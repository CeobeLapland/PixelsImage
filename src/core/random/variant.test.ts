/**
 * 随机灵感器的参数生成测试。
 *
 * 随机的东西也要能被锁住：同一 seed 必须同一套参数，否则「换一批」会变成
 * 不可复现的抽奖，出了问题也没法查。
 */

import { describe, expect, it } from 'vitest';

import { makePalette, BLUE, RED, WHITE } from '@/core/__testing__/fixtures';
import { makeRandomVariant, makeSeeds } from './variant';

const POOL = [
  makePalette('a', [RED, WHITE]),
  makePalette('b', [BLUE, WHITE]),
  makePalette('c', [RED, BLUE]),
];

describe('makeRandomVariant', () => {
  it('同一 seed 得到同一套参数', () => {
    const a = makeRandomVariant(12345, POOL);
    const b = makeRandomVariant(12345, POOL);
    expect(a.settings).toEqual(b.settings);
    expect(a.label).toBe(b.label);
  });

  it('参数落在允许范围内', () => {
    const plan = makeRandomVariant(999, POOL);
    expect([16, 24, 32, 48, 64, 96]).toContain(plan.settings.targetW);
    expect(plan.settings.targetH).toBe('auto');
    expect(['nearest', 'area', 'dominant', 'median']).toContain(plan.settings.sampling);
    expect(['rgb', 'weighted', 'lab']).toContain(plan.settings.distance);
    expect(['none', 'atkinson', 'floyd', 'sierra', 'bayer2', 'bayer4', 'bayer8']).toContain(
      plan.settings.dither,
    );
    expect(plan.settings.ditherStrength).toBeGreaterThanOrEqual(0.5);
    expect(plan.settings.ditherStrength).toBeLessThanOrEqual(1);
    expect(['palette', 'kmeans']).toContain(plan.settings.quantize);
    expect(plan.settings.maxColors).toBeGreaterThanOrEqual(2);
    expect(plan.settings.preprocess.brightness).toBeGreaterThanOrEqual(-10);
    expect(plan.settings.preprocess.brightness).toBeLessThanOrEqual(10);
    // 去背景绝不随机开启
    expect(plan.settings.preprocess.removeBackground).toBe('none');
  });

  it('调色板一定来自传入的池子', () => {
    for (let seed = 0; seed < 20; seed += 1) {
      const plan = makeRandomVariant(seed, POOL);
      if (plan.settings.quantize === 'palette') {
        expect(POOL.map((p) => p.id)).toContain(plan.settings.paletteId);
      }
    }
  });

  it('不同 seed 会给出不同风格（不是一辈子同一个参数）', () => {
    const sizes = new Set<number>();
    const dithers = new Set<string>();
    for (let seed = 0; seed < 30; seed += 1) {
      const plan = makeRandomVariant(seed, POOL);
      sizes.add(plan.settings.targetW);
      dithers.add(plan.settings.dither);
    }
    expect(sizes.size).toBeGreaterThan(1);
    expect(dithers.size).toBeGreaterThan(1);
  });

  it('调色板池为空时不会崩，退回默认板', () => {
    const plan = makeRandomVariant(7, []);
    expect(plan.settings.paletteId.length).toBeGreaterThan(0);
    expect(plan.label.length).toBeGreaterThan(0);
  });
});

describe('makeSeeds', () => {
  it('数量对、可复现', () => {
    expect(makeSeeds(6, 42)).toEqual(makeSeeds(6, 42));
    expect(makeSeeds(6, 42)).toHaveLength(6);
  });

  it('种子之间有差异', () => {
    expect(new Set(makeSeeds(8, 42)).size).toBeGreaterThan(6);
  });
});
