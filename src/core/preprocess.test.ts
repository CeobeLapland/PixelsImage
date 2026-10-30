import { describe, expect, it } from 'vitest';

import { CLEAR, GREEN, RED, WHITE, makeImage, pixelAt } from '@/core/__testing__/fixtures';
import {
  applyDecontaminate,
  isPreprocessIdentity,
  preprocess,
  removeBackgroundColor,
} from './preprocess';
import { DEFAULT_PREPROCESS, type PreprocessSettings } from './types';

function settings(patch: Partial<PreprocessSettings> = {}): PreprocessSettings {
  return { ...DEFAULT_PREPROCESS, ...patch };
}

describe('isPreprocessIdentity', () => {
  it('默认设置视为全中性（可以整体跳过）', () => {
    expect(isPreprocessIdentity(settings())).toBe(true);
  });

  it('任何一项被改动就不再是中性', () => {
    expect(isPreprocessIdentity(settings({ brightness: 1 }))).toBe(false);
    expect(isPreprocessIdentity(settings({ alphaThreshold: 128 }))).toBe(false);
    expect(isPreprocessIdentity(settings({ decontaminate: true }))).toBe(false);
    expect(isPreprocessIdentity(settings({ removeBackground: 'edges' }))).toBe(false);
  });

  it('只改容差但没开启去背景时，仍视为中性（那个值不起作用）', () => {
    expect(isPreprocessIdentity(settings({ bgTolerance: 80 }))).toBe(true);
  });
});

/* ------------------------------------------------------------ 去背景色 */

const BLACK: readonly [number, number, number, number] = [0, 0, 0, 255];
/** 距白 9：落在容差(24)之内 → 算背景，会被整格去掉 */
const NEAR_WHITE: readonly [number, number, number, number] = [246, 246, 246, 255];
/** 距白 25：刚好在容差之外、软化上限(72)之内 → 过渡色，被软化 */
const SOFT_230: readonly [number, number, number, number] = [230, 230, 230, 255];
/** 距白 55：同上，但离白更远 → 更不透明 */
const MID_200: readonly [number, number, number, number] = [200, 200, 200, 255];
/** 距白 50：够不到容差，也不会被软化（> 72 之外）…… 见下面「浅灰主体」那条 */
const LIGHT_GRAY: readonly [number, number, number, number] = [205, 205, 205, 255];

const RB = { mode: 'edges' as const, tolerance: 24, softEdge: false };

type Pixel = readonly [number, number, number, number];

function img(w: number, h: number, pixels: readonly Pixel[]) {
  return makeImage(w, h, pixels);
}

/**
 * 按 (x, y) 造一张图。
 *
 * 之所以不手写像素数组：泛洪是从**四条边**开始的，所以「内部」要求 w≥3 且 h≥3
 * （第一列、最后一列、第一行、最后一行全是种子）。手写数组时很容易造出
 * 一张 1 像素高的图，然后误以为中间那格是「内部」—— 实际上那整行都是边缘。
 */
function paint(w: number, h: number, fn: (x: number, y: number) => Pixel): Uint8ClampedArray {
  return new Uint8ClampedArray(painted(w, h, fn).data);
}

/** 同上，但返回完整的 RGBAImage —— 给 preprocess 用 */
function painted(w: number, h: number, fn: (x: number, y: number) => Pixel) {
  const pixels: Pixel[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) pixels.push(fn(x, y));
  }
  return img(w, h, pixels);
}

/** 读某格的 RGBA。pixelAt 按 width 算偏移，所以这里必须传真实宽度 */
function px(data: Uint8ClampedArray, w: number, h: number, x: number, y: number): number[] {
  return pixelAt({ width: w, height: h, data }, x, y);
}

