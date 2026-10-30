/**
 * 明度阶梯（M7）：同一个色相，一键出一串由暗到亮的颜色。
 *
 * 为什么在 **CIELAB** 里做，而不是简单的 RGB 乘系数：
 * - RGB 按比例缩放会让暗部发黑、亮部发白，而且蓝色压暗后色相会偏紫；
 * - LAB 的 L* 是感知亮度，等间隔取 L 得到的阶梯**看起来**亮度差也均匀，
 *   这正是像素画里「高光 + 中间调 + 阴影」需要的东西；
 * - 直接改 L*、保留 a/b，就是「同一个颜色」的定义本身。
 *
 * 反过来说，色域限制让很鲜艳的色在两端会被钳制（那是物理上画不出来的部分），
 * 所以高饱和色的最亮档可能略偏白 —— 比强行保持色相却叠出一堆脏色要好。
 */

import { labToRgb, rgbToLab } from '@/core/color/space';
import type { RGBA } from '@/core/types';

export interface LadderOptions {
  /** 档数，含两端。2-9 比较有意义 */
  steps: number;
  /** 最暗档的 L*（0-100），默认 18 */
  dark?: number;
  /** 最亮档的 L*，默认 94 */
  light?: number;
}

export const DEFAULT_LADDER_STEPS = 5;
const MIN_STEPS = 2;
const MAX_STEPS = 9;

/**
 * 生成明度阶梯，顺序是**由暗到亮**。
 *
 * 顺序很重要：加进调色板后索引递增，正好与「越来越亮」对应，
 * 在面板上就是一排从深到浅的色块。反过来做也能用，但看的时候要倒着数。
 */
export function buildLightnessLadder(color: RGBA, options: LadderOptions): RGBA[] {
  const steps = clampSteps(options.steps);
  const dark = clampL(options.dark ?? 18);
  const light = clampL(options.light ?? 94);

  const lab = [0, 0, 0];
  rgbToLab(color[0], color[1], color[2], lab);
  const a = lab[1] as number;
  const b = lab[2] as number;
  const alpha = color[3] ?? 255;

  const out: RGBA[] = [];
  for (let i = 0; i < steps; i += 1) {
    const t = steps === 1 ? 0 : i / (steps - 1);
    const L = dark + (light - dark) * t;
    const rgb = [0, 0, 0];
    labToRgb(L, a, b, rgb);
    out.push([rgb[0] as number, rgb[1] as number, rgb[2] as number, alpha]);
  }
  return out;
}

function clampSteps(steps: number): number {
  if (!Number.isFinite(steps)) return DEFAULT_LADDER_STEPS;
  return Math.max(MIN_STEPS, Math.min(MAX_STEPS, Math.round(steps)));
}

function clampL(value: number): number {
  if (!Number.isFinite(value)) return 50;
  return Math.max(0, Math.min(100, value));
}

/**
 * 阶梯里最接近某个颜色的一档。
 *
 * 用途：把阶梯加进调色板之后，让「前景色」自动落在离原色最近的那一档，
 * 而不是跳到最暗或最亮 —— 用户刚点的那个颜色不该被抢走。
 */
export function nearestLadderIndex(ladder: readonly RGBA[], color: RGBA): number {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < ladder.length; i += 1) {
    const c = ladder[i];
    const d =
      (c[0] - color[0]) ** 2 + (c[1] - color[1]) ** 2 + (c[2] - color[2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}