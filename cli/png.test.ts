/**
 * PNG 编解码的测试（cli/png.ts）。
 *
 * 这里刻意**自己搭 PNG 文件**而不是拿现成文件：只有能按需造出
 * 五种滤波、四种 colorType、以及「tRNS 在 PLTE 前后」这些组合，
 * 才能确认解码器真的按规范读，而不是只认自己编码器产出的那一种形状。
 *
 * 「自己编码 → 自己解码 → 逐像素比对」能测出写入端的错误，
 * 但对「两边都误解了规范」是瞎的 —— 所以 colorType 3 的用例里
 * 断言的期望值全部写成字面量，不经过任何本项目的函数。
 */

import { deflateSync } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { decodePng, encodePng } from './png';

/* ------------------------------------------------------------- 造 PNG 用的小工具 */

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = (CRC_TABLE[(c ^ bytes[i]) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(data.length + 12);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 把一行原始样本按 PNG 规则算成滤波后的字节（解码器要做的是反过来） */
function filterRow(filter: number, row: number[], prev: number[] | null, bpp: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < row.length; i += 1) {
    const x = row[i] as number;
    const a = i >= bpp ? (row[i - bpp] as number) : 0;
    const b = prev ? (prev[i] as number) : 0;
    const c = prev && i >= bpp ? (prev[i - bpp] as number) : 0;
    switch (filter) {
      case 0:
        out.push(x);
        break;
      case 1:
        out.push((x - a + 256) % 256);
        break;
      case 2:
        out.push((x - b + 256) % 256);
        break;
      case 3:
        out.push((x - Math.floor((a + b) / 2) + 256) % 256);
        break;
      case 4:
        out.push((x - paeth(a, b, c) + 256) % 256);
        break;
      default:
        throw new Error(`测试不该出现滤波器 ${filter}`);
    }
  }
  return out;
}

function channelsOf(colorType: number): number {
  return colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
}

interface PngSpec {
  width: number;
  height: number;
  colorType: number;
  /** 每行未滤波的样本，长度 = width × 通道数 */
  rows: number[][];
  /** 每行的滤波器；给一个数字则所有行都用它 */
  filters?: number | number[];
  plte?: number[];
  trns?: number[];
  /** 把 tRNS 放到 PLTE 前面，测「先读到 tRNS」的分支 */
  trnsBeforePlte?: boolean;
  /** 篡改 IHDR 里的位深 / 隔行，用来测报错 */
  bitDepth?: number;
  interlace?: number;
}

function buildPng(spec: PngSpec): Buffer {
  const channels = channelsOf(spec.colorType);
  const filters = Array.isArray(spec.filters)
    ? spec.filters
    : spec.rows.map(() => (spec.filters as number | undefined) ?? 0);

  const raw: number[] = [];
  for (let y = 0; y < spec.height; y += 1) {
    const row = spec.rows[y] as number[];
    raw.push(filters[y] ?? 0);
    raw.push(...filterRow(filters[y] ?? 0, row, y > 0 ? (spec.rows[y - 1] as number[]) : null, channels));
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(spec.width, 0);
  ihdr.writeUInt32BE(spec.height, 4);
  ihdr[8] = spec.bitDepth ?? 8;
  ihdr[9] = spec.colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = spec.interlace ?? 0;

  const parts: Buffer[] = [Buffer.from(SIGNATURE), chunk('IHDR', new Uint8Array(ihdr))];
  const plteChunk = spec.plte ? chunk('PLTE', new Uint8Array(spec.plte)) : null;
  const trnsChunk = spec.trns ? chunk('tRNS', new Uint8Array(spec.trns)) : null;
  if (trnsChunk && spec.trnsBeforePlte) parts.push(trnsChunk);
  if (plteChunk) parts.push(plteChunk);
  if (trnsChunk && !spec.trnsBeforePlte) parts.push(trnsChunk);
  parts.push(chunk('IDAT', new Uint8Array(deflateSync(Buffer.from(raw)))));
  parts.push(chunk('IEND', new Uint8Array(0)));
  return Buffer.concat(parts);
}

/** 取输出里某个像素，方便逐点断言 */
function pixelAt(
  image: { width: number; data: Uint8ClampedArray },
  x: number,
  y: number,
): [number, number, number, number] {
  const o = (y * image.width + x) * 4;
  return [image.data[o] as number, image.data[o + 1] as number, image.data[o + 2] as number, image.data[o + 3] as number];
}

/* ------------------------------------------------------------------- 用例 */

describe('encodePng ↔ decodePng 往返', () => {
  it('RGBA 逐像素还原，含半透明', () => {
    const data = new Uint8ClampedArray([
      255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 12, 34, 56, 200, 78, 90, 123, 255, 200, 201,
      202, 77,
    ]);
    const decoded = decodePng(encodePng(data, 3, 2));
    expect(decoded.width).toBe(3);
    expect(decoded.height).toBe(2);
    expect(Array.from(decoded.data)).toEqual(Array.from(data));
  });

  it('1×1 也能往返', () => {
    const data = new Uint8ClampedArray([9, 8, 7, 6]);
    const decoded = decodePng(encodePng(data, 1, 1));
    expect(pixelAt(decoded, 0, 0)).toEqual([9, 8, 7, 6]);
  });

  it('全透明像素的 alpha 保持 0（不是 255）', () => {
    const data = new Uint8ClampedArray(4 * 4 * 4);
    const decoded = decodePng(encodePng(data, 4, 4));
    expect(decoded.data.every((v) => v === 0)).toBe(true);
  });
});

describe('反滤波', () => {
  const rows = [
    [10, 200, 30, 255, 40, 50, 60, 70, 80, 90, 100, 110],
    [120, 130, 140, 150, 160, 170, 180, 190, 200, 210, 220, 230],
  ];

  it.each([0, 1, 2, 3, 4])('滤波器 %i 的结果与原始数据一致', (filter) => {
    const png = buildPng({ width: 3, height: 2, colorType: 6, rows, filters: filter });
    const decoded = decodePng(png);
    const expected = rows.flat();
    // 原图是 RGBA，解码后就是同一串值
    expect(Array.from(decoded.data)).toEqual(expected);
  });

  it('每行用不同的滤波器也一致（真实编码器是逐行选的）', () => {
    const png = buildPng({ width: 3, height: 2, colorType: 6, rows, filters: [4, 1] });
    expect(Array.from(decodePng(png).data)).toEqual(rows.flat());
  });
});

describe('各种 colorType 展开成 RGBA', () => {
  it('colorType 2（RGB）补上不透明 alpha', () => {
    const decoded = decodePng(
      buildPng({
        width: 2,
        height: 1,
        colorType: 2,
        rows: [[255, 0, 0, 0, 255, 0]],
      }),
    );
    expect(pixelAt(decoded, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(decoded, 1, 0)).toEqual([0, 255, 0, 255]);
  });

  it('colorType 0（灰度）三个通道相同', () => {
    const decoded = decodePng(
      buildPng({ width: 2, height: 1, colorType: 0, rows: [[17, 200]] }),
    );
    expect(pixelAt(decoded, 0, 0)).toEqual([17, 17, 17, 255]);
    expect(pixelAt(decoded, 1, 0)).toEqual([200, 200, 200, 255]);
  });

  it('colorType 4（灰度 + alpha）', () => {
    const decoded = decodePng(
      buildPng({ width: 2, height: 1, colorType: 4, rows: [[17, 0, 200, 128]] }),
    );
    expect(pixelAt(decoded, 0, 0)).toEqual([17, 17, 17, 0]);
    expect(pixelAt(decoded, 1, 0)).toEqual([200, 200, 200, 128]);
  });

  it('colorType 3（索引色）查 PLTE 与 tRNS', () => {
    const decoded = decodePng(
      buildPng({
        width: 2,
        height: 1,
        colorType: 3,
        rows: [[0, 1]],
        // 两条：纯红不透明、绿色半透明
        plte: [255, 0, 0, 0, 255, 0],
        trns: [255, 128],
      }),
    );
    // 期望值写死，不经过本项目的任何函数
    expect(pixelAt(decoded, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(decoded, 1, 0)).toEqual([0, 255, 0, 128]);
  });

  it('tRNS 出现在 PLTE 之前也能接上', () => {
    const decoded = decodePng(
      buildPng({
        width: 1,
        height: 1,
        colorType: 3,
        rows: [[0]],
        plte: [10, 20, 30],
        trns: [77],
        trnsBeforePlte: true,
      }),
    );
    expect(pixelAt(decoded, 0, 0)).toEqual([10, 20, 30, 77]);
  });

  it('索引色没有 tRNS 时全部不透明', () => {
    const decoded = decodePng(
      buildPng({ width: 1, height: 1, colorType: 3, rows: [[0]], plte: [1, 2, 3] }),
    );
    expect(pixelAt(decoded, 0, 0)).toEqual([1, 2, 3, 255]);
  });
});

describe('坏文件的报错', () => {
  it('太短', () => {
    expect(() => decodePng(Buffer.from([1, 2, 3]))).toThrow(/太短/);
  });

  it('签名不对', () => {
    const png = buildPng({ width: 1, height: 1, colorType: 6, rows: [[1, 2, 3, 4]] });
    png[0] = 0;
    expect(() => decodePng(png)).toThrow(/签名/);
  });

  it('16 位色深给出可读提示', () => {
    const png = buildPng({
      width: 1,
      height: 1,
      colorType: 6,
      bitDepth: 16,
      rows: [[1, 2, 3, 4]],
    });
    expect(() => decodePng(png)).toThrow(/8 位/);
  });

  it('隔行扫描给出可读提示', () => {
    const png = buildPng({
      width: 1,
      height: 1,
      colorType: 6,
      interlace: 1,
      rows: [[1, 2, 3, 4]],
    });
    expect(() => decodePng(png)).toThrow(/隔行/);
  });

  it('缺 IDAT', () => {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(1, 0);
    ihdr.writeUInt32BE(1, 4);
    ihdr[8] = 8;
    ihdr[9] = 6;
    const png = Buffer.concat([
      Buffer.from(SIGNATURE),
      chunk('IHDR', new Uint8Array(ihdr)),
      chunk('IEND', new Uint8Array(0)),
    ]);
    expect(() => decodePng(png)).toThrow(/IDAT/);
  });

  it('数据被截断', () => {
    const png = buildPng({ width: 2, height: 1, colorType: 6, rows: [[1, 2, 3, 4, 5, 6, 7, 8]] });
    // 把 IDAT 载荷截掉一半：块长度还写着原值
    const cut = png.subarray(0, png.length - 30);
    expect(() => decodePng(Buffer.from(cut))).toThrow();
  });
});

describe('编码端的入参校验', () => {
  it('尺寸为 0', () => {
    expect(() => encodePng(new Uint8ClampedArray(0), 0, 1)).toThrow(/大于 0/);
  });

  it('数据长度与尺寸不符', () => {
    expect(() => encodePng(new Uint8ClampedArray(8), 2, 2)).toThrow(/长度/);
  });
});
