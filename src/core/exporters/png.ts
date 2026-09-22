/**
 * PNG 导出。
 *
 * M1 只做「当前网格 → PNG（可整数倍放大）」，也就是验收标准里那条：
 * 「导出的 1x PNG 在 Photoshop 里放大后是干净硬边，无插值模糊」。
 *
 * 精灵图集 / GIF / 蓝图见 M6。
 */

import { gridToImageData, upscaleNearest } from '../composite';
import { parseHex } from '../color/space';
import type { Palette, PixelGrid } from '../types';

export interface PngExportOptions {
  /** 放大倍数，整数，1 = 原始像素 */
  scale: number;
  /** 'transparent' 或 hex 颜色：透明区是否压到一个底色上 */
  background: 'transparent' | string;
}

export const DEFAULT_PNG_OPTIONS: PngExportOptions = {
  scale: 1,
  background: 'transparent',
};

/** 把透明区合成到指定底色上 */
function flatten(data: ImageData, hex: string): void {
  const parsed = parseHex(hex);
  if (!parsed) return;
  const [br, bg, bb] = parsed;
  const px = data.data;

  for (let o = 0; o < px.length; o += 4) {
    const a = px[o + 3];
    if (a === 255) continue;
    if (a === 0) {
      px[o] = br;
      px[o + 1] = bg;
      px[o + 2] = bb;
      px[o + 3] = 255;
      continue;
    }
    const t = a / 255;
    px[o] = Math.round(br + (px[o] - br) * t);
    px[o + 1] = Math.round(bg + (px[o + 1] - bg) * t);
    px[o + 2] = Math.round(bb + (px[o + 2] - bb) * t);
    px[o + 3] = 255;
  }
}

export function renderGridToImageData(
  grid: PixelGrid,
  palette: Palette,
  options: PngExportOptions,
): ImageData {
  let data = gridToImageData(grid, palette);
  if (options.background !== 'transparent') {
    flatten(data, options.background);
  }
  if (options.scale > 1) {
    data = upscaleNearest(data, options.scale);
  }
  return data;
}

export async function imageDataToPngBlob(data: ImageData): Promise<Blob> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(data.width, data.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 2D 上下文');
    ctx.putImageData(data, 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
  }

  const canvas = document.createElement('canvas');
  canvas.width = data.width;
  canvas.height = data.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 上下文');
  ctx.putImageData(data, 0, 0);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('PNG 编码失败'));
    }, 'image/png');
  });
}

export async function exportGridPng(
  grid: PixelGrid,
  palette: Palette,
  options: PngExportOptions,
): Promise<Blob> {
  return imageDataToPngBlob(renderGridToImageData(grid, palette, options));
}

/* ------------------------------------------------------------- 下载工具 */

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // 交给下一轮事件循环再释放，避免某些浏览器下载被中断
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

/** 由源图文件名推导导出名：photo.jpg + 32×24 → photo_32x24.png */
export function buildExportName(
  sourceName: string,
  grid: PixelGrid,
  scale: number,
): string {
  const base = sourceName.replace(/\.[^.]+$/, '') || 'pixels';
  const suffix = scale > 1 ? `_${grid.w}x${grid.h}@${scale}x` : `_${grid.w}x${grid.h}`;
  return `${base}${suffix}.png`;
}