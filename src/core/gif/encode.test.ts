/**
 * GIF 编码器的测试（M8）。
 *
 * 这里配了一个**独立的 GIF 解析器 + LZW 解码器**，按格式规范写，
 * 不复用 encode.ts 里的任何常量或函数 —— 否则「编码与解码两边同错一致」，
 * 测试会全绿而浏览器打不开。.ase 那轮就踩过这个坑（见 docs/DESIGN.md §12）。
 *
 * 覆盖重点：码宽增长时机（最容易写错）、透明索引、逐帧局部色表、
 * 256 色时丢色、整数放大、子块切分。
 */

import { describe, expect, it } from 'vitest';

import { makePalette, BLUE, CLEAR, GREEN, RED, WHITE } from '@/core/__testing__/fixtures';
import { createGrid, type Palette, type PixelGrid } from '@/core/types';
import { encodeGif, type GifOptions } from './encode';

/* ---------------------------------------------------------------- 被测算助 */

function gridOf(w: number, h: number, indices: number[], alphas?: number[]): PixelGrid {
  const grid = createGrid(w, h);
  grid.indices.set(indices);
  grid.alpha.fill(255);
  if (alphas) grid.alpha.set(alphas);
  return grid;
}

const TWO = makePalette('two', [RED, BLUE]);
const FOUR = makePalette('four', [RED, GREEN, BLUE, WHITE]);

function opts(patch: Partial<GifOptions> = {}): GifOptions {
  return { delayMs: 100, loopCount: 0, transparent: true, alphaThreshold: 128, scale: 1, ...patch };
}

/* ---------------------------------------------------------- 独立的 GIF 解析 */

interface ParsedFrame {
  indices: number[];
  delayCentis: number;
  transparentIndex: number;
  hasTransparent: boolean;
  /** 局部色表（扁平 RGB），没有就是 null */
  localTable: Uint8Array | null;
}

interface ParsedGif {
  width: number;
  height: number;
  globalTable: Uint8Array | null;
  loopCount: number | null;
  frames: ParsedFrame[];
}

/** 标准 GIF LZW 解码；实现依据是规范，不参考编码端 */
function lzwDecode(data: Uint8Array, minCodeSize: number, pixelCount: number): number[] {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let codeSize = minCodeSize + 1;
  let next = end + 1;
  let bitPos = 0;

  const readCode = (): number => {
    let code = 0;
    for (let i = 0; i < codeSize; i += 1) {
      const byteIndex = bitPos >> 3;
      if (byteIndex >= data.length) return end;
      const bit = (data[byteIndex] as number) >> (bitPos & 7) & 1;
      code |= bit << i;
      bitPos += 1;
    }
    return code;
  };

  const prefix = new Int32Array(4096);
  const suffix = new Int32Array(4096);
  const stack = new Int32Array(4097);
  for (let i = 0; i < clear; i += 1) suffix[i] = i;

  const out: number[] = [];
  let prev = -1;

  const pushString = (code: number): number => {
    let sp = 0;
    let c = code;
    // 编码号 ≥ clear 的都带着前缀；一路回溯到字面量
    while (c >= clear) {
      stack[sp] = suffix[c] as number;
      sp += 1;
      c = prefix[c] as number;
      if (sp > 4096) throw new Error('LZW 前缀链裂了');
    }
    stack[sp] = c;
    sp += 1;
    return sp;
  };

  for (;;) {
    const code = readCode();
    if (code === end) break;
    if (code === clear) {
      codeSize = minCodeSize + 1;
      next = end + 1;
      prev = -1;
      continue;
    }

    if (prev === -1) {
      if (code >= clear) throw new Error(`早出现的码 ${code} 不是字面量`);
      out.push(code);
      prev = code;
      continue;
    }

    let first: number;
    if (code < next) {
      const sp = pushString(code);
      first = stack[sp - 1] as number;
      for (let i = sp - 1; i >= 0; i -= 1) out.push(stack[i] as number);
    } else if (code === next) {
      const sp = pushString(prev);
      first = stack[sp - 1] as number;
      for (let i = sp - 1; i >= 0; i -= 1) out.push(stack[i] as number);
      out.push(first);
    } else {
      throw new Error(`读到不存在的码 ${code}（字典只到 ${next - 1}）`);
    }

    if (next < 4096) {
      prefix[next] = prev;
      suffix[next] = first;
      next += 1;
      if (next === 1 << codeSize && codeSize < 12) codeSize += 1;
    }
    prev = code;
  }

  if (out.length < pixelCount) throw new Error(`解出的像素不够：${out.length}/${pixelCount}`);
  return out.slice(0, pixelCount);
}

