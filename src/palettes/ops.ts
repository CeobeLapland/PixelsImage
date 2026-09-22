/**
 * 调色板的结构性操作：排序、合并近似色，以及随之而来的索引重映射。
 *
 * **索引重映射是这里最容易出错的地方**：调色板一被重排，`PixelGrid.indices`
 * 与编辑层里的 `PixelCell.index` 就全部指错了槽位。所以每个操作都返回
 * `map[旧索引] = 新索引`，调用方必须同时把底图与编辑层一起重映射 ——
 * 漏掉编辑层的话，画面看起来正常，但用户手改过的格子会突然变成别的颜色。
 */

import { relativeLuminance, hueOf } from '@/core/color/space';
import type { EditLayer, PixelGrid, RGBA } from '@/core/types';

export type SortKey = 'luminance' | 'hue';

export interface RemapResult {
  colors: RGBA[];
  /** map[旧索引] = 新索引 */
  map: number[];
}

/**
 * 排序调色板。
 *
 * `hue` 模式把接近灰的颜色排在最前（按明度），其余按色相环顺序 —— 这样
 * 「黑白灰 → 红橙黄绿青蓝紫」的顺序符合找色时的直觉。灰色的色相是无意义的浮点噪声，
 * 若不单独挑出来，排序结果会看起来毫无规律。
 */
export function sortColors(colors: readonly RGBA[], key: SortKey): RemapResult {
  const order = colors.map((_, i) => i);

  const keyOf = (i: number): [number, number] => {
    const c = colors[i];
    if (!c) return [0, 0];
    const lum = relativeLuminance(c[0], c[1], c[2]);
    if (key === 'luminance') return [lum, 0];
    const hue = hueOf(c[0], c[1], c[2]);
    // 灰色(hue<0)排最前，且灰色内部按明度排
    return hue < 0 ? [-1, lum] : [hue, lum];
  };

  order.sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka[0] !== kb[0]) return ka[0] - kb[0];
    if (ka[1] !== kb[1]) return ka[1] - kb[1];
    return a - b; // 完全同键时按下标定序，保证结果是确定的
  });

  const map = new Array<number>(colors.length);
  order.forEach((from, to) => {
    map[from] = to;
  });

  return { colors: order.map((i) => colors[i] as RGBA), map };
}

/** 加权 RGB 距离（与转换流水线的默认口径一致） */
export function colorDistanceSq(a: RGBA, b: RGBA): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}

/**
 * 合并近似色：距离小于容差的颜色归到先出现的那个槽位。
 *
 * 用贪心而不是聚类：槽位顺序本身有意义（用户按顺序认色），
 * 聚类会把结果顺序打乱，且「保留哪一个」不可预测。
 * 容差是加权距离的**欧氏长度**（不是平方），单位接近 RGB 的 0-255 尺度：
 * 8 左右只合并几乎一样的色，64 以上会开始把同色系的深浅压成一层。
 */
export function mergeSimilarColors(colors: readonly RGBA[], tolerance: number): RemapResult {
  const limit = Math.max(0, tolerance);
  const limitSq = limit * limit;
  const kept: RGBA[] = [];
  const map = new Array<number>(colors.length);

  for (let i = 0; i < colors.length; i += 1) {
    const c = colors[i] as RGBA;
    let target = -1;
    for (let k = 0; k < kept.length; k += 1) {
      if (colorDistanceSq(c, kept[k] as RGBA) <= limitSq) {
        target = k;
        break;
      }
    }
    if (target < 0) {
      kept.push(c);
      target = kept.length - 1;
    }
    map[i] = target;
  }

  return { colors: kept, map };
}

/** 按 map 重写底图索引（就地） */
export function remapGridIndices(grid: PixelGrid, map: readonly number[]): void {
  const last = map.length;
  for (let i = 0; i < grid.indices.length; i += 1) {
    const idx = grid.indices[i] ?? 0;
    const next = idx < last ? map[idx] : undefined;
    if (next !== undefined) grid.indices[i] = next;
  }
}

/** 按 map 重写编辑层里的索引（就地）；alpha 与「是否覆盖」保持不变 */
export function remapEditLayer(layer: EditLayer, map: readonly number[]): void {
  const last = map.length;
  for (const cell of layer.cells) {
    if (!cell) continue;
    const next = cell.index < last ? map[cell.index] : undefined;
    if (next !== undefined) cell.index = next;
  }
}