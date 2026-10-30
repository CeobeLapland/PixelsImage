/**
 * 预处理：在降采样**之前**作用于源图。
 *
 * 顺序是刻意的：
 *   ① 去背景色      —— 用**原图颜色**判定，与你眼里的原图一致（先调亮度就会判错）
 *   ② 亮度/对比度/饱和度 —— 逐像素的颜色调整
 *   ③ 锐化               —— 需要邻域，必须在下采样前做，否则边缘已经糊掉了
 *   ④ alpha 阈值         —— 去背景要放在最后，否则调色时会把背景色也一起算进去
 *   ⑤ 边缘色晕清理       —— 必须在阈值之后：它要靠「谁还是半透明」来判断边缘
 *
 * 全部返回新缓冲，不改动调用方的源数据（源图要能反复重算）。
 */

import { parseHex } from './color/space';
import type { PreprocessSettings, RGBAImage } from './types';

type RGBAImageData = { width: number; height: number; data: Uint8ClampedArray };

/** 判断设置是否全为中性值，是则可以整体跳过 */
export function isPreprocessIdentity(p: PreprocessSettings): boolean {
  return (
    p.brightness === 0 &&
    p.contrast === 0 &&
    p.saturation === 0 &&
    p.sharpen === 0 &&
    p.alphaThreshold >= 255 &&
    !p.decontaminate &&
    p.removeBackground === 'none'
  );
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** 亮度 / 对比度 / 饱和度 */
function applyColorAdjust(
  data: Uint8ClampedArray,
  p: PreprocessSettings,
): void {
  const brightOffset = (p.brightness / 100) * 128;

  // 标准对比度公式，输入范围映射到 -255..255
  const c = (p.contrast / 100) * 255;
  const contrastFactor = (259 * (c + 255)) / (255 * (259 - c));

  const satFactor = 1 + p.saturation / 100;

  const n = data.length;
  for (let o = 0; o < n; o += 4) {
    if (data[o + 3] === 0) continue;

    let r = data[o];
    let g = data[o + 1];
    let b = data[o + 2];

    if (p.brightness !== 0) {
      r += brightOffset;
      g += brightOffset;
      b += brightOffset;
    }

    if (p.contrast !== 0) {
      r = contrastFactor * (r - 128) + 128;
      g = contrastFactor * (g - 128) + 128;
      b = contrastFactor * (b - 128) + 128;
    }

    if (p.saturation !== 0) {
      // Rec.601 亮度权重
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      r = luma + (r - luma) * satFactor;
      g = luma + (g - luma) * satFactor;
      b = luma + (b - luma) * satFactor;
    }

    data[o] = clamp255(Math.round(r));
    data[o + 1] = clamp255(Math.round(g));
    data[o + 2] = clamp255(Math.round(b));
  }
}

/**
 * 3×3 反锐化掩模（unsharp）。
 * 用「原图 + 强度·(原图 − 均值)」实现，比卷积核实现更容易控制强度。
 */
function applySharpen(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  amount: number,
): void {
  const src = new Uint8ClampedArray(data);
  const k = amount / 100;

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const o = (y * w + x) * 4;
      if (src[o + 3] === 0) continue;

      let sr = 0;
      let sg = 0;
      let sb = 0;
      let count = 0;

      for (let dy = -1; dy <= 1; dy += 1) {
        const ny = y + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          const nx = x + dx;
          if (nx < 0 || nx >= w) continue;
          const no = (ny * w + nx) * 4;
          if (src[no + 3] === 0) continue;
          sr += src[no];
          sg += src[no + 1];
          sb += src[no + 2];
          count += 1;
        }
      }

      if (count === 0) continue;
      const mr = sr / count;
      const mg = sg / count;
      const mb = sb / count;

      data[o] = clamp255(Math.round(src[o] + k * (src[o] - mr)));
      data[o + 1] = clamp255(Math.round(src[o + 1] + k * (src[o + 1] - mg)));
      data[o + 2] = clamp255(Math.round(src[o + 2] + k * (src[o + 2] - mb)));
    }
  }
}

/** alpha 阈值：低于阈值的 alpha 直接归零（去背景） */
function applyAlphaThreshold(data: Uint8ClampedArray, threshold: number): void {
  const n = data.length;
  for (let o = 3; o < n; o += 4) {
    if (data[o] < threshold) data[o] = 0;
  }
}

/* ------------------------------------------------------------ 去背景色 */

/** 去底色时判定「多像底色才算背景」：取各通道差值的最大者，比欧氏距离更直观可控 */
function distanceTo(base: readonly [number, number, number], r: number, g: number, b: number): number {
  const dr = r - base[0];
  const dg = g - base[1];
  const db = b - base[2];
  return Math.max(dr < 0 ? -dr : dr, dg < 0 ? -dg : dg, db < 0 ? -db : db);
}

export interface RemoveBackgroundOptions {
  /** 'edges' = 只去与画面边缘连通的区域；'all' = 所有近底色像素 */
  mode: 'edges' | 'all';
  /** 每通道与底色的最大差值 */
  tolerance: number;
  /** 边缘软化：过渡像素按相似度给半透明 */
  softEdge: boolean;
  /** 底色，默认白 */
  color?: readonly [number, number, number];
}

