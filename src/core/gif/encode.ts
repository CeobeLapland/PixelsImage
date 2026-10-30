/**
 * GIF89a 编码器（M8 动图）。
 *
 * 为什么自己写而不引 `gifenc`：输入已经是「调色板索引 + alpha 的网格」，
 * 编码要做的事只剩「查表 → LZW → 拼块」；而 GIF 的调色板上限 256 与我们的
 * `PixelGrid` 上限恰好一致，不需要再做一次量化。用现成库反而要额外处理
 * 它的 API、版本与 1 位透明的约定。
 *
 * 三个容易踩的格式点：
 *
 * 1. **LZW 的码宽增长时机**：写完一条码之后才判断「下一个可用码是否装不下」，
 *    加宽只用在下一条码上。早一格会让解码器读错位，出来是一片雪花。
 *
 * 2. **GIF 只有 1 位透明度**：半透明边缘只能用 alpha 阈值切成「全不透明 / 全透明」。
 *    这是格式限制，不是偷懒 —— 想要柔和边缘就输出 APNG/WebP。
 *
 * 3. **调色板最多 256 色，但透明索引还要占一个槽**：调色板本身 256 色时，
 *    只能丢掉用得最少的那个颜色（把它的像素并到最近的相邻色），否则没地方放透明索引。
 *
 * 布局：文件头 6B → 逻辑屏幕描述符 7B → 全局色表 → 循环扩展 → 每帧（GCE + 图像描述符 + LZW）→ 结尾 0x3B
 */

import type { Palette, PixelGrid } from '../types';

export interface GifFrameInput {
  grid: PixelGrid;
  palette: Palette;
  /** 该帧原始时长（毫秒）；不传就用 options.delayMs */
  delayMs?: number;
}

export interface GifOptions {
  /** 后备帧延时（毫秒） */
  delayMs: number;
  /** 循环次数；0 = 无限循环 */
  loopCount: number;
  /** 是否把 alpha 阈值以下当作透明 */
  transparent: boolean;
  /** alpha 阈值：≥ 它算不透明，默认 128 */
  alphaThreshold?: number;
  /** 整数倍最近邻放大，默认 1 */
  scale?: number;
}

export const DEFAULT_GIF_OPTIONS: GifOptions = {
  delayMs: 100,
  loopCount: 0,
  transparent: true,
  alphaThreshold: 128,
  scale: 1,
};

/** GIF 的延时单位是 1/100 秒；浏览器对 0 的处理很不一致，所以最小给 1 */
const MIN_DELAY_CENTISEC = 1;
const MAX_DELAY_CENTISEC = 0xffff;

/* ------------------------------------------------------------------ 字节缓冲 */

class ByteSink {
  private buf = new Uint8Array(4096);
  private len = 0;

  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let next = this.buf.length * 2;
    while (next < this.len + extra) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.buf.subarray(0, this.len));
    this.buf = grown;
  }

  push(v: number): void {
    this.ensure(1);
    this.buf[this.len] = v & 0xff;
    this.len += 1;
  }

  pushBytes(src: Uint8Array): void {
    this.ensure(src.length);
    this.buf.set(src, this.len);
    this.len += src.length;
  }

  pushString(text: string): void {
    for (let i = 0; i < text.length; i += 1) this.push(text.charCodeAt(i));
  }

  finish(): Uint8Array {
    return this.buf.slice(0, this.len);
  }
}

/* --------------------------------------------------------------------- LZW */

/**
 * GIF 的 LZW 压缩。
 *
 * `minCodeSize` 是调色板位宽（≥2）。返回的已经是**分块后**的数据
 * （每块 ≤255 字节，前面一个长度字节，末尾 0x00 结束符）。
 */
