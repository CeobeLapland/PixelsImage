import { describe, expect, it } from 'vitest';

import { MC_DYE_PALETTE, MC_CONCRETE_PALETTE } from '@/palettes/builtin';
import {
  colorKey,
  findBlock,
  MC_BLOCKS,
  resolveBlock,
  sanitizeBlockMap,
  suggestBlockMap,
} from './blocks';

describe('方块表本身', () => {
  it('id 唯一、hex 合法', () => {
    const ids = MC_BLOCKS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const block of MC_BLOCKS) {
      expect(block.hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(block.name.length).toBeGreaterThan(0);
    }
  });

  it('id 形如小写下划线，能直接写进 CSV', () => {
    for (const block of MC_BLOCKS) {
      expect(block.id).toMatch(/^[a-z0-9_]+$/);
    }
  });
});

describe('colorKey', () => {
  it('输出不带 # 的大写 6 位 hex', () => {
    expect(colorKey([249, 255, 254, 255])).toBe('F9FFFE');
    expect(colorKey([0, 0, 0, 255])).toBe('000000');
  });
});

describe('suggestBlockMap', () => {
  it('MC 染料板精确命中羊毛 —— 色值就是羊毛色值，不该被映射到别的方块', () => {
    const map = suggestBlockMap(MC_DYE_PALETTE.colors);
    expect(map[colorKey(MC_DYE_PALETTE.colors[0])]).toBe('white_wool');
    expect(map[colorKey(MC_DYE_PALETTE.colors[3])]).toBe('black_wool');
    expect(map[colorKey(MC_DYE_PALETTE.colors[15])]).toBe('pink_wool');
    expect(Object.keys(map)).toHaveLength(MC_DYE_PALETTE.colors.length);
  });

  it('MC 混凝土板精确命中混凝土', () => {
    const map = suggestBlockMap(MC_CONCRETE_PALETTE.colors);
    expect(map[colorKey(MC_CONCRETE_PALETTE.colors[0])]).toBe('white_concrete');
    expect(map[colorKey(MC_CONCRETE_PALETTE.colors[5])]).toBe('red_concrete');
  });

  it('任意颜色都能拿到一个方块（不会留空）', () => {
    const map = suggestBlockMap([
      [12, 200, 90, 255],
      [200, 12, 90, 255],
    ]);
    expect(Object.values(map).every((id) => findBlock(id) !== undefined)).toBe(true);
  });

  it('同一个颜色只出现一次', () => {
    const white: [number, number, number, number] = [249, 255, 254, 255];
    const map = suggestBlockMap([white, white, white]);
    expect(Object.keys(map)).toHaveLength(1);
  });
});

describe('resolveBlock', () => {
  const white: [number, number, number, number] = [249, 255, 254, 255];

  it('用户改过的映射优先于建议值', () => {
    const block = resolveBlock(white, { F9FFFE: 'snow_block' }, { F9FFFE: 'white_wool' });
    expect(block?.id).toBe('snow_block');
  });

  it('用户没改过时用建议值', () => {
    const block = resolveBlock(white, {}, { F9FFFE: 'white_wool' });
    expect(block?.id).toBe('white_wool');
  });

  it('两边都没有时返回 undefined —— 由调用方决定写空还是提示', () => {
    expect(resolveBlock(white, {}, {})).toBeUndefined();
  });

  it('用户映射里是已下线的方块 id 时退回建议值', () => {
    const block = resolveBlock(white, { F9FFFE: 'not_a_block' }, { F9FFFE: 'white_wool' });
    expect(block?.id).toBe('white_wool');
  });
});

describe('sanitizeBlockMap', () => {
  it('丢掉键不是 6 位 hex 的条目', () => {
    expect(sanitizeBlockMap({ 'F9FFFE': 'white_wool', '#F9FFFE': 'white_wool', abc: 'stone' })).toEqual({
      F9FFFE: 'white_wool',
    });
  });

  it('丢掉值不是已知方块的条目', () => {
    expect(sanitizeBlockMap({ F9FFFE: 'white_wool', 111111: 'made_up_block' })).toEqual({
      F9FFFE: 'white_wool',
    });
  });

  it('非对象一律回退成空表', () => {
    expect(sanitizeBlockMap(null)).toEqual({});
    expect(sanitizeBlockMap('nope')).toEqual({});
    expect(sanitizeBlockMap([1, 2])).toEqual({});
  });

  it('小写 hex 被拒 —— 键必须统一成大写，否则同色会有两条记录', () => {
    expect(sanitizeBlockMap({ f9fffe: 'white_wool' })).toEqual({});
  });
});
