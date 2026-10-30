/**
 * 命令行用的 PNG 编解码（M7 的 CLI）。
 *
 * 为什么自己写而不是引 `pngjs`：这里的需求极窄 —— 8 位、非隔行、四种通道组合。
 * 用 `node:zlib` 做 inflate/deflate，剩下的只是读块、反滤波、写块，一共一百多行，
 * 还能被完整地单测（自己编码 → 自己解码 → 逐像素比对）。
 * 引一个包反而要额外处理它的版本、维护状态与 API 变更。
 *
 * 明确不支持（会给出可读的报错，而不是静默出错）：
 * - 16 位色深、隔行扫描、Adam7
 * - APNG（当作静态首帧读，因为没有 `acTL` 就只是普通 PNG）
 */

import { deflateSync, inflateSync } from 'node:zlib';

export interface DecodedPng {
  width: number;
  height: number;
  /** RGBA，8 位，自上而下 */
  data: Uint8ClampedArray;
}

/** PNG 的五个滤波器类型 */
const FILTER_NONE = 0;
const FILTER_SUB = 1;
const FILTER_UP = 2;
const FILTER_AVERAGE = 3;
const FILTER_PAETH = 4;

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** 一行反滤波（原地改 buf） */
function unfilterRow(
  filter: number,
  // 必须是 Uint8Array 而不是 Uint8ClampedArray：滤波的逆运算在字节上取模 256，
  // 超出 255 要「绕回去」；ClampedArray 会把它钳到 255，得到一片白
  buf: Uint8Array,
  offset: number,
  prevOffset: number,
  rowLen: number,
  bpp: number,
): void {
  for (let i = 0; i < rowLen; i += 1) {
    const x = buf[offset + i];
    const a = i >= bpp ? buf[offset + i - bpp] : 0;
    const b = prevOffset >= 0 ? buf[prevOffset + i] : 0;
    const c = prevOffset >= 0 && i >= bpp ? buf[prevOffset + i - bpp] : 0;

    let value = x;
    switch (filter) {
      case FILTER_NONE:
        break;
      case FILTER_SUB:
        value = x + a;
        break;
      case FILTER_UP:
        value = x + b;
        break;
      case FILTER_AVERAGE:
        value = x + Math.floor((a + b) / 2);
        break;
      case FILTER_PAETH:
        value = x + paeth(a, b, c);
        break;
      default:
        throw new Error(`PNG 里出现了未知的滤波类型 ${filter}`);
    }
    buf[offset + i] = value;
  }
}

/** 从 iCCP/sRGB 之类的辅助块里拿到调色板与 tRNS */
interface PaletteInfo {
  entries: Uint8Array;
  trns: Uint8Array | null;
}

