/**
 * 裁剪四周全透明边。
 * 裁完后尺寸可能变化，所以返回新网格而不是就地修改。
 */

import { createGrid, type PixelGrid } from '../types';

export interface TrimResult {
  grid: PixelGrid;
  /** 相对原网格裁掉的边距，UI 用来提示 */
  offsetX: number;
  offsetY: number;
  changed: boolean;
}

export function trimTransparent(grid: PixelGrid): TrimResult {
  const { w, h, indices, alpha } = grid;

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (alpha[y * w + x] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  // 整张图都是透明的：保持原样，避免产出 0×0
  if (maxX < 0) {
    return { grid, offsetX: 0, offsetY: 0, changed: false };
  }

  if (minX === 0 && minY === 0 && maxX === w - 1 && maxY === h - 1) {
    return { grid, offsetX: 0, offsetY: 0, changed: false };
  }

  const nw = maxX - minX + 1;
  const nh = maxY - minY + 1;
  const out = createGrid(nw, nh);

  for (let y = 0; y < nh; y += 1) {
    const srcRow = (y + minY) * w + minX;
    const dstRow = y * nw;
    for (let x = 0; x < nw; x += 1) {
      out.indices[dstRow + x] = indices[srcRow + x];
      out.alpha[dstRow + x] = alpha[srcRow + x];
    }
  }

  return { grid: out, offsetX: minX, offsetY: minY, changed: true };
}