function readSubBlocks(bytes: Uint8Array, start: number): { data: Uint8Array; next: number } {
  const parts: number[] = [];
  let p = start;
  for (;;) {
    const size = bytes[p] as number;
    p += 1;
    if (size === 0) break;
    for (let i = 0; i < size; i += 1) parts.push(bytes[p + i] as number);
    p += size;
  }
  return { data: Uint8Array.from(parts), next: p };
}

function parseGif(bytes: Uint8Array): ParsedGif {
  expect(String.fromCharCode(...Array.from(bytes.subarray(0, 6)))).toBe('GIF89a');

  let p = 6;
  const width = (bytes[p] as number) | ((bytes[p + 1] as number) << 8);
  const height = (bytes[p + 2] as number) | ((bytes[p + 3] as number) << 8);
  const packed = bytes[p + 4] as number;
  p += 7;

  let globalTable: Uint8Array | null = null;
  if (packed & 0x80) {
    const size = 1 << ((packed & 0x07) + 1);
    globalTable = new Uint8Array(bytes.subarray(p, p + size * 3));
    p += size * 3;
  }

  const frames: ParsedFrame[] = [];
  let loopCount: number | null = null;
  let pendingDelay = 0;
  let pendingTransparent = -1;
  let pendingHasTransparent = false;

  while (p < bytes.length) {
    const marker = bytes[p] as number;
    p += 1;
    if (marker === 0x3b) break;

    if (marker === 0x21) {
      const label = bytes[p] as number;
      p += 1;
      if (label === 0xf9) {
        const size = bytes[p] as number;
        const flags = bytes[p + 1] as number;
        pendingDelay = (bytes[p + 2] as number) | ((bytes[p + 3] as number) << 8);
        pendingTransparent = bytes[p + 4] as number;
        pendingHasTransparent = (flags & 1) === 1;
        p += 1 + size + 1;
      } else if (label === 0xff) {
        const size = bytes[p] as number;
        const name = String.fromCharCode(...Array.from(bytes.subarray(p + 1, p + 1 + size)));
        p += 1 + size;
        const block = readSubBlocks(bytes, p);
        const id = block.data[0];
        if (name === 'NETSCAPE2.0' && id === 1) {
          loopCount = (block.data[1] as number) | ((block.data[2] as number) << 8);
        }
        p = block.next;
      } else {
        const block = readSubBlocks(bytes, p);
        p = block.next;
      }
      continue;
    }

    if (marker === 0x2c) {
      const left = (bytes[p] as number) | ((bytes[p + 1] as number) << 8);
      const top = (bytes[p + 2] as number) | ((bytes[p + 3] as number) << 8);
      const fw = (bytes[p + 4] as number) | ((bytes[p + 5] as number) << 8);
      const fh = (bytes[p + 6] as number) | ((bytes[p + 7] as number) << 8);
      const flags = bytes[p + 8] as number;
      p += 9;

      let localTable: Uint8Array | null = null;
      if (flags & 0x80) {
        const size = 1 << ((flags & 0x07) + 1);
        localTable = new Uint8Array(bytes.subarray(p, p + size * 3));
        p += size * 3;
      }

      const minCodeSize = bytes[p] as number;
      p += 1;
      const block = readSubBlocks(bytes, p);
      p = block.next;

      expect(left).toBe(0);
      expect(top).toBe(0);
      const table = localTable ?? globalTable;
      if (!table) throw new Error('既没有全局色表也没有局部色表，无法解码');
      const indices = lzwDecode(block.data, minCodeSize, fw * fh);

      frames.push({
        indices,
        delayCentis: pendingDelay,
        transparentIndex: pendingTransparent,
        hasTransparent: pendingHasTransparent,
        localTable,
      });
      pendingDelay = 0;
      pendingTransparent = -1;
      pendingHasTransparent = false;
      continue;
    }

    throw new Error(`不认识的块标记 0x${marker.toString(16)}`);
  }

  return { width, height, globalTable, loopCount, frames };
}

/** 从色表里取某个索引的 RGB */
function colorOf(table: Uint8Array, index: number): [number, number, number] {
  return [
    table[index * 3] as number,
    table[index * 3 + 1] as number,
    table[index * 3 + 2] as number,
  ];
}

/* ------------------------------------------------------------------- 用例 */