function lzwEncode(indices: Uint8Array, minCodeSize: number): Uint8Array {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  const out = new ByteSink();
  let acc = 0;
  let accBits = 0;
  let codeSize = minCodeSize + 1;
  let maxCode = (1 << codeSize) - 1;
  let nextCode = endCode + 1;
  const dict = new Map<number, number>();

  const writeCode = (code: number): void => {
    acc |= code << accBits;
    accBits += codeSize;
    while (accBits >= 8) {
      out.push(acc & 0xff);
      acc >>>= 8;
      accBits -= 8;
    }
    // 加宽时机：这条码仍用旧宽度写，之后才判断下一条装不装得下
    if (nextCode > maxCode && codeSize < 12) {
      codeSize += 1;
      maxCode = (1 << codeSize) - 1;
    }
  };

  writeCode(clearCode);

  let prefix = -1;
  for (let i = 0; i < indices.length; i += 1) {
    const k = indices[i] as number;
    if (prefix < 0) {
      prefix = k;
      continue;
    }

    const key = prefix * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }

    writeCode(prefix);

    if (nextCode < 4096) {
      dict.set(key, nextCode);
      nextCode += 1;
    } else {
      // 字典满了：发清除码、重建字典。解码器看到清除码会同步重置
      writeCode(clearCode);
      dict.clear();
      nextCode = endCode + 1;
      codeSize = minCodeSize + 1;
      maxCode = (1 << codeSize) - 1;
    }
    prefix = k;
  }

  if (prefix >= 0) writeCode(prefix);
  writeCode(endCode);

  if (accBits > 0) out.push(acc & 0xff);

  const bytes = out.finish();
  const blocks = new ByteSink();
  for (let i = 0; i < bytes.length; i += 255) {
    const n = Math.min(255, bytes.length - i);
    blocks.push(n);
    blocks.pushBytes(bytes.subarray(i, i + n));
  }
  blocks.push(0);
  return blocks.finish();
}

/* ---------------------------------------------------------------- 帧准备 */

interface PreparedFrame {
  indices: Uint8Array;
  width: number;
  height: number;
  delayMs: number;
  hasTransparent: boolean;
  /** 与 indices 同长：1 = 这一格该用透明索引 */
  transparentMask: Uint8Array | null;
}

/** 整数倍最近邻放大索引与 alpha（与 composite 里那套放大同一规则） */
function expandFrame(grid: PixelGrid, factor: number): PixelGrid {
  if (factor === 1) return grid;
  const w = grid.w * factor;
  const h = grid.h * factor;
  const indices = new Uint8Array(w * h);
  const alpha = new Uint8Array(w * h);

  for (let y = 0; y < grid.h; y += 1) {
    for (let x = 0; x < grid.w; x += 1) {
      const src = y * grid.w + x;
      const index = grid.indices[src] as number;
      const a = grid.alpha[src] as number;
      for (let dy = 0; dy < factor; dy += 1) {
        const row = (y * factor + dy) * w + x * factor;
        for (let dx = 0; dx < factor; dx += 1) {
          indices[row + dx] = index;
          alpha[row + dx] = a;
        }
      }
    }
  }

  return { w, h, indices, alpha };
}

/** 调色板身份：色值完全一样才能共用全局色表 */
function paletteKey(palette: Palette): string {
  return palette.colors.map((c) => `${c[0]},${c[1]},${c[2]}`).join(';');
}

