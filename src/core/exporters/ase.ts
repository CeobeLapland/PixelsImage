/**
 * Aseprite 原生格式 `.ase` 导出（M7）。
 *
 * 目标是「把像素图丢进 Aseprite 继续画」。为什么不直接给 PNG：
 * PNG 当然能被 Aseprite 打开，但 `.ase` 能带上图层名与画布尺寸信息，
 * 之后在 Aseprite 里加图层、做动画时不用再重新起文档。
 *
 * 这里只写**最小合法文件**：1 帧、1 图层、32 位 RGBA、normal 混合模式。
 * 不做调色板块 —— RGBA 图层本来就不需要它，写了反而可能被误认成索引模式。
 *
 * 格式上的四个坑（已按 aseprite 官方 spec 与真实解析器核对过一遍）：
 *
 * 1. **块头是「DWORD 长度 + WORD 类型」**，长度**包含**这 6 字节的块头本身。
 *    这两个字段的顺序与含义都容易记反（帧头的长度字段则是「含帧头」的整帧长度）。
 *
 * 2. **赛尔块的类型是 0x2005，不是 0x2001** —— 0x2001 是旧版调色板块。
 *    赛尔块固定部分有 20 字节：图层索引、x、y、不透明度、赛尔类型、z 索引、
 *    5 字节保留、宽、高。少写这 5 个保留字节会让后面整条数据流错位。
 *
 * 3. **像素数据是自下而上的行序**（与 BMP 同源的老习惯）。
 *    我们的网格是自上而下存的，必须整行倒序写入，否则在 Aseprite 里是竖着翻过来的。
 *
 * 4. **字符串是 WORD 长度 + UTF-8 字节**，不是 C 风格的零结尾。
 *
 * 结构：
 *   文件头 128B → 帧头 16B → 图层块(0x2004) → 赛尔块(0x2005) → 结束
 */

import { gridToImageData } from '../composite';
import type { Palette, PixelGrid } from '../types';

/** 文件头固定 128 字节；帧头 16；块头 6（DWORD 长度 + WORD 类型） */
const HEADER_SIZE = 128;
const FRAME_HEADER_SIZE = 16;
const CHUNK_HEADER_SIZE = 6;

const MAGIC = 0xa5e0;
const FRAME_MAGIC = 0xf1fa;

const CHUNK_LAYER = 0x2004;
const CHUNK_CEL = 0x2005;

/** 单图层时的图层名。带日期会让同一个素材每导一次都不一样，所以用固定名字 */
const DEFAULT_LAYER_NAME = '图层 1';

/** 默认帧时长（毫秒） */
const DEFAULT_FRAME_MS = 100;

export interface AseFrameInput {
  grid: PixelGrid;
  palette: Palette;
  /** 该帧时长（毫秒）；不传就用 options.durationMs */
  durationMs?: number;
}

export interface AseExportOptions {
  /** 图层名。默认「图层 1」 */
  layerName?: string;
  /** 每帧时长（毫秒），默认 100 */
  durationMs?: number;
}

interface Chunk {
  id: number;
  data: Uint8Array;
}

/** 一个可以按需增长写入的字节缓冲；比预分配精确长度好读得多 */
class ByteWriter {
  private buf: Uint8Array;
  private pos = 0;
  private view: DataView;

  constructor(capacity = 64) {
    this.buf = new Uint8Array(capacity);
    this.view = new DataView(this.buf.buffer);
  }