describe('文件骨架', () => {
  it('帧数、画布尺寸、循环次数、每帧延时', () => {
    const a = gridOf(3, 2, [0, 0, 1, 1, 0, 0]);
    const b = gridOf(3, 2, [1, 1, 0, 0, 1, 1]);
    const parsed = parseGif(
      encodeGif(
        [
          { grid: a, palette: TWO, delayMs: 80 },
          { grid: b, palette: TWO, delayMs: 120 },
        ],
        opts({ loopCount: 3 }),
      ),
    );

    expect(parsed.width).toBe(3);
    expect(parsed.height).toBe(2);
    expect(parsed.frames).toHaveLength(2);
    expect(parsed.loopCount).toBe(3);
    expect(parsed.frames[0]?.delayCentis).toBe(8);
    expect(parsed.frames[1]?.delayCentis).toBe(12);
  });

  it('没给帧时长时用 options.delayMs', () => {
    const parsed = parseGif(
      encodeGif([{ grid: gridOf(1, 1, [0]), palette: TWO }], opts({ delayMs: 250 })),
    );
    expect(parsed.frames[0]?.delayCentis).toBe(25);
  });

  it('延时 0 也不会写成 0（浏览器对 0 的处理不一致）', () => {
    const parsed = parseGif(
      encodeGif([{ grid: gridOf(1, 1, [0]), palette: TWO, delayMs: 0 }], opts()),
    );
    expect(parsed.frames[0]?.delayCentis).toBe(1);
  });

  it('根本没有帧时报错', () => {
    expect(() => encodeGif([], opts())).toThrow(/至少需要一帧/);
  });

  it('帧尺寸不一致时报错，而不是悄悄取第一帧的尺寸', () => {
    expect(() =>
      encodeGif(
        [
          { grid: gridOf(2, 2, [0, 1, 0, 1]), palette: TWO },
          { grid: gridOf(3, 3, [0, 1, 0, 1, 0, 1, 0, 1, 0]), palette: TWO },
        ],
        opts(),
      ),
    ).toThrow(/尺寸不一致/);
  });
});

describe('索引与色表', () => {
  it('同一块调色板的帧共用全局色表，索引逐格还原', () => {
    const indices = [0, 1, 0, 1, 1, 0];
    const parsed = parseGif(
      encodeGif([{ grid: gridOf(3, 2, indices), palette: TWO }], opts({ transparent: false })),
    );

    expect(parsed.globalTable).not.toBeNull();
    expect(parsed.frames[0]?.localTable).toBeNull();
    expect(parsed.frames[0]?.indices).toEqual(indices);
    // 色表按调色板顺序写；两色就是 2 项（GIF 的色表最小 2 项，不必再补）
    const table = parsed.globalTable as Uint8Array;
    expect(colorOf(table, 0)).toEqual([255, 0, 0]);
    expect(colorOf(table, 1)).toEqual([0, 0, 255]);
    expect(table.length).toBe(2 * 3);
  });

  it('不同调色板的帧各写局部色表，且没有全局色表', () => {
    const parsed = parseGif(
      encodeGif(
        [
          { grid: gridOf(2, 1, [0, 1]), palette: TWO },
          { grid: gridOf(2, 1, [2, 3]), palette: FOUR },
        ],
        opts({ transparent: false }),
      ),
    );

    expect(parsed.globalTable).toBeNull();
    const second = parsed.frames[1];
    expect(second?.localTable).not.toBeNull();
    const table = second?.localTable as Uint8Array;
    expect(colorOf(table, 2)).toEqual([0, 0, 255]);
    expect(colorOf(table, 3)).toEqual([255, 255, 255]);
    expect(second?.indices).toEqual([2, 3]);
  });

  it('长图也能解回来（LZW 会切出多个子块）', () => {
    const w = 64;
    const h = 64;
    const indices = Array.from({ length: w * h }, (_, i) => ((i * 7) % 3 === 0 ? 1 : 0));
    const parsed = parseGif(
      encodeGif([{ grid: gridOf(w, h, indices), palette: TWO }], opts({ transparent: false })),
    );
    expect(parsed.frames[0]?.indices).toEqual(indices);
  });

  it('码宽增长的临界点：字典装满 2^n 时不能早加宽', () => {
    // 逐像素都不重复的图最容易踩到加宽时机：字典几乎每个像素都在增长
    const w = 40;
    const h = 40;
    const indices = Array.from({ length: w * h }, (_, i) => (i % 4));
    const parsed = parseGif(
      encodeGif([{ grid: gridOf(w, h, indices), palette: FOUR }], opts({ transparent: false })),
    );
    expect(parsed.frames[0]?.indices).toEqual(indices);
  });
});

