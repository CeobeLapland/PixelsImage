/**
 * `.ase` 写入器的结构测试。
 *
 * 这里没有 Aseprite 可以验证，所以测试是「按官方 spec 写一个独立的读取器」，
 * 再用它把写出来的字节读回来断言。这能锁住几件事：
 * 头部各字段的位置与取值、块长度字段的含义、**像素行序是自下而上**。
 *
 * 刻意不复用写入器里的任何常量与函数 —— 如果两边共用一份实现，
 * 写错了读也会跟着「错得一致」，测试就白做了。
 */

import { describe, expect, it } from 'vitest';

import { makePalette, BLUE, RED, WHITE } from '@/core/__testing__/fixtures';
import { createGrid, type PixelGrid } from '@/core/types';
import { buildAseFile, buildAseFrames } from './ase';

const PALETTE = makePalette('t', [RED, WHITE, BLUE]);

/** 造一张每格颜色不同的网格，方便断言行序 */
function makeGrid(w: number, h: number): PixelGrid {
  const grid = createGrid(w, h);
  for (let i = 0; i < grid.indices.length; i += 1) {
    grid.indices[i] = i % 3;
    grid.alpha[i] = 255;
  }
  return grid;
}

interface ParsedAse {
  fileSize: number;
  magic: number;
  frames: number;
  width: number;
  height: number;
  depth: number;
  flags: number;
  frameSize: number;
  frameMagic: number;
  chunkCount: number;
  layer: { flags: number; type: number; blend: number; opacity: number; name: string };
  cel: { layerIndex: number; x: number; y: number; celType: number; w: number; h: number };
  /** 按文件里的实际顺序（自下而上）展开的 RGBA */
  pixels: Uint8Array;
}

function readAse(bytes: Uint8Array): ParsedAse {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u8 = (o: number): number => view.getUint8(o);
  const u16 = (o: number): number => view.getUint16(o, true);
  const u32 = (o: number): number => view.getUint32(o, true);
  const i16 = (o: number): number => view.getInt16(o, true);

  const header = {
    fileSize: u32(0),
    magic: u16(4),
    frames: u16(6),
    width: u16(8),
    height: u16(10),
    depth: u16(12),
    flags: u32(14),
  };

  expect(header.magic).toBe(0xa5e0);
  // 色深必须是 32（RGBA）
  expect(header.depth).toBe(32);

  /* ---------------- 帧头 ---------------- */
  const f = 128;
  const frameSize = u32(f);
  const frameMagic = u16(f + 4);
  expect(frameMagic).toBe(0xf1fa);
  const oldChunks = u16(f + 6);
  expect(oldChunks).toBe(0xffff);
  const chunkCount = u32(f + 12);

  /* ---------------- 块 ---------------- */
  let p = f + 16;
  const layer: ParsedAse['layer'] = {
    flags: 0,
    type: 0,
    blend: 0,
    opacity: 0,
    name: '',
  };
  const cel: ParsedAse['cel'] = { layerIndex: 0, x: 0, y: 0, celType: 0, w: 0, h: 0 };
  let pixels: Uint8Array<ArrayBufferLike> = new Uint8Array(0);

  for (let i = 0; i < chunkCount; i += 1) {
    // 真实布局：DWORD 长度（含 6 字节块头）+ WORD 类型
    const size = u32(p);
    const id = u16(p + 4);
    const body = p + 6;

    if (id === 0x2004) {
      // 固定字段布局：flags(2) type(2) child(2) 默认宽(2) 默认高(2) blend(2) opacity(1) 保留(3) → 共 16
      layer.flags = u16(body);
      layer.type = u16(body + 2);
      layer.blend = u16(body + 10);
      layer.opacity = u8(body + 12);
      const nameLen = u16(body + 16);
      const raw = bytes.subarray(body + 18, body + 18 + nameLen);
      layer.name = new TextDecoder().decode(raw);
      // 块长度必须正好等于「6 字节块头 + 固定字段 + 字符串」
      expect(size).toBe(6 + 16 + 2 + nameLen);
    } else if (id === 0x2005) {
      // 赛尔块固定 20 字节：图层(2) x(2) y(2) 不透明度(1) 类型(2) z(2) 保留(5) 宽(2) 高(2)
      cel.layerIndex = u16(body);
      cel.x = i16(body + 2);
      cel.y = i16(body + 4);
      cel.celType = u16(body + 7);
      cel.w = u16(body + 16);
      cel.h = u16(body + 18);
      const dataStart = body + 20;
      const bytesNeeded = cel.w * cel.h * 4;
      pixels = bytes.subarray(dataStart, dataStart + bytesNeeded);
      expect(size).toBe(6 + 20 + bytesNeeded);
    } else {
      throw new Error(`出现了没预期的块 0x${id.toString(16)}`);
    }

    p += size;
  }

  return {
    ...header,
    frameSize,
    frameMagic,
    chunkCount,
    layer,
    cel,
    pixels,
  };
}