describe('removeBackgroundColor：连通性判断（防误杀的核心）', () => {
  it('与边缘连通的白底被去掉', () => {
    // 5×5：四周白底，中间 1×1 黑块
    const data = paint(5, 5, (x, y) => (x === 2 && y === 2 ? BLACK : WHITE));
    const result = removeBackgroundColor(data, 5, 5, RB);
    expect(result.removed).toBe(24);
    expect(px(data, 5, 5, 2, 2)[3]).toBe(255); // 中心黑块还在
  });

  it('**主体内部的白色不被误杀** —— 眼睛高光、白衣服、白字全靠这条', () => {
    /*
     * 7×7：外圈白底 → 一圈黑框 → 中心 3×3 白。
     * 中心的 9 格白被黑框完整包住，与画面边缘不连通，必须原样留着。
     */
    const data = paint(7, 7, (x, y) => {
      const onOuterRing = x === 0 || y === 0 || x === 6 || y === 6;
      if (onOuterRing) return WHITE;
      const inCenter = x >= 2 && x <= 4 && y >= 2 && y <= 4;
      return inCenter ? WHITE : BLACK;
    });

    const result = removeBackgroundColor(data, 7, 7, RB);
    // 24 格外圈白底被去掉；中心 9 格白一格不动
    expect(result.removed).toBe(24);
    expect(px(data, 7, 7, 3, 3)[3]).toBe(255);
    expect(px(data, 7, 7, 2, 2)[3]).toBe(255);
    expect(px(data, 7, 7, 4, 4)[3]).toBe(255);
    expect(px(data, 7, 7, 0, 0)[3]).toBe(0);
  });

  it('白色空洞贴着主体内部时也留着（只与边缘连通才会被去掉）', () => {
    // 5×5：全黑，只在正中心放一格白
    const data = paint(5, 5, (x, y) => (x === 2 && y === 2 ? WHITE : BLACK));
    expect(removeBackgroundColor(data, 5, 5, RB).removed).toBe(0);
    expect(px(data, 5, 5, 2, 2)[3]).toBe(255);
  });

  it('泛洪沿着连通区域拐弯，不会被一圈主体挡住', () => {
    // 3×3：左上 2×2 是白（与边缘连通），其余是黑
    const data = paint(3, 3, (x, y) => (x < 2 && y < 2 ? WHITE : BLACK));
    expect(removeBackgroundColor(data, 3, 3, RB).removed).toBe(4);
  });

  it('只有一像素高的图：整行都算边缘，所以近白像素会被全部去掉', () => {
    // 这不是特例，是「从四边泛洪」的直接推论 —— 1 像素高的图没有内部。
    // 写下来免得日后有人把这条当 bug「修」掉。
    const data = paint(4, 1, () => NEAR_WHITE);
    expect(removeBackgroundColor(data, 4, 1, RB).removed).toBe(4);
  });

  it('近白（JPEG 噪声）也能去掉，靠的是容差', () => {
    const data = paint(3, 1, (x) => (x === 2 ? BLACK : NEAR_WHITE));
    // 246 距 255 是 9，容差 24 够
    expect(removeBackgroundColor(data, 3, 1, RB).removed).toBe(2);
  });

  it('容差为 0 时只去掉纯白', () => {
    const data = paint(3, 1, (x) => (x === 1 ? WHITE : NEAR_WHITE));
    expect(removeBackgroundColor(data, 3, 1, { ...RB, tolerance: 0 }).removed).toBe(1);
  });

  it('浅灰主体不会被默认容差吃掉', () => {
    // 205 距 255 是 50，容差 24 够不着
    const data = paint(5, 5, (x, y) => {
      const onRing = x === 0 || y === 0 || x === 4 || y === 4;
      if (onRing) return WHITE;
      return x === 2 && y === 2 ? LIGHT_GRAY : BLACK;
    });
    const result = removeBackgroundColor(data, 5, 5, RB);
    expect(result.removed).toBe(16);
    expect(px(data, 5, 5, 2, 2)[3]).toBe(255);
  });

  it('本来已经透明的像素不计入，也不重复处理', () => {
    const data = paint(3, 1, (x) => (x === 0 ? CLEAR : x === 1 ? WHITE : BLACK));
    const result = removeBackgroundColor(data, 3, 1, RB);
    expect(result.removed).toBe(1);
    expect(px(data, 3, 1, 0, 0)[3]).toBe(0);
  });

  it('整张白图：全部被去掉，不会死循环', () => {
    const data = paint(4, 4, () => WHITE);
    expect(removeBackgroundColor(data, 4, 4, RB).removed).toBe(16);
  });

  it('完全没有背景色时什么也不做', () => {
    const data = paint(4, 4, () => BLACK);
    expect(removeBackgroundColor(data, 4, 4, RB).removed).toBe(0);
  });

  it('大图不爆栈（1024×1024 纯白底）', () => {
    // 递归实现会直接栈溢出，这条用来钉住「必须用显式栈」
    const w = 1024;
    const h = 1024;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i += 1) {
      data[i * 4] = 255;
      data[i * 4 + 1] = 255;
      data[i * 4 + 2] = 255;
      data[i * 4 + 3] = 255;
    }
    expect(removeBackgroundColor(data, w, h, RB).removed).toBe(w * h);
  });
});

