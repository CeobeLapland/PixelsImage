import { describe, expect, it } from 'vitest';

import { PALETTE_MAX_COLORS } from '@/core/types';
import type { RGBA } from '@/core/types';
import {
  parseGpl,
  parseHexPalette,
  parseJascPal,
  parsePaletteText,
  serializeGplPalette,
  serializeHexPalette,
  serializeJascPalette,
} from './parse';

/** 往返测试共用的一组颜色，覆盖边界值 0 / 255 与中间值 */
const SAMPLE: RGBA[] = [
  [0, 0, 0, 255],
  [255, 255, 255, 255],
  [176, 46, 38, 255],
  [22, 156, 156, 255],
];

describe('parseHexPalette / .hex', () => {
  it('逐行解析 RRGGBB，补 alpha 255', () => {
    expect(parseHexPalette('FF0000\n00FF00\n0000FF')).toEqual([
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ]);
  });

  it('支持 # 前缀，且 3 位会展开成 6 位', () => {
    expect(parseHexPalette('#abc\n#F9FFFE')).toEqual([
      [170, 187, 204, 255],
      [249, 255, 254, 255],
    ]);
  });

  it('以 # 开头但本身是合法颜色时不能被当成注释丢掉', () => {
    // 这是 .hex 最容易踩的坑：#F9FFFE 既像注释又是颜色
    expect(parseHexPalette('#F9FFFE')).toEqual([[249, 255, 254, 255]]);
  });

  it('跳过纯注释行（#、;、// 形式）', () => {
    const text = '# this is a comment\n; another\n// yet another\nFF0000';
    expect(parseHexPalette(text)).toEqual([[255, 0, 0, 255]]);
  });

  it('token 后面的行内注释被忽略', () => {
    expect(parseHexPalette('FF0000 red primary')).toEqual([[255, 0, 0, 255]]);
  });

  it('跳过空行与非法 token，保留其余颜色', () => {
    const text = 'FF0000\n\nbogus\n12345\n00FF00\n#ff\nzzzzzz\n0000FF';
    expect(parseHexPalette(text)).toEqual([
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ]);
  });

  it('同时处理 CRLF 与 LF', () => {
    expect(parseHexPalette('FF0000\r\n00FF00\n0000FF\r\n')).toEqual([
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ]);
  });

  it('空文本返回 null', () => {
    expect(parseHexPalette('')).toBeNull();
  });

  it('纯垃圾文本返回 null', () => {
    expect(parseHexPalette('hello world\nnot a color\n#### \n12')).toBeNull();
  });

  it('超过 256 色时截断', () => {
    const lines: string[] = [];
    for (let i = 0; i < 300; i += 1) lines.push(i.toString(16).padStart(6, '0'));
    const parsed = parseHexPalette(lines.join('\n'));
    expect(parsed).not.toBeNull();
    expect(parsed?.length).toBe(PALETTE_MAX_COLORS);
  });
});

describe('parseGpl / GIMP Palette', () => {
  it('正常解析，忽略 Name / Columns / 注释行', () => {
    const text = [
      'GIMP Palette',
      'Name: My Palette',
      'Columns: 8',
      '# a comment',
      '255   0   0\tRed',
      '  0 255   0\tGreen',
      '0 0 255',
    ].join('\n');
    expect(parseGpl(text)).toEqual([
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ]);
  });

  it('容忍前导空行与大小写差异', () => {
    expect(parseGpl('\n\ngimp palette\n10 20 30')).toEqual([[10, 20, 30, 255]]);
  });

  it('缺头部返回 null', () => {
    expect(parseGpl('Name: X\n255 0 0')).toBeNull();
  });

  it('有头部但没有数据行返回 null', () => {
    expect(parseGpl('GIMP Palette\nName: X\nColumns: 8')).toBeNull();
  });

  it('空文本返回 null', () => {
    expect(parseGpl('')).toBeNull();
  });

  it('纯垃圾文本返回 null', () => {
    expect(parseGpl('lorem ipsum\ndolor sit amet')).toBeNull();
  });

  it('数据行不是 R G B 形态时返回 null，而不是静默跳过', () => {
    expect(parseGpl('GIMP Palette\n255 0 0\nhello world')).toBeNull();
  });

  it('超过 256 色时截断', () => {
    const colors: RGBA[] = Array.from({ length: 300 }, (_, i) => [i % 256, i % 256, i % 256, 255]);
    const parsed = parseGpl(serializeGplPalette(colors, '大板'));
    expect(parsed).not.toBeNull();
    expect(parsed?.length).toBe(PALETTE_MAX_COLORS);
  });
});

