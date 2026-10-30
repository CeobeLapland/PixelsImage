/**
 * 源图解码与尺寸保护。
 *
 * 两级上限：
 * - PREVIEW_MAX_EDGE：画布显示用位图上限。超过则再降采样一份预览，保证 UI 流畅。
 * - HARD_MAX_*：处理上限。超过则源数据本身降采样，并标记 truncated 由 UI 提示。
 *
 * 见 docs/DESIGN.md §8 性能策略
 */

import { imageDataToPngBlob } from './exporters/png';
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

/* -------------------------------------------------------------- 动图拆帧 */

/**
 * 拆帧的上限。超过就只取前面的帧 —— 一个 1000 帧的 GIF 会把队列塞爆，
 * 而队列本身不做虚拟滚动（见 DESIGN §8），几百项之后就没法用了。
 */
export const MAX_ANIMATION_FRAMES = 240;

/** 嗅探只读文件头，够覆盖所有格式的签名与 APNG 的 acTL 块 */
const SNIFF_BYTES = 64 * 1024;

export type ImageKind = 'png' | 'apng' | 'jpeg' | 'gif' | 'webp' | 'bmp' | 'avif';

export interface ImageSniff {
  kind: ImageKind;
  /** 交给解码器的 MIME。APNG 用 image/png（比 image/apng 更通用） */
  mime: string;
  /**
   * 这个容器**可能**带多帧。GIF / WebP 静态图也存在，所以这里不保证真有动画，
   * 真正的帧数要解码后才知道。
   */
  mayAnimate: boolean;
}