describe('透明', () => {
  it('alpha 低于阈值用透明索引，高于阈值的仍是实色', () => {
    const indices = [0, 1, 0, 1];
    const alphas = [0, 255, 100, 200];
    const parsed = parseGif(
      encodeGif([{ grid: gridOf(2, 2, indices, alphas), palette: TWO }], opts({ alphaThreshold: 128 })),
    );

    const frame = parsed.frames[0];
    expect(frame?.hasTransparent).toBe(true);
    // 两色 + 一个透明槽 → 4 项色表，透明索引 2
    expect(frame?.transparentIndex).toBe(2);
    expect(frame?.indices).toEqual([2, 1, 2, 1]);
  });

  it('关掉透明时 alpha 全部忽略，也不写透明标记', () => {
    const parsed = parseGif(
      encodeGif(
        [{ grid: gridOf(2, 2, [0, 1, 0, 1], [0, 0, 0, 0]), palette: TWO }],
        opts({ transparent: false }),
      ),
    );
    expect(parsed.frames[0]?.hasTransparent).toBe(false);
    expect(parsed.frames[0]?.indices).toEqual([0, 1, 0, 1]);
  });

  it('调色板满 256 色时挤出透明槽：丢掉用得最少的颜色并并到相邻色', () => {
    // 1..255 号色各用一次，0 号色完全不用 → 应该丢掉 0 号
    const colors = Array.from({ length: 256 }, (_, i) => [i, 255 - i, i] as const);
    colors[0] = [255, 0, 0];
    colors[1] = [0, 255, 0];
    const palette: Palette = {
      id: 'full',
      name: 'full',
      colors: colors.map((c) => [c[0], c[1], c[2], 255] as const),
    };

    // 第一格（旧索引 0）是透明的，其余 255 格依次用 1..255 号色
    const indices = [0];
    for (let i = 1; i < 256; i += 1) indices.push(i);
    const alphas = indices.map(() => 255);
    alphas[0] = 0;

    const parsed = parseGif(
      encodeGif([{ grid: gridOf(256, 1, indices, alphas), palette }], opts()),
    );

    const frame = parsed.frames[0];
    expect(frame?.hasTransparent).toBe(true);
    // 255 色 + 1 透明槽 = 256
    expect(frame?.transparentIndex).toBe(255);
    const table = parsed.globalTable as Uint8Array;
    expect(table.length).toBe(256 * 3);
    // 透明那格指向 255；其余像素的索引整体前移一位（被丢的是 0 号）
    expect(frame?.indices[0]).toBe(255);
    for (let i = 1; i < 256; i += 1) expect(frame?.indices[i]).toBe(i - 1);
  });
});

describe('放大', () => {
  it('scale 2 让画布与每格都翻倍', () => {
    const parsed = parseGif(
      encodeGif([{ grid: gridOf(2, 2, [0, 1, 0, 1]), palette: TWO }], opts({ scale: 2, transparent: false })),
    );
    expect(parsed.width).toBe(4);
    expect(parsed.height).toBe(4);
    expect(parsed.frames[0]?.indices).toEqual([
      0, 0, 1, 1,
      0, 0, 1, 1,
      0, 0, 1, 1,
      0, 0, 1, 1,
    ]);
  });
});

describe('边界输入', () => {
  it('1×1 单帧', () => {
    const parsed = parseGif(encodeGif([{ grid: gridOf(1, 1, [1]), palette: TWO }], opts()));
    expect(parsed.width).toBe(1);
    expect(parsed.frames[0]?.indices).toEqual([1]);
  });

  it('全透明的一帧也能编出来', () => {
    const parsed = parseGif(
      encodeGif([{ grid: gridOf(2, 2, [0, 0, 0, 0], [0, 0, 0, 0]), palette: TWO }], opts()),
    );
    expect(parsed.frames[0]?.indices).toEqual([2, 2, 2, 2]);
  });

  it('全不透明时透明槽不会混进画面（透明索引不会被任何像素用到）', () => {
    const parsed = parseGif(
      encodeGif([{ grid: gridOf(2, 1, [0, 1]), palette: TWO }], opts()),
    );
    expect(parsed.frames[0]?.hasTransparent).toBe(false);
  });
});

describe('CLEAR 色的约定', () => {
  it('alpha 为 0 的像素在不开透明时保留索引，不会变成透明洞', () => {
    const parsed = parseGif(
      encodeGif([{ grid: gridOf(2, 1, [0, 1], [0, 255]), palette: makePalette('x', [CLEAR, BLUE]) }], opts({ transparent: false })),
    );
    expect(parsed.frames[0]?.hasTransparent).toBe(false);
    expect(parsed.frames[0]?.indices).toEqual([0, 1]);
  });
});
