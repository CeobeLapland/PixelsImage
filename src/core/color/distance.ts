/**
 * 颜色距离与「最近的调色板色」查找。
 *
 * 三档度量，对应精度/速度的权衡；见 docs/DESIGN.md §4.3。
 * 核心优化：5bit/通道 的查找缓存表（32768 项）。
 * 预览时拖动滑块会反复量化大量重复颜色，缓存命中率很高。
 */

import type { RGBA, DistanceMode } from '../types';
import { rgbToLab } from './space';

/** 缓存表条目数：32 × 32 × 32 */
const CACHE_SIZE = 32768;
/** 未命中标记。存「索引 + 1」，0 表示未填 */
const CACHE_EMPTY = 0;

export function createDistanceCache(): Uint16Array {
  return new Uint16Array(CACHE_SIZE);
}

/** 把 8bit 每通道压到 5bit，合成缓存键 */
function cacheKey(r: number, g: number, b: number): number {
  return ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
}

/**
 * 构建「(r,g,b) → 调色板索引」的查找函数。
 *
 * labPal 为调色板的 LAB 展平数组（distance === 'lab' 时必需）。
 */
export function createNearestFinder(
  palette: readonly RGBA[],
  distance: DistanceMode,
  labPal: Float32Array | null,
  cache: Uint16Array,
): (r: number, g: number, b: number) => number {
  const n = palette.length;

  // 单色调色板：无需计算，直接返回 0（后续比较循环会退化成无意义的遍历）
  if (n === 1) return () => 0;

  const labScratch = new Float32Array(3);

  const find = (r: number, g: number, b: number): number => {
    let best = 0;
    let bestD = Infinity;

    if (distance === 'lab' && labPal) {
      rgbToLab(r, g, b, labScratch);
      const sl = labScratch[0];
      const sa = labScratch[1];
      const sb = labScratch[2];
      for (let i = 0; i < n; i += 1) {
        const o = i * 3;
        const dl = sl - labPal[o];
        const da = sa - labPal[o + 1];
        const db = sb - labPal[o + 2];
        const d = dl * dl + da * da + db * db;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    }

    if (distance === 'weighted') {
      // 2·Δr² + 4·Δg² + 3·Δb² —— 便宜的感知近似
      for (let i = 0; i < n; i += 1) {
        const c = palette[i];
        const dr = r - c[0];
        const dg = g - c[1];
        const db = b - c[2];
        const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      return best;
    }

    for (let i = 0; i < n; i += 1) {
      const c = palette[i];
      const dr = r - c[0];
      const dg = g - c[1];
      const db = b - c[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  return (r: number, g: number, b: number): number => {
    const key = cacheKey(r, g, b);
    const hit = cache[key];
    if (hit !== CACHE_EMPTY) return hit - 1;
    const idx = find(r, g, b);
    cache[key] = idx + 1;
    return idx;
  };
}

/**
 * 缓存表的代价说明（写下来免得日后被当成 bug）：
 * 同一 5bit 桶内的颜色会得到同一个索引，最坏情况是每通道偏 7（桶宽 8）。
 * 调色板色距通常远大于这个值（16 色板平均色距 ~40），所以结果几乎无偏差；
 * 换来的是大幅减少 LAB 转换与全调色板扫描次数。
 */
export const DISTANCE_CACHE_NOTE =
  '查找缓存把颜色压到 5bit/通道，同桶内的细微差异会被抹平；对像素艺术而言影响可忽略。';