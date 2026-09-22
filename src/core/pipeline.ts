/**
 * 转换流水线：源图 + 参数 → PixelGrid。
 *
 * 这是纯函数，不依赖 DOM 也不依赖 UI，所以能直接跑在 Web Worker 里，
 * 将来也能被 CLI 复用（见 docs/DESIGN.md §4）。
 *
 *  源 RGBA
 *    ↓ ① 预处理        preprocess.ts
 *    ↓ ② 降采样        sampling.ts      → targetW × targetH 的 RGBA
 *    ↓ ③ 量化（含抖动） quantize.ts      → indices + alpha
 *    ↓ ④ 后处理        trim
 *  PixelGrid
 */

import { countUsedColors, quantizeInto, type QuantizeTarget } from './color/quantize';
import { createDistanceCache } from './color/distance';
import { preprocess } from './preprocess';
import { downsample } from './sampling';
import { trimTransparent } from './assists/trim';
import {
  createGrid,
  resolveTargetSize,
  type ConvertSettings,
  type DistanceMode,
  type Palette,
  type PixelGrid,
  type RGBAImage,
} from './types';

export interface ConvertOptions {
  /**
   * 快速模式：拖动滑块时使用。
   * 强制用加权 RGB 距离，跳过 CIELAB 转换 —— 这是流水线里最贵的一步。
   */
  fast?: boolean;
}

export interface ConvertResult {
  grid: PixelGrid;
  /** 实际使用的目标尺寸（trim 后可能不同） */
  targetW: number;
  targetH: number;
  /** 实际用到的调色板颜色数 */
  usedColors: number;
  /** 是否因 trimTransparent 改变了尺寸 */
  trimmed: boolean;
}

export function convert(
  source: RGBAImage,
  settings: ConvertSettings,
  palette: Palette,
  options: ConvertOptions = {},
): ConvertResult {
  const { w: targetW, h: targetH } = resolveTargetSize(
    settings,
    source.width,
    source.height,
  );

  const prepared = preprocess(source, settings.preprocess);

  const small = downsample(
    prepared,
    targetW,
    targetH,
    settings.sampling,
    settings.pixelPerfect,
  );

  const distance: DistanceMode = options.fast ? 'weighted' : settings.distance;

  const grid = createGrid(small.width, small.height);
  const target: QuantizeTarget = { indices: grid.indices, alpha: grid.alpha };

  quantizeInto(
    small,
    {
      palette: palette.colors,
      distance,
      dither: settings.dither,
      ditherStrength: settings.ditherStrength,
      cache: createDistanceCache(),
    },
    target,
  );

  const usedColors = countUsedColors(grid.indices, grid.alpha);

  if (settings.trimTransparent) {
    const trimmed = trimTransparent(grid);
    return {
      grid: trimmed.grid,
      targetW,
      targetH,
      usedColors,
      trimmed: trimmed.changed,
    };
  }

  return { grid, targetW, targetH, usedColors, trimmed: false };
}