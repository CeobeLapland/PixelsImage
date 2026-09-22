/**
 * k-means 聚类出代表色。
 *
 * 两个用途：
 * 1. 「k-means 限色」转换模式：直接从图里聚出 N 个主色当调色板（docs/DESIGN.md §4.3 模式 B）；
 * 2. 调色板提色的备选方法（`palettes/extract.ts`）。
 *
 * **确定性是第一要求**：同一张图跑两次必须给出完全一样的调色板，否则用户
 * 每拖一次抖动滑块调色板就变一次，手改的颜色会跟着乱跳。
 * 所以初始化不用 k-means++ 的随机采样，而用最大最小距离法（farthest-first）：
 * 第一个中心取离样本均值最远的点，之后每次取「到已有中心最近距离」最大的点。
 */

import type { RGBA } from '../types';

export interface KmeansOptions {
  /** 迭代上限。像素画不需要收敛到极致，8–12 次足够 */
  iterations?: number;
  /** 参与聚类的样本上限，超过则等步长抽稀（保证大图也能秒出） */
  maxSamples?: number;
}

/** RGB 样本的缓冲类型：内部用 Uint8Array，直接从 ImageData 抽时是 Uint8ClampedArray */
export type RgbBuffer = Uint8Array | Uint8ClampedArray;

/** 样本是一串扁平的 RGB 三元组：长度 = 样本数 × 3 */
export interface RgbSamples {
  data: RgbBuffer;
  /** 样本个数 */
  count: number;
}

/**
 * 加权 RGB 距离的平方（与 `color/distance.ts` 的加权口径一致）。
 * 用平方而不是开根：聚类只需要比较大小，省掉每轮几万次 Math.sqrt。
 */
function distanceSq(
  r1: number,
  g1: number,
  b1: number,
  r2: number,
  g2: number,
  b2: number,
): number {
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  return 2 * dr * dr + 4 * dg * dg + 3 * db * db;
}

/** 等步长抽稀，把样本数压到上限以内 */
export function strideSamples(samples: RgbSamples, maxSamples: number): RgbSamples {
  if (samples.count <= maxSamples || maxSamples <= 0) return samples;
  const stride = Math.ceil(samples.count / maxSamples);
  const count = Math.ceil(samples.count / stride);
  const data = new Uint8Array(count * 3);
  for (let i = 0, o = 0; i < samples.count; i += stride, o += 3) {
    const src = i * 3;
    data[o] = samples.data[src] ?? 0;
    data[o + 1] = samples.data[src + 1] ?? 0;
    data[o + 2] = samples.data[src + 2] ?? 0;
  }
  return { data, count };
}

/** 去掉完全重复的颜色，保持首次出现的顺序 */
export function uniqueSamples(samples: RgbSamples): RgbSamples {
  const seen = new Set<number>();
  const keep: number[] = [];
  for (let i = 0; i < samples.count; i += 1) {
    const o = i * 3;
    const r = samples.data[o] ?? 0;
    const g = samples.data[o + 1] ?? 0;
    const b = samples.data[o + 2] ?? 0;
    const key = (r << 16) | (g << 8) | b;
    if (seen.has(key)) continue;
    seen.add(key);
    keep.push(o);
  }
  const data = new Uint8Array(keep.length * 3);
  for (let k = 0; k < keep.length; k += 1) {
    const src = keep[k] ?? 0;
    data[k * 3] = samples.data[src] ?? 0;
    data[k * 3 + 1] = samples.data[src + 1] ?? 0;
    data[k * 3 + 2] = samples.data[src + 2] ?? 0;
  }
  return { data, count: keep.length };
}

/**
 * 聚出 k 个代表色。
 *
 * 返回值个数可能少于 k：样本里的不同颜色比 k 还少时，多出来的中心没有意义
 * （返回重复色会污染调色板，也会让「实际用到几种色」的统计虚高）。
 */
