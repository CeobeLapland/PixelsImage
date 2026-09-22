/**
 * 源图解码与尺寸保护。
 *
 * 两级上限：
 * - PREVIEW_MAX_EDGE：画布显示用位图上限。超过则再降采样一份预览，保证 UI 流畅。
 * - HARD_MAX_*：处理上限。超过则源数据本身降采样，并标记 truncated 由 UI 提示。
 *
 * 见 docs/DESIGN.md §8 性能策略
 */

import type { SourceImage } from './types';

/** 显示位图的最长边上限 */
const PREVIEW_MAX_EDGE = 2048;
/** 源数据最长边上限 */
const HARD_MAX_EDGE = 8192;
/** 源数据总像素上限（约 64MPix ≈ 256MB RGBA） */
const HARD_MAX_PIXELS = 64_000_000;

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type AnyCtx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/** 复用一个 scratch canvas，避免每次解码都新建 */
let scratchCanvas: AnyCanvas | null = null;

function getScratchCanvas(w: number, h: number): AnyCanvas {
  if (!scratchCanvas) {
    if (typeof OffscreenCanvas !== 'undefined') {
      scratchCanvas = new OffscreenCanvas(w, h);
    } else {
      const el = document.createElement('canvas');
      el.width = w;
      el.height = h;
      scratchCanvas = el;
    }
  }
  scratchCanvas.width = w;
  scratchCanvas.height = h;
  return scratchCanvas;
}

function get2d(canvas: AnyCanvas): AnyCtx2D {
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as AnyCtx2D | null;
  if (!ctx) throw new Error('无法创建 2D 绘图上下文');
  return ctx;
}

function drawToImageData(
  src: CanvasImageSource,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
  smooth: boolean,
): ImageData {
  const canvas = getScratchCanvas(dw, dh);
  const ctx = get2d(canvas);
  ctx.imageSmoothingEnabled = smooth;
  ctx.imageSmoothingQuality = 'high';
  ctx.clearRect(0, 0, dw, dh);
  ctx.drawImage(src, 0, 0, sw, sh, 0, 0, dw, dh);
  return ctx.getImageData(0, 0, dw, dh);
}

let idSeq = 0;

/** 计算源数据尺寸：超出处理上限则等比降采样 */
function planSourceSize(w: number, h: number): { w: number; h: number; truncated: boolean } {
  if (w > HARD_MAX_EDGE || h > HARD_MAX_EDGE || w * h > HARD_MAX_PIXELS) {
    const scale = Math.min(
      HARD_MAX_EDGE / w,
      HARD_MAX_EDGE / h,
      Math.sqrt(HARD_MAX_PIXELS / (w * h)),
    );
    return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), truncated: true };
  }
  return { w, h, truncated: false };
}

/** 由源数据生成显示位图，必要时再降采样一次 */
async function makePreview(
  imageData: ImageData,
): Promise<{ bitmap: ImageBitmap; scale: number }> {
  const { width: w, height: h } = imageData;
  const edge = Math.max(w, h);
  if (edge <= PREVIEW_MAX_EDGE) {
    return { bitmap: await createImageBitmap(imageData), scale: 1 };
  }

  const ratio = PREVIEW_MAX_EDGE / edge;
  const pw = Math.max(1, Math.round(w * ratio));
  const ph = Math.max(1, Math.round(h * ratio));

  const full = await createImageBitmap(imageData);
  try {
    const canvas = getScratchCanvas(pw, ph);
    const ctx = get2d(canvas);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, pw, ph);
    ctx.drawImage(full, 0, 0, w, h, 0, 0, pw, ph);
    const previewData = ctx.getImageData(0, 0, pw, ph);
    return { bitmap: await createImageBitmap(previewData), scale: w / pw };
  } finally {
    full.close();
  }
}

/**
 * 解码后的像素数据（不含显示用位图）。
 *
 * 批量处理一次要解码几十张图，而显示位图（最长边 2048）每张就要好几个 MB，
 * 队列里根本用不上。所以把它拆出来，批量走这条路。
 */
