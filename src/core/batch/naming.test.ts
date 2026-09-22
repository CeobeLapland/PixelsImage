import { describe, expect, it } from 'vitest';

import {
  applyNameTemplate,
  baseNameOf,
  buildBatchNames,
  DEFAULT_NAME_TEMPLATE,
  dedupeFileNames,
  sanitizeFileName,
  unknownTokens,
} from './naming';

const ctx = (over: Partial<Parameters<typeof applyNameTemplate>[1]> = {}) => ({
  name: 'hero.jpg',
  w: 32,
  h: 24,
  scale: 1,
  index: 1,
  ...over,
});

describe('baseNameOf', () => {
  it('去掉扩展名', () => {
    expect(baseNameOf('hero.jpg')).toBe('hero');
    expect(baseNameOf('a.b.c.png')).toBe('a.b.c');
  });

  it('没有扩展名时原样返回', () => {
    expect(baseNameOf('hero')).toBe('hero');
  });

  it('以点开头的隐藏文件整体当名字，不切成空串', () => {
    expect(baseNameOf('.gitignore')).toBe('.gitignore');
  });
});

describe('applyNameTemplate', () => {
  it('默认模板产出 名字_宽x高.png', () => {
    expect(applyNameTemplate(DEFAULT_NAME_TEMPLATE, ctx())).toBe('hero_32x24.png');
  });

  it('支持 index 与 scale', () => {
    expect(applyNameTemplate('{index}_{name}@{scale}x.png', ctx({ index: 7, scale: 4 }))).toBe(
      '7_hero@4x.png',
    );
  });

  it('模板没写后缀时自动补 .png', () => {
    expect(applyNameTemplate('{name}', ctx())).toBe('hero.png');
  });

  it('已经是 .PNG 时不再重复追加', () => {
    expect(applyNameTemplate('{name}.PNG', ctx())).toBe('hero.PNG');
  });

  it('未知占位符原样保留，让人一眼看见自己写错了', () => {
    expect(applyNameTemplate('{name}_{date}.png', ctx())).toBe('hero_{date}.png');
  });

  it('清掉非法字符', () => {
    expect(applyNameTemplate('{name}.png', ctx({ name: 'a/b:c*d?e"f<g>h|i.jpg' }))).toBe(
      'a_b_c_d_e_f_g_h_i.png',
    );
  });

  it('模板清空后回退到源文件名', () => {
    expect(applyNameTemplate('   ', ctx())).toBe('hero.png');
  });
});

describe('sanitizeFileName', () => {
  it('全是非法字符时给兜底名', () => {
    expect(sanitizeFileName('///')).toBe('___');
    expect(sanitizeFileName('   ')).toBe('pixels');
  });
});

describe('unknownTokens', () => {
  it('列出模板里不认识的占位符且去重', () => {
    expect(unknownTokens('{name}_{date}_{date}_{zzz}.png')).toEqual(['date', 'zzz']);
  });

  it('全认识时返回空数组', () => {
    expect(unknownTokens('{name}_{w}x{h}@{scale}_{index}.png')).toEqual([]);
  });
});

describe('dedupeFileNames', () => {
  it('没有冲突时原样返回', () => {
    expect(dedupeFileNames(['a.png', 'b.png'])).toEqual(['a.png', 'b.png']);
  });

  it('冲突时在扩展名前插序号', () => {
    expect(dedupeFileNames(['a.png', 'a.png', 'a.png'])).toEqual(['a.png', 'a_2.png', 'a_3.png']);
  });

  it('忽略大小写 —— Windows / macOS 上 A.png 与 a.png 会互相覆盖', () => {
    expect(dedupeFileNames(['Hero.png', 'hero.png'])).toEqual(['Hero.png', 'hero_2.png']);
  });

  it('序号本身撞车时继续往后找', () => {
    expect(dedupeFileNames(['a.png', 'a_2.png', 'a.png'])).toEqual([
      'a.png',
      'a_2.png',
      'a_3.png',
    ]);
  });

  it('没有扩展名时序号直接接在末尾', () => {
    expect(dedupeFileNames(['a', 'a'])).toEqual(['a', 'a_2']);
  });

  it('保留顺序', () => {
    expect(dedupeFileNames(['b.png', 'a.png', 'b.png'])).toEqual(['b.png', 'a.png', 'b_2.png']);
  });
});

describe('buildBatchNames', () => {
  it('序号从 1 开始，且与入参一一对应', () => {
    const names = buildBatchNames(
      '{index}_{name}.png',
      [
        { name: 'b.png', w: 8, h: 8 },
        { name: 'a.png', w: 8, h: 8 },
      ],
      2,
    );
    expect(names).toEqual(['1_b.png', '2_a.png']);
  });

  it('同尺寸同名的两张图不会互相覆盖', () => {
    const names = buildBatchNames(
      DEFAULT_NAME_TEMPLATE,
      [
        { name: 'hero.png', w: 32, h: 32 },
        { name: 'hero.jpg', w: 32, h: 32 },
      ],
      1,
    );
    expect(names).toEqual(['hero_32x32.png', 'hero_32x32_2.png']);
  });

  it('裁剪后尺寸不同则天然不冲突', () => {
    const names = buildBatchNames(
      DEFAULT_NAME_TEMPLATE,
      [
        { name: 'hero.png', w: 32, h: 32 },
        { name: 'hero.png', w: 30, h: 32 },
      ],
      1,
    );
    expect(names).toEqual(['hero_32x32.png', 'hero_30x32.png']);
  });
});
