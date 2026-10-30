/**
 * 随机灵感器（最后一个可选扩展）。
 *
 * 目标是「先出一批，再挑一张」：把转换参数随机组合成几种明显不同的风格，
 * 一次跑出一排缩略图，挑中意的再套用。
 *
 * 为什么用**种子**而不是直接用 Math.random：同样的种子必须得到同一套参数，
 * 否则测试只能断言「值在范围内」，断言不了「这次改了什么」。种子还方便以后做「换一批」。
 *
 * 随机范围刻意收窄：预处理只做小幅明暗/饱和/锐化扰动，不碰去背景 ——
 * 去背景是「素材决定的事」，随机开它只会把主体啃掉一块。
 */

import {
  DEFAULT_PREPROCESS,
  makeDefaultSettings,
  type ConvertSettings,
  type DitherMode,
  type DistanceMode,
  type Palette,
  type SamplingMode,
} from '../types';

/** 随机挑的几个目标格数（都是常用档位） */
const SIZES = [16, 24, 32, 48, 64, 96] as const;
const SAMPLINGS: readonly SamplingMode[] = ['nearest', 'area', 'dominant', 'median'];
const DISTANCES: readonly DistanceMode[] = ['rgb', 'weighted', 'lab'];
const DITHERS: readonly DitherMode[] = [
  'none',
  'atkinson',
  'floyd',
  'sierra',
  'bayer2',
  'bayer4',
  'bayer8',
];
const KMEANS_COLORS = [4, 6, 8, 12, 16, 24, 32] as const;

const DITHER_LABELS: Record<DitherMode, string> = {
  none: '不抖动',
  atkinson: 'Atkinson',
  floyd: 'Floyd',
  sierra: 'Sierra',
  bayer2: 'Bayer 2',
  bayer4: 'Bayer 4',
  bayer8: 'Bayer 8',
};

/** 确定性伪随机（mulberry32）：同一 seed 在任何环境都给同一串数 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface VariantPlan {
  seed: number;
  settings: ConvertSettings;
  /** 给 UI 看的一行摘要 */
  label: string;
}

/**
 * 由一个种子生成一套随机参数。
 *
 * `palettePool` 是可选调色板（内置 + 自定义）；量化模式为 k-means 时，
 * 这套参数里的 paletteId 只是「随机时的参考板」，实际用色由聚类当场生成。
 */
export function makeRandomVariant(seed: number, palettePool: readonly Palette[]): VariantPlan {
  const rng = mulberry32(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rng() * list.length)] as T;
  const int = (min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));

  const base = makeDefaultSettings();
  const width = pick(SIZES);
  const quantize = rng() < 0.35 ? 'kmeans' : 'palette';
  const palette = palettePool.length > 0 ? pick(palettePool) : null;
  const maxColors = pick(KMEANS_COLORS);
  const dither = pick(DITHERS);

  const settings: ConvertSettings = {
    ...base,
    targetW: width,
    targetH: 'auto',
    sampling: pick(SAMPLINGS),
    quantize,
    // 池子里没有自定义板时退回默认板 id；量化模式其实不看它，但字段必须合法
    paletteId: palette?.id ?? base.paletteId,
    maxColors,
    distance: pick(DISTANCES),
    dither,
    ditherStrength: Math.round((0.5 + rng() * 0.5) * 100) / 100,
    preprocess: {
      ...DEFAULT_PREPROCESS,
      brightness: int(-10, 10),
      contrast: int(-10, 10),
      saturation: int(-20, 20),
      sharpen: rng() < 0.5 ? 0 : int(10, 40),
      // 去背景是「素材决定的事」，随机开它只会把主体啃掉一块
      removeBackground: 'none',
    },
    trimTransparent: rng() < 0.2,
    pixelPerfect: rng() < 0.3,
  };

  const paletteLabel = quantize === 'kmeans' ? `k-means ${maxColors} 色` : palette?.name ?? '默认板';
  return {
    seed,
    settings,
    label: `${width} 格 · ${paletteLabel} · ${DITHER_LABELS[dither]}`,
  };
}

/** 生成一串互不相同的种子（「换一批」时调用方只要换起点就行） */
export function makeSeeds(count: number, seedBase: number): number[] {
  const rng = mulberry32(seedBase);
  const out: number[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(Math.floor(rng() * 0xffffffff));
  }
  return out;
}