export function decodePng(buffer: Buffer | Uint8Array): DecodedPng {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.length < 8) throw new Error('不是有效的 PNG（文件太短）');

  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== signature[i]) throw new Error('不是有效的 PNG（签名不对）');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idat: Uint8Array[] = [];
  let palette: PaletteInfo | null = null;
  /** 先读到 tRNS、后读到 PLTE 时暂存，等 PLTE 到了再挂上去 */
  let pendingTrns: Uint8Array | null = null;

  let p = 8;
  while (p + 8 <= bytes.length) {
    const length = readU32(bytes, p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const dataStart = p + 8;
    if (dataStart + length > bytes.length) throw new Error('PNG 数据被截断了');

    if (type === 'IHDR') {
      width = readU32(bytes, dataStart);
      height = readU32(bytes, dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      interlace = bytes[dataStart + 12];
    } else if (type === 'PLTE') {
      const entries = new Uint8Array(bytes.subarray(dataStart, dataStart + length));
      // tRNS 可能在前也可能在后；两种顺序都接住
      palette = { entries, trns: palette ? palette.trns : pendingTrns };
    } else if (type === 'tRNS') {
      const trns = new Uint8Array(bytes.subarray(dataStart, dataStart + length));
      if (palette) palette.trns = trns;
      else pendingTrns = trns;
    } else if (type === 'IDAT') {
      idat.push(new Uint8Array(bytes.subarray(dataStart, dataStart + length)));
    } else if (type === 'IEND') {
      break;
    }
    p = dataStart + length + 4; // +4：跳过 CRC（我们不校验，浏览器的编码器不会产出坏 CRC）
  }

  if (width <= 0 || height <= 0) throw new Error('PNG 缺少 IHDR，或尺寸为 0');
  if (bitDepth !== 8) {
    throw new Error(`只支持 8 位色深的 PNG（这张是 ${bitDepth} 位，请先转成 8 位）`);
  }
  if (interlace !== 0) throw new Error('不支持隔行扫描（Adam7）的 PNG，请先另存为普通 PNG');
  if (idat.length === 0) throw new Error('PNG 里没有图像数据（IDAT）');

  const channels =
    colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  if (colorType === 3 && !palette) throw new Error('索引色 PNG 缺少调色板（PLTE）');

  const raw = inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c))));
  const rowLen = width * channels;
  const needed = (rowLen + 1) * height;
  if (raw.length < needed) throw new Error('PNG 图像数据长度与尺寸不符');

  // 先在「原通道数」的缓冲里反滤波，再统一展开成 RGBA
  const planar = new Uint8Array(rowLen * height);
  for (let y = 0; y < height; y += 1) {
    const srcRow = y * (rowLen + 1);
    const filter = raw[srcRow];
    const dst = y * rowLen;
    planar.set(raw.subarray(srcRow + 1, srcRow + 1 + rowLen), dst);
    unfilterRow(filter, planar, dst, y > 0 ? dst - rowLen : -1, rowLen, channels);
  }

  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const o = i * 4;
    const s = i * channels;
    if (colorType === 6) {
      data[o] = planar[s];
      data[o + 1] = planar[s + 1];
      data[o + 2] = planar[s + 2];
      data[o + 3] = planar[s + 3];
    } else if (colorType === 2) {
      data[o] = planar[s];
      data[o + 1] = planar[s + 1];
      data[o + 2] = planar[s + 2];
      data[o + 3] = 255;
    } else if (colorType === 0) {
      data[o] = data[o + 1] = data[o + 2] = planar[s];
      data[o + 3] = 255;
    } else if (colorType === 4) {
      data[o] = data[o + 1] = data[o + 2] = planar[s];
      data[o + 3] = planar[s + 1];
    } else {
      // 索引色：查表
      const index = planar[s];
      const entry = index * 3;
      const table = palette?.entries;
      if (!table) throw new Error('索引色 PNG 缺少调色板');
      data[o] = table[entry] ?? 0;
      data[o + 1] = table[entry + 1] ?? 0;
      data[o + 2] = table[entry + 2] ?? 0;
      // tRNS 里第 index 个字节是透明度；不存在就全不透明
      data[o + 3] = palette?.trns?.[index] ?? 255;
    }
  }

  return { width, height, data };
}

/* -------------------------------------------------------------- 编码 */

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset] ?? 0) << 24) |
    ((bytes[offset + 1] ?? 0) << 16) |
    ((bytes[offset + 2] ?? 0) << 8) |
    (bytes[offset + 3] ?? 0)
  ) >>> 0;
}

/** PNG 的 CRC 是标准 CRC-32（与 zip 同一个多项式） */
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
  const crcInput = out.subarray(4, 8 + data.length);
  out.writeUInt32BE(crc32(crcInput), 8 + data.length);
  return out;
}

/**
 * RGBA → PNG。
 *
 * 一律写 8 位 RGBA（colorType 6），并**不做调色板化**：目标是「把像素图导出成文件」，
 * 用 RGBA 能保证透明区与颜色一个不差；文件大一点无所谓（像素图本来就小）。
 */
export function encodePng(data: Uint8ClampedArray, width: number, height: number): Buffer {
  if (width <= 0 || height <= 0) throw new Error('图片尺寸必须大于 0');
  if (data.length !== width * height * 4) {
    throw new Error('像素数据长度与尺寸不符');
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 位深
  ihdr[9] = 6; // colorType：RGBA
  ihdr[10] = 0; // 压缩方法：deflate
  ihdr[11] = 0; // 滤波方法：自适应
  ihdr[12] = 0; // 非隔行

  // 每行前面放一个滤波字节；全用 0（None）—— 像素图色块大，滤波收益很低
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = FILTER_NONE;
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const idat = deflateSync(raw, { level: 6 });
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(idat)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