describe('parseJascPal / JASC-PAL', () => {
  it('正常解析', () => {
    const text = 'JASC-PAL\n0100\n3\n255 0 0\n0 255 0\n0 0 255';
    expect(parseJascPal(text)).toEqual([
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
    ]);
  });

  it('声明数量多于实际行数时以实际为准', () => {
    const text = 'JASC-PAL\n0100\n5\n10 20 30\n40 50 60';
    expect(parseJascPal(text)).toEqual([
      [10, 20, 30, 255],
      [40, 50, 60, 255],
    ]);
  });

  it('声明数量少于实际行数时也以实际为准', () => {
    const text = 'JASC-PAL\n0100\n1\n10 20 30\n40 50 60\n70 80 90';
    expect(parseJascPal(text)?.length).toBe(3);
  });

  it('缺头部或版本行返回 null', () => {
    expect(parseJascPal('0100\n2\n1 2 3')).toBeNull();
    expect(parseJascPal('JASC-PAL\n0001\n2\n1 2 3')).toBeNull();
  });

  it('没有数据行返回 null', () => {
    expect(parseJascPal('JASC-PAL\n0100\n0')).toBeNull();
  });

  it('空文本返回 null', () => {
    expect(parseJascPal('')).toBeNull();
  });

  it('纯垃圾文本返回 null', () => {
    expect(parseJascPal('nothing\nhere\nto see')).toBeNull();
  });
});

describe('序列化与往返一致', () => {
  it('serializeHexPalette → parseHexPalette 往返一致', () => {
    const text = serializeHexPalette(SAMPLE, '测试板');
    expect(text.startsWith('# 测试板\n')).toBe(true);
    expect(parseHexPalette(text)).toEqual(SAMPLE);
  });

  it('serializeHexPalette 不带 name 时不产生额外行', () => {
    const text = serializeHexPalette(SAMPLE);
    expect(text).toBe('000000\nFFFFFF\nB02E26\n169C9C\n');
  });

  it('serializeGplPalette → parseGpl 往返一致', () => {
    const text = serializeGplPalette(SAMPLE, '测试板');
    expect(text.startsWith('GIMP Palette\nName: 测试板\nColumns: 8\n#\n')).toBe(true);
    expect(parseGpl(text)).toEqual(SAMPLE);
  });

  it('serializeJascPalette → parseJascPal 往返一致', () => {
    const text = serializeJascPalette(SAMPLE);
    expect(text.startsWith('JASC-PAL\n0100\n4\n')).toBe(true);
    expect(parseJascPal(text)).toEqual(SAMPLE);
  });
});

describe('parsePaletteText / 后缀分派与兜底', () => {
  const hexText = 'FF0000\n00FF00';
  const gplText = 'GIMP Palette\nName: X\n1 2 3';
  const jascText = 'JASC-PAL\n0100\n1\n4 5 6';

  it('按后缀选择解析器', () => {
    expect(parsePaletteText(hexText, 'a.hex')).toEqual([[255, 0, 0, 255], [0, 255, 0, 255]]);
    expect(parsePaletteText(gplText, 'a.gpl')).toEqual([[1, 2, 3, 255]]);
    expect(parsePaletteText(jascText, 'a.pal')).toEqual([[4, 5, 6, 255]]);
  });

  it('.txt 也走 hex 解析器', () => {
    expect(parsePaletteText(hexText, 'a.txt')).toEqual([[255, 0, 0, 255], [0, 255, 0, 255]]);
  });

  it('后缀大小写不敏感', () => {
    expect(parsePaletteText(gplText, 'A.GPL')).toEqual([[1, 2, 3, 255]]);
  });

  it('没有文件名时依次尝试 gpl → jasc → hex', () => {
    expect(parsePaletteText(gplText)).toEqual([[1, 2, 3, 255]]);
    expect(parsePaletteText(jascText)).toEqual([[4, 5, 6, 255]]);
    expect(parsePaletteText(hexText)).toEqual([[255, 0, 0, 255], [0, 255, 0, 255]]);
  });

  it('未知后缀时走兜底尝试', () => {
    expect(parsePaletteText(gplText, 'a.foo')).toEqual([[1, 2, 3, 255]]);
    expect(parsePaletteText(hexText, 'a.foo')).toEqual([[255, 0, 0, 255], [0, 255, 0, 255]]);
    expect(parsePaletteText(hexText, 'noext')).toEqual([[255, 0, 0, 255], [0, 255, 0, 255]]);
  });

  it('完全无法识别的文本返回 null', () => {
    expect(parsePaletteText('totally not a palette', 'a.xyz')).toBeNull();
  });
});