export function kmeansPalette(
  input: RgbSamples,
  k: number,
  options: KmeansOptions = {},
): RGBA[] {
  const wanted = Math.max(1, Math.min(256, Math.round(k)));
  const iterations = Math.max(1, options.iterations ?? 10);
  const samples = uniqueSamples(strideSamples(input, options.maxSamples ?? 20000));
  const n = samples.count;
  if (n === 0) return [];

  const { data } = samples;
  const kk = Math.min(wanted, n);

  /* ---- 初始化：farthest-first ---- */
  const centers = new Float32Array(kk * 3);
  // 第一个中心：离全体样本均值最远的点。比「取第一个样本」稳定得多 ——
  // 否则调色板会依赖像素扫描顺序（左上角有块黑边就全歪了）
  let mr = 0;
  let mg = 0;
  let mb = 0;
  for (let i = 0; i < n; i += 1) {
    mr += data[i * 3] ?? 0;
    mg += data[i * 3 + 1] ?? 0;
    mb += data[i * 3 + 2] ?? 0;
  }
  mr /= n;
  mg /= n;
  mb /= n;

  let best = 0;
  let bestDist = -1;
  for (let i = 0; i < n; i += 1) {
    const d = distanceSq(data[i * 3] ?? 0, data[i * 3 + 1] ?? 0, data[i * 3 + 2] ?? 0, mr, mg, mb);
    if (d > bestDist) {
      bestDist = d;
      best = i;
    }
  }
  centers[0] = data[best * 3] ?? 0;
  centers[1] = data[best * 3 + 1] ?? 0;
  centers[2] = data[best * 3 + 2] ?? 0;

  // 每个样本到最近中心的距离，随中心增加而单调减少，只需增量更新
  const nearest = new Float32Array(n).fill(Infinity);

  for (let c = 1; c < kk; c += 1) {
    const cr = centers[(c - 1) * 3] ?? 0;
    const cg = centers[(c - 1) * 3 + 1] ?? 0;
    const cb = centers[(c - 1) * 3 + 2] ?? 0;
    let far = 0;
    let farDist = -1;
    for (let i = 0; i < n; i += 1) {
      const d = distanceSq(data[i * 3] ?? 0, data[i * 3 + 1] ?? 0, data[i * 3 + 2] ?? 0, cr, cg, cb);
      if (d < (nearest[i] ?? Infinity)) nearest[i] = d;
      if ((nearest[i] ?? 0) > farDist) {
        farDist = nearest[i] ?? 0;
        far = i;
      }
    }
    centers[c * 3] = data[far * 3] ?? 0;
    centers[c * 3 + 1] = data[far * 3 + 1] ?? 0;
    centers[c * 3 + 2] = data[far * 3 + 2] ?? 0;
  }

  /* ---- 迭代 ---- */
  const assign = new Int32Array(n).fill(-1);
  const sumR = new Float64Array(kk);
  const sumG = new Float64Array(kk);
  const sumB = new Float64Array(kk);
  const counts = new Int32Array(kk);

  for (let iter = 0; iter < iterations; iter += 1) {
    let moved = false;

    // 归类
    for (let i = 0; i < n; i += 1) {
      const r = data[i * 3] ?? 0;
      const g = data[i * 3 + 1] ?? 0;
      const b = data[i * 3 + 2] ?? 0;
      let target = 0;
      let targetDist = Infinity;
      for (let c = 0; c < kk; c += 1) {
        const d = distanceSq(r, g, b, centers[c * 3] ?? 0, centers[c * 3 + 1] ?? 0, centers[c * 3 + 2] ?? 0);
        if (d < targetDist) {
          targetDist = d;
          target = c;
        }
      }
      if (assign[i] !== target) {
        assign[i] = target;
        moved = true;
      }
    }

    // 重算中心
    sumR.fill(0);
    sumG.fill(0);
    sumB.fill(0);
    counts.fill(0);
    for (let i = 0; i < n; i += 1) {
      const c = assign[i] ?? 0;
      sumR[c] += data[i * 3] ?? 0;
      sumG[c] += data[i * 3 + 1] ?? 0;
      sumB[c] += data[i * 3 + 2] ?? 0;
      counts[c] += 1;
    }
    for (let c = 0; c < kk; c += 1) {
      const count = counts[c] ?? 0;
      // 空簇保留原中心：重新随机播种会破坏确定性，也没有实际收益
      if (count === 0) continue;
      centers[c * 3] = sumR[c] / count;
      centers[c * 3 + 1] = sumG[c] / count;
      centers[c * 3 + 2] = sumB[c] / count;
    }

    if (!moved) break;
  }

  /* ---- 输出：按占样数降序，主色在前 ---- */
  const order = Array.from({ length: kk }, (_, c) => c)
    .filter((c) => (counts[c] ?? 0) > 0)
    .sort((a, b) => (counts[b] ?? 0) - (counts[a] ?? 0));

  return order.map((c) => {
    const r = Math.max(0, Math.min(255, Math.round(centers[c * 3] ?? 0)));
    const g = Math.max(0, Math.min(255, Math.round(centers[c * 3 + 1] ?? 0)));
    const b = Math.max(0, Math.min(255, Math.round(centers[c * 3 + 2] ?? 0)));
    return [r, g, b, 255] as unknown as RGBA;
  });
}