import { describe, expect, it } from 'vitest';

import { CLEAR, GREEN, RED, WHITE, makeImage, pixelAt } from '@/core/__testing__/fixtures';
import { applyDecontaminate, isPreprocessIdentity, preprocess } from './preprocess';
import { DEFAULT_PREPROCESS, type PreprocessSettings } from './types';

function settings(patch: Partial<PreprocessSettings> = {}): PreprocessSettings {
  return { ...DEFAULT_PREPROCESS, ...patch };
}

describe('isPreprocessIdentity', () => {
  it('默认设置视为全中性（可以整体跳过）', () => {
    expect(isPreprocessIdentity(settings())).toBe(true);
  });

  it('任何一项被改动就不再是中性', () => {
    expect(isPreprocessIdentity(settings({ brightness: 1 }))).toBe(false);
    expect(isPreprocessIdentity(settings({ alphaThreshold: 128 }))).toBe(false);
    expect(isPreprocessIdentity(settings({ decontaminate: true }))).toBe(false);
  });
});

describe('applyDecontaminate（边缘色晕清理）', () => {
  /** 3×1：不透明红 | 半透明绿（背景残留） | 全透明 */
  function haloRow(): Uint8ClampedArray {
    const image = makeImage(3, 1, [RED, [0, 255, 0, 128], CLEAR]);
    return new Uint8ClampedArray(image.data);
  }

  it('半透明边缘的 RGB 被换成相邻主体色，alpha 保持不变', () => {
    const data = haloRow();
    const changed = applyDecontaminate(data, 3, 1);

    expect(changed).toBe(1);
    // 中间那格原本是「半透明的绿」——绿就是背景残留，应该被染成红
    expect([data[4], data[5], data[6], data[7]]).toEqual([255, 0, 0, 128]);
  });

  it('全透明像素一个都不碰（它的 RGB 本来就不参与渲染）', () => {
    const data = haloRow();
    applyDecontaminate(data, 3, 1);
    expect([data[8], data[9], data[10], data[11]]).toEqual([0, 0, 0, 0]);
  });

  it('不外扩到指定圈数之外', () => {
    // 1×5：不透明红 + 四格半透明绿。rings=1 时只有紧邻的那一格被处理
    const image = makeImage(5, 1, [
      RED,
      [0, 255, 0, 128],
      [0, 255, 0, 128],
      [0, 255, 0, 128],
      [0, 255, 0, 128],
    ]);
    const data = new Uint8ClampedArray(image.data);

    expect(applyDecontaminate(data, 5, 1, 1)).toBe(1);
    expect(pixelAt({ width: 5, height: 1, data }, 1, 0)).toEqual([255, 0, 0, 128]);
    expect(pixelAt({ width: 5, height: 1, data }, 2, 0)).toEqual([0, 255, 0, 128]);
  });

  it('多圈时沿着半透明区域把颜色推出去', () => {
    const image = makeImage(4, 1, [
      RED,
      [0, 255, 0, 128],
      [0, 255, 0, 128],
      [0, 255, 0, 128],
    ]);
    const data = new Uint8ClampedArray(image.data);

    expect(applyDecontaminate(data, 4, 1, 3)).toBe(3);
    for (const x of [1, 2, 3]) {
      expect(pixelAt({ width: 4, height: 1, data }, x, 0)).toEqual([255, 0, 0, 128]);
    }
  });

  it('没有半透明像素时什么都不做', () => {
    const image = makeImage(2, 1, [RED, WHITE]);
    const data = new Uint8ClampedArray(image.data);
    expect(applyDecontaminate(data, 2, 1)).toBe(0);
  });

  it('零尺寸不崩', () => {
    expect(applyDecontaminate(new Uint8ClampedArray(0), 0, 0)).toBe(0);
  });

  it('紧贴边缘的像素也能找到主体色（不越界）', () => {
    // 2×2：左上不透明红，其余半透明绿
    const image = makeImage(2, 2, [RED, [0, 255, 0, 100], [0, 255, 0, 100], [0, 255, 0, 100]]);
    const data = new Uint8ClampedArray(image.data);
    expect(applyDecontaminate(data, 2, 2, 3)).toBe(3);
    expect(pixelAt({ width: 2, height: 2, data }, 1, 1)).toEqual([255, 0, 0, 100]);
  });
});

describe('preprocess 管线里的接线', () => {
  it('全中性设置时原样返回输入缓冲（不复制）', () => {
    const image = makeImage(1, 1, [GREEN]);
    const out = preprocess(image, settings());
    expect(out.data).toBe(image.data);
  });

  it('alpha 阈值先把背景判掉，色晕清理再擦掉边缘残留', () => {
    // 不透明红 | 半透明绿 α200（主体边缘，保住） | α60 与 α100（判为背景）
    const image = makeImage(4, 1, [RED, [0, 255, 0, 200], [0, 255, 0, 60], [0, 255, 0, 100]]);
    const out = preprocess(image, settings({ alphaThreshold: 128, decontaminate: true }));

    // α < 128 的两格被置为全透明
    expect(out.data[11]).toBe(0); // 第 2 格（α=60）
    expect(out.data[15]).toBe(0); // 第 3 格（α=100）
    // 保住的半透明格，RGB 已被换成相邻主体色（红），不再是背景的绿
    expect([out.data[4], out.data[5], out.data[6], out.data[7]]).toEqual([255, 0, 0, 200]);
  });

  it('关了开关就不做清理（对照）', () => {
    const image = makeImage(2, 1, [RED, [0, 255, 0, 200]]);
    const out = preprocess(image, settings({ alphaThreshold: 128 }));
    expect(pixelAt(out, 1, 0)).toEqual([0, 255, 0, 200]);
  });
});