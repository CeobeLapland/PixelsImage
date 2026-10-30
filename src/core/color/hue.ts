/**
 * 色相偏移（调色板理论工具）。
 *
 * 在 CIELAB 的色度平面里把颜色转一个角度：**保留 L\* 与彩度 C，只改色相角**。
 * 为什么不在 HSL 里转：HSL 的 L 是「亮度」，两端（很暗/很亮）转色相会连带改变
 * 观感亮度，同一块板转完之后明暗关系就乱了。LAB 里 L 是感知明度，转色相时不动它，
 * 整块板的明暗层次原样保留。
 *
 * 灰阶（彩度接近 0）直接跳过：色相角对它们没有意义，硬转会凭空染上一层颜色。
 */

import { labToRgb, rgbToLab } from './space';
import type { RGBA } from '../types';

/** 彩度低于这个值就当作灰阶。1.5 大约相当于 RGB 三通道相差 2-3 个色阶 */
const ACHROMATIC_CHROMA = 1.5;

/** 把单个颜色在 LAB 色度平面里转 degrees 度（alpha 原样保留） */
export function rotateHue(color: RGBA, degrees: number): RGBA {
  if (!Number.isFinite(degrees) || degrees === 0) return color;

  const lab = [0, 0, 0];
  rgbToLab(color[0], color[1], color[2], lab);
  const lightness = lab[0] as number;
  const a = lab[1] as number;
  const b = lab[2] as number;

  const chroma = Math.hypot(a, b);
  // 灰阶：转了也不会有颜色变化，反而会在 8bit 上抖出一点偏色
  if (chroma < ACHROMATIC_CHROMA) return color;

  const angle = Math.atan2(b, a) + (degrees * Math.PI) / 180;
  const out = [0, 0, 0];
  labToRgb(lightness, chroma * Math.cos(angle), chroma * Math.sin(angle), out);

  return [out[0] as number, out[1] as number, out[2] as number, color[3]];
}

/**
 * 整块调色板一起转。
 *
 * 顺序与长度不变、灰阶不动 —— 因为调用方会拿它直接替换调色板，
 * 而网格里的索引是按槽位指向颜色的。
 */
export function rotatePaletteHue(colors: readonly RGBA[], degrees: number): RGBA[] {
  return colors.map((color) => rotateHue(color, degrees));
}
