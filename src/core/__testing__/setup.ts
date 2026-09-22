/**
 * 测试环境准备。
 *
 * core/ 的算法层刻意不依赖 DOM，能在 node 里直接跑。
 * 但渲染与导出层（composite.ts / exporters/）用到了 ImageData，
 * node 里没有这个全局对象。
 *
 * 这里补一个最小实现，让「网格 → 像素缓冲 → 放大」这条导出路径
 * 也能被测试覆盖 —— 导出的硬边像素是本工具的验收标准之一，
 * 值得锁死。不引入 jsdom：为了一个 ImageData 拉进整个 DOM 实现不划算。
 */

class ImageDataShim {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  readonly colorSpace: PredefinedColorSpace = 'srgb';

  constructor(
    dataOrWidth: Uint8ClampedArray | number,
    widthOrHeight: number,
    height?: number,
  ) {
    if (typeof dataOrWidth === 'number') {
      this.width = dataOrWidth;
      this.height = widthOrHeight;
      this.data = new Uint8ClampedArray(this.width * this.height * 4);
      return;
    }
    this.width = widthOrHeight;
    this.height = height ?? Math.round(dataOrWidth.length / 4 / widthOrHeight);
    // 按规范复制一份，避免调用方后续改动源缓冲
    this.data = new Uint8ClampedArray(dataOrWidth);
  }
}

if (typeof globalThis.ImageData === 'undefined') {
  (globalThis as unknown as { ImageData: unknown }).ImageData = ImageDataShim;
}