describe('removeBackgroundColor：激进模式', () => {
  it('all 模式把主体内部的白色也去掉（用户明确要求时才用）', () => {
    const data = paint(7, 7, (x, y) => {
      const onOuterRing = x === 0 || y === 0 || x === 6 || y === 6;
      if (onOuterRing) return WHITE;
      const inCenter = x >= 2 && x <= 4 && y >= 2 && y <= 4;
      return inCenter ? WHITE : BLACK;
    });
    const result = removeBackgroundColor(data, 7, 7, { ...RB, mode: 'all' });
    expect(result.removed).toBe(24 + 9); // 外圈 24 + 中心 9，全被去掉
    expect(px(data, 7, 7, 3, 3)[3]).toBe(0);
  });

  it('all 模式同样受容差约束', () => {
    const data = paint(2, 1, (x) => (x === 0 ? WHITE : LIGHT_GRAY));
    expect(removeBackgroundColor(data, 2, 1, { ...RB, mode: 'all' }).removed).toBe(1);
  });
});

describe('removeBackgroundColor：边缘软化', () => {
  /**
   * 5×5：最左一列是白底（会被整格去掉），第 1 列是过渡色，
   * 其余是黑主体。第 1 列的第 1–3 行是真正的「内部」，也正好紧贴被去掉的区域。
   *
   * 注意过渡色必须**落在容差之外**：容差内的颜色本来就会被整格去掉，
   * 轮不到软化来处理。软化的作用区间是 (容差, 容差×3]。
   */
  function edgeCase(mid: Pixel): Uint8ClampedArray {
    return paint(5, 5, (x, y) => {
      if (x === 0) return WHITE;
      if (x === 1 && y > 0 && y < 4) return mid;
      return BLACK;
    });
  }

  it('过渡色拿到半透明 alpha，离底色越近越透明', () => {
    const near = edgeCase(SOFT_230); // 距白 25
    const far = edgeCase(MID_200); // 距白 55

    const nearResult = removeBackgroundColor(near, 5, 5, { ...RB, softEdge: true });
    const farResult = removeBackgroundColor(far, 5, 5, { ...RB, softEdge: true });

    expect(nearResult.softened).toBe(3);
    expect(farResult.softened).toBe(3);
    expect(px(near, 5, 5, 1, 2)[3]).toBeLessThan(px(far, 5, 5, 1, 2)[3]);
    expect(px(near, 5, 5, 1, 2)[3]).toBeGreaterThan(0);
    expect(px(far, 5, 5, 1, 2)[3]).toBeLessThan(255);
    // 主体不受影响
    expect(px(far, 5, 5, 2, 2)[3]).toBe(255);
  });

  it('容差内的颜色被整格去掉，不是「半透明」—— 两条阈值各管一段', () => {
    const inside = edgeCase(NEAR_WHITE); // 距白 9 < 容差 24
    const result = removeBackgroundColor(inside, 5, 5, { ...RB, softEdge: true });
    expect(result.softened).toBe(0);
    expect(px(inside, 5, 5, 1, 2)[3]).toBe(0);
  });

  it('只软化紧贴背景的那一圈，更远的不碰', () => {
    const data = paint(6, 5, (x, y) => {
      if (x === 0) return WHITE;
      if ((x === 1 || x === 2) && y > 0 && y < 4) return SOFT_230;
      return BLACK;
    });
    removeBackgroundColor(data, 6, 5, { ...RB, softEdge: true });
    expect(px(data, 6, 5, 1, 2)[3]).toBeLessThan(255); // 紧贴背景 → 软化
    expect(px(data, 6, 5, 2, 2)[3]).toBe(255); // 隔了一层 → 不动
  });

  it('关掉软化时，过渡像素保持不透明（会留下一圈硬边，但这是用户的选择）', () => {
    const data = edgeCase(SOFT_230);
    const result = removeBackgroundColor(data, 5, 5, { ...RB, softEdge: false });
    expect(result.softened).toBe(0);
    expect(px(data, 5, 5, 1, 2)[3]).toBe(255);
  });

  it('已经基本是主体色的边缘像素不给透明度', () => {
    // 黑主体紧贴白底：黑距白 255，远超软化上限（容差 24 × 3 = 72）
    const data = paint(5, 5, (x) => (x === 0 ? WHITE : BLACK));
    const result = removeBackgroundColor(data, 5, 5, { ...RB, softEdge: true });
    expect(result.softened).toBe(0);
    expect(px(data, 5, 5, 1, 2)[3]).toBe(255);
  });

  it('容差为 0 时不做软化（软化上限也为 0）', () => {
    const data = edgeCase(NEAR_WHITE);
    const result = removeBackgroundColor(data, 5, 5, {
      tolerance: 0,
      mode: 'edges',
      softEdge: true,
    });
    expect(result.softened).toBe(0);
  });
});

