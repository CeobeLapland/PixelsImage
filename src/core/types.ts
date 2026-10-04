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

export type PaletteSource = 'builtin' | 'extracted' | 'imported' | 'custom';

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
  /**
   * 边缘色晕清理：把半透明边缘的 RGB 换成相邻不透明像素的颜色，
   * 消除抠图残留的背景色（绿幕边、白底灰边）。只在 alphaThreshold 生效后才有意义。
   */
  decontaminate: boolean;

  /**
   * 按颜色去背景（去白底）。
   *
   * 与 alphaThreshold 是两件事：那个看 alpha，**只对本来就有透明通道的图有用**；
   * 一张白底的 JPEG 每格 alpha 都是 255，阈值对它完全无效。这个看的是颜色。
   *
   * - 'none'：关闭
   * - 'edges'：只去掉**与画面边缘连通**的近底色区域（默认，安全）
   * - 'all'：去掉所有近底色像素（激进，适合主体里确实没有白的情况）
   *
   * 之所以默认「从边缘连通」：主体内部的白色（眼睛高光、白衣服、白字）不与边缘相通，
   * 就不会被误杀 —— 这是这类功能最容易挨骂的地方。
   */
  removeBackground: 'none' | 'edges' | 'all';
  /** 去背景容差：每通道与底色（白）的最大差值，0-255。越大越激进 */
  bgTolerance: number;
  /**
   * 边缘软化：紧贴背景的过渡像素按「离底色有多远」给半透明。
   * 抗锯齿边缘本来就是主体色与底色的混合，一刀切成不透明会留下一圈硬白边，
   * 降采样后就是一圈灰脏边。开启后这些像素变成半透明，再由色晕清理把颜色换回主体色。
   */
  bgSoftEdge: boolean;
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

/** 矩形区域，格坐标；w/h 至少为 1，且 x/y 是左上角（已规范化） */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 由拖拽的两点得到规范化的矩形（左上角 + 正尺寸） */
export function normalizeRect(a: GridPoint, b: GridPoint): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    w: Math.abs(a.x - b.x) + 1,
    h: Math.abs(a.y - b.y) + 1,
  };
}

export function rectContains(rect: Rect, x: number, y: number): boolean {
  return x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h;
}

/** 橡皮 / 删除写入的值：索引归 0、alpha 归 0，渲染时即为全透明 */
export const TRANSPARENT_CELL: PixelCell = { index: 0, alpha: 0 };

export const DEFAULT_PREPROCESS: PreprocessSettings = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  sharpen: 0,
  alphaThreshold: 255,
  decontaminate: false,
  removeBackground: 'none',
  // 24：JPEG 的白底通常在 247-255 之间浮动，加上压缩噪声约 ±10，24 够用又不会吃掉浅灰主体
  bgTolerance: 24,
  bgSoftEdge: true,
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