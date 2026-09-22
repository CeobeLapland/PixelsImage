import { describe, expect, it } from 'vitest';

import {
  boolOf,
  DEFAULT_EXPORTER_ID,
  defaultOptionValues,
  EXPORTERS,
  getExporter,
  mergeOptionValues,
  numOf,
  paletteHexText,
  stemOf,
  strOf,
} from './registry';
import { makePalette, BLUE, RED, WHITE } from '@/core/__testing__/fixtures';

describe('注册表本身', () => {
  it('id 唯一', () => {
    const ids = EXPORTERS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('每个导出器都有标签、说明、至少一个选项', () => {
    for (const exporter of EXPORTERS) {
      expect(exporter.label.length).toBeGreaterThan(0);
      expect(exporter.description.length).toBeGreaterThan(0);
      expect(exporter.options.length).toBeGreaterThan(0);
    }
  });

  it('选项 key 在同一个导出器内不重复', () => {
    for (const exporter of EXPORTERS) {
      const keys = exporter.options.map((o) => o.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('数字选项的默认值落在范围内', () => {
    for (const exporter of EXPORTERS) {
      for (const option of exporter.options) {
        if (option.kind !== 'number') continue;
        expect(option.default).toBeGreaterThanOrEqual(option.min);
        expect(option.default).toBeLessThanOrEqual(option.max);
      }
    }
  });

  it('下拉选项的默认值在候选项里', () => {
    for (const exporter of EXPORTERS) {
      for (const option of exporter.options) {
        if (option.kind !== 'select') continue;
        expect(option.options.some((o) => o.value === option.default)).toBe(true);
      }
    }
  });

  it('默认导出器能在表里找到', () => {
    expect(getExporter(DEFAULT_EXPORTER_ID)).toBeDefined();
  });

  it('未知 id 返回 undefined，不抛错', () => {
    expect(getExporter('nope')).toBeUndefined();
  });

  it('图集导出器声明需要批量队列 —— 面板据此禁用按钮', () => {
    expect(getExporter('spritesheet')?.needs).toBe('batch');
    expect(getExporter('png')?.needs).toBe('grid');
  });
});

describe('defaultOptionValues', () => {
  it('把 schema 里的默认值铺成一份值表', () => {
    const exporter = getExporter('png');
    if (!exporter) throw new Error('缺少 png 导出器');
    expect(defaultOptionValues(exporter)).toEqual({ scale: 1, background: 'transparent' });
  });

  it('每个导出器都能铺出完整的值表', () => {
    for (const exporter of EXPORTERS) {
      const values = defaultOptionValues(exporter);
      expect(Object.keys(values)).toHaveLength(exporter.options.length);
    }
  });
});

describe('mergeOptionValues', () => {
  const exporter = getExporter('png')!;

  it('没有存过时就是默认值', () => {
    expect(mergeOptionValues(exporter, undefined)).toEqual(defaultOptionValues(exporter));
  });

  it('存过的值覆盖默认值', () => {
    expect(mergeOptionValues(exporter, { scale: 8 })).toEqual({ scale: 8, background: 'transparent' });
  });

  it('旧版本存下的多余字段不会漏进结果 —— schema 是唯一事实来源', () => {
    const merged = mergeOptionValues(exporter, { scale: 4, removedOption: 'x' });
    expect(merged).toEqual({ scale: 4, background: 'transparent' });
    expect('removedOption' in merged).toBe(false);
  });
});

describe('选项取值兜底', () => {
  it('类型不对时退回默认值，不把 NaN 传下去', () => {
    expect(numOf({ a: 'x' as never }, 'a', 7)).toBe(7);
    expect(numOf({ a: NaN }, 'a', 7)).toBe(7);
    expect(numOf({}, 'a', 7)).toBe(7);
    expect(numOf({ a: 3 }, 'a', 7)).toBe(3);
  });

  it('布尔与字符串同理', () => {
    expect(boolOf({ a: 1 as never }, 'a', true)).toBe(true);
    expect(boolOf({ a: false }, 'a', true)).toBe(false);
    expect(strOf({ a: 5 as never }, 'a', 'd')).toBe('d');
    expect(strOf({ a: '' }, 'a', 'd')).toBe('');
  });
});

describe('stemOf', () => {
  it('去掉扩展名', () => {
    expect(stemOf('hero.png')).toBe('hero');
    expect(stemOf('a.b.jpg')).toBe('a.b');
  });

  it('清掉路径分隔符等非法字符', () => {
    expect(stemOf('a/b:c.png')).toBe('a_b_c');
  });

  it('空名字给兜底', () => {
    expect(stemOf('')).toBe('pixels');
    expect(stemOf('///')).toBe('___');
  });
});

describe('paletteHexText', () => {
  it('每行一个色值，供复制到剪贴板', () => {
    const palette = makePalette('t', [RED, WHITE, BLUE]);
    expect(paletteHexText(palette)).toBe('#ff0000\n#ffffff\n#0000ff');
  });
});