export interface DecodedImage {
  /** 转换实际使用的源数据；超出处理上限时已降采样 */
  imageData: ImageData;
  /** 原始文件尺寸 */
  originalWidth: number;
  originalHeight: number;
  /** 是否因超出处理上限而降采样 */
  truncated: boolean;
}

export async function decodeImage(file: File | Blob): Promise<DecodedImage> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(
      '无法解码该文件，可能不是受支持的图片格式（支持 PNG / JPEG / WebP / GIF / BMP）',
    );
  }

  try {
    const originalWidth = bitmap.width;
    const originalHeight = bitmap.height;
    if (!originalWidth || !originalHeight) {
      throw new Error('图片尺寸为 0，无法处理');
    }

    const plan = planSourceSize(originalWidth, originalHeight);
    const imageData = drawToImageData(
      bitmap,
      originalWidth,
      originalHeight,
      plan.w,
      plan.h,
      true,
    );

    return { imageData, originalWidth, originalHeight, truncated: plan.truncated };
  } finally {
    bitmap.close();
  }
}

/** 从 File / Blob 加载源图（含画布显示用的预览位图） */
export async function loadSourceImage(
  file: File | Blob,
  fallbackName = '粘贴的图片',
): Promise<SourceImage> {
  const name = file instanceof File ? file.name : fallbackName;
  const type = file.type || 'image/*';
  const bytes = file.size;

  const decoded = await decodeImage(file);
  const { bitmap: previewBitmap, scale } = await makePreview(decoded.imageData);

  idSeq += 1;
  return {
    id: `src-${Date.now().toString(36)}-${idSeq}`,
    name,
    type,
    bytes,
    originalWidth: decoded.originalWidth,
    originalHeight: decoded.originalHeight,
    imageData: decoded.imageData,
    previewBitmap,
    previewScale: scale,
    truncated: decoded.truncated,
  };
}

/** 队列缩略图的最长边。列表里只要认得出来是哪张图就够了 */
const THUMB_MAX_EDGE = 96;

/**
 * 生成列表用的小缩略图。
 * 缩略图是**尽力而为**的：生成失败（格式怪、内存紧）不该让整张图进不了队列，
 * 所以失败时返回 null，由 UI 退化成文件名占位。
 */
export async function makeThumbnail(file: File | Blob): Promise<ImageBitmap | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }

  const edge = Math.max(bitmap.width, bitmap.height);
  if (edge <= THUMB_MAX_EDGE) return bitmap;

  try {
    const ratio = THUMB_MAX_EDGE / edge;
    const w = Math.max(1, Math.round(bitmap.width * ratio));
    const h = Math.max(1, Math.round(bitmap.height * ratio));
    const canvas = getScratchCanvas(w, h);
    const ctx = get2d(canvas);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, w, h);
    const thumb = await createImageBitmap(ctx.getImageData(0, 0, w, h));
    return thumb;
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}

/** 可解码的图片类型（用于文件选择与拖拽过滤） */
export const ACCEPTED_TYPES =
  'image/png,image/jpeg,image/webp,image/gif,image/bmp,image/avif';

/**
 * Blob → data URL。
 *
 * 存档要把源图内嵌进 JSON，而 JSON 里只能放字符串，所以必须走这一步。
 * 用 FileReader 而不是自己拼 base64：后者要先把 ArrayBuffer 转成二进制字符串，
 * 几兆的缓冲上做字符拼接既慢又容易爆栈。
 */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    if (typeof FileReader === 'undefined') {
      reject(new Error('当前环境不支持 FileReader，无法内嵌源图'));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') resolve(result);
      else reject(new Error('源图编码失败'));
    };
    reader.onerror = () => reject(new Error('源图编码失败'));
    reader.readAsDataURL(blob);
  });
}

/** data URL → Blob；交给 createImageBitmap 解码 */
export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  if (!response.ok) throw new Error('存档里的源图无法读取');
  return await response.blob();
}

export function isProbablyImage(file: File): boolean {
  if (file.type.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(file.name);
}

/** 人类可读的字节数 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}