describe('buildAseFile：文件头', () => {
  it('文件总长字段与实际长度一致', () => {
    const bytes = buildAseFile(makeGrid(4, 3), PALETTE);
    expect(readAse(bytes).fileSize).toBe(bytes.length);
  });

  it('帧数为 1，宽高等于网格尺寸', () => {
    const parsed = readAse(buildAseFile(makeGrid(7, 5), PALETTE));
    expect(parsed.frames).toBe(1);
    expect(parsed.width).toBe(7);
    expect(parsed.height).toBe(5);
  });

  it('头部固定 128 字节（后面紧跟帧头）', () => {
    const bytes = buildAseFile(makeGrid(2, 2), PALETTE);
    // 帧头位置 128 处必须是帧魔数
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(132, true)).toBe(0xf1fa);
  });

  it('标志位声明了「图层不透明度有效」', () => {
    expect(readAse(buildAseFile(makeGrid(2, 2), PALETTE)).flags).toBe(1);
  });

  it('RGBA 模式不写调色板颜色数（0 = 无调色板）', () => {
    const bytes = buildAseFile(makeGrid(2, 2), PALETTE);
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(32, true)).toBe(0);
  });
});

describe('buildAseFile：帧与块', () => {
  it('帧长包含帧头，等于「剩余字节 + 16」', () => {
    const bytes = buildAseFile(makeGrid(3, 2), PALETTE);
    const parsed = readAse(bytes);
    expect(parsed.frameSize).toBe(bytes.length - 128);
    expect(parsed.frameSize).toBeGreaterThan(16);
  });

  it('两个块：图层 + 赛尔', () => {
    expect(readAse(buildAseFile(makeGrid(2, 2), PALETTE)).chunkCount).toBe(2);
  });

  it('图层可见、可编辑、normal 混合、不透明度 255', () => {
    const layer = readAse(buildAseFile(makeGrid(2, 2), PALETTE)).layer;
    expect(layer.flags).toBe(0x0003);
    expect(layer.type).toBe(0);
    expect(layer.blend).toBe(0);
    expect(layer.opacity).toBe(255);
  });

  it('图层名是 UTF-8（中文不会乱码）', () => {
    const layer = readAse(buildAseFile(makeGrid(2, 2), PALETTE, { layerName: '英雄' })).layer;
    expect(layer.name).toBe('英雄');
  });

  it('默认图层名不为空', () => {
    expect(readAse(buildAseFile(makeGrid(2, 2), PALETTE)).layer.name).toBe('图层 1');
  });

  it('赛尔是原始类型（0），覆盖整张画布', () => {
    const cel = readAse(buildAseFile(makeGrid(5, 4), PALETTE)).cel;
    expect(cel.celType).toBe(0);
    expect(cel.layerIndex).toBe(0);
    expect(cel.x).toBe(0);
    expect(cel.y).toBe(0);
    expect(cel.w).toBe(5);
    expect(cel.h).toBe(4);
  });
});

describe('buildAseFile：像素与行序', () => {
  /** 取「自上而下」的第 y 行第 x 格的颜色 */
  function colorAt(grid: PixelGrid, palette: typeof PALETTE, x: number, y: number): number[] {
    const i = y * grid.w + x;
    return [...(palette.colors[grid.indices[i]] ?? [0, 0, 0, 0])] as number[];
  }

  /** 从「自下而上」的像素流里取一行；row 是文件里的顺序（0 = 最下面那行） */
  function fileRow(pixels: Uint8Array, w: number, row: number): number[] {
    const o = row * w * 4;
    return [pixels[o], pixels[o + 1], pixels[o + 2], pixels[o + 3]] as number[];
  }

  it('像素总数与画布一致', () => {
    const parsed = readAse(buildAseFile(makeGrid(6, 4), PALETTE));
    expect(parsed.pixels.length).toBe(6 * 4 * 4);
  });

  it('**文件里的第一行是最下面那行**（Aseprite 的行序是自下而上）', () => {
    // 3×2：第一行全红、第二行全白
    const grid = createGrid(3, 2);
    grid.indices.fill(0, 0, 3);
    grid.alpha.fill(255);
    grid.indices.fill(1, 3, 6);

    const parsed = readAse(buildAseFile(grid, PALETTE));
    // 文件第 0 行 = 网格最后一行（索引 1 的白）
    expect(fileRow(parsed.pixels, 3, 0)).toEqual(colorAt(grid, PALETTE, 0, 1));
    // 文件第 1 行 = 网格第一行（索引 0 的红）
    expect(fileRow(parsed.pixels, 3, 1)).toEqual(colorAt(grid, PALETTE, 0, 0));
  });

  it('多行时每一行都对得上（不是只对首尾）', () => {
    const grid = createGrid(4, 5);
    for (let i = 0; i < 20; i += 1) grid.indices[i] = i % 3;
    grid.alpha.fill(255);
    const parsed = readAse(buildAseFile(grid, PALETTE));

    for (let y = 0; y < 5; y += 1) {
      // 文件里的第 (h-1-y) 行 = 网格的第 y 行
      expect(fileRow(parsed.pixels, 4, 4 - y)).toEqual(colorAt(grid, PALETTE, 0, y));
    }
  });

  it('alpha 被原样写入（透明度不会丢）', () => {
    const grid = createGrid(2, 1);
    grid.indices.fill(2); // BLUE，不透明
    grid.alpha.fill(0);
    const parsed = readAse(buildAseFile(grid, PALETTE));
    expect(parsed.pixels[3]).toBe(0);
  });

  it('1×1 的图也能写出合法文件', () => {
    const parsed = readAse(buildAseFile(makeGrid(1, 1), PALETTE));
    expect(parsed.width).toBe(1);
    expect(parsed.height).toBe(1);
    expect(parsed.pixels.length).toBe(4);
  });
});

