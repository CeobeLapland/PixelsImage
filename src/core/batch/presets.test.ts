import { describe, expect, it } from 'vitest';

import { makeDefaultSettings } from '@/core/types';
import { DEFAULT_NAME_TEMPLATE } from './naming';
import { coercePresets, parsePresets, serializePresets, uniquePresetName, type BatchPreset } from './presets';

const preset = (over: Partial<BatchPreset> = {}): BatchPreset => ({
  id: 'p1',
  name: '素材批量',
  template: '{name}_{w}x{h}.png',
  scale: 2,
  opaque: false,
  settings: makeDefaultSettings(),
  savedAt: 1700000000000,
  ...over,
});

describe('uniquePresetName', () => {
  it('不冲突时原样返回', () => {
    expect(uniquePresetName('a', ['b'])).toBe('a');
  });

  it('冲突时加序号', () => {
    expect(uniquePresetName('a', ['a', 'a (2)'])).toBe('a (3)');
  });
});

describe('serializePresets / parsePresets', () => {
  it('完整的预设能往返', () => {
    const list = [preset()];
    const back = parsePresets(serializePresets(list));
    expect(back).toHaveLength(1);
    expect(back[0].name).toBe('素材批量');
    expect(back[0].scale).toBe(2);
    expect(back[0].settings.targetW).toBe(list[0].settings.targetW);
  });

  it('坏 JSON 回退成空列表，不抛异常', () => {
    expect(parsePresets('{ не json')).toEqual([]);
    expect(parsePresets('')).toEqual([]);
    expect(parsePresets('[]')).toEqual([]);
  });
});

describe('coercePresets', () => {
  it('非数组一律回退成空列表', () => {
    expect(coercePresets(null)).toEqual([]);
    expect(coercePresets({ presets: [] })).toEqual([]);
    expect(coercePresets('nope')).toEqual([]);
  });

  it('缺 id 或名字的条目被丢掉', () => {
    expect(coercePresets([{ name: 'x' }, { id: 'y' }, { id: 'z', name: '  ' }])).toEqual([]);
  });

  it('id 重复时只保留第一条', () => {
    const back = coercePresets([preset(), preset({ name: '另一份' })]);
    expect(back).toHaveLength(1);
    expect(back[0].name).toBe('素材批量');
  });

  it('倍数越界或非数字时钳到 1-64', () => {
    expect(coercePresets([preset({ scale: 999 })])[0].scale).toBe(64);
    expect(coercePresets([preset({ scale: 0 })])[0].scale).toBe(1);
    expect(coercePresets([{ ...preset(), scale: 'x' as never }])[0].scale).toBe(1);
  });

  it('模板为空时回退到默认模板', () => {
    expect(coercePresets([preset({ template: '   ' })])[0].template).toBe(DEFAULT_NAME_TEMPLATE);
  });

  it('settings 损坏时回退到默认设置 —— 坏数据绝不能流进转换流程', () => {
    const back = coercePresets([{ ...preset(), settings: 'oops' }]);
    expect(back).toHaveLength(1);
    expect(back[0].settings.preprocess.alphaThreshold).toBe(
      makeDefaultSettings().preprocess.alphaThreshold,
    );
  });

  it('settings.preprocess 只有部分字段时补齐其余项', () => {
    const back = coercePresets([
      { ...preset(), settings: { ...makeDefaultSettings(), preprocess: { brightness: 30 } } },
    ]);
    expect(back[0].settings.preprocess.brightness).toBe(30);
    expect(back[0].settings.preprocess.contrast).toBe(0);
  });

  it('opaque 只认 true', () => {
    expect(coercePresets([{ ...preset(), opaque: 1 }])[0].opaque).toBe(false);
    expect(coercePresets([preset({ opaque: true })])[0].opaque).toBe(true);
  });
});