/**
 * 网格数据 JSON 导出（M6）。
 *
 * 给程序消费的格式：`{ w, h, palette: string[], indices: number[], alpha?: number[] }`。
 * 索引 + 调色板分开存，而不是直接存每格的 RGB —— 同一张像素图里颜色高度重复，
 * 存索引能小一个数量级，而且程序侧做「按颜色分组」之类的处理也更容易。
 *
 * 纯函数，不碰 DOM，可直接单测。
 */

import { toHex } from '@/core/color/space';
import type { Palette, PixelGrid } from '@/core/types';

export interface GridJsonOptions {
  /** 是否总是写入 alpha 通道 */
  alwaysAlpha: boolean;
  /** 是否写入调色板色值 */
  includePalette: boolean;
}

export const DEFAULT_GRID_JSON_OPTIONS: GridJsonOptions = {
  alwaysAlpha: false,
  includePalette: true,
};

export interface GridJson {
  name: string;
  w: number;
  h: number;
  palette: { id: string; name: string; colors: string[] } | null;
  indices: number[];
  /** 只在「需要」时出现：见 needsAlpha */
  alpha?: number[];
}

/**
 * 是否需要 alpha 数组。
 *
 * 全不透明的图省掉 alpha 能让文件小一半（256×256 少 6.5 万个数字），
 * 但只要有一格不是 255 就必须写 —— 丢了它等于丢了半透明边缘，
 * 而这种损失在程序侧完全看不出来。
 */
export function needsAlpha(grid: PixelGrid, alwaysAlpha: boolean): boolean {
  if (alwaysAlpha) return true;
  for (let i = 0; i < grid.alpha.length; i += 1) {
    if (grid.alpha[i] !== 255) return true;
  }
  return false;
}

export function buildGridJson(
  grid: PixelGrid,
  palette: Palette,
  name: string,
  options: GridJsonOptions,
): GridJson {
  const json: GridJson = {
    name,
    w: grid.w,
    h: grid.h,
    palette: options.includePalette
      ? {
          id: palette.id,
          name: palette.name,
          colors: palette.colors.map((c) => toHex(c[0], c[1], c[2])),
        }
      : null,
    indices: Array.from(grid.indices),
  };

  if (needsAlpha(grid, options.alwaysAlpha)) {
    json.alpha = Array.from(grid.alpha);
  }

  return json;
}

/** 缩进两格：这是给人也会打开看一眼的文件，压成一行不友好 */
export function serializeGridJson(json: GridJson): string {
  return `${JSON.stringify(json, null, 2)}\n`;
}