describe('removeBackgroundColor：底色的选择', () => {
  const GREEN_SCREEN = [0, 255, 0, 255] as const;

  it('可指定任意底色 —— 绿幕也能去掉', () => {
    const data = paint(5, 5, (x, y) =>
      x === 0 || y === 0 || x === 4 || y === 4 ? GREEN_SCREEN : BLACK,
    );
    const result = removeBackgroundColor(data, 5, 5, { ...RB, color: [0, 255, 0] });
    expect(result.removed).toBe(16);
    expect(px(data, 5, 5, 2, 2)[3]).toBe(255);
  });

  it('换成绿幕时，白色不再算背景', () => {
    const data = paint(5, 5, () => WHITE);
    expect(removeBackgroundColor(data, 5, 5, { ...RB, color: [0, 255, 0] }).removed).toBe(0);
  });

  it('不传底色时默认白（老调用方不用改）', () => {
    const data = paint(5, 5, () => WHITE);
    expect(removeBackgroundColor(data, 5, 5, RB).removed).toBe(25);
  });

  it('底色接近但不完全相同的也能去掉（实拍绿幕没有纯绿）', () => {
    const KEYED = [30, 220, 40, 255] as const;
    const data = paint(4, 4, () => KEYED);
    // 距 (0,255,0)：max(30, 35, 40) = 40，容差 48 够
    expect(removeBackgroundColor(data, 4, 4, { ...RB, tolerance: 48, color: [0, 255, 0] }).removed).toBe(
      16,
    );
  });

  it('预处理里的 bgColor 生效', () => {
    const out = preprocess(painted(5, 5, (x) => (x === 0 ? WHITE : BLACK)), {
      ...DEFAULT_PREPROCESS,
      removeBackground: 'edges',
      bgColor: '#00ff00',
    });
    // 底色是绿，白底不该被去掉
    expect(px(out.data, 5, 5, 0, 2)[3]).toBe(255);
  });

  it('bgColor 是乱码时退回白，不让整张图失去处理', () => {
    const out = preprocess(painted(5, 5, (x) => (x === 0 ? WHITE : BLACK)), {
      ...DEFAULT_PREPROCESS,
      removeBackground: 'edges',
      bgColor: 'not-a-color',
    });
    expect(px(out.data, 5, 5, 0, 2)[3]).toBe(0);
  });
});

describe('preprocess 里的去背景顺序', () => {
  const isRing = (x: number, y: number, w: number, h: number): boolean =>
    x === 0 || y === 0 || x === w - 1 || y === h - 1;

  it('去背景用原图颜色判定 —— 同时调暗亮度，白底照样能去掉', () => {
    // 5×5：白底环 + 黑主体，同时把亮度压 -50（那会把白底压成灰）
    const out = preprocess(painted(5, 5, (x, y) => (isRing(x, y, 5, 5) ? WHITE : BLACK)), {
      ...DEFAULT_PREPROCESS,
      brightness: -50,
      removeBackground: 'edges',
    });
    expect(px(out.data, 5, 5, 0, 0)[3]).toBe(0);
    expect(px(out.data, 5, 5, 2, 2)[3]).toBe(255);
  });

  it('去背景之后，色晕清理能接着把半透明边缘染成主体色', () => {
    // 5×5：白底列 + 过渡色列 + 黑主体
    const source = painted(5, 5, (x, y) => {
      if (x === 0) return WHITE;
      if (x === 1 && y > 0 && y < 4) return SOFT_230;
      return BLACK;
    });
    const out = preprocess(source, {
      ...DEFAULT_PREPROCESS,
      removeBackground: 'edges',
      bgSoftEdge: true,
      decontaminate: true,
    });

    const [r, g, b, a] = px(out.data, 5, 5, 1, 2);
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(255);
    // 半透明边缘的 RGB 被换成了相邻主体色（黑）
    expect([r, g, b]).toEqual([0, 0, 0]);
  });

  it('去背景关闭时白底一律保留（老行为不变）', () => {
    const out = preprocess(img(2, 1, [WHITE, RED]), { ...DEFAULT_PREPROCESS, brightness: 10 });
    expect(px(out.data, 2, 1, 0, 0)[3]).toBe(255);
  });
});

