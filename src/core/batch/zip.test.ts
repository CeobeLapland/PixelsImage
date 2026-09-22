import { describe, expect, it } from 'vitest';

import { createZip, crc32, type ZipEntry } from './zip';

/**
 * 一个最小的 ZIP 回读器：只认本模块写出的结构（store 模式、无注释）。
 * 用它来断言，比「比一遍字节」更能说明问题 —— 字节对了但字段位置错，
 * 解压软件照样打不开。
 */
function readZip(bytes: Uint8Array): {
  count: number;
  entries: {
    name: string;
    method: number;
    crc: number;
    rawSize: number;
    data: Uint8Array;
  }[];
} {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdOffset = bytes.length - 22;
  expect(view.getUint32(eocdOffset, true)).toBe(0x06054b50);

  const count = view.getUint16(eocdOffset + 10, true);
  const centralSize = view.getUint32(eocdOffset + 12, true);
  const centralOffset = view.getUint32(eocdOffset + 16, true);
  // 中央目录必须紧贴在尾部记录前面，否则偏移算错了
  expect(centralOffset + centralSize).toBe(eocdOffset);

  const decoder = new TextDecoder();
  const entries: ReturnType<typeof readZip>['entries'] = [];
  let p = centralOffset;

  for (let i = 0; i < count; i += 1) {
    expect(view.getUint32(p, true)).toBe(0x02014b50);
    const method = view.getUint16(p + 10, true);
    const crc = view.getUint32(p + 16, true);
    const compressedSize = view.getUint32(p + 20, true);
    const rawSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const localNameLen = view.getUint16(localOffset + 26, true);
    const dataStart = localOffset + 30 + localNameLen;

    entries.push({
      name,
      method,
      crc,
      rawSize,
      data: bytes.subarray(dataStart, dataStart + compressedSize),
    });
    p += 46 + nameLen;
  }

  return { count, entries };
}

const bytes = (...values: number[]) => new Uint8Array(values);

describe('crc32', () => {
  it('标准测试向量 "123456789" → 0xCBF43926', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('空数据为 0', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('结果始终是无符号 32 位', () => {
    const crc = crc32(bytes(0xff, 0xff, 0xff, 0xff));
    expect(crc).toBeGreaterThanOrEqual(0);
    expect(crc).toBeLessThanOrEqual(0xffffffff);
  });
});

describe('createZip', () => {
  const date = new Date(2026, 0, 2, 3, 4, 6);

  it('空列表也能产出一个合法的空 zip', () => {
    const zip = createZip([], date);
    expect(zip).toHaveLength(22);
    const { count } = readZip(zip);
    expect(count).toBe(0);
  });

  it('条目内容与名字能原样读回', () => {
    const entries: ZipEntry[] = [
      { name: 'a.png', data: bytes(1, 2, 3) },
      { name: 'b.txt', data: new TextEncoder().encode('hello') },
    ];
    const { count, entries: read } = readZip(createZip(entries, date));

    expect(count).toBe(2);
    expect(read.map((e) => e.name)).toEqual(['a.png', 'b.txt']);
    expect(Array.from(read[0].data)).toEqual([1, 2, 3]);
    expect(new TextDecoder().decode(read[1].data)).toBe('hello');
  });

  it('用 store 模式（method 0），且 CRC 与原始数据对得上', () => {
    const payload = bytes(9, 8, 7, 6, 5);
    const { entries } = readZip(createZip([{ name: 'x.bin', data: payload }], date));

    expect(entries[0].method).toBe(0);
    expect(entries[0].rawSize).toBe(payload.length);
    expect(entries[0].crc).toBe(crc32(payload));
  });

  it('中文名按 UTF-8 编码，且置位了 UTF-8 标记', () => {
    const zip = createZip([{ name: '英雄_32x32.png', data: bytes(1) }], date);
    const view = new DataView(zip.buffer);
    // 本地头标志位：0x0800 = 文件名是 UTF-8
    expect(view.getUint16(6, true) & 0x0800).toBe(0x0800);
    expect(readZip(zip).entries[0].name).toBe('英雄_32x32.png');
  });

  it('条目偏移随数据长度累加（第二个条目的本地头位置正确）', () => {
    const zip = createZip(
      [
        { name: 'first.png', data: new Uint8Array(1000) },
        { name: 'second.png', data: bytes(42) },
      ],
      date,
    );
    const { entries } = readZip(zip);
    expect(entries[1].data[0]).toBe(42);
    expect(entries[0].data).toHaveLength(1000);
  });

  it('零字节条目也不出错', () => {
    const { entries } = readZip(createZip([{ name: 'empty.txt', data: new Uint8Array(0) }], date));
    expect(entries[0].rawSize).toBe(0);
    expect(entries[0].data).toHaveLength(0);
  });

  it('1980 年之前的时间戳退回 0，不产生负数年份', () => {
    const zip = createZip([{ name: 'a.png', data: bytes(1) }], new Date(1970, 0, 1));
    const view = new DataView(zip.buffer);
    expect(view.getUint16(10, true)).toBe(0); // 修改时间
    expect(view.getUint16(12, true)).toBe(0); // 修改日期
  });
});