/** 调色板里第 i 个色与其余色的最近距离（用于「丢掉最少用的那个色」时找替身） */
function nearestOther(colors: readonly (readonly number[])[], drop: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < colors.length; i += 1) {
    if (i === drop) continue;
    const a = colors[i] as readonly number[];
    const b = colors[drop] as readonly number[];
    const dr = (a[0] as number) - (b[0] as number);
    const dg = (a[1] as number) - (b[1] as number);
    const db = (a[2] as number) - (b[2] as number);
    const dist = 2 * dr * dr + 4 * dg * dg + 3 * db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

interface TablePlan {
  /** 写进色表的 RGB 三元组（已补到 2 的幂） */
  table: Uint8Array;
  /** 色表位宽（逻辑屏幕描述符里的字段是 bits-1） */
  bits: number;
  /** 透明索引；没有透明就是 -1 */
  transparentIndex: number;
  /** 旧索引 → 新索引（丢色时会有几项相同） */
  mapping: Uint16Array | null;
}

/**
 * 由调色板与「是否需要透明」算出色表。
 *
 * 调色板已经满 256 色时没有空槽放透明索引，只能丢掉用得最少的那个色。
 * 丢哪个不是随便挑的：取整批帧里被引用次数最少的，再把它的像素并到最近的邻居。
 */
function planTable(
  colors: readonly (readonly number[])[],
  needTransparent: boolean,
  usage: Uint32Array,
): TablePlan {
  let list = colors.map((c) => [c[0], c[1], c[2]] as [number, number, number]);
  let mapping: Uint16Array | null = null;

  if (needTransparent && list.length >= 256) {
    let drop = -1;
    let minUse = Infinity;
    for (let i = 0; i < list.length; i += 1) {
      const used = usage[i] ?? 0;
      if (used < minUse) {
        minUse = used;
        drop = i;
      }
    }
    // 全都被用到时也必须丢一个：挑末尾那个，代价最小
    if (drop < 0) drop = list.length - 1;
    const keep = nearestOther(list, drop);
    if (keep >= 0) {
      list = list.filter((_, i) => i !== drop);
      // 丢色之后的索引整体前移一位；被丢的色并入最近的邻居
      mapping = new Uint16Array(colors.length);
      for (let i = 0; i < colors.length; i += 1) {
        if (i === drop) mapping[i] = keep > drop ? keep - 1 : keep;
        else mapping[i] = i > drop ? i - 1 : i;
      }
    }
  }

  const entryCount = Math.max(2, list.length + (needTransparent ? 1 : 0));
  let size = 2;
  let bits = 1;
  while (size < entryCount && size < 256) {
    size *= 2;
    bits += 1;
  }

  const table = new Uint8Array(size * 3);
  for (let i = 0; i < list.length; i += 1) {
    const c = list[i] as [number, number, number];
    table[i * 3] = c[0];
    table[i * 3 + 1] = c[1];
    table[i * 3 + 2] = c[2];
  }

  return {
    table,
    bits,
    transparentIndex: needTransparent ? list.length : -1,
    mapping,
  };
}

/* ------------------------------------------------------------------ 主入口 */

/**
 * 把若干帧编码成一张 GIF。
 *
 * 帧与帧之间只做「整帧覆盖」，用处置方式 2（恢复背景）——
 * 这样每帧都是独立的完整画面，不会出现上一帧残留的半边。
 */
export function encodeGif(
  frames: readonly GifFrameInput[],
  options: GifOptions = DEFAULT_GIF_OPTIONS,
): Uint8Array {
  if (frames.length === 0) throw new Error('GIF 至少需要一帧');

  const scale = Math.max(1, Math.min(16, Math.round(options.scale ?? 1)));
  const threshold =
    options.alphaThreshold === undefined ? 128 : Math.max(1, Math.min(255, options.alphaThreshold));

  const prepared: PreparedFrame[] = [];
  let width = 0;
  let height = 0;
  let sourceW = 0;
  let sourceH = 0;

  for (let f = 0; f < frames.length; f += 1) {
    const frame = frames[f] as GifFrameInput;
    if (frame.grid.w <= 0 || frame.grid.h <= 0) throw new Error(`第 ${f + 1} 帧尺寸为 0`);
    if (f > 0 && (frame.grid.w !== sourceW || frame.grid.h !== sourceH)) {
      throw new Error(
        `帧尺寸不一致（${frame.grid.w}×${frame.grid.h} 与 ${sourceW}×${sourceH}）：GIF 要求每帧同尺寸`,
      );
    }
    sourceW = frame.grid.w;
    sourceH = frame.grid.h;
    width = sourceW * scale;
    height = sourceH * scale;

    const expanded = expandFrame(frame.grid, scale);
    const total = expanded.w * expanded.h;
    const indices = new Uint8Array(total);
    indices.set(expanded.indices);

    const transparentMask = options.transparent ? new Uint8Array(total) : null;
    let hasTransparent = false;
    if (transparentMask) {
      for (let i = 0; i < total; i += 1) {
        if ((expanded.alpha[i] as number) < threshold) {
          transparentMask[i] = 1;
          hasTransparent = true;
        }
      }
    }

    prepared.push({
      indices,
      width: expanded.w,
      height: expanded.h,
      delayMs: frame.delayMs ?? options.delayMs,
      hasTransparent,
      transparentMask,
    });
  }

  /* ------- 色表：全帧同一块板就写全局色表，否则每帧局部色表 ------- */
  const keys = frames.map((f) => paletteKey(f.palette));
  const common = keys.every((k) => k === keys[0]);
  const anyTransparent = prepared.some((p) => p.hasTransparent);

  // 每个「不同的调色板」只统计一次用量；丢色时要用它挑最少用的那个
  const usageCache = new Map<string, Uint32Array>();
  const usageOf = (key: string): Uint32Array => {
    const cached = usageCache.get(key);
    if (cached) return cached;
    const usage = new Uint32Array(256);
    for (let i = 0; i < frames.length; i += 1) {
      if (keys[i] !== key) continue;
      const frame = frames[i] as GifFrameInput;
      for (let p = 0; p < frame.grid.indices.length; p += 1) {
        const alpha = frame.grid.alpha[p] as number;
        if (options.transparent && alpha < threshold) continue;
        const index = frame.grid.indices[p] as number;
        usage[index] = (usage[index] as number) + 1;
      }
    }
    usageCache.set(key, usage);
    return usage;
  };

  const commonPlan = common
    ? planTable(
        (frames[0] as GifFrameInput).palette.colors,
        anyTransparent,
        usageOf(keys[0] as string),
      )
    : null;

  const out = new ByteSink();

  /* ---------------- 文件头 ---------------- */
  out.pushString('GIF89a');

  /* ---------------- 逻辑屏幕描述符 ---------------- */
  // 没有全局色表时，色表字段必须全员为 0：否则解码器会按「有位图」去读，
  // 把后面的循环扩展当成色表数据
  const packed = commonPlan
    ? 0x80 | ((commonPlan.bits - 1) << 4) | (commonPlan.bits - 1)
    : 0;
  out.push(width & 0xff);
  out.push((width >> 8) & 0xff);
  out.push(height & 0xff);
  out.push((height >> 8) & 0xff);
  out.push(packed);
  out.push(commonPlan && commonPlan.transparentIndex >= 0 ? commonPlan.transparentIndex : 0);
  out.push(0); // 像素宽高比

  if (commonPlan) out.pushBytes(commonPlan.table);

  /* ---------------- 循环扩展 ---------------- */
  out.push(0x21);
  out.push(0xff);
  out.push(0x0b);
  out.pushString('NETSCAPE2.0');
  out.push(0x03);
  out.push(0x01);
  const loops = Math.max(0, Math.min(0xffff, Math.round(options.loopCount)));
  out.push(loops & 0xff);
  out.push((loops >> 8) & 0xff);
  out.push(0);

  /* ---------------- 各帧 ---------------- */
  const localPlans = common
    ? null
    : frames.map((f, i) =>
        // 局部色表只服务这一帧：透明槽按这一帧自己的需求决定，
        // 别因为别帧需要透明就从它这块板上挤掉一个颜色
        planTable(f.palette.colors, (prepared[i] as PreparedFrame).hasTransparent, usageOf(keys[i] as string)),
      );

  for (let i = 0; i < prepared.length; i += 1) {
    const frame = prepared[i] as PreparedFrame;
    const plan = commonPlan ?? (localPlans ? (localPlans[i] as TablePlan) : null);
    if (!plan) throw new Error('GIF 色表计算失败');

    if (plan.mapping) {
      for (let p = 0; p < frame.indices.length; p += 1) {
        const old = frame.indices[p] as number;
        frame.indices[p] = plan.mapping[old] ?? 0;
      }
    }

    // 透明像素替换成透明索引
    if (frame.hasTransparent && plan.transparentIndex >= 0) {
      const mask = frame.transparentMask;
      if (mask) {
        for (let p = 0; p < frame.indices.length; p += 1) {
          if (mask[p] === 1) frame.indices[p] = plan.transparentIndex;
        }
      }
    }

    const delay = Math.max(
      MIN_DELAY_CENTISEC,
      Math.min(MAX_DELAY_CENTISEC, Math.round(frame.delayMs / 10)),
    );

    /* 图形控制扩展：处置方式 2（恢复背景）+ 可选透明 */
    out.push(0x21);
    out.push(0xf9);
    out.push(0x04);
    const transparentFlag = frame.hasTransparent ? 1 : 0;
    out.push(transparentFlag ? 0x09 : 0x04); // 处置方式 2 在 bit2-4（值 2 → 0x08）
    out.push(delay & 0xff);
    out.push((delay >> 8) & 0xff);
    out.push(frame.hasTransparent ? plan.transparentIndex & 0xff : 0);
    out.push(0);

    /* 图像描述符 */
    out.push(0x2c);
    out.push(0);
    out.push(0);
    out.push(0);
    out.push(0);
    out.push(frame.width & 0xff);
    out.push((frame.width >> 8) & 0xff);
    out.push(frame.height & 0xff);
    out.push((frame.height >> 8) & 0xff);
    if (localPlans) {
      const bits = plan.bits;
      out.push(0x80 | (bits - 1));
      out.pushBytes(plan.table);
    } else {
      out.push(0);
    }

    const minCodeSize = Math.max(2, plan.bits);
    out.push(minCodeSize);
    out.pushBytes(lzwEncode(frame.indices, minCodeSize));
  }

  out.push(0x3b);
  return out.finish();
}
