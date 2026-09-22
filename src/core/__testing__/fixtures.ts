/** 测试用的小工具：构造图像与调色板，避免每个测试文件重复写样板 */

import type { Palette, RGBA, RGBAImage } from '@/core/types';

export type Pixel = readonly [r: number, g: number, b: number, a: number];

export const RED: Pixel = [255, 0, 0, 255];
export const GREEN: Pixel = [0, 255, 0, 255];
export const BLUE: Pixel = [0, 0, 255, 255];
export const BLACK: Pixel = [0, 0, 0, 255];
export const WHITE: Pixel = [255, 255, 255, 255];
export const CLEAR: Pixel = [0, 0, 0, 0];

/** 由挑选用「行优先」的像素数组构造图像 */
export function makeImage(w: number, h: number, pixels: readonly Pixel[]): RGBAImage {
  if (pixels.length !== w * h) {
    throw new Error(`像素数量 ${pixels.length} 与 ${w}×${h} 不符`);
  }
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < pixels.length; i += 1) {
    const p = pixels[i];
    const o = i * 4;
    data[o] = p[0];
    data[o + 1] = p[1];
    data[o + 2] = p[2];
    data[o + 3] = p[3];
  }
  return { width: w, height: h, data };
}

/** 用同一个颜色填满 */
export function fillImage(w: number, h: number, color: Pixel): RGBAImage {
  return makeImage(w, h, new Array<Pixel>(w * h).fill(color));
}

/** 读某格的 RGBA */
export function pixelAt(
  img: RGBAImage,
  x: number,
  y: number,
): [number, number, number, number] {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}

/**
 * 制造一张有颜色变化的图。
 * 单调的纯色图测不出采样与抖动的问题，需要真实的梯度。
 */
export function makeGradient(w: number, h: number): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      data[o] = Math.round((x / Math.max(1, w - 1)) * 255);
      data[o + 1] = Math.round((y / Math.max(1, h - 1)) * 255);
      data[o + 2] = Math.round(((x + y) / Math.max(1, w + h - 2)) * 255);
      data[o + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

export function makePalette(id: string, colors: readonly Pixel[]): Palette {
  return {
    id,
    name: id,
    colors: colors.map((c) => c as unknown as RGBA),
    source: 'imported',
  };
}