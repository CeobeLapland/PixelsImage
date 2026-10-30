/**
 * 反向解析（M10）：把一张**现成的像素图**还原成「调色板 + 网格」。
 *
 * 为什么不走转换流水线：流水线是「高清图 → 低分辨率」的方向，它不知道
 * 「这张图本来就是 32×32」。反向解析要保留原有像素与颜色，一个像素都不许动，
 * 所以必须绕开降采样与量化，直接读图。
 *
 * 两个关键点：
 * 1. **识别整倍数放大**。网上的像素素材常被放大 2×/4×/8× 保存（不放大没法看），
 *    直接按图片像素建网格会得到一张「每格 4×4 都一样」的废网格。做法是找所有
 *    同色连续段长度的最大公约数，再验证候选倍数下每块确实统一。
 * 2. **调色板取图里真实出现的颜色**。超过 256 色时才退回 k-means 量化 ——
 *    反向解析的意义是保真，量化是无可奈何的兜底，必须如实告诉调用方。
 */

import { kmeansPalette, strideSamples } from './color/kmeans';
import { quantizeInto } from './color/quantize';
import { createGrid, PALETTE_MAX_COLORS, type Palette, type PixelGrid, type RGBA, type RGBAImage } from './types';

/** 反向解析的网格上限：超过就不是「低分辨率素材」，再大编辑器也扛不住 */
const MAX_REVERSE_CELLS = 1_000_000;

export interface ReverseOptions {
  /** 0 = 自动识别整倍数放大；>0 = 强制使用该倍数 */
  scale?: number;
  /** 最多保留多少色，默认 256（GIF / 调色板索引的上限） */
  maxColors?: number;
}

export interface ReverseResult {
  grid: PixelGrid;
  palette: Palette;
  /** 识别到的像素块大小（1 = 原图就是 1 像素 1 格） */
  scale: number;
  /** 原图里实际出现的颜色数（不计全透明） */
  sourceColors: number;
  /** 是否因为超过 maxColors 而量化过 */
  quantized: boolean;
}

function gcd(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);
  while (y > 0) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x;
}

function samePixel(data: Uint8ClampedArray, a: number, b: number): boolean {
  const oa = a * 4;
  const ob = b * 4;
  return (
    data[oa] === data[ob] &&
    data[oa + 1] === data[ob + 1] &&
    data[oa + 2] === data[ob + 2] &&
    data[oa + 3] === data[ob + 3]
  );
}

/**
 * 所有同色连续段长度的最大公约数。
 *
 * 例：4× 放大的 2×2 像素图，横向每段长 4；某两块恰好同色会被合并成 8，
 * 但其它段仍是 4，所以公约数还是 4 —— 这正是我们要的块大小。
 */
function runLengthGcd(image: RGBAImage): number {
  const { width: w, height: h, data } = image;
  let g = 0;

  for (let y = 0; y < h; y += 1) {
    let run = 1;
    for (let x = 1; x < w; x += 1) {
      if (samePixel(data, y * w + x, y * w + x - 1)) {
        run += 1;
      } else {
        g = gcd(g, run);
        run = 1;
      }
    }
    g = gcd(g, run);
    if (g === 1) return 1;
  }

  for (let x = 0; x < w; x += 1) {
    let run = 1;
    for (let y = 1; y < h; y += 1) {
      if (samePixel(data, y * w + x, (y - 1) * w + x)) {
        run += 1;
      } else {
        g = gcd(g, run);
        run = 1;
      }
    }
    g = gcd(g, run);
    if (g === 1) return 1;
  }

  return g;
}

/** 每个 k×k 块内部是否完全同色 */
function blocksUniform(image: RGBAImage, k: number): boolean {
  const { width: w, height: h, data } = image;
  for (let by = 0; by < h; by += k) {
    for (let bx = 0; bx < w; bx += k) {
      const first = by * w + bx;
      for (let dy = 0; dy < k; dy += 1) {
        for (let dx = 0; dx < k; dx += 1) {
          if (samePixel(data, first, (by + dy) * w + (bx + dx))) continue;
          return false;
        }
      }
    }
  }
  return true;
}

/** 降序的约数列表 */
function divisorsDesc(n: number): number[] {
  const out: number[] = [];
  for (let i = 1; i <= n; i += 1) {
    if (n % i === 0) out.push(i);
  }
  return out.reverse();
}

/**
 * 自动推断「几个图像像素 = 一个网格块」。
 *
 * 返回 1 表示没有识别出放大（要么本来就是 1×，要么图里有抗锯齿/噪声，
 * 块与块之间对不齐 —— 那种图本来也不该走反向解析）。
 */
export function detectPixelScale(image: RGBAImage): number {
  const g = runLengthGcd(image);
  if (g <= 1) return 1;

  for (const k of divisorsDesc(g)) {
    if (k <= 1) break;
    // 1×1 的网格没有意义（整张图一个颜色时会出现），留给 k=1
    if (image.width / k * (image.height / k) <= 1) continue;
    if (blocksUniform(image, k)) return k;
  }
  return 1;
}

