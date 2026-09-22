/**
 * 颜色量化：把降采样后的 RGBA 图像映射到调色板索引。
 *
 * 抖动与量化在这里是同一个循环的两面 —— 误差扩散必须知道
 * 「量化后的颜色是什么」才能算出误差，无法拆成两步。
 *
 * alpha 独立处理：完全透明的像素不参与量化，也不参与误差扩散
 * （否则透明区会把误差传给相邻的不透明像素，产生脏边）。
 */

import type { RGBA, RGBAImage, DitherMode, DistanceMode } from '../types';
import { createNearestFinder, createDistanceCache } from './distance';
import { getDiffusionKernel, getOrderedMatrix, estimateDitherSpread } from './dither';
import { paletteToLab } from './space';

export interface QuantizeOptions {
  palette: readonly RGBA[];
  distance: DistanceMode;
  dither: DitherMode;
  /** 0-1 */
  ditherStrength: number;
  /**
   * 查找缓存，**必须属于当前调色板与距离度量**。
   * 缓存里存的是调色板索引，跨调色板复用会导致索引越界
   * （例如 16 色板的索引 15 在 2 色板里不存在）。
   * 不传则内部新建一个，作用域仅限本次调用。
   */
  cache?: Uint16Array;
}

export interface QuantizeTarget {
  indices: Uint8Array;
  alpha: Uint8Array;
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * 就地量化。
 *
 * src 的 RGB 被当作颜色来源，alpha 直接搬到 out.alpha。
 * out.indices / out.alpha 长度需为 src.width * src.height。
 */
export function quantizeInto(
  src: RGBAImage,
  opts: QuantizeOptions,
  out: QuantizeTarget,
): void {
  const { width: w, height: h, data } = src;
  const total = w * h;
  const palette = opts.palette;
  if (palette.length === 0) throw new Error('调色板为空，无法量化');

  const strength = opts.ditherStrength <= 0 ? 0 : Math.min(1, opts.ditherStrength);
  const useLab = opts.distance === 'lab';
  const labPal = useLab ? paletteToLab(palette) : null;
  const cache = opts.cache && opts.cache.length === 32768 ? opts.cache : createDistanceCache();
  const nearest = createNearestFinder(palette, opts.distance, labPal, cache);

  const diffusion = strength > 0 ? getDiffusionKernel(opts.dither) : null;
  const ordered = strength > 0 ? getOrderedMatrix(opts.dither) : null;

  /* 误差扩散：需要在浮点缓冲上累加误差，不能直接改 8bit 源 */
  let bufR: Float32Array | null = null;
  let bufG: Float32Array | null = null;
  let bufB: Float32Array | null = null;

  if (diffusion) {
    bufR = new Float32Array(total);
    bufG = new Float32Array(total);
    bufB = new Float32Array(total);
    for (let i = 0, o = 0; i < total; i += 1, o += 4) {
      bufR[i] = data[o];
      bufG[i] = data[o + 1];
      bufB[i] = data[o + 2];
    }
  }

  const spread = ordered ? estimateDitherSpread(palette) * strength : 0;
  const entries = diffusion ? diffusion.entries : null;
  const divisor = diffusion ? diffusion.divisor : 1;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const o = i * 4;
      const a = data[o + 3];

      // 全透明：索引归 0，不参与量化与扩散
      if (a === 0) {
        out.indices[i] = 0;
        out.alpha[i] = 0;
        continue;
      }

      out.alpha[i] = a;

      let r: number;
      let g: number;
      let b: number;
      const erBuf = bufR;
      const egBuf = bufG;
      const ebBuf = bufB;

      if (erBuf && egBuf && ebBuf) {
        r = clamp255(Math.round(erBuf[i]));
        g = clamp255(Math.round(egBuf[i]));
        b = clamp255(Math.round(ebBuf[i]));
      } else {
        r = data[o];
        g = data[o + 1];
        b = data[o + 2];
      }

      if (ordered) {
        // 阈值偏移：把 (matrix/(n²)) - 0.5 映射到 ±spread/2
        const n = ordered.size;
        const t = (ordered.data[(y % n) * n + (x % n)] + 0.5) / (n * n) - 0.5;
        const off = t * spread;
        r = clamp255(Math.round(r + off));
        g = clamp255(Math.round(g + off));
        b = clamp255(Math.round(b + off));
      }

      const idx = nearest(r, g, b);
      out.indices[i] = idx;

      if (entries && erBuf && egBuf && ebBuf) {
        const pc = palette[idx];
        const er = (r - pc[0]) * strength;
        const eg = (g - pc[1]) * strength;
        const eb = (b - pc[2]) * strength;
        if (er !== 0 || eg !== 0 || eb !== 0) {
          for (let k = 0; k < entries.length; k += 1) {
            const e = entries[k];
            const nx = x + e.dx;
            const ny = y + e.dy;
            if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
            const j = ny * w + nx;
            // 不把误差扩散进透明像素
            if (data[j * 4 + 3] === 0) continue;
            const f = e.w / divisor;
            erBuf[j] += er * f;
            egBuf[j] += eg * f;
            ebBuf[j] += eb * f;
          }
        }
      }
    }
  }
}

/** 量化后的统计信息，供 UI 显示「实际用了几种颜色」 */
export function countUsedColors(indices: Uint8Array, alpha: Uint8Array): number {
  const seen = new Uint8Array(256);
  let count = 0;
  for (let i = 0; i < indices.length; i += 1) {
    if (alpha[i] === 0) continue;
    const idx = indices[i];
    if (seen[idx] === 0) {
      seen[idx] = 1;
      count += 1;
    }
  }
  return count;
}