describe('buildAseFrames：多帧（M8 动图）', () => {
  interface FrameView {
    duration: number;
    chunkIds: number[];
    pixels: Uint8Array;
  }

  interface MultiView {
    fileSize: number;
    frameCount: number;
    speed: number;
    frames: FrameView[];
  }

  /** 按 spec 顺序走完全部帧；与单帧那个读取器独立，只看多帧关心的字段 */
  function readMulti(bytes: Uint8Array): MultiView {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (o: number): number => view.getUint16(o, true);
    const u32 = (o: number): number => view.getUint32(o, true);

    const fileSize = u32(0);
    const frameCount = u16(6);
    // 头部：fileSize(4) magic(2) frames(2) w(2) h(2) depth(2) flags(4) → 默认帧间隔在 18
    const speed = u16(18);

    const frames: FrameView[] = [];
    let p = 128;
    for (let f = 0; f < frameCount; f += 1) {
      const frameSize = u32(p);
      expect(u16(p + 4)).toBe(0xf1fa);
      const duration = u16(p + 8);
      const chunkCount = u32(p + 12);

      const chunkIds: number[] = [];
      let pixels: Uint8Array = new Uint8Array(0);
      let c = p + 16;
      for (let i = 0; i < chunkCount; i += 1) {
        const size = u32(c);
        const id = u16(c + 4);
        chunkIds.push(id);
        if (id === 0x2005) {
          const body = c + 6;
          const w = u16(body + 16);
          const h = u16(body + 18);
          pixels = bytes.subarray(body + 20, body + 20 + w * h * 4);
        }
        c += size;
      }

      frames.push({ duration, chunkIds, pixels });
      p += frameSize;
    }

    return { fileSize, frameCount, speed, frames };
  }

  it('头部帧数、默认帧间隔与文件总长都对', () => {
    const a = makeGrid(3, 2);
    const b = makeGrid(3, 2);
    const bytes = buildAseFrames([
      { grid: a, palette: PALETTE, durationMs: 120 },
      { grid: b, palette: PALETTE, durationMs: 80 },
    ]);
    const parsed = readMulti(bytes);

    expect(parsed.fileSize).toBe(bytes.length);
    expect(parsed.frameCount).toBe(2);
    // 老字段「默认帧间隔」取第一帧的时长
    expect(parsed.speed).toBe(120);
    expect(parsed.frames.map((f) => f.duration)).toEqual([120, 80]);
  });

  it('图层块只写在第一帧，赛尔块每帧都有', () => {
    const parsed = readMulti(
      buildAseFrames([
        { grid: makeGrid(2, 2), palette: PALETTE },
        { grid: makeGrid(2, 2), palette: PALETTE },
        { grid: makeGrid(2, 2), palette: PALETTE },
      ]),
    );

    expect(parsed.frames[0]?.chunkIds).toEqual([0x2004, 0x2005]);
    expect(parsed.frames[1]?.chunkIds).toEqual([0x2005]);
    expect(parsed.frames[2]?.chunkIds).toEqual([0x2005]);
  });

  it('每一帧都带自己的像素（不是复用第一帧）', () => {
    const first = createGrid(2, 1);
    first.indices.fill(0);
    first.alpha.fill(255);

    const second = createGrid(2, 1);
    second.indices.fill(2);
    second.alpha.fill(255);

    const parsed = readMulti(
      buildAseFrames([
        { grid: first, palette: PALETTE },
        { grid: second, palette: PALETTE },
      ]),
    );

    // 第一帧首像素红，第二帧首像素蓝
    expect([...parsed.frames[0]!.pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    expect([...parsed.frames[1]!.pixels.subarray(0, 4)]).toEqual([0, 0, 255, 255]);
  });

  it('时长被钳到 WORD 范围', () => {
    const parsed = readMulti(
      buildAseFrames([
        { grid: makeGrid(1, 1), palette: PALETTE, durationMs: 70000 },
        { grid: makeGrid(1, 1), palette: PALETTE, durationMs: -5 },
      ]),
    );
    expect(parsed.frames[0]?.duration).toBe(0xffff);
    expect(parsed.frames[1]?.duration).toBe(0);
  });

  it('帧尺寸不一致时报错（.ase 的帧共享同一张画布）', () => {
    expect(() =>
      buildAseFrames([
        { grid: makeGrid(2, 2), palette: PALETTE },
        { grid: makeGrid(3, 3), palette: PALETTE },
      ]),
    ).toThrow(/尺寸不一致/);
  });

  it('不给帧时也不会写出空文件', () => {
    expect(() => buildAseFrames([])).toThrow(/至少需要一帧/);
  });
});