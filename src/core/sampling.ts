/**
 * 降采样：把源图缩到目标格数。
 *
 * 四种模式对应四种意图（见 docs/DESIGN.md §4.1）：
 *   nearest  保留原始硬边缘 —— 源图本身就是像素画时用
 *   area     面积平均（默认）—— 照片/插画最稳
 *   dominant 块内主色投票 —— 想要色块感、避免产生原图不存在的混合色
 *   median   块内取中位数 —— 抗噪点、抗单点高光污染
 *
 * 关键细节：**所有平均都必须按 alpha 预乘**。
 * 直接把透明像素的 RGB 一起平均，会把完全无关的颜色混进来（透明像素的 RGB
 * 常常是残留的白色或黑色），导致边缘出现脏色。所以：
 *   先累加 Σ(w·a)、Σ(w·a·c)，再用 Σ(w·a·c)/Σ(w·a) 还原颜色。
 */

import type { RGBAImage, SamplingMode } from './types';

type RGBAImageData = { width: number; height: number; data: Uint8ClampedArray };

/* --------------------------------------------------- dominant 模式的直方图 */

/** 5bit/通道 的直方图容器，容量 32³。模块级复用，避免每次转换都分配 */
const HIST_SIZE = 32768;

const histCount = new Float32Array(HIST_SIZE);
const histR = new Float32Array(HIST_SIZE);
const histG = new Float32Array(HIST_SIZE);
const histB = new Float32Array(HIST_SIZE);
/** 每个桶所属的轮次；不等于当前轮次即视为空 */
const histStamp = new Int32Array(HIST_SIZE);
/**
 * 本轮被写入过的桶列表 —— 找最大值只需扫这些，而不是扫满 32768 项。
 *
 * 长度必须等于 HIST_SIZE：一个格子里的不同颜色数上限就是 32768
 * （5bit/通道），若用小数组截断，超出的桶不计入投票，
 * 结果会静默偏向先扫到的颜色。一次分配 128KB，全程复用。
 */
const touched = new Int32Array(HIST_SIZE);
let touchedCount = 0;
let histEpoch = 0;

function resetHistogram(): void {
  histEpoch += 1;
  touchedCount = 0;
}

function histBump(r: number, g: number, b: number, weight: number): void {
  const key = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
  if (histStamp[key] !== histEpoch) {
    histStamp[key] = histEpoch;
    histCount[key] = weight;
    histR[key] = r * weight;
    histG[key] = g * weight;
    histB[key] = b * weight;
    touched[touchedCount] = key;
    touchedCount += 1;
    return;
  }
  histCount[key] += weight;
  histR[key] += r * weight;
  histG[key] += g * weight;
  histB[key] += b * weight;
}

/* ------------------------------------------------------------- 最近邻放大 */

/**
 * pixelPerfect 用：以整数倍最近邻把源图放大到中间尺寸。
 * 放大的目的是让后续的面积平均能用「整数倍」去做，保证每格覆盖像素数一致。
 */
export function upscaleNearest(
  src: RGBAImage,
  dstW: number,
  dstH: number,
): RGBAImageData {
  const out = new Uint8ClampedArray(dstW * dstH * 4);
  const { width: sw, height: sh, data } = src;
  for (let y = 0; y < dstH; y += 1) {
    const sy = Math.min(sh - 1, Math.floor((y * sh) / dstH));
    for (let x = 0; x < dstW; x += 1) {
      const sx = Math.min(sw - 1, Math.floor((x * sw) / dstW));
      const so = (sy * sw + sx) * 4;
      const dof = (y * dstW + x) * 4;
      out[dof] = data[so];
      out[dof + 1] = data[so + 1];
      out[dof + 2] = data[so + 2];
      out[dof + 3] = data[so + 3];
    }
  }
  return { width: dstW, height: dstH, data: out };
}

/* --------------------------------------------------------------- 主入口 */

/**
 * 降采样。
 *
 * pixelPerfect = true 时先做一次整数倍最近邻放大，再做面积平均。
 * 原因是当源图尺寸不是目标格数的整数倍时，面积平均会让不同格子覆盖
 * 不同数量的源像素（有的覆盖 2 个、有的 3 个），同一视觉元素在不同
 * 位置的大小会不一致 —— 这是像素画的经典瑕疵。
 */
