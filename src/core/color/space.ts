/**
 * 色彩空间转换。
 *
 * 只实现量化需要的方向：sRGB → CIELAB。
 * 反向（LAB → sRGB）目前不需要：量化是「找最近的调色板色」，
 * 结果永远是调色板里已有的颜色，不需要从 LAB 反算回来。
 */

/** sRGB 8bit → 线性光。查表避免每像素一次 pow */
const SRGB_TO_LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i += 1) {
  const c = i / 255;
  SRGB_TO_LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** D65 白点 */
const WHITE_X = 0.95047;
const WHITE_Y = 1.0;
const WHITE_Z = 1.08883;

/** f(t) 的 LAB 分段函数 */
function labF(t: number): number {
  return t > 0.008856451679035631 ? Math.cbrt(t) : 7.787037037037037 * t + 16 / 116;
}

/**
 * sRGB(0-255) → CIELAB。
 *
 * 结果写入 out（长度 3 的 Float32Array 或普通数组），避免每次分配小对象。
 * L ∈ [0,100]，a/b 约 ∈ [-128,127]。
 */
export function rgbToLab(
  r: number,
  g: number,
  b: number,
  out: Float32Array | number[],
  offset = 0,
): void {
  const lr = SRGB_TO_LINEAR[r];
  const lg = SRGB_TO_LINEAR[g];
  const lb = SRGB_TO_LINEAR[b];

  // sRGB → XYZ (D65)
  const x = (0.4124564 * lr + 0.3575761 * lg + 0.1804375 * lb) / WHITE_X;
  const y = (0.2126729 * lr + 0.7151522 * lg + 0.072175 * lb) / WHITE_Y;
  const z = (0.0193339 * lr + 0.119192 * lg + 0.9503041 * lb) / WHITE_Z;

  const fx = labF(x);
  const fy = labF(y);
  const fz = labF(z);

  out[offset] = 116 * fy - 16;
  out[offset + 1] = 500 * (fx - fy);
  out[offset + 2] = 200 * (fy - fz);
}

/** 把一个调色板整体转到 LAB，展平成 [L,a,b, L,a,b, ...] 的 Float32Array */
export function paletteToLab(colors: readonly (readonly number[])[]): Float32Array {
  const out = new Float32Array(colors.length * 3);
  for (let i = 0; i < colors.length; i += 1) {
    const c = colors[i];
    rgbToLab(c[0], c[1], c[2], out, i * 3);
  }
  return out;
}

const HEX_ONLY = /^[0-9a-fA-F]+$/;

/** 解析 #RGB / #RRGGBB / #RRGGBBAA → RGBA。失败返回 null */
export function parseHex(input: string): [number, number, number, number] | null {
  let hex = input.trim();
  if (hex.startsWith('#')) hex = hex.slice(1);

  // 先整体校验字符，避免 parseInt 把非法输入解析成 NaN 后混过去
  if (!HEX_ONLY.test(hex)) return null;

  if (hex.length === 3) {
    const r = hex[0];
    const g = hex[1];
    const b = hex[2];
    return [parseInt(r + r, 16), parseInt(g + g, 16), parseInt(b + b, 16), 255];
  }

  if (hex.length === 6 || hex.length === 8) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) : 255;
    return [r, g, b, a];
  }

  return null;
}

/** RGBA → #RRGGBB（小写，不含 alpha） */
export function toHex(r: number, g: number, b: number): string {
  const v = (r << 16) | (g << 8) | b;
  return `#${v.toString(16).padStart(6, '0')}`;
}

/** RGBA → #RRGGBBAA */
export function toHexA(r: number, g: number, b: number, a: number): string {
  const v = ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
  return `#${v.toString(16).padStart(8, '0')}`;
}

/* ------------------------------------------------------------ 明度与色相 */

/**
 * 相对亮度 0-1（Rec.709 权重）。
 *
 * 用于「按明度排序调色板」与「只提取某个明度区间的颜色」。
 * 刻意用线性权重而不是 CIELAB 的 L*：前者与「肉眼扫一眼觉得哪个更亮」基本一致，
 * 且不需要为排序建整张 LAB 表。
 */
export function relativeLuminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/** HSL 饱和度 0-1 */
export function saturationOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const l = (max + min) / 510;
  const d = (max - min) / 255;
  return l > 0.5 ? d / (2 - max / 255 - min / 255) : d / (max / 255 + min / 255);
}

/**
 * HSL 色相 0-360。
 * 接近灰色的颜色（饱和度 < 0.08）没有有意义的色相，返回 -1 —— 排序时据此把它们挑出来，
 * 否则灰色的色相由浮点噪声决定，排序结果会看起来毫无规律。
 */
export function hueOf(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return -1;

  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;

  h *= 60;
  if (h < 0) h += 360;
  return saturationOf(r, g, b) < 0.08 ? -1 : h;
}