/**
 * 文件格式嗅探（sniffImage）的测试。
 *
 * 为什么值得单独测：它决定「一个文件被当成静态图还是拆成帧」。
 * 判断错了不会报错，只会静默只取第一帧 —— 而用户看到的是「动图坏了」。
 * 所以这里用**手工拼的最小字节**覆盖每种容器，并特意验证「扩展名不影响结果」。
 */

import { describe, expect, it } from 'vitest';

import { sniffImage, splitAnimatedFrames } from './image';

/** 拼一个 PNG 字节流：只需要签名 + 若干块头，嗅探只看块类型与长度 */
function pngBytes(types: readonly string[]): Uint8Array {
  const parts: number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (const type of types) {
    // 块长度 0 的占位块：嗅探只读长度与类型，不解析内容
    parts.push(0, 0, 0, 0);
    for (let i = 0; i < 4; i += 1) parts.push(type.charCodeAt(i));
    parts.push(0, 0, 0, 0); // CRC
  }
  while (parts.length < 12) parts.push(0);
  return Uint8Array.from(parts);
}

function gifBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0); // GIF89a
  return bytes;
}

function webpBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0); // RIFF
  bytes.set([0x57, 0x45, 0x42, 0x50], 8); // WEBP
  return bytes;
}

function jpegBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0xff, 0xd8, 0xff], 0);
  return bytes;
}

function bmpBytes(): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x42, 0x4d], 0);
  return bytes;
}

function avifBytes(brand: string): Uint8Array {
  const bytes = new Uint8Array(32);
  bytes.set([0x66, 0x74, 0x79, 0x70], 4); // 'ftyp'
  for (let i = 0; i < 4; i += 1) bytes[8 + i] = brand.charCodeAt(i);
  return bytes;
}

function blobOf(bytes: Uint8Array, name: string, type = ''): File {
  // slice() 会得到 Uint8Array<ArrayBuffer>；直接传 Uint8Array<ArrayBufferLike> 不被 BlobPart 接受
  return new File([bytes.slice()], name, { type });
}

describe('按文件头识别格式', () => {
  it('GIF：可能是动图', async () => {
    const sniff = await sniffImage(blobOf(gifBytes(), 'a.gif', 'image/gif'));
    expect(sniff).toEqual({ kind: 'gif', mime: 'image/gif', mayAnimate: true });
  });

  it('WebP：可能是动图', async () => {
    const sniff = await sniffImage(blobOf(webpBytes(), 'a.webp', 'image/webp'));
    expect(sniff?.kind).toBe('webp');
    expect(sniff?.mayAnimate).toBe(true);
  });

  it('普通 PNG：不是动图', async () => {
    const sniff = await sniffImage(blobOf(pngBytes(['IHDR', 'IDAT', 'IEND']), 'a.png', 'image/png'));
    expect(sniff).toEqual({ kind: 'png', mime: 'image/png', mayAnimate: false });
  });

  it('带 acTL 的 PNG 当作 APNG', async () => {
    const sniff = await sniffImage(
      blobOf(pngBytes(['IHDR', 'acTL', 'IDAT', 'IEND']), 'a.png', 'image/png'),
    );
    expect(sniff?.kind).toBe('apng');
    expect(sniff?.mayAnimate).toBe(true);
  });

  it('JPEG / BMP / AVIF', async () => {
    const jpeg = await sniffImage(blobOf(jpegBytes(), 'a.jpg', 'image/jpeg'));
    const bmp = await sniffImage(blobOf(bmpBytes(), 'a.bmp', 'image/bmp'));
    const avif = await sniffImage(blobOf(avifBytes('avif'), 'a.avif', 'image/avif'));
    // 动画 AVIF 的品牌是 avis
    const animAvif = await sniffImage(blobOf(avifBytes('avis'), 'a.avif'));

    expect(jpeg?.kind).toBe('jpeg');
    expect(bmp?.kind).toBe('bmp');
    expect(avif?.kind).toBe('avif');
    expect(avif?.mayAnimate).toBe(false);
    expect(animAvif?.mayAnimate).toBe(true);
  });

  it('扩展名与 MIME 都不影响判断（伪装成 jpg 的 GIF）', async () => {
    const disguised = blobOf(gifBytes(), 'photo.jpg', 'image/jpeg');
    const sniff = await sniffImage(disguised);
    expect(sniff?.kind).toBe('gif');
    expect(sniff?.mayAnimate).toBe(true);
  });

  it('认不出的内容返回 null', async () => {
    expect(await sniffImage(blobOf(new Uint8Array([1, 2, 3]), 'x.bin'))).toBeNull();
    expect(await sniffImage(blobOf(new Uint8Array(0), 'empty'))).toBeNull();
  });
});

describe('拆帧入口对静态图的行为', () => {
  it('非动图直接返回 null，不碰 ImageDecoder（node 里也能跑）', async () => {
    const file = blobOf(pngBytes(['IHDR', 'IDAT', 'IEND']), 'a.png', 'image/png');
    expect(await splitAnimatedFrames(file)).toBeNull();
  });

  it('一眼就认不出动画的格式也不会被当成动图', async () => {
    const file = blobOf(jpegBytes(), 'a.jpg', 'image/jpeg');
    expect(await splitAnimatedFrames(file)).toBeNull();
  });
});