export function downsample(
  src: RGBAImage,
  targetW: number,
  targetH: number,
  mode: SamplingMode,
  pixelPerfect: boolean,
): RGBAImageData {
  const tw = Math.max(1, Math.round(targetW));
  const th = Math.max(1, Math.round(targetH));

  let input: RGBAImage = src;

  if (pixelPerfect && mode !== 'nearest') {
    // 找一个整数倍 k，使得 tw*k、th*k 都 ≥ 源图尺寸（放大而非缩小时才需要 k>1）
    const k = Math.max(1, Math.ceil(Math.max(src.width / tw, src.height / th)));
    if (k > 1) {
      input = upscaleNearest(src, tw * k, th * k);
    }
  }

  switch (mode) {
    case 'nearest':
      return sampleNearest(input, tw, th);
    case 'dominant':
      return sampleDominant(input, tw, th);
    case 'median':
      return sampleMedian(input, tw, th);
    case 'area':
    default:
      return sampleArea(input, tw, th);
  }
}

/** 取块中心像素 */
function sampleNearest(src: RGBAImage, tw: number, th: number): RGBAImageData {
  const out = new Uint8ClampedArray(tw * th * 4);
  const { width: sw, height: sh, data } = src;
  for (let ty = 0; ty < th; ty += 1) {
    const sy = Math.min(sh - 1, Math.floor(((ty + 0.5) * sh) / th));
    for (let tx = 0; tx < tw; tx += 1) {
      const sx = Math.min(sw - 1, Math.floor(((tx + 0.5) * sw) / tw));
      const so = (sy * sw + sx) * 4;
      const dof = (ty * tw + tx) * 4;
      out[dof] = data[so];
      out[dof + 1] = data[so + 1];
      out[dof + 2] = data[so + 2];
      out[dof + 3] = data[so + 3];
    }
  }
  return { width: tw, height: th, data: out };
}

/**
 * 面积平均（alpha 预乘）。
 * 用真实覆盖面积做权重，因此非整数倍缩放时不会出现规则条纹。
 */
function sampleArea(src: RGBAImage, tw: number, th: number): RGBAImageData {
  const out = new Uint8ClampedArray(tw * th * 4);
  const { width: sw, height: sh, data } = src;
  const xScale = sw / tw;
  const yScale = sh / th;

  for (let ty = 0; ty < th; ty += 1) {
    const y0 = ty * yScale;
    const y1 = (ty + 1) * yScale;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(sh, Math.ceil(y1));

    for (let tx = 0; tx < tw; tx += 1) {
      const x0 = tx * xScale;
      const x1 = (tx + 1) * xScale;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(sw, Math.ceil(x1));

      let sumW = 0;
      let sumA = 0;
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;

      for (let y = iy0; y < iy1; y += 1) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        if (wy <= 0) continue;
        for (let x = ix0; x < ix1; x += 1) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const o = (y * sw + x) * 4;
          const a = data[o + 3] / 255;
          sumW += w;
          sumA += w * a;
          if (a > 0) {
            sumR += w * a * data[o];
            sumG += w * a * data[o + 1];
            sumB += w * a * data[o + 2];
          }
        }
      }

      const dof = (ty * tw + tx) * 4;
      if (sumW <= 0 || sumA <= 0) {
        out[dof] = 0;
        out[dof + 1] = 0;
        out[dof + 2] = 0;
        out[dof + 3] = 0;
        continue;
      }
      // 未被 alpha 覆盖的部分视为透明，所以平均 alpha 要按总面积算
      out[dof] = Math.round(sumR / sumA);
      out[dof + 1] = Math.round(sumG / sumA);
      out[dof + 2] = Math.round(sumB / sumA);
      out[dof + 3] = Math.round((sumA / sumW) * 255);
    }
  }
  return { width: tw, height: th, data: out };
}

/**
 * 主色投票：块内像素量化到 5bit 后投票，取占比最高那一档的平均色。
 * 取平均而不是取桶中心，是为了避免颜色整体偏移。
 */
