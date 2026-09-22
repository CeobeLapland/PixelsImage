/**
 * 自动明暗分层（posterize）—— docs/ROADMAP.md M4。
 *
 * 本质是**把明暗压成三档**，不是「在某一层里换个颜色」。所以对每个非透明格：
 *   1. 按它当前颜色的亮度判档，把该档区间的**中点**当目标亮度
 *      （不写死 0.25/0.5/0.75：阈值一改目标跟着走，行为才可预测）；
 *   2. 把颜色按亮度缩放到目标亮度 —— 压暗就整体乘系数，提亮就朝白插值，
 *      这一步尽量保住色相；
 *   3. 再在**整块调色板**里找与缩放结果最接近的颜色当落点。
 *
 * **候选色绝不能按档位过滤**（这是本模块最容易走回去的坑）：
 * 档位只负责决定「目标亮度」。一旦拿它去筛候选色，格子就只能换成同档的兄弟色，
 * 中灰会变成中红 —— 那不是压明暗，是把色相随机打乱，比什么都不做更糟。
 * 只在全调色板里找最近色，提亮后的红才会落到更亮的红上，而不是落到灰上。
 *
 * 纯计算：不碰输入、不碰编辑层，只返回要写哪些格，预览与落库共用这一份列表。
 */

import { relativeLuminance } from '@/core/color/space';
import { readCell, type CellWrite } from '@/core/edit';
import type { EditLayer, Palette, PixelGrid, RGBA } from '@/core/types';

export interface ShadeOptions {
  /** 亮度低于此值算阴影（0-1，默认 0.33） */
  darkMax: number;
  /** 亮度高于此值算高光（0-1，默认 0.66） */
  lightMin: number;
}

export interface ShadeStats {
  /** 三层各自可用几个色槽 */
  darkSlots: number;
  midSlots: number;
  lightSlots: number;
}

/** 三层序号：0 阴影 / 1 中间调 / 2 高光 */
const BAND_DARK = 0;
const BAND_MID = 1;
const BAND_LIGHT = 2;

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 归一化两个阈值。
 *
 * UI 里两个滑块可能被拖成交叉状态（darkMax ≥ lightMin），这时把 lightMin 抬到 darkMax
 * 并继续算，而不是抛错：拖到中间态的那一帧不该让整块面板报错，也不该让按钮静默失效 ——
 * 钳完得到的是「没有中间调」的确定分层，用户松手后自然恢复。
 */
function normalizeThresholds(opts: ShadeOptions): { darkMax: number; lightMin: number } {
  const darkMax = clamp01(opts.darkMax);
  // Math.max 顺带保证 lightMin ≥ darkMax，配合 [0,1] 钳位即得合法区间
  const lightMin = Math.max(darkMax, clamp01(opts.lightMin));
  return { darkMax, lightMin };
}

/** 某亮度落在哪一档 */
function bandOf(lum: number, darkMax: number, lightMin: number): number {
  if (lum < darkMax) return BAND_DARK;
  if (lum >= lightMin) return BAND_LIGHT;
  return BAND_MID;
}

/** 该档的目标亮度 = 档位区间的中点 */
function targetOf(lum: number, darkMax: number, lightMin: number): number {
  if (lum < darkMax) return darkMax / 2;
  if (lum < lightMin) return (darkMax + lightMin) / 2;
  return (lightMin + 1) / 2;
}

/**
 * 把调色板按明度分到三层。
 *
 * 只用于 bandSlots：它描述的是**调色板自己的明暗分布**（UI 上「三层可用色」的读数），
 * 不代表 planShade 只能从某一层里挑色 —— 见文件头，落点永远是全调色板里最近的色。
 */
function groupByBand(colors: readonly RGBA[], darkMax: number, lightMin: number): number[][] {
  const groups: number[][] = [[], [], []];
  for (let i = 0; i < colors.length; i += 1) {
    const c = colors[i];
    groups[bandOf(relativeLuminance(c[0], c[1], c[2]), darkMax, lightMin)].push(i);
  }
  return groups;
}

/**
 * 把调色板分到三个明度层，供 UI 预览「每层有几个可用色」。
 * 注意它只描述调色板的明暗分布，不是「该层只能从这些色里挑」。
 */
export function bandSlots(palette: Palette, opts: ShadeOptions): ShadeStats {
  const { darkMax, lightMin } = normalizeThresholds(opts);
  const groups = groupByBand(palette.colors, darkMax, lightMin);
  return {
    darkSlots: groups[BAND_DARK].length,
    midSlots: groups[BAND_MID].length,
    lightSlots: groups[BAND_LIGHT].length,
  };
}

/**
 * 把颜色按亮度缩放到 target，尽量保持色相。
 * 返回 null 表示无从缩放：纯黑（亮度 0）与纯白（亮度 1）会让公式除零，
 * 而且它们提亮/压暗后都是灰，「保持色相」本就无从谈起 —— 交给调用方跳过。
 */
function scaleToLuminance(
  c: RGBA,
  lum: number,
  target: number,
): [number, number, number] | null {
  if (lum <= 0 || lum >= 1) return null;
  if (target < lum) {
    const s = target / lum; // 压暗：整体乘系数，色相不受影响
    return [c[0] * s, c[1] * s, c[2] * s];
  }
  const t = (target - lum) / (1 - lum); // 提亮：朝白插值
  return [c[0] + (255 - c[0]) * t, c[1] + (255 - c[1]) * t, c[2] + (255 - c[2]) * t];
}

/**
 * 在整块调色板里找与目标色最接近的下标（加权 RGB 距离的平方，与调色板合并、
 * 转换流水线同口径）。平手时取下标小的，保证同一输入永远得到同一结果。
 */
function nearestIndex(target: readonly number[], colors: readonly RGBA[]): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < colors.length; i += 1) {
    const c = colors[i];
    const dr = target[0] - c[0];
    const dg = target[1] - c[1];
    const db = target[2] - c[2];
    const d = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** 计算明暗分层要写入的格子（不改动任何输入） */
export function planShade(
  base: PixelGrid,
  edit: EditLayer | null,
  palette: Palette,
  opts: ShadeOptions,
): CellWrite[] {
  const { darkMax, lightMin } = normalizeThresholds(opts);
  const colors = palette.colors;
  const { w, h } = base;
  const writes: CellWrite[] = [];

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const cur = readCell(base, edit, x, y);
      // 透明格一律不动：明暗是给实心像素做的，动透明区只会把去背后的轮廓搅乱
      if (cur.alpha === 0) continue;

      const src = colors[cur.index];
      // 索引落在当前调色板之外（换过板、尺寸刚改的瞬间）：无从比色，保持原样
      if (!src) continue;

      const lum = relativeLuminance(src[0], src[1], src[2]);
      const scaled = scaleToLuminance(src, lum, targetOf(lum, darkMax, lightMin));
      if (!scaled) continue; // 纯黑 / 纯白：缩放到哪都是灰，跳过

      const best = nearestIndex(scaled, colors);
      // 落点就是原色 → 它本就处于该档的目标亮度，不产生无意义写入
      if (best === cur.index) continue;

      writes.push({ index: y * w + x, cell: { index: best, alpha: cur.alpha } });
    }
  }

  return writes;
}