/**
 * 从图片提取主色，生成自定义调色板。
 *
 * 两种方法：
 * - **中位切分（median cut）**：默认。把颜色空间按最宽的通道反复从中位数切开，
 *   直到切够 N 个盒子，每盒取平均色。比 k-means 快、无需迭代，出来的色更「散得开」，
 *   更适合当调色板。
 * - **k-means**：备选。簇中心更贴近视觉重心，适合「想要最能代表这张图的 N 个色」。
 *
 * 两个过滤器解决「提出来一堆背景色」这个最常见的抱怨：
 * 排除透明像素、只取某个明度区间。
 */

import { kmeansPalette, strideSamples, type RgbBuffer, type RgbSamples } from '@/core/color/kmeans';
import { relativeLuminance } from '@/core/color/space';
import { PALETTE_MAX_COLORS, type RGBA, type RGBAImage } from '@/core/types';

export type ExtractMethod = 'medianCut' | 'kmeans';

export interface ExtractOptions {
  /** 想要的颜色数，1-256 */
  count: number;
  method?: ExtractMethod;
  /** alpha ≤ 此值的像素不参与统计（默认 0，即只排除全透明） */
  alphaThreshold?: number;
  /** 只统计亮度落在这个区间的像素，0-1（默认全区间） */
  luminanceRange?: readonly [number, number];
  /** 参与统计的像素上限，超出则等步长抽稀 */
  maxSamples?: number;
}

const DEFAULT_MAX_SAMPLES = 20000;

/** 按过滤条件把图像像素抽成 RGB 样本串 */
function collectSamples(image: RGBAImage, options: ExtractOptions): RgbSamples {
  const { width: w, height: h, data } = image;
  const total = w * h;
  if (total === 0) return { data: new Uint8Array(0), count: 0 };

  const alphaMin = (options.alphaThreshold ?? 0) + 1;
  const [lumLo, lumHi] = options.luminanceRange ?? [0, 1];
  const filterLuminance = lumLo > 0 || lumHi < 1;

  const out = new Uint8Array(total * 3);
  let count = 0;
  for (let i = 0; i < total; i += 1) {
    const o = i * 4;
    if ((data[o + 3] ?? 0) < alphaMin) continue;
    const r = data[o] ?? 0;
    const g = data[o + 1] ?? 0;
    const b = data[o + 2] ?? 0;
    if (filterLuminance) {
      const lum = relativeLuminance(r, g, b);
      if (lum < lumLo || lum > lumHi) continue;
    }
    out[count * 3] = r;
    out[count * 3 + 1] = g;
    out[count * 3 + 2] = b;
    count += 1;
  }

  return strideSamples({ data: out.subarray(0, count * 3), count }, options.maxSamples ?? DEFAULT_MAX_SAMPLES);
}

/* ------------------------------------------------------------ 中位切分 */

interface Box {
  /** 在 order 数组里的区间 [lo, hi) */
  lo: number;
  hi: number;
}

/** 盒内各通道的取值范围 */
function channelRanges(order: Int32Array, data: RgbBuffer, box: Box): [number, number, number] {
  let rMin = 255;
  let rMax = 0;
  let gMin = 255;
  let gMax = 0;
  let bMin = 255;
  let bMax = 0;
  for (let i = box.lo; i < box.hi; i += 1) {
    const s = (order[i] ?? 0) * 3;
    const r = data[s] ?? 0;
    const g = data[s + 1] ?? 0;
    const b = data[s + 2] ?? 0;
    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
    if (b < bMin) bMin = b;
    if (b > bMax) bMax = b;
  }
  return [rMax - rMin, gMax - gMin, bMax - bMin];
}

function medianCut(samples: RgbSamples, count: number): RGBA[] {
  const n = samples.count;
  if (n === 0) return [];
  const { data } = samples;

  const order = new Int32Array(n);
  for (let i = 0; i < n; i += 1) order[i] = i;

  let boxes: Box[] = [{ lo: 0, hi: n }];

  while (boxes.length < count) {
    // 挑要切的盒子：像素数 × 最大通道跨度。
    // 只按像素数挑，会让「一大片但颜色极均匀」的区域被反复切开，
    // 而真正有细节的小区域反而分不到中心。
    let target = -1;
    let targetChannel = 0;
    let bestScore = 0;
    for (let bi = 0; bi < boxes.length; bi += 1) {
      const box = boxes[bi];
      if (!box || box.hi - box.lo < 2) continue;
      const ranges = channelRanges(order, data, box);
      const widest = ranges[0] > ranges[1] ? (ranges[0] > ranges[2] ? 0 : 2) : ranges[1] > ranges[2] ? 1 : 2;
      const span = ranges[widest] ?? 0;
      const score = (box.hi - box.lo) * span;
      if (score > bestScore) {
        bestScore = score;
        target = bi;
        targetChannel = widest;
      }
    }
    // 所有盒子都只剩一个颜色（或跨度全为 0）→ 已经无法再分
    if (target < 0) break;

    const box = boxes[target] as Box;
    const segment = Array.from(order.subarray(box.lo, box.hi));
    segment.sort((a, b) => (data[a * 3 + targetChannel] ?? 0) - (data[b * 3 + targetChannel] ?? 0));
    order.set(segment, box.lo);

    const mid = box.lo + ((box.hi - box.lo) >> 1);
    boxes = boxes
      .filter((_, i) => i !== target)
      .concat([
        { lo: box.lo, hi: mid },
        { lo: mid, hi: box.hi },
      ]);
  }

  return boxes.map((box) => {
    let r = 0;
    let g = 0;
    let b = 0;
    const size = box.hi - box.lo;
    for (let i = box.lo; i < box.hi; i += 1) {
      const s = (order[i] ?? 0) * 3;
      r += data[s] ?? 0;
      g += data[s + 1] ?? 0;
      b += data[s + 2] ?? 0;
    }
    return [
      Math.round(r / size),
      Math.round(g / size),
      Math.round(b / size),
      255,
    ] as unknown as RGBA;
  });
}

/* ------------------------------------------------------------------ 入口 */

/**
 * 提色。返回的颜色**不做排序**（保持算法给出的自然顺序），
 * 需要排序请调用方显式用 `palettes/ops.ts` 的 `sortColors`。
 */
export function extractPalette(image: RGBAImage, options: ExtractOptions): RGBA[] {
  const count = Math.max(1, Math.min(PALETTE_MAX_COLORS, Math.round(options.count)));
  const samples = collectSamples(image, options);
  if (samples.count === 0) return [];

  return options.method === 'kmeans'
    ? kmeansPalette(samples, count)
    : medianCut(samples, count);
}