/**
 * 网格合成与渲染。
 *
 * composite 是双层编辑模型的核心运算（docs/DESIGN.md §3.4）：
 *   composite(i) = editLayer.cells[i] ?? baseGrid(i)
 *
 * M2 起编辑层才会被写入；M1 阶段它恒为 null，但这层必须现在就存在，
 * 否则 M2 接进来时要改动所有渲染路径。
 */

import type { EditLayer, Palette, PixelGrid } from './types';
import { createGrid } from './types';

/**
 * 把底层网格与手工编辑层合成为最终网格。
 * 两者尺寸必须一致；不一致时（例如尺寸变更后尚未重采样）以底层尺寸为准，
 * 编辑层中越界的部分被忽略。
 */
export function composite(base: PixelGrid, edit: EditLayer | null): PixelGrid {
  if (!edit) return base;

  const sameSize = edit.w === base.w && edit.h === base.h;
  const out = createGrid(base.w, base.h);
  out.indices.set(base.indices);
  out.alpha.set(base.alpha);

  if (sameSize) {
    const cells = edit.cells;
    for (let i = 0; i < cells.length; i += 1) {
      const cell = cells[i];
      if (!cell) continue;
      out.indices[i] = cell.index;
      out.alpha[i] = cell.alpha;
    }
    return out;
  }

  return out;
}

/** 网格 → ImageData（供 canvas 绘制与 PNG 导出） */
export function gridToImageData(grid: PixelGrid, palette: Palette): ImageData {
  const { w, h, indices, alpha } = grid;
  const data = new Uint8ClampedArray(w * h * 4);
  const colors = palette.colors;
  const last = colors.length - 1;

  for (let i = 0, o = 0; i < w * h; i += 1, o += 4) {
    const a = alpha[i];
    if (a === 0) {
      // 保持全透明；RGB 归零避免半透明边缘出现残留色
      continue;
    }
    // 索引越界时钳到最后一个色，避免整块变黑
    const idx = indices[i] > last ? last : indices[i];
    const c = colors[idx];
    data[o] = c[0];
    data[o + 1] = c[1];
    data[o + 2] = c[2];
    data[o + 3] = a;
  }

  return new ImageData(data, w, h);
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

  const { width: sw, height: sh, data } = src;
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

  return new ImageData(out, dw, dh);
}