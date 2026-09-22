import { describe, expect, it } from 'vitest';

import { BUILTIN_PALETTES, DEFAULT_PALETTE_ID, MC_DYE_PALETTE, getBuiltinPalette, resolvePalette } from './builtin';
import { PALETTE_MAX_COLORS } from '@/core/types';

describe('内置调色板数据', () => {
  it('id 唯一', () => {
    const ids = BUILTIN_PALETTES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每块板都有名字、且颜色数在合理范围', () => {
    for (const p of BUILTIN_PALETTES) {
      expect(p.name.length, p.id).toBeGreaterThan(0);
      expect(p.colors.length, p.id).toBeGreaterThanOrEqual(2);
      expect(p.colors.length, p.id).toBeLessThanOrEqual(PALETTE_MAX_COLORS);
      expect(p.builtin, p.id).toBe(true);
    }
  });

  it('颜色都是合法的 0-255 整数且不透明', () => {
    for (const p of BUILTIN_PALETTES) {
      for (const c of p.colors) {
        for (const v of c) {
          expect(Number.isInteger(v), `${p.id} ${c.join(',')}`).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(255);
        }
        // 这些板的颜色本身不携带透明度（透明是网格的事）
        expect(c[3], p.id).toBe(255);
      }
    }
  });

  it('同一块板里没有完全重复的颜色', () => {
    // 重复色不会报错，只会让「实际用到几种色」虚高、并让抖动浪费一个槽位
    for (const p of BUILTIN_PALETTES) {
      const keys = p.colors.map((c) => `${c[0]},${c[1]},${c[2]}`);
      expect(new Set(keys).size, p.id).toBe(keys.length);
    }
  });

  it('Minecraft 染料板与混凝土板槽位一一对应（16 色，顺序同为官方命名顺序）', () => {
    const concrete = getBuiltinPalette('mc-concrete');
    expect(concrete).toBeDefined();
    expect(concrete?.colors.length).toBe(MC_DYE_PALETTE.colors.length);
  });

  it('DEFAULT_PALETTE_ID 指向真实存在且带 16 色的板', () => {
    const fallback = getBuiltinPalette(DEFAULT_PALETTE_ID);
    expect(fallback).toBeDefined();
    expect(fallback?.colors.length).toBe(16);
  });
});

describe('resolvePalette', () => {
  it('按 id 取内置板', () => {
    expect(resolvePalette('pico8').name).toContain('PICO-8');
  });

  it('自定义板优先于同名内置板', () => {
    const custom = { id: 'pico8', name: '我的板', colors: [[1, 2, 3, 255] as const] };
    const resolved = resolvePalette('pico8', { pico8: { ...custom, colors: custom.colors.map((c) => c) } });
    expect(resolved.name).toBe('我的板');
  });

  it('悬空 id 回退到默认板而不是抛错', () => {
    // 删掉一个正在使用的自定义板时会走到这条路径
    expect(resolvePalette('does-not-exist').id).toBe(DEFAULT_PALETTE_ID);
    expect(resolvePalette('').id).toBe(DEFAULT_PALETTE_ID);
  });
});