export interface RemoveBackgroundResult {
  /** 被置为全透明的像素数 */
  removed: number;
  /** 被软化的边缘像素数 */
  softened: number;
}

/**
 * 按颜色去背景（去白底）。
 *
 * 核心是**从画面四边做泛洪**（flood fill），只擦掉「与边缘连通」的近底色区域。
 * 为什么不简单地「所有近白像素都擦掉」：主体内部的白色（眼睛高光、白衣服、
 * 白字、反光）会被一起干掉，而这类误杀没法用撤销救回来 —— 它发生在预处理阶段，
 * 每次重算都会重来一遍。连通性判断是这个问题唯一可靠的解法。
 *
 * 用显式栈而不是递归：4K 图的背景可能有上千万像素，递归会直接爆栈。
 * 用 Uint8Array 记访问标记而不是 Set：正整数索引下它更快也更省。
 *
 * 代价：多一张与像素数等长的标记数组（4K 图约 8MB，处理上限那张 64MP 的图约 64MB）。
 * 这张数组不能省 —— 它区分「本来透明」和「刚被去掉」两种像素，
 * 而边缘软化必须只处理后者（否则会把原本透明的像素染成半透明，凭空多出一片雾）。
 *
 * 边缘软化：抗锯齿边缘是主体色与底色的混合（比如黑主体配白底，边缘是灰）。
 * 一刀切成不透明会留下一圈灰边，降采样后就是脏边。开启后这些**紧贴背景**的
 * 过渡像素按「离底色多远」拿到一个半透明 alpha —— 再配合色晕清理把它们的 RGB
 * 换成主体色，边缘就干净了。
 *
 * 两条阈值各管一段：距底色 ≤ 容差 → 整格去掉；容差 < 距底色 ≤ 容差×3 → 半透明。
 */
export function removeBackgroundColor(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  options: RemoveBackgroundOptions,
): RemoveBackgroundResult {
  const total = w * h;
  if (w <= 0 || h <= 0) return { removed: 0, softened: 0 };

  const base = options.color ?? ([255, 255, 255] as const);
  const tol = Math.max(0, options.tolerance);
  // 软化上限取容差的 3 倍：再远就已经是主体色了，不该继续给它透明度
  const softLimit = tol * 3;

  const removed = new Uint8Array(total);
  const result: RemoveBackgroundResult = { removed: 0, softened: 0 };

  /** 命中判定：透明像素不算（已经是背景），底色范围内的算 */
  const isBackground = (i: number): boolean => {
    const o = i * 4;
    if (data[o + 3] === 0) return false;
    return distanceTo(base, data[o], data[o + 1], data[o + 2]) <= tol;
  };

  if (options.mode === 'all') {
    for (let i = 0; i < total; i += 1) {
      if (!isBackground(i)) continue;
      data[i * 4 + 3] = 0;
      removed[i] = 1;
      result.removed += 1;
    }
  } else {
    /* 种子：四条边上的近底色像素 */
    const stack: number[] = [];
    const push = (i: number): void => {
      if (removed[i] === 1 || !isBackground(i)) return;
      removed[i] = 1;
      stack.push(i);
    };

    for (let x = 0; x < w; x += 1) {
      push(x);
      push((h - 1) * w + x);
    }
    for (let y = 0; y < h; y += 1) {
      push(y * w);
      push(y * w + w - 1);
    }

    while (stack.length > 0) {
      const i = stack.pop() as number;
      const x = i % w;
      const y = (i - x) / w;
      if (x > 0) push(i - 1);
      if (x < w - 1) push(i + 1);
      if (y > 0) push(i - w);
      if (y < h - 1) push(i + w);
    }

    for (let i = 0; i < total; i += 1) {
      if (removed[i] === 1) {
        data[i * 4 + 3] = 0;
        result.removed += 1;
      }
    }
  }

  if (!options.softEdge || softLimit <= 0) return result;

  /*
   * 软化：找出所有「紧贴已去除区域、且自己还没到主体色那么远」的像素。
   * 先把候选收集起来再改 alpha —— 边扫边改会让后面的判定读到已经改过的邻居。
   */
  const candidates: number[] = [];
  for (let i = 0; i < total; i += 1) {
    if (removed[i] === 1) continue;
    if (data[i * 4 + 3] === 0) continue; // 本来就是透明的边缘，不重复处理

    const x = i % w;
    const y = (i - x) / w;
    const touchesBackground =
      (x > 0 && removed[i - 1] === 1) ||
      (x < w - 1 && removed[i + 1] === 1) ||
      (y > 0 && removed[i - w] === 1) ||
      (y < h - 1 && removed[i + w] === 1);
    if (!touchesBackground) continue;

    const o = i * 4;
    const d = distanceTo(base, data[o], data[o + 1], data[o + 2]);
    if (d >= softLimit) continue; // 已经基本是主体色了，保持不透明
    candidates.push(i);
  }

  for (const i of candidates) {
    const o = i * 4;
    const d = distanceTo(base, data[o], data[o + 1], data[o + 2]);
    // d 越小说明越接近底色 → alpha 越小
    data[o + 3] = clamp255(Math.round((d / softLimit) * 255));
    result.softened += 1;
  }

  return result;
}

