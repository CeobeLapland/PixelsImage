/**
 * 预处理：在降采样**之前**作用于源图。
 *
 * 顺序是刻意的：
 *   ① 亮度/对比度/饱和度 —— 逐像素的颜色调整
 *   ② 锐化               —— 需要邻域，必须在下采样前做，否则边缘已经糊掉了
 *   ③ alpha 阈值         —— 去背景要放在最后，否则调色时会把背景色也一起算进去
 *
 * 全部返回新缓冲，不改动调用方的源数据（源图要能反复重算）。
 */

import type { PreprocessSettings, RGBAImage } from './types';

type RGBAImageData = { width: number; height: number; data: Uint8ClampedArray };

/** 判断设置是否全为中性值，是则可以整体跳过 */
export function isPreprocessIdentity(p: PreprocessSettings): boolean {
  return (
    p.brightness === 0 &&
    p.contrast === 0 &&
    p.saturation === 0 &&
    p.sharpen === 0 &&
    p.alphaThreshold >= 255
  );
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** 亮度 / 对比度 / 饱和度 */
function applyColorAdjust(
  data: Uint8ClampedArray,
  p: PreprocessSettings,
): void {
  const brightOffset = (p.brightness / 100) * 128;

  // 标准对比度公式，输入范围映射到 -255..255
  const c = (p.contrast / 100) * 255;
  const contrastFactor = (259 * (c + 255)) / (255 * (259 - c));

  const satFactor = 1 + p.saturation / 100;

  const n = data.length;
  for (let o = 0; o < n; o += 4) {
    if (data[o + 3] === 0) continue;

    let r = data[o];
    let g = data[o + 1];
    let b = data[o + 2];

    if (p.brightness !== 0) {
      r += brightOffset;
      g += brightOffset;
      b += brightOffset;
    }

    if (p.contrast !== 0) {
      r = contrastFactor * (r - 128) + 128;
      g = contrastFactor * (g - 128) + 128;
      b = contrastFactor * (b - 128) + 128;
    }

    if (p.saturation !== 0) {
      // Rec.601 亮度权重
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      r = luma + (r - luma) * satFactor;
      g = luma + (g - luma) * satFactor;
      b = luma + (b - luma) * satFactor;
    }

    data[o] = clamp255(Math.round(r));
    data[o + 1] = clamp255(Math.round(g));
    data[o + 2] = clamp255(Math.round(b));
  }
}

/**
 * 3×3 反锐化掩模（unsharp）。
 * 用「原图 + 强度·(原图 − 均值)」实现，比卷积核实现更容易控制强度。
 */
function applySharpen(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  amount: number,
): void {
  const src = new Uint8ClampedArray(data);
  const k = amount / 100;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      if (src[o + 3] === 0) continue;

      let sr = 0;
      let sg = 0;
      let sb = 0;
      let count = 0;

      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const no = (ny * w + nx) * 4;
          if (src[no + 3] === 0) continue;
          sr += src[no];
          sg += src[no + 1];
          sb += src[no + 2];
          count += 1;
        }
      }

      if (count === 0) continue;
      const mr = sr / count;
      const mg = sg / count;
      const mb = sb / count;

      data[o] = clamp255(Math.round(src[o] + k * (src[o] - mr)));
      data[o + 1] = clamp255(Math.round(src[o + 1] + k * (src[o + 1] - mg)));
      data[o + 2] = clamp255(Math.round(src[o + 2] + k * (src[o + 2] - mb)));
    }
  }
}

/** alpha 阈值：低于阈值的 alpha 直接归零（去背景） */
function applyAlphaThreshold(data: Uint8ClampedArray, threshold: number): void {
  const n = data.length;
  for (let o = 3; o < n; o += 4) {
    if (data[o] < threshold) data[o] = 0;
  }
}

/**
 * 执行预处理。返回新缓冲；若设置全中性则原样返回输入的缓冲（不复制）。
 */
export function preprocess(src: RGBAImage, p: PreprocessSettings): RGBAImageData {
  if (isPreprocessIdentity(p)) {
    return { width: src.width, height: src.height, data: src.data };
  }

  const data = new Uint8ClampedArray(src.data);

  if (p.brightness !== 0 || p.contrast !== 0 || p.saturation !== 0) {
    applyColorAdjust(data, p);
  }
  if (p.sharpen > 0) {
    applySharpen(data, src.width, src.height, p.sharpen);
  }
  if (p.alphaThreshold < 255) {
    applyAlphaThreshold(data, Math.max(0, p.alphaThreshold));
  }

  return { width: src.width, height: src.height, data };
}