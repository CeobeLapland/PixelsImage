import { describe, expect, it } from 'vitest';

import { paletteToLab, parseHex, rgbToLab, toHex, toHexA } from './space';

describe('parseHex', () => {
  it('解析 6 位十六进制', () => {
    expect(parseHex('#F9FFFE')).toEqual([249, 255, 254, 255]);
  });

  it('解析 3 位缩写', () => {
    expect(parseHex('#fff')).toEqual([255, 255, 255, 255]);
    expect(parseHex('#f00')).toEqual([255, 0, 0, 255]);
  });

  it('解析带 alpha 的 8 位', () => {
    expect(parseHex('#FF000080')).toEqual([255, 0, 0, 128]);
  });

  it('接受不带 # 前缀与前后空白', () => {
    expect(parseHex('00ff00')).toEqual([0, 255, 0, 255]);
    expect(parseHex('  #abcdef  ')).toEqual([171, 205, 239, 255]);
  });

  it('非法输入返回 null，而不是 NaN', () => {
    // 3 位分支曾经漏了字符校验，'zzz' 会返回 [NaN, NaN, NaN, 255]
    expect(parseHex('zzz')).toBeNull();
    expect(parseHex('#gg0000')).toBeNull();
    expect(parseHex('#12345')).toBeNull();
    expect(parseHex('#1234567')).toBeNull();
    expect(parseHex('')).toBeNull();
  });
});

describe('toHex', () => {
  it('补零到 6 位', () => {
    expect(toHex(0, 0, 0)).toBe('#000000');
    expect(toHex(1, 2, 3)).toBe('#010203');
  });

  it('与 parseHex 互为逆运算', () => {
    for (const hex of ['#000000', '#ffffff', '#B02E26', '#3AB3DA']) {
      const parsed = parseHex(hex);
      expect(parsed).not.toBeNull();
      expect(toHex(parsed![0], parsed![1], parsed![2])).toBe(hex.toLowerCase());
    }
  });

  it('toHexA 保留 alpha', () => {
    expect(toHexA(255, 0, 0, 128)).toBe('#ff000080');
  });
});

describe('rgbToLab', () => {
  it('白色 L≈100、a/b≈0', () => {
    const out = new Float32Array(3);
    rgbToLab(255, 255, 255, out);
    expect(out[0]).toBeCloseTo(100, 1);
    expect(out[1]).toBeCloseTo(0, 1);
    expect(out[2]).toBeCloseTo(0, 1);
  });

  it('黑色 L=0', () => {
    const out = new Float32Array(3);
    rgbToLab(0, 0, 0, out);
    expect(out[0]).toBeCloseTo(0, 2);
  });

  it('中灰 L≈53.6（sRGB 的感知非线性）', () => {
    const out = new Float32Array(3);
    rgbToLab(128, 128, 128, out);
    expect(out[0]).toBeGreaterThan(50);
    expect(out[0]).toBeLessThan(58);
  });

  it('纯红的 a 分量为正、纯蓝的 b 分量为负', () => {
    const red = new Float32Array(3);
    const blue = new Float32Array(3);
    rgbToLab(255, 0, 0, red);
    rgbToLab(0, 0, 255, blue);
    expect(red[1]).toBeGreaterThan(50);
    expect(blue[2]).toBeLessThan(-50);
  });

  it('只写 offset 指定的位置，不越界', () => {
    const out = new Float32Array(6);
    rgbToLab(255, 0, 0, out, 3);
    expect(out[0]).toBe(0);
    expect(out[3]).toBeGreaterThan(0);
  });
});

describe('paletteToLab', () => {
  it('展平成 3n 长度，并按 offset 正确落位', () => {
    const lab = paletteToLab([
      [0, 0, 0],
      [255, 255, 255],
    ]);
    expect(lab.length).toBe(6);
    expect(lab[0]).toBeCloseTo(0, 2); // 黑
    expect(lab[3]).toBeCloseTo(100, 1); // 白
  });
});