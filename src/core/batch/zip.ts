/**
 * 极简 ZIP 打包（store 模式，不压缩）。
 *
 * 为什么自己写，而不是引 fflate：
 * - 这里的输入全是 PNG，而 PNG 内部**已经是 DEFLATE 压缩数据**了。
 *   对已压缩数据再压一遍，体积收益通常不到 1%，却要付出一次全量 CPU 遍历，
 *   外加一个 30KB 起步的依赖 —— 批量导 20 张图时这笔账不划算。
 * - store 模式的 ZIP 结构非常简单：本地头 + 中央目录 + 尾部记录，三段拼起来即可，
 *   一百多行能写对，而且能被单测直接回读校验。
 *
 * 代价（明确写出来，免得将来踩）：只支持单卷、单条目 < 4GB、不支持加密与 zip64。
 * 对本工具的用途（一次几十张 PNG）完全够用。
 */

export interface ZipEntry {
  /** 包内路径，用 `/` 分隔。本工具只产出扁平结构 */
  name: string;
  data: Uint8Array;
}

/* ------------------------------------------------------------------ CRC-32 */

/** 查表惰性构建一次；CRC 是打包里唯一的 CPU 热点 */
let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** 标准 CRC-32（IEEE 802.3），ZIP 与 PNG 用的是同一个多项式 */
export function crc32(data: Uint8Array): number {
  const table = getCrcTable();
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = table[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ---------------------------------------------------------------- 时间戳 */

/**
 * ZIP 用的 MS-DOS 时间戳：秒只有 5 位，所以只能表示偶数秒（这是格式本身的限制）。
 * 1980 年之前的时间统一记 0，否则年份字段会变成负数。
 */
function dosDateTime(date: Date): { time: number; date: number } {
  const year = date.getFullYear();
  if (year < 1980) return { time: 0, date: 0 };
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/* ------------------------------------------------------------------ 打包 */

/** 本地文件头固定 30 字节，中央目录项固定 46 字节，尾部记录固定 22 字节 */
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const EOCD = 22;

export function createZip(entries: readonly ZipEntry[], date: Date = new Date()): Uint8Array {
  const encoder = new TextEncoder();
  const { time, date: dosDate } = dosDateTime(date);

  // 文件名先编码成 UTF-8 字节，长度字段要的是字节数而不是字符数
  const prepared = entries.map((entry) => {
    const nameBytes = encoder.encode(entry.name);
    return { nameBytes, data: entry.data, crc: crc32(entry.data) };
  });

  const localSize = prepared.reduce(
    (sum, p) => sum + LOCAL_HEADER + p.nameBytes.length + p.data.length,
    0,
  );
  const centralSize = prepared.reduce((sum, p) => sum + CENTRAL_HEADER + p.nameBytes.length, 0);

  const out = new Uint8Array(localSize + centralSize + EOCD);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let offset = 0;

  /* ---------------- 各条目的本地头 + 数据 ---------------- */
  for (const p of prepared) {
    offsets.push(offset);
    view.setUint32(offset, 0x04034b50, true); offset += 4; // 本地头签名
    view.setUint16(offset, 20, true); offset += 2;         // 解压所需版本 2.0
    view.setUint16(offset, 0x0800, true); offset += 2;     // 置位 11：文件名是 UTF-8
    view.setUint16(offset, 0, true); offset += 2;          // 0 = store（不压缩）
    view.setUint16(offset, time, true); offset += 2;
    view.setUint16(offset, dosDate, true); offset += 2;
    view.setUint32(offset, p.crc, true); offset += 4;
    view.setUint32(offset, p.data.length, true); offset += 4; // 压缩后大小 = 原始大小
    view.setUint32(offset, p.data.length, true); offset += 4;
    view.setUint16(offset, p.nameBytes.length, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;          // 扩展字段长度
    out.set(p.nameBytes, offset); offset += p.nameBytes.length;
    out.set(p.data, offset); offset += p.data.length;
  }

  /* ---------------- 中央目录 ---------------- */
  const centralStart = offset;
  for (let i = 0; i < prepared.length; i += 1) {
    const p = prepared[i];
    view.setUint32(offset, 0x02014b50, true); offset += 4; // 中央目录签名
    view.setUint16(offset, 20, true); offset += 2;         // 创建版本（高字节 0 = MS-DOS）
    view.setUint16(offset, 20, true); offset += 2;         // 解压所需版本
    view.setUint16(offset, 0x0800, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;
    view.setUint16(offset, time, true); offset += 2;
    view.setUint16(offset, dosDate, true); offset += 2;
    view.setUint32(offset, p.crc, true); offset += 4;
    view.setUint32(offset, p.data.length, true); offset += 4;
    view.setUint32(offset, p.data.length, true); offset += 4;
    view.setUint16(offset, p.nameBytes.length, true); offset += 2;
    view.setUint16(offset, 0, true); offset += 2;          // 扩展字段
    view.setUint16(offset, 0, true); offset += 2;          // 条目注释
    view.setUint16(offset, 0, true); offset += 2;          // 起始磁盘号
    view.setUint16(offset, 0, true); offset += 2;          // 内部属性
    view.setUint32(offset, 0, true); offset += 4;          // 外部属性
    view.setUint32(offset, offsets[i], true); offset += 4; // 本地头偏移
    out.set(p.nameBytes, offset); offset += p.nameBytes.length;
  }

  /* ---------------- 尾部记录 ---------------- */
  view.setUint32(offset, 0x06054b50, true); offset += 4;
  view.setUint16(offset, 0, true); offset += 2; // 本磁盘编号
  view.setUint16(offset, 0, true); offset += 2; // 中央目录起始磁盘
  view.setUint16(offset, prepared.length, true); offset += 2;
  view.setUint16(offset, prepared.length, true); offset += 2;
  view.setUint32(offset, centralSize, true); offset += 4;
  view.setUint32(offset, centralStart, true); offset += 4;
  view.setUint16(offset, 0, true); offset += 2; // 注释长度

  return out;
}