function sampleDominant(src: RGBAImage, tw: number, th: number): RGBAImageData {
  const out = new Uint8ClampedArray(tw * th * 4);
  const { width: sw, height: sh, data } = src;
  const xScale = sw / tw;
  const yScale = sh / th;

  for (let ty = 0; ty < th; ty += 1) {
    const y0 = ty * yScale;
    const y1 = (ty + 1) * yScale;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(sh, Math.ceil(y1));

    for (let tx = 0; tx < tw; tx += 1) {
      const x0 = tx * xScale;
      const x1 = (tx + 1) * xScale;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(sw, Math.ceil(x1));

      resetHistogram();
      let totalW = 0;
      let totalA = 0;

      for (let y = iy0; y < iy1; y += 1) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        if (wy <= 0) continue;
        for (let x = ix0; x < ix1; x += 1) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (wx <= 0) continue;
          const o = (y * sw + x) * 4;
          const a = data[o + 3] / 255;
          const w = wx * wy;
          totalW += w;
          totalA += w * a;
          if (a > 0) {
            histBump(data[o], data[o + 1], data[o + 2], w * a);
          }
        }
      }

      const dof = (ty * tw + tx) * 4;
      if (totalW <= 0 || totalA <= 0) {
        continue; // 保持全透明
      }

      // 只看本轮写入过的桶，而不是扫满 32768 项
      let bestKey = -1;
      let bestCount = -1;
      for (let t = 0; t < touchedCount; t += 1) {
        const key = touched[t];
        const c = histCount[key];
        if (c > bestCount) {
          bestCount = c;
          bestKey = key;
        }
      }

      if (bestKey < 0 || bestCount <= 0) continue;
      out[dof] = Math.round(histR[bestKey] / bestCount);
      out[dof + 1] = Math.round(histG[bestKey] / bestCount);
      out[dof + 2] = Math.round(histB[bestKey] / bestCount);
      out[dof + 3] = Math.round((totalA / totalW) * 255);
    }
  }
  return { width: tw, height: th, data: out };
}

/** 中位数：各通道取中位数，抗噪点与单点高光 */
function sampleMedian(src: RGBAImage, tw: number, th: number): RGBAImageData {
  const out = new Uint8ClampedArray(tw * th * 4);
  const { width: sw, height: sh, data } = src;
  const xScale = sw / tw;
  const yScale = sh / th;

  // 复用缓冲；按需扩容
  let cap = 64;
  let bufR = new Uint8Array(cap);
  let bufG = new Uint8Array(cap);
  let bufB = new Uint8Array(cap);

  for (let ty = 0; ty < th; ty += 1) {
    const y0 = ty * yScale;
    const y1 = (ty + 1) * yScale;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(sh, Math.ceil(y1));

    for (let tx = 0; tx < tw; tx += 1) {
      const x0 = tx * xScale;
      const x1 = (tx + 1) * xScale;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(sw, Math.ceil(x1));

      let count = 0;
      let sumA = 0;
      let sumW = 0;

      for (let y = iy0; y < iy1; y += 1) {
        const wy = Math.min(y + 1, y1) - Math.max(y, y0);
        if (wy <= 0) continue;
        for (let x = ix0; x < ix1; x += 1) {
          const wx = Math.min(x + 1, x1) - Math.max(x, x0);
          if (wx <= 0) continue;
          const o = (y * sw + x) * 4;
          const w = wx * wy;
          sumW += w;
          const a = data[o + 3];
          sumA += (w * a) / 255;
          if (a === 0) continue;

          if (count >= cap) {
            cap *= 2;
            const nr = new Uint8Array(cap);
            const ng = new Uint8Array(cap);
            const nb = new Uint8Array(cap);
            nr.set(bufR);
            ng.set(bufG);
            nb.set(bufB);
            bufR = nr;
            bufG = ng;
            bufB = nb;
          }
          bufR[count] = data[o];
          bufG[count] = data[o + 1];
          bufB[count] = data[o + 2];
          count += 1;
        }
      }

      const dof = (ty * tw + tx) * 4;
      if (count === 0 || sumW <= 0) {
        continue; // 全透明
      }

      const viewR = bufR.subarray(0, count).sort();
      const viewG = bufG.subarray(0, count).sort();
      const viewB = bufB.subarray(0, count).sort();
      const mid = count >> 1;

      out[dof] = viewR[mid];
      out[dof + 1] = viewG[mid];
      out[dof + 2] = viewB[mid];
      out[dof + 3] = Math.round((sumA / sumW) * 255);
    }
  }
  return { width: tw, height: th, data: out };
}