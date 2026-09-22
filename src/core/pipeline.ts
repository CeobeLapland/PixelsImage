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

import { kmeansPalette, strideSamples, type RgbSamples } from './color/kmeans';
import { countUsedColors, quantizeInto, type QuantizeTarget } from './color/quantize';
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
  type RGBA,
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
  /**
   * k-means 限色模式下**实际生成**的调色板；其余模式为 undefined
   * （此时调用方传入的调色板就是实际用的那个）。
   */
  generatedPalette?: Palette;
}

/** 把降采样结果抽成聚类样本（去掉全透明像素） */
function samplesOf(image: RGBAImage): RgbSamples {
  const total = image.width * image.height;
  const out = new Uint8Array(total * 3);
  let count = 0;
  for (let i = 0; i < total; i += 1) {
    const o = i * 4;
    if ((image.data[o + 3] ?? 0) === 0) continue;
    out[count * 3] = image.data[o] ?? 0;
    out[count * 3 + 1] = image.data[o + 1] ?? 0;
    out[count * 3 + 2] = image.data[o + 2] ?? 0;
    count += 1;
  }
  return strideSamples({ data: out.subarray(0, count * 3), count }, 20000);
}

/**
 * k-means 限色：从**降采样后**的图上聚出调色板。
 *
 * 为什么用降采样结果而不是原图：原图 400 万像素聚类要几百毫秒，而目标格数最多
 * 256×256 = 6.5 万格，其颜色分布已经足够代表最终要画的这张像素图 ——
 * 我们要的是「这张像素图该用哪些色」，不是「原图有哪些色」。
 */
function buildKmeansPalette(small: RGBAImage, maxColors: number): Palette {
  const k = Math.max(2, Math.min(256, Math.round(maxColors)));
  const colors: RGBA[] = kmeansPalette(samplesOf(small), k);
  return {
    id: `kmeans-${k}`,
    name: `k-means ${k} 色`,
    colors,
    source: 'extracted',
  };
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

  // 限色模式：先用 k-means 造一块临时调色板，再照常走「映射到调色板」这条路。
  // 这样抖动、距离度量、alpha 处理全部复用同一套代码，两条模式不会各写一遍。
  const generated =
    settings.quantize === 'kmeans' ? buildKmeansPalette(small, settings.maxColors) : undefined;
  const effective = generated ?? palette;

  const grid = createGrid(small.width, small.height);
  const target: QuantizeTarget = { indices: grid.indices, alpha: grid.alpha };

  quantizeInto(
    small,
    {
      palette: effective.colors,
      distance,
      dither: settings.dither,
      ditherStrength: settings.ditherStrength,
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
      generatedPalette: generated,
    };
  }

  return { grid, targetW, targetH, usedColors, trimmed: false, generatedPalette: generated };
}