/**
 * 边缘色晕清理（color decontamination）。
 *
 * 问题：抠图或 α 阈值去背后，边缘那圈**半透明**像素的 RGB 里仍然混着原来的背景色
 * （绿幕残留、白底灰边就是这么来的）。降到像素画尺寸时，这些混合色会变成一圈脏边，
 * 而且它会被当成「真实颜色」参与量化，把调色板带偏。
 *
 * 做法：从贴着不透明像素的半透明像素出发，把不透明像素的颜色一层层「灌」进半透明边缘，
 * 最多扩散 `rings` 圈。只改 RGB，不动 alpha —— 边缘的柔和过渡该保留还保留，
 * 只是它通往的颜色换成了主体色。
 *
 * 超大图直接跳过：需要一个与像素数等长的标记数组（1600 万像素 = 16MB），
 * 再大就不值得为边缘四圈像素付这份内存。跳过时行为等价于没开这个开关。
 */
const MAX_DECONTAMINATE_PIXELS = 16_000_000;
/** 向外扩散的圈数，够覆盖常见的 1-3px 抗锯齿边缘 */
const DECONTAMINATE_RINGS = 3;

export function applyDecontaminate(
  data: Uint8ClampedArray,
  w: number,
  h: number,
  rings = DECONTAMINATE_RINGS,
): number {
  const total = w * h;
  if (w <= 0 || h <= 0 || total > MAX_DECONTAMINATE_PIXELS) return 0;

  const filled = new Uint8Array(total);
  let frontier: number[] = [];

  // 第一圈：紧贴不透明像素（alpha === 255）的半透明像素
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const a = data[i * 4 + 3];
      if (a === 0 || a === 255) continue;

      const nx = [x - 1, x + 1, x, x];
      const ny = [y, y, y - 1, y + 1];
      for (let k = 0; k < 4; k += 1) {
        const px = nx[k];
        const py = ny[k];
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const j = py * w + px;
        if (data[j * 4 + 3] !== 255) continue;
        data[i * 4] = data[j * 4];
        data[i * 4 + 1] = data[j * 4 + 1];
        data[i * 4 + 2] = data[j * 4 + 2];
        filled[i] = 1;
        frontier.push(i);
        break;
      }
    }
  }

  let changed = frontier.length;

  // 后续几圈：沿着半透明区域继续把颜色推出去
  for (let ring = 1; ring < rings && frontier.length > 0; ring += 1) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % w;
      const y = (i - x) / w;
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];

      const nx = [x - 1, x + 1, x, x];
      const ny = [y, y, y - 1, y + 1];
      for (let k = 0; k < 4; k += 1) {
        const px = nx[k];
        const py = ny[k];
        if (px < 0 || py < 0 || px >= w || py >= h) continue;
        const j = py * w + px;
        const a = data[j * 4 + 3];
        if (a === 0 || a === 255 || filled[j] === 1) continue;
        data[j * 4] = r;
        data[j * 4 + 1] = g;
        data[j * 4 + 2] = b;
        filled[j] = 1;
        next.push(j);
      }
    }
    changed += next.length;
    frontier = next;
  }

  return changed;
}

/**
 * 执行预处理。返回新缓冲；若设置全中性则原样返回输入的缓冲（不复制）。
 */
export function preprocess(src: RGBAImage, p: PreprocessSettings): RGBAImageData {
  if (isPreprocessIdentity(p)) {
    return { width: src.width, height: src.height, data: src.data };
  }

  const data = new Uint8ClampedArray(src.data);

  // 去背景放在最前面：判定用原图颜色，与你在原图上看到的底色一致。
  // 放到颜色调整之后，一改亮度就会判错（调暗后底色变灰，容差就够不着了）。
  if (p.removeBackground !== 'none') {
    // 底色解析失败（旧存档缺字段、被手改成乱码）时退回白 —— 静默用默认值，
    // 比「整张图不做去背」更接近用户预期，而且面板上的取色器一眼就能看出不是他选的那个
    const parsed = parseHex(p.bgColor);
    const color: readonly [number, number, number] = parsed
      ? ([parsed[0], parsed[1], parsed[2]] as const)
      : ([255, 255, 255] as const);

    removeBackgroundColor(data, src.width, src.height, {
      mode: p.removeBackground,
      tolerance: p.bgTolerance,
      softEdge: p.bgSoftEdge,
      color,
    });
  }
  if (p.brightness !== 0 || p.contrast !== 0 || p.saturation !== 0) {
    applyColorAdjust(data, p);
  }
  if (p.sharpen > 0) {
    applySharpen(data, src.width, src.height, p.sharpen);
  }
  if (p.alphaThreshold < 255) {
    applyAlphaThreshold(data, Math.max(0, p.alphaThreshold));
  }
  if (p.decontaminate) {
    applyDecontaminate(data, src.width, src.height);
  }

  return { width: src.width, height: src.height, data };
}