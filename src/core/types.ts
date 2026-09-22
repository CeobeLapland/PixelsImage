/**
 * 全局类型定义 —— 对应 docs/DESIGN.md §3 核心数据模型
 *
 * 约定：
 * - 所有颜色为 0-255 的 RGBA 元组
 * - 所有像素缓冲为 Uint8Array / Uint8ClampedArray，长度 = w * h
 * - 这些类型是纯数据，必须可 JSON 序列化（支撑预设、项目存档、批量复用）
 */

/** 调色板中的一个颜色，0-255 */
export type RGBA = readonly [r: number, g: number, b: number, a: number];

/**
 * 轻量 RGBA 图像缓冲。
 * 不用 ImageData 类型是为了能在 Web Worker 中安全使用（ImageData 在部分环境不可构造）；
 * 浏览器的 ImageData 结构上兼容此接口，可直接传入。
 */
export interface RGBAImage {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
}

export type PaletteSource = 'builtin' | 'extracted' | 'imported';

export interface Palette {
  id: string;
  name: string;
  /** 上限 256 —— 索引存进 Uint8Array */
  colors: RGBA[];
  builtin?: boolean;
  source?: PaletteSource;
}

export const PALETTE_MAX_COLORS = 256;

/** 像素网格：转换与编辑的统一工作对象 */
export interface PixelGrid {
  w: number;
  h: number;
  /** 长度 w*h，值为调色板索引 */
  indices: Uint8Array;
  /** 长度 w*h，0-255，独立于调色板（支持半透明） */
  alpha: Uint8Array;
}

export function createGrid(w: number, h: number): PixelGrid {
  return {
    w,
    h,
    indices: new Uint8Array(w * h),
    alpha: new Uint8Array(w * h),
  };
}

export type SamplingMode = 'nearest' | 'area' | 'dominant' | 'median';
export type QuantizeMode = 'palette' | 'kmeans';
export type DistanceMode = 'rgb' | 'weighted' | 'lab';
export type DitherMode =
  | 'none'
  | 'bayer2'
  | 'bayer4'
  | 'bayer8'
  | 'floyd'
  | 'atkinson'
  | 'sierra';

export interface PreprocessSettings {
  /** -100 ~ 100 */
  brightness: number;
  contrast: number;
  saturation: number;
  /** 0 ~ 100 */
  sharpen: number;
  /** 0-255，低于此值视为全透明；255 表示不处理 */
  alphaThreshold: number;
}

export interface ConvertSettings {
  /** 目标格数（宽） */
  targetW: number;
  /** 'auto' = 按原图宽高比推导 */
  targetH: number | 'auto';
  sampling: SamplingMode;

  quantize: QuantizeMode;
  /** quantize === 'palette' 时生效 */
  paletteId: string;
  /** quantize === 'kmeans' 时生效，2-256 */
  maxColors: number;
  distance: DistanceMode;

  dither: DitherMode;
  /** 0-1 */
  ditherStrength: number;

  preprocess: PreprocessSettings;

  /** 转换后裁掉四周全透明边 */
  trimTransparent: boolean;
  /** 禁止产生「半格」，保证每格覆盖权重一致 */
  pixelPerfect: boolean;
}

/** 编辑层中的一格：有值表示该格被手工覆盖 */
export interface PixelCell {
  index: number;
  alpha: number;
}

/** 手工编辑层，与 baseGrid 同尺寸；null 表示该格走底层 */
export interface EditLayer {
  w: number;
  h: number;
  cells: (PixelCell | null)[];
}

export function createEditLayer(w: number, h: number): EditLayer {
  return { w, h, cells: new Array<PixelCell | null>(w * h).fill(null) };
}

/** 已解码的源图 */
export interface SourceImage {
  id: string;
  name: string;
  type: string;
  /** 文件字节数 */
  bytes: number;
  /** 原始文件尺寸 */
  originalWidth: number;
  originalHeight: number;
  /** 转换实际使用的源数据；超出处理上限时已降采样 */
  imageData: ImageData;
  /** 画布显示用位图（可能相对 imageData 再降采样一次） */
  previewBitmap: ImageBitmap;
  /** imageData 像素 / previewBitmap 像素 的比值，用于把光标坐标换算回源像素 */
  previewScale: number;
  /** 是否因超出处理上限而降采样 */
  truncated: boolean;
}

/** 一份工作文档 */
export interface PixelDocument {
  source: SourceImage;
  settings: ConvertSettings;
  palette: Palette;
  /** 转换前的原始调色板，用于「恢复默认」 */
  basePalette: Palette;
  /** 由 settings 重算得出；未转换时为 null */
  baseGrid: PixelGrid | null;
  /** 用户手工改动；未转换时为 null */
  editLayer: EditLayer | null;
}

export type ToolId =
  | 'pencil'
  | 'eraser'
  | 'bucket'
  | 'eyedropper'
  | 'line'
  | 'rect'
  | 'ellipse'
  | 'select';

export type SymmetryMode = 'none' | 'x' | 'y' | 'xy';

/** 编辑器用到的「调色板索引 + alpha」写值 */
export interface GridPoint {
  x: number;
  y: number;
}

export const DEFAULT_PREPROCESS: PreprocessSettings = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  sharpen: 0,
  alphaThreshold: 255,
};

export const DEFAULT_CONVERT_SETTINGS: ConvertSettings = {
  targetW: 64,
  targetH: 'auto',
  sampling: 'area',

  quantize: 'palette',
  paletteId: 'mc-dye',
  maxColors: 16,
  distance: 'weighted',

  dither: 'atkinson',
  ditherStrength: 1,

  preprocess: { ...DEFAULT_PREPROCESS },

  trimTransparent: false,
  pixelPerfect: false,
};

/** 深拷贝一份默认设置，避免共享 preprocess 引用 */
export function makeDefaultSettings(): ConvertSettings {
  return { ...DEFAULT_CONVERT_SETTINGS, preprocess: { ...DEFAULT_PREPROCESS } };
}

/** 按原图宽高比推导目标高度，至少 1 格 */
export function resolveTargetSize(
  settings: ConvertSettings,
  srcW: number,
  srcH: number,
): { w: number; h: number } {
  const w = Math.max(1, Math.round(settings.targetW));
  if (settings.targetH !== 'auto') {
    return { w, h: Math.max(1, Math.round(settings.targetH)) };
  }
  const h = Math.max(1, Math.round((w * srcH) / srcW));
  return { w, h };
}