/**
 * 网格合成与渲染。
 *
 * composite 是双层编辑模型的核心运算（docs/DESIGN.md §3.4）：
 *   composite(i) = editLayer.cells[i] ?? baseGrid(i)
 *
 * 合成结果只用在**渲染与导出**上；编辑层本身保持稀疏，只记被手改过的格子。
 * 注意 composite() 在没有编辑层时会直接返回底层对象（省一次拷贝），
 * 拿到返回值的一方按只读对待。
 */

import type { EditLayer, Palette, PixelGrid } from './types';
import { createGrid } from './types';

/**
 * 把底层网格与手工编辑层合成为最终网格。
 * 两者尺寸必须一致；不一致时（例如尺寸变更后尚未重采样）以底层尺寸为准，
 * 编辑层中越界的部分被忽略。
 */
export function composite(base: PixelGrid, edit: EditLayer | null): PixelGrid {
  // 没有手工编辑时直接返回底层本身（只读约定，渲染方不得改动返回的网格）
  if (!edit) return base;

  const out = createGrid(base.w, base.h);
  compositeInto(base, edit, out);
  return out;
}

/**
 * 同上，但写入调用方提供的网格对象，不分配新缓冲。
 *
 * M2 起每画一笔都要重算合成结果，512×512 的网格每次分配 0.5MB 会让 GC 抖；
 * 画布端因此持有一份 scratch 网格反复复用。
 */
export function compositeInto(base: PixelGrid, edit: EditLayer | null, out: PixelGrid): void {
  out.indices.set(base.indices);
  out.alpha.set(base.alpha);
  if (!edit) return;
  if (edit.w !== base.w || edit.h !== base.h) return;

  const cells = edit.cells;
  for (let i = 0; i < cells.length; i += 1) {
    const cell = cells[i];
    if (!cell) continue;
    out.indices[i] = cell.index;
    out.alpha[i] = cell.alpha;
  }
}

/** 网格 → RGBA 缓冲（长度 w*h*4），写入调用方提供的缓冲 */
export function gridToRgba(grid: PixelGrid, palette: Palette, out: Uint8ClampedArray): void {
  const { w, h, indices, alpha } = grid;
  const colors = palette.colors;
  const last = colors.length - 1;

  for (let i = 0, o = 0; i < w * h; i += 1, o += 4) {
    const a = alpha[i];
    if (a === 0) {
      // 保持全透明；RGB 归零避免半透明边缘出现残留色
      out[o] = 0;
      out[o + 1] = 0;
      out[o + 2] = 0;
      out[o + 3] = 0;
      continue;
    }
    // 索引越界时钳到最后一个色，避免整块变黑
    const idx = indices[i] > last ? last : indices[i];
    const c = colors[idx];
    out[o] = c[0];
    out[o + 1] = c[1];
    out[o + 2] = c[2];
    out[o + 3] = a;
  }
}

/** 网格 → ImageData（供 canvas 绘制与 PNG 导出） */
export function gridToImageData(grid: PixelGrid, palette: Palette): ImageData {
  const data = new Uint8ClampedArray(grid.w * grid.h * 4);
  gridToRgba(grid, palette, data);
  return new ImageData(data, grid.w, grid.h);
}

/**
 * 整数倍最近邻放大。
 *
 * 刻意手写循环而不用 drawImage：各浏览器对 imageSmoothingEnabled=false 的
 * 边界像素处理不完全一致（尤其是放大倍数非整数、或有半透明像素时），
 * 手写循环能保证导出的每个像素都精确是 k×k 的方块。
 */
export function upscaleNearest(src: ImageData, k: number): ImageData {
  const factor = Math.max(1, Math.round(k));
  if (factor === 1) return src;
  const scaled = upscaleNearestRgba(src.data, src.width, src.height, factor);
  return new ImageData(scaled.data, scaled.width, scaled.height);
}

/**
 * 与 `upscaleNearest` 相同，但只处理裸 RGBA 缓冲。
 *
 * 拆出这一支是为了 CLI（M7）：那边没有 `ImageData`（那是浏览器的东西），
 * 而放大算法本身与它无关。两份实现会各自漂移，所以只留一个真正的循环。
 */
export function upscaleNearestRgba(
  data: Uint8ClampedArray,
  sw: number,
  sh: number,
  k: number,
): { data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number } {
  const factor = Math.max(1, Math.round(k));
  if (factor === 1) return { data: new Uint8ClampedArray(data), width: sw, height: sh };

  const dw = sw * factor;
  const dh = sh * factor;
  const out = new Uint8ClampedArray(dw * dh * 4);

  for (let y = 0; y < sh; y += 1) {
    const rowStart = y * factor * dw;
    for (let x = 0; x < sw; x += 1) {
      const so = (y * sw + x) * 4;
      const r = data[so];
      const g = data[so + 1];
      const b = data[so + 2];
      const a = data[so + 3];
      for (let dy = 0; dy < factor; dy += 1) {
        let o = (rowStart + dy * dw + x * factor) * 4;
        for (let dx = 0; dx < factor; dx += 1) {
          out[o] = r;
          out[o + 1] = g;
          out[o + 2] = b;
          out[o + 3] = a;
          o += 4;
        }
      }
    }
  }

  return { data: out, width: dw, height: dh };
}