  private ensure(extra: number): void {
    if (this.pos + extra <= this.buf.length) return;
    let next = this.buf.length * 2;
    while (next < this.pos + extra) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.buf.subarray(0, this.pos));
    this.buf = grown;
    this.view = new DataView(grown.buffer);
  }

  u8(v: number): this {
    this.ensure(1);
    this.buf[this.pos] = v & 0xff;
    this.pos += 1;
    return this;
  }

  u16(v: number): this {
    this.ensure(2);
    this.view.setUint16(this.pos, v & 0xffff, true);
    this.pos += 2;
    return this;
  }

  i16(v: number): this {
    this.ensure(2);
    this.view.setInt16(this.pos, v, true);
    this.pos += 2;
    return this;
  }

  u32(v: number): this {
    this.ensure(4);
    this.view.setUint32(this.pos, v >>> 0, true);
    this.pos += 4;
    return this;
  }

  bytes(src: Uint8Array): this {
    this.ensure(src.length);
    this.buf.set(src, this.pos);
    this.pos += src.length;
    return this;
  }

  zeros(n: number): this {
    this.ensure(n);
    this.pos += n; // Uint8Array 初始为 0，不需要写
    return this;
  }

  /** Aseprite 的字符串：WORD 长度 + UTF-8 字节 */
  string(text: string): this {
    const bytes = new TextEncoder().encode(text);
    this.u16(bytes.length);
    return this.bytes(bytes);
  }

  finish(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

/** 拼一个块：DWORD 长度（含这 6 字节块头）+ WORD 类型 + 载荷 */
function packChunk(id: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(CHUNK_HEADER_SIZE + payload.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, CHUNK_HEADER_SIZE + payload.length, true);
  view.setUint16(4, id, true);
  out.set(payload, CHUNK_HEADER_SIZE);
  return out;
}

/** 图层块：一个普通、可见、可编辑的 RGBA 图层 */
function makeLayerChunk(name: string): Chunk {
  const w = new ByteWriter(64);
  w.u16(0x0003); // flags：bit0 可见 + bit1 可编辑
  w.u16(0); // 图层类型：0 = 普通图片图层
  w.u16(0); // 子层级
  w.u16(0); // 默认宽（被忽略）
  w.u16(0); // 默认高（被忽略）
  w.u16(0); // 混合模式：0 = normal
  w.u8(255); // 不透明度
  w.zeros(3); // 保留
  w.string(name);
  return { id: CHUNK_LAYER, data: w.finish() };
}

/** 赛尔块：原始像素（未压缩），行序自下而上 */
function makeCelChunk(image: ImageData): Chunk {
  const w = new ByteWriter(image.width * image.height * 4 + 64);
  w.u16(0); // 所属图层索引
  w.i16(0); // x
  w.i16(0); // y
  w.u8(255); // 不透明度
  w.u16(0); // 赛尔类型 0 = 原始图像
  w.i16(0); // z 索引（只对同图层内多个赛尔有意义）
  w.zeros(5); // 保留
  w.u16(image.width);
  w.u16(image.height);

  const px = image.data;
  const stride = image.width * 4;
  // 自下而上：先写最后一行
  for (let y = image.height - 1; y >= 0; y -= 1) {
    const start = y * stride;
    w.bytes(new Uint8Array(px.buffer, px.byteOffset + start, stride));
  }

  return { id: CHUNK_CEL, data: w.finish() };
}

/**
 * 把网格写成 `.ase` 字节（单帧）。
 *
 * 出图用 `gridToImageData` 渲染 —— 与 PNG 导出走同一条路，
 * 所以「导出的 PNG 与 .ase 里看到的一样」这件事不需要额外保证。
 */
export function buildAseFile(
  grid: PixelGrid,
  palette: Palette,
  options: AseExportOptions = {},
): Uint8Array {
  return buildAseFrames([{ grid, palette }], options);
}

/**
 * 多帧 `.ase`（M8 动图）。
 *
 * 帧序就是 Aseprite 时间轴的顺序；每帧的时长写在**帧头**里（毫秒）。
 *
 * 图层块只写在第一帧：Aseprite 与解析器都把图层定义当成「文档级」的，
 * 每帧重复写会让人在图层列表里看到 N 个同名图层。赛尔块每帧一个，
 * 引用同一个图层索引 0。
 *
 * 不写 frame tag（0x2018）：标签只是给时间段起名，没有它照样能播放与导出；
 * 而它的字节布局在 spec 里几经改动，写错会让整个文件打不开 —— 收益不足。
 */
export function buildAseFrames(
  frames: readonly AseFrameInput[],
  options: AseExportOptions = {},
): Uint8Array {
  if (frames.length === 0) throw new Error('.ase 至少需要一帧');

  const first = frames[0] as AseFrameInput;
  const width = first.grid.w;
  const height = first.grid.h;
  if (width <= 0 || height <= 0) throw new Error('网格尺寸为 0，无法导出 .ase');

  for (let i = 1; i < frames.length; i += 1) {
    const frame = frames[i] as AseFrameInput;
    if (frame.grid.w !== width || frame.grid.h !== height) {
      throw new Error(
        `帧尺寸不一致（${frame.grid.w}×${frame.grid.h} 与 ${width}×${height}）：.ase 要求每帧同尺寸`,
      );
    }
  }

  const layerName = options.layerName ?? DEFAULT_LAYER_NAME;
  const durations = frames.map((frame) =>
    clampDuration(frame.durationMs ?? options.durationMs ?? DEFAULT_FRAME_MS),
  );

  const layerChunk = packChunk(CHUNK_LAYER, makeLayerChunk(layerName).data);
  const frameChunks = frames.map((frame, index) => {
    const chunks: Uint8Array[] = [];
    if (index === 0) chunks.push(layerChunk);
    chunks.push(
      packChunk(CHUNK_CEL, makeCelChunk(gridToImageData(frame.grid, frame.palette)).data),
    );
    return chunks;
  });

  const frameBodies = frameChunks.map((chunks) => ({
    body: chunks.reduce((sum, c) => sum + c.length, 0),
    chunks,
  }));
  const total = frameBodies.reduce((sum, f) => sum + f.body, 0);

  const w = new ByteWriter(HEADER_SIZE + frames.length * FRAME_HEADER_SIZE + total);

  /* ---------------- 文件头 ---------------- */
  const fileSize =
    HEADER_SIZE + frames.length * FRAME_HEADER_SIZE + total;
  w.u32(fileSize);
  w.u16(MAGIC);
  w.u16(frames.length); // 帧数
  w.u16(width);
  w.u16(height);
  w.u16(32); // 色深：32 = RGBA
  w.u32(1); // flags：bit0 = 图层不透明度有效
  w.u16(durations[0] as number); // 默认帧间隔（毫秒），老字段，仍被不少工具读
  w.u32(0);
  w.u32(0);
  w.u8(0); // 索引模式下的透明索引；RGBA 下无意义
  w.zeros(3);
  w.u16(0); // 调色板颜色数：0 = RGBA 无调色板
  w.u8(0); // 像素宽
  w.u8(0); // 像素高
  w.i16(0); // 网格 x
  w.i16(0); // 网格 y
  w.u16(0); // 网格宽
  w.u16(0); // 网格高
  w.zeros(84); // 保留给将来

  /* ---------------- 各帧 ---------------- */
  for (let i = 0; i < frameBodies.length; i += 1) {
    const frame = frameBodies[i] as { body: number; chunks: Uint8Array[] };
    w.u32(FRAME_HEADER_SIZE + frame.body); // 本帧总长（含帧头，与块头的含义不同）
    w.u16(FRAME_MAGIC);
    w.u16(0xffff); // 旧字段：始终 0xFFFF，表示后面用「新字段」的块数
    w.u16(durations[i] as number); // 帧时长（毫秒）
    w.zeros(2); // 保留
    w.u32(frame.chunks.length); // 新字段：块数

    for (const chunk of frame.chunks) w.bytes(chunk);
  }

  return w.finish();
}

/** 帧时长是 WORD（0-65535 毫秒） */
function clampDuration(ms: number): number {
  if (!Number.isFinite(ms)) return DEFAULT_FRAME_MS;
  return Math.max(0, Math.min(0xffff, Math.round(ms)));
}
