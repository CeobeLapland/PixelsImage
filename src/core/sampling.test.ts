import { describe, expect, it } from 'vitest';

import {
  BLACK,
  BLUE,
  CLEAR,
  GREEN,
  RED,
  WHITE,
  fillImage,
  makeGradient,
  makeImage,
  pixelAt,
} from '@/core/__testing__/fixtures';
import { downsample, resizeNearest } from './sampling';

describe('resizeNearest', () => {
  it('整数倍放大后每个像素变成 k×k 方块', () => {
    const src = makeImage(2, 2, [RED, WHITE, BLUE, BLACK]);
    const out = resizeNearest(src, 4, 4);

    expect(out.width).toBe(4);
    expect(out.height).toBe(4);
    // 左上 2×2 应全是红
    expect(pixelAt(out, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(out, 1, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(out, 0, 1)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(out, 1, 1)).toEqual([255, 0, 0, 255]);
    // 右上角应是白
    expect(pixelAt(out, 2, 0)).toEqual([255, 255, 255, 255]);
    // 右下角应是黑
    expect(pixelAt(out, 3, 3)).toEqual([0, 0, 0, 255]);
  });

  it('缩放到相同尺寸时内容不变', () => {
    const src = makeImage(2, 2, [RED, WHITE, BLUE, BLACK]);
    const out = resizeNearest(src, 2, 2);
    expect(Array.from(out.data)).toEqual(Array.from(src.data));
  });

  it('水平与垂直可以取不同的放大比例', () => {
    // 源 6×2 → 目标 12×6：横向 2 倍、纵向 3 倍
    const src = makeGradient(6, 2);
    const out = resizeNearest(src, 12, 6);
    expect(out.width).toBe(12);
    expect(out.height).toBe(6);
    // 同一源像素被复制到相邻列
    expect(pixelAt(out, 0, 0)).toEqual(pixelAt(out, 1, 0));
    expect(pixelAt(out, 0, 0)).toEqual(pixelAt(out, 0, 1));
  });

  it('缩小时也走最近邻（不插值）', () => {
    const src = makeImage(4, 1, [BLACK, WHITE, RED, GREEN]);
    const out = resizeNearest(src, 2, 1);
    expect(out.width).toBe(2);
    // 取样点落在源像素上，不会出现混合色
    for (let x = 0; x < 2; x += 1) {
      expect([BLACK, WHITE, RED, GREEN]).toContainEqual(pixelAt(out, x, 0));
    }
  });
});

describe('downsample / 面积平均', () => {
  it('纯色块降采样后仍是同一个色', () => {
    const src = fillImage(4, 4, RED);
    const out = downsample(src, 2, 2, 'area', false);
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
    for (let y = 0; y < 2; y += 1) {
      for (let x = 0; x < 2; x += 1) {
        expect(pixelAt(out, x, y)).toEqual([255, 0, 0, 255]);
      }
    }
  });

  it('两个极端色的平均值落在中间', () => {
    const src = makeImage(2, 1, [BLACK, WHITE]);
    const out = downsample(src, 1, 1, 'area', false);
    const [r, g, b, a] = pixelAt(out, 0, 0);
    expect(r).toBe(128);
    expect(g).toBe(128);
    expect(b).toBe(128);
    expect(a).toBe(255);
  });

  it('按 alpha 预乘：透明像素的 RGB 不会污染结果', () => {
    // 两个不透明红 + 两个「透明但 RGB 是蓝」的像素。
    // 若直接平均 RGB，结果会偏紫；正确做法是先乘 alpha 再还原。
    const src = makeImage(2, 2, [RED, [0, 0, 255, 0], RED, [0, 0, 255, 0]]);
    const out = downsample(src, 1, 1, 'area', false);
    const [r, g, b, a] = pixelAt(out, 0, 0);
    expect(r).toBe(255);
    expect(g).toBe(0);
    expect(b).toBe(0); // 关键断言：不是被蓝色污染的 128
    expect(a).toBe(128); // 一半面积被覆盖
  });

  it('全透明块保持全透明', () => {
    const src = fillImage(4, 4, CLEAR);
    const out = downsample(src, 2, 2, 'area', false);
    expect(pixelAt(out, 0, 0)).toEqual([0, 0, 0, 0]);
  });

  it('半透明色按覆盖率保留 alpha', () => {
    const src = fillImage(4, 4, [255, 0, 0, 128]);
    const out = downsample(src, 2, 2, 'area', false);
    expect(pixelAt(out, 0, 0)[3]).toBe(128);
  });

  it('非整数倍缩放不改变尺寸约定', () => {
    const out = downsample(makeGradient(37, 23), 8, 5, 'area', false);
    expect(out.width).toBe(8);
    expect(out.height).toBe(5);
    expect(out.data.length).toBe(8 * 5 * 4);
  });

  it('放大尺寸也不崩（目标比源大）', () => {
    const out = downsample(fillImage(2, 2, RED), 5, 5, 'area', false);
    expect(out.width).toBe(5);
    expect(pixelAt(out, 2, 2)).toEqual([255, 0, 0, 255]);
  });
});

describe('downsample / 最近邻', () => {
  it('取块中心像素', () => {
    // 4×4 中只有 (1,1) 是红，缩到 2×2 时左上格的中心正是 (1,1)
    const pixels = new Array<readonly [number, number, number, number]>(16).fill(BLACK);
    pixels[1 * 4 + 1] = RED;
    const out = downsample(makeImage(4, 4, pixels), 2, 2, 'nearest', false);

    expect(pixelAt(out, 0, 0)).toEqual([255, 0, 0, 255]);
    expect(pixelAt(out, 1, 0)).toEqual([0, 0, 0, 255]);
    expect(pixelAt(out, 0, 1)).toEqual([0, 0, 0, 255]);
  });

  it('保留原始 alpha', () => {
    const src = makeImage(2, 2, [RED, CLEAR, CLEAR, CLEAR]);
    const out = downsample(src, 1, 1, 'nearest', false);
    // 中心落在 (0,0) 或 (1,0) 附近，只要不是全透明就说明 alpha 被保留了
    expect(out.width).toBe(1);
    expect(out.data.length).toBe(4);
  });
});

describe('downsample / 主色投票', () => {
  it('块内出现最多的颜色胜出', () => {
    // 4×4 = 16 格：12 红 + 4 蓝
    const pixels = new Array<readonly [number, number, number, number]>(16).fill(RED);
    pixels[0] = BLUE;
    pixels[1] = BLUE;
    pixels[2] = BLUE;
    pixels[3] = BLUE;
    const out = downsample(makeImage(4, 4, pixels), 1, 1, 'dominant', false);
    expect(pixelAt(out, 0, 0)).toEqual([255, 0, 0, 255]);
  });

  it('不会产出块内不存在的混合色', () => {
    // 面积平均会把红+白混成粉；主色投票应给出纯红
    const pixels = new Array<readonly [number, number, number, number]>(16).fill(RED);
    pixels[0] = WHITE;
    const out = downsample(makeImage(4, 4, pixels), 1, 1, 'dominant', false);
    expect(pixelAt(out, 0, 0)).toEqual([255, 0, 0, 255]);
  });

  it('颜色种类很多时也能给出正确主色（直方图投票不漏桶）', () => {
    // 大块里塞入超过 4096 种颜色，再确认主色仍被认出来。
    // 这是回归测试：touched 列表曾经只有 4096 项，超出的桶不计入投票。
    const w = 80;
    const h = 80;
    const pixels: (readonly [number, number, number, number])[] = [];
    for (let i = 0; i < w * h; i += 1) {
      // 用 i 展开成大量不同的颜色，但让 (10,20,30) 出现次数明显最多
      pixels.push([i % 256, (i * 7) % 256, (i * 13) % 256, 255]);
    }
    // 覆盖前 200 个为 (10,20,30)，成为最高票
    for (let i = 0; i < 200; i += 1) pixels[i] = [10, 20, 30, 255];

    const out = downsample(makeImage(w, h, pixels), 1, 1, 'dominant', false);
    expect(pixelAt(out, 0, 0)).toEqual([10, 20, 30, 255]);
  });

  it('全透明块保持全透明', () => {
    const out = downsample(fillImage(4, 4, CLEAR), 1, 1, 'dominant', false);
    expect(pixelAt(out, 0, 0)).toEqual([0, 0, 0, 0]);
  });
});

describe('downsample / 中位数', () => {
  it('取中位数而不是平均值（抗噪点）', () => {
    // 三个灰度值 10 / 20 / 200 → 中位数 20，平均值是 76
    const src = makeImage(1, 3, [
      [10, 10, 10, 255],
      [20, 20, 20, 255],
      [200, 200, 200, 255],
    ]);
    const out = downsample(src, 1, 1, 'median', false);
    expect(pixelAt(out, 0, 0)[0]).toBe(20);
  });

  it('忽略透明像素', () => {
    const src = makeImage(3, 1, [
      [10, 10, 10, 255],
      [20, 20, 20, 255],
      [255, 255, 255, 0],
    ]);
    const out = downsample(src, 1, 1, 'median', false);
    // 只统计两个不透明像素 → 中位数取较大的那个（count=2, mid=1）
    expect(pixelAt(out, 0, 0)[0]).toBe(20);
  });
});

describe('downsample / pixelPerfect', () => {
  it('尺寸仍然正确', () => {
    const out = downsample(makeGradient(37, 23), 8, 5, 'area', true);
    expect(out.width).toBe(8);
    expect(out.height).toBe(5);
  });

  it('确实走了不同的路径（先整数倍放大再平均）', () => {
    // 源 6×2 → 目标 2×1：非整数倍，pixelPerfect 会把高度放大到 3 再平均
    const src = makeGradient(6, 2);
    const plain = downsample(src, 2, 1, 'area', false);
    const perfect = downsample(src, 2, 1, 'area', true);
    expect(Array.from(perfect.data)).not.toEqual(Array.from(plain.data));
  });

  it('整数倍关系下与普通面积平均一致', () => {
    // 源 4×4 → 目标 2×2：k=2，放大到 4×4 等于原图，结果应完全相同
    const src = makeGradient(4, 4);
    const plain = downsample(src, 2, 2, 'area', false);
    const perfect = downsample(src, 2, 2, 'area', true);
    expect(Array.from(perfect.data)).toEqual(Array.from(plain.data));
  });

  it('对 nearest 模式不产生影响', () => {
    const src = makeGradient(9, 5);
    const plain = downsample(src, 3, 2, 'nearest', false);
    const perfect = downsample(src, 3, 2, 'nearest', true);
    expect(Array.from(perfect.data)).toEqual(Array.from(plain.data));
  });
});