function asciiAt(bytes: Uint8Array, offset: number, text: string): boolean {
  if (offset + text.length > bytes.length) return false;
  for (let i = 0; i < text.length; i += 1) {
    if (bytes[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function readU32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

/** PNG 里有没有 acTL（APNG 的动画控制块）。它必须在 IDAT 之前出现 */
function pngHasActl(bytes: Uint8Array): boolean {
  let p = 8;
  while (p + 8 <= bytes.length) {
    const length = readU32BE(bytes, p);
    const type = String.fromCharCode(
      bytes[p + 4] as number,
      bytes[p + 5] as number,
      bytes[p + 6] as number,
      bytes[p + 7] as number,
    );
    if (type === 'acTL') return true;
    if (type === 'IDAT' || type === 'IEND') return false;
    p += 12 + length;
  }
  return false;
}

/**
 * 按**文件头字节**判断格式，不看扩展名与 MIME。
 *
 * 为什么要这样：动图经常被「伪装」成 `.jpg` / `.png`（从网页另存、聊天软件转发都会发生），
 * 只看扩展名就会把它当静态图，最后只拿到第一帧 —— 而且完全没有任何提示。
 * 读 64KB 的代价可以忽略，换来的是「文件叫什么名字都不影响识别」。
 */
export async function sniffImage(file: Blob): Promise<ImageSniff | null> {
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  if (head.length < 12) return null;

  if (asciiAt(head, 0, 'GIF87a') || asciiAt(head, 0, 'GIF89a')) {
    return { kind: 'gif', mime: 'image/gif', mayAnimate: true };
  }
  if (asciiAt(head, 0, 'RIFF') && asciiAt(head, 8, 'WEBP')) {
    return { kind: 'webp', mime: 'image/webp', mayAnimate: true };
  }
  if (asciiAt(head, 0, '\u0089PNG\r\n\u001a\n')) {
    return pngHasActl(head)
      ? { kind: 'apng', mime: 'image/png', mayAnimate: true }
      : { kind: 'png', mime: 'image/png', mayAnimate: false };
  }
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return { kind: 'jpeg', mime: 'image/jpeg', mayAnimate: false };
  }
  if (head[0] === 0x42 && head[1] === 0x4d) {
    return { kind: 'bmp', mime: 'image/bmp', mayAnimate: false };
  }
  // AVIF：'ftyp' 盒在 4..7，主品牌在 8..11；'avis' 是动画品牌
  if (asciiAt(head, 4, 'ftyp')) {
    if (asciiAt(head, 8, 'avif') || asciiAt(head, 8, 'avis')) {
      return { kind: 'avif', mime: 'image/avif', mayAnimate: asciiAt(head, 8, 'avis') };
    }
  }

  return null;
}

/** 浏览器是否提供 WebCodecs 的拆帧能力（Chrome / Edge 有，Firefox 目前没有） */
export function supportsFrameDecoding(): boolean {
  return typeof ImageDecoder !== 'undefined';
}

export interface AnimationProbe {
  /** 帧总数 */
  frameCount: number;
  /** 循环次数；0 = 无限 */
  loopCount: number;
  /** 解码器应使用的 MIME */
  mime: string;
}

/**
 * 只看「是不是真动图、有几帧」，不解码像素。
 *
 * 单图入口（把文件拖到画布）需要这个：静态 GIF 应该进编辑器，
 * 动图则要转去批量队列。`track.frameCount` 在 tracks.ready 后就有，
 * 不用逐帧解码 —— 那是拆帧时才付的代价。
 *
 * 不做的事：浏览器没有 ImageDecoder 时抛错（由调用方决定是提示还是降级）。
 */
export async function probeAnimation(
  file: File,
  known?: ImageSniff | null,
): Promise<AnimationProbe | null> {
  const sniff = known === undefined ? await sniffImage(file) : known;
  if (!sniff || !sniff.mayAnimate) return null;
  if (!supportsFrameDecoding()) throw new Error('当前浏览器不支持拆帧（需要 Chrome / Edge）');

  const decoder = new ImageDecoder({
    // 只是为了读 track 的帧数；这里把整份数据交过去是最稳的方式（ImageDecoder 只接受 buffer）
    data: await file.arrayBuffer(),
    type: sniff.mime,
    preferAnimation: true,
  });
  try {
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    const frameCount = track?.frameCount ?? 0;
    if (!track || frameCount <= 1) return null;
    const repetition = track.repetitionCount;
    return {
      frameCount,
      loopCount: Number.isFinite(repetition) ? Math.max(0, repetition) : 0,
      mime: sniff.mime,
    };
  } finally {
    decoder.close();
  }
}

/** 从动图拆出来的一帧：已经编码成 PNG 文件，能直接当普通图片入队 */
export interface AnimationFrameFile {
  file: File;
  /** 这一帧在源动图里的时长（毫秒） */
  delayMs: number;
}

export interface SplitAnimationResult {
  frames: AnimationFrameFile[];
  /** 源动图声明的循环次数；0 = 无限循环 */
  loopCount: number;
  /** 源动图的帧总数（可能大于 frames.length） */
  totalFrames: number;
  /** 是否因为上限截断了 */
  truncated: boolean;
}

/**
 * 把动图拆成逐帧 PNG 文件。
 *
 * 返回 null = 不是动图（单帧），调用方按普通图片处理。
 * 浏览器没有 ImageDecoder 时**直接抛错**而不返回 null：
 * 静默只取第一帧会让用户以为动图「就是这样」，这比报错更糟。
 *
 * 为什么不把帧留在内存里：拆帧发生在导入时，而队列里的项要能单张打开编辑器、
 * 能重新解码、能进 zip —— 统一成 PNG 文件后，这些路径一行都不用改。
 */
export async function splitAnimatedFrames(
  file: File,
  maxFrames = MAX_ANIMATION_FRAMES,
  known?: ImageSniff | null,
): Promise<SplitAnimationResult | null> {
  const sniff = known === undefined ? await sniffImage(file) : known;
  if (!sniff || !sniff.mayAnimate) return null;

  if (!supportsFrameDecoding()) {
    throw new Error(
      '当前浏览器不支持拆帧（需要 Chrome / Edge）。' +
        '可以先在别处把动图导出成 PNG 序列，再把这些 PNG 一次拖进来',
    );
  }

  const decoder = new ImageDecoder({
    data: await file.arrayBuffer(),
    type: sniff.mime,
    preferAnimation: true,
  });

  try {
    await decoder.tracks.ready;
    const track = decoder.tracks.selectedTrack;
    const total = track?.frameCount ?? 0;
    if (!track || total <= 1) return null;

    const take = Math.min(total, Math.max(1, maxFrames));
    const digits = String(take).length;
    const stem = file.name.replace(/\.[^.]+$/, '') || 'frame';

    const frames: AnimationFrameFile[] = [];
    for (let i = 0; i < take; i += 1) {
      // completeFramesOnly：等这一帧能完整呈现再交给我们。
      // GIF 的「只更新一小块」在这里已经由解码器合成为整帧，直接整张画上画布即可
      const { image } = await decoder.decode({ frameIndex: i, completeFramesOnly: true });
      try {
        const w = image.displayWidth;
        const h = image.displayHeight;
        if (w <= 0 || h <= 0) throw new Error(`动图的第 ${i + 1} 帧尺寸为 0`);

        const canvas = getScratchCanvas(w, h);
        const ctx = get2d(canvas);
        ctx.clearRect(0, 0, w, h);
        ctx.drawImage(image, 0, 0);

        const blob = await imageDataToPngBlob(ctx.getImageData(0, 0, w, h));
        const name = `${stem}_${String(i + 1).padStart(digits, '0')}.png`;
        frames.push({
          file: new File([blob], name, { type: 'image/png', lastModified: Date.now() }),
          // ImageDecoder 给的是微秒；GIF 的时长精度本来就是 10ms，四舍五入到毫秒足够
          delayMs: Math.max(0, Math.round((image.duration ?? 0) / 1000)),
        });
      } finally {
        image.close();
      }
    }

    const repetition = track.repetitionCount;
    return {
      frames,
      loopCount: Number.isFinite(repetition) ? Math.max(0, repetition) : 0,
      totalFrames: total,
      truncated: total > take,
    };
  } finally {
    decoder.close();
  }
}

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