interface CellColor {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** 按块取色（块的左上角像素就是这个块的颜色） */
function sampleCells(image: RGBAImage, k: number): CellColor[] {
  const gw = image.width / k;
  const gh = image.height / k;
  const cells: CellColor[] = [];
  for (let gy = 0; gy < gh; gy += 1) {
    for (let gx = 0; gx < gw; gx += 1) {
      const o = (gy * k * image.width + gx * k) * 4;
      cells.push({
        r: image.data[o] as number,
        g: image.data[o + 1] as number,
        b: image.data[o + 2] as number,
        a: image.data[o + 3] as number,
      });
    }
  }
  return cells;
}

function colorKey(cell: CellColor): string {
  return `${cell.r},${cell.g},${cell.b}`;
}

/**
 * 把一张像素图还原成网格 + 调色板。
 *
 * 像素本身一位都不改：颜色按「首次出现顺序」排成调色板，alpha 逐格保留。
 * 只有在颜色数超过 maxColors 时才量化（`quantized` 会告诉调用方）。
 */
export function reversePixelImage(image: RGBAImage, options: ReverseOptions = {}): ReverseResult {
  const { width: w, height: h } = image;
  if (w <= 0 || h <= 0) throw new Error('图片尺寸为 0，无法反解析');

  const forced = Math.round(options.scale ?? 0);
  const scale = forced > 0 ? forced : detectPixelScale(image);
  if (scale <= 0 || w % scale !== 0 || h % scale !== 0) {
    throw new Error(`放大倍数 ${scale} 不能整除图片尺寸 ${w}×${h}`);
  }

  const gw = w / scale;
  const gh = h / scale;
  if (gw * gh > MAX_REVERSE_CELLS) {
    throw new Error(
      `反解析后是 ${gw}×${gh} 格，超过 ${MAX_REVERSE_CELLS} 格上限。` +
        '这张图看起来不是低分辨率素材；如果确实要按像素编辑，请先裁小一点',
    );
  }

  const maxColors = Math.max(2, Math.min(PALETTE_MAX_COLORS, Math.round(options.maxColors ?? PALETTE_MAX_COLORS)));
  const cells = sampleCells(image, scale);
  const total = cells.length;

  /* 收集真实出现的颜色（全透明格不计，它们的索引落 0 且不可见） */
  const indexOf = new Map<string, number>();
  const colors: RGBA[] = [];
  let sourceColors = 0;
  let opaqueCells = 0;

  for (const cell of cells) {
    if (cell.a === 0) continue;
    opaqueCells += 1;
    const key = colorKey(cell);
    if (indexOf.has(key)) continue;
    indexOf.set(key, colors.length);
    colors.push([cell.r, cell.g, cell.b, 255]);
    sourceColors += 1;
  }

  // 全透明图也要给一块合法调色板，否则渲染端拿空数组会越界
  if (colors.length === 0) colors.push([0, 0, 0, 255]);

  const grid = createGrid(gw, gh);

  if (sourceColors <= maxColors) {
    for (let i = 0; i < total; i += 1) {
      const cell = cells[i] as CellColor;
      if (cell.a === 0) continue;
      grid.indices[i] = indexOf.get(colorKey(cell)) ?? 0;
      grid.alpha[i] = cell.a;
    }
    return {
      grid,
      palette: reversePalette(colors),
      scale,
      sourceColors,
      quantized: false,
    };
  }

  /* 颜色超过上限：按 k-means 量化（保留 alpha，不抖动 —— 保真优先） */
  const rgba = new Uint8ClampedArray(total * 4);
  const samples = new Uint8Array(opaqueCells * 3);
  let s = 0;
  for (let i = 0; i < total; i += 1) {
    const cell = cells[i] as CellColor;
    const o = i * 4;
    rgba[o] = cell.r;
    rgba[o + 1] = cell.g;
    rgba[o + 2] = cell.b;
    rgba[o + 3] = cell.a;
    if (cell.a === 0) continue;
    samples[s] = cell.r;
    samples[s + 1] = cell.g;
    samples[s + 2] = cell.b;
    s += 3;
  }

  const generated = kmeansPalette(strideSamples({ data: samples, count: opaqueCells }, 20000), maxColors);
  const target = { indices: grid.indices, alpha: grid.alpha };
  quantizeInto(
    { width: gw, height: gh, data: rgba },
    { palette: generated, distance: 'weighted', dither: 'none', ditherStrength: 0 },
    target,
  );

  return {
    grid,
    palette: reversePalette(generated),
    scale,
    sourceColors,
    quantized: true,
  };
}

function reversePalette(colors: RGBA[]): Palette {
  return {
    id: 'reverse',
    name: `反解析 ${colors.length} 色`,
    colors,
    builtin: false,
    source: 'extracted',
  };
}