describe('applyDecontaminate（边缘色晕清理）', () => {
  /** 3×1：不透明红 | 半透明绿（背景残留） | 全透明 */
  function haloRow(): Uint8ClampedArray {
    const image = makeImage(3, 1, [RED, [0, 255, 0, 128], CLEAR]);
    return new Uint8ClampedArray(image.data);
  }

  it('半透明边缘的 RGB 被换成相邻主体色，alpha 保持不变', () => {
    const data = haloRow();
    const changed = applyDecontaminate(data, 3, 1);

    expect(changed).toBe(1);
    // 中间那格原本是「半透明的绿」——绿就是背景残留，应该被染成红
    expect([data[4], data[5], data[6], data[7]]).toEqual([255, 0, 0, 128]);
  });

  it('全透明像素一个都不碰（它的 RGB 本来就不参与渲染）', () => {
    const data = haloRow();
    applyDecontaminate(data, 3, 1);
    expect([data[8], data[9], data[10], data[11]]).toEqual([0, 0, 0, 0]);
  });

  it('不外扩到指定圈数之外', () => {
    // 1×5：不透明红 + 四格半透明绿。rings=1 时只有紧邻的那一格被处理
    const image = makeImage(5, 1, [
      RED,
      [0, 255, 0, 128],
      [0, 255, 0, 128],
      [0, 255, 0, 128],
      [0, 255, 0, 128],
    ]);
    const data = new Uint8ClampedArray(image.data);

    expect(applyDecontaminate(data, 5, 1, 1)).toBe(1);
    expect(pixelAt({ width: 5, height: 1, data }, 1, 0)).toEqual([255, 0, 0, 128]);
    expect(pixelAt({ width: 5, height: 1, data }, 2, 0)).toEqual([0, 255, 0, 128]);
  });

  it('多圈时沿着半透明区域把颜色推出去', () => {
    const image = makeImage(4, 1, [
      RED,
      [0, 255, 0, 128],
      [0, 255, 0, 128],
      [0, 255, 0, 128],
    ]);
    const data = new Uint8ClampedArray(image.data);

    expect(applyDecontaminate(data, 4, 1, 3)).toBe(3);
    for (const x of [1, 2, 3]) {
      expect(pixelAt({ width: 4, height: 1, data }, x, 0)).toEqual([255, 0, 0, 128]);
    }
  });

  it('没有半透明像素时什么都不做', () => {
    const image = makeImage(2, 1, [RED, WHITE]);
    const data = new Uint8ClampedArray(image.data);
    expect(applyDecontaminate(data, 2, 1)).toBe(0);
  });

  it('零尺寸不崩', () => {
    expect(applyDecontaminate(new Uint8ClampedArray(0), 0, 0)).toBe(0);
  });

  it('紧贴边缘的像素也能找到主体色（不越界）', () => {
    // 2×2：左上不透明红，其余半透明绿
    const image = makeImage(2, 2, [RED, [0, 255, 0, 100], [0, 255, 0, 100], [0, 255, 0, 100]]);
    const data = new Uint8ClampedArray(image.data);
    expect(applyDecontaminate(data, 2, 2, 3)).toBe(3);
    expect(pixelAt({ width: 2, height: 2, data }, 1, 1)).toEqual([255, 0, 0, 100]);
  });
});

describe('preprocess 管线里的接线', () => {
  it('全中性设置时原样返回输入缓冲（不复制）', () => {
    const image = makeImage(1, 1, [GREEN]);
    const out = preprocess(image, settings());
    expect(out.data).toBe(image.data);
  });

  it('alpha 阈值先把背景判掉，色晕清理再擦掉边缘残留', () => {
    // 不透明红 | 半透明绿 α200（主体边缘，保住） | α60 与 α100（判为背景）
    const image = makeImage(4, 1, [RED, [0, 255, 0, 200], [0, 255, 0, 60], [0, 255, 0, 100]]);
    const out = preprocess(image, settings({ alphaThreshold: 128, decontaminate: true }));

    // α < 128 的两格被置为全透明
    expect(out.data[11]).toBe(0); // 第 2 格（α=60）
    expect(out.data[15]).toBe(0); // 第 3 格（α=100）
    // 保住的半透明格，RGB 已被换成相邻主体色（红），不再是背景的绿
    expect([out.data[4], out.data[5], out.data[6], out.data[7]]).toEqual([255, 0, 0, 200]);
  });

  it('关了开关就不做清理（对照）', () => {
    const image = makeImage(2, 1, [RED, [0, 255, 0, 200]]);
    const out = preprocess(image, settings({ alphaThreshold: 128 }));
    expect(pixelAt(out, 1, 0)).toEqual([0, 255, 0, 200]);
  });
});