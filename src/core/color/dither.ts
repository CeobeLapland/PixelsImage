/**
 * 抖动：有序（Bayer）阈值矩阵 + 误差扩散卷积核。
 *
 * 两类抖动天然不同，放在一起是因为它们共用「扩散强度」这一个调节量：
 * - 有序抖动：加阈值偏移后再查找最近色，图案规则、可无缝平铺
 * - 误差扩散：量化当前像素后，把误差按核权重加到尚未处理的邻居上
 *
 * 误差扩散的核定义只是数据；执行循环在 quantize.ts 里（必须与量化交织）。
 */

import type { DitherMode } from '../types';

/* ----------------------------------------------------------- 有序抖动矩阵 */

/** Bayer 2×2 */
const BAYER_2 = new Uint8Array([0, 2, 3, 1]);

/** Bayer 4×4（标准递归构造） */
const BAYER_4 = new Uint8Array([
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
]);

/** Bayer 8×8 */
const BAYER_8 = new Uint8Array([
  0, 32, 8, 40, 2, 34, 10, 42,
  48, 16, 56, 24, 50, 18, 58, 26,
  12, 44, 4, 36, 14, 46, 6, 38,
  60, 28, 52, 20, 62, 30, 54, 22,
  3, 35, 11, 43, 1, 33, 9, 41,
  51, 19, 59, 27, 49, 17, 57, 25,
  15, 47, 7, 39, 13, 45, 5, 37,
  63, 31, 55, 23, 61, 29, 53, 21,
]);

export interface OrderedMatrix {
  size: number;
  data: Uint8Array;
}

export function getOrderedMatrix(mode: DitherMode): OrderedMatrix | null {
  switch (mode) {
    case 'bayer2':
      return { size: 2, data: BAYER_2 };
    case 'bayer4':
      return { size: 4, data: BAYER_4 };
    case 'bayer8':
      return { size: 8, data: BAYER_8 };
    default:
      return null;
  }
}

/* ------------------------------------------------------------- 误差扩散核 */

export interface DiffusionEntry {
  dx: number;
  dy: number;
  /** 分子权重；实际扩散量 = 误差 * (w / divisor) * strength */
  w: number;
}

export interface DiffusionKernel {
  divisor: number;
  entries: readonly DiffusionEntry[];
}

/** Floyd–Steinberg：细节最好，但有「虫形」伪影 */
const FLOYD: DiffusionKernel = {
  divisor: 16,
  entries: [
    { dx: 1, dy: 0, w: 7 },
    { dx: -1, dy: 1, w: 3 },
    { dx: 0, dy: 1, w: 5 },
    { dx: 1, dy: 1, w: 1 },
  ],
};

/**
 * Atkinson：只扩散 6/8 的误差，对比度高、伪影少。
 * 这是像素画圈的偏好选择，也是本工具的默认值。
 */
const ATKINSON: DiffusionKernel = {
  divisor: 8,
  entries: [
    { dx: 1, dy: 0, w: 1 },
    { dx: 2, dy: 0, w: 1 },
    { dx: -1, dy: 1, w: 1 },
    { dx: 0, dy: 1, w: 1 },
    { dx: 1, dy: 1, w: 1 },
    { dx: 0, dy: 2, w: 1 },
  ],
};

/** Sierra（Sierra-3）：介于 Floyd 与 Atkinson 之间 */
const SIERRA: DiffusionKernel = {
  divisor: 32,
  entries: [
    { dx: 1, dy: 0, w: 5 },
    { dx: 2, dy: 0, w: 3 },
    { dx: -2, dy: 1, w: 2 },
    { dx: -1, dy: 1, w: 4 },
    { dx: 0, dy: 1, w: 5 },
    { dx: 1, dy: 1, w: 4 },
    { dx: 2, dy: 1, w: 2 },
    { dx: -1, dy: 2, w: 2 },
    { dx: 0, dy: 2, w: 3 },
    { dx: 1, dy: 2, w: 2 },
  ],
};

export function getDiffusionKernel(mode: DitherMode): DiffusionKernel | null {
  switch (mode) {
    case 'floyd':
      return FLOYD;
    case 'atkinson':
      return ATKINSON;
    case 'sierra':
      return SIERRA;
    default:
      return null;
  }
}

/* --------------------------------------------------------- 抖动幅度估计 */

/**
 * 有序抖动需要知道「加多大的阈值偏移才够」。
 *
 * 硬编码一个常数（比如 64）在不同调色板下表现差异很大：
 * 16 色的 Minecraft 板色距大，需要强偏移才有可见过渡；
 * 而 256 色板色距很小，同样的偏移会变成噪点。
 *
 * 所以按调色板自身的平均最近邻色距来定，强度 1 时偏移峰值 ≈ 色距。
 */
export function estimateDitherSpread(colors: readonly (readonly number[])[]): number {
  const n = colors.length;
  if (n < 2) return 0;

  let total = 0;
  for (let i = 0; i < n; i += 1) {
    const a = colors[i];
    let best = Infinity;
    for (let j = 0; j < n; j += 1) {
      if (i === j) continue;
      const b = colors[j];
      const dr = a[0] - b[0];
      const dg = a[1] - b[1];
      const db = a[2] - b[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < best) best = d;
    }
    if (best < Infinity) total += Math.sqrt(best);
  }
  return total / n;
}