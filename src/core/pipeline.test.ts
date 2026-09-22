import { describe, expect, it } from 'vitest';

import { BLACK, BLUE, CLEAR, RED, WHITE, makeGradient, makeImage } from '@/core/__testing__/fixtures';
import { composite } from './composite';
import { createEditLayer, createGrid, makeDefaultSettings, type PixelGrid } from './types';
import { convert } from './pipeline';
import { trimTransparent } from './assists/trim';
import { BUILTIN_PALETTES, MC_DYE_PALETTE, MONO_PALETTE, resolvePalette } from '@/palettes/builtin';

describe('convert / 目标尺寸', () => {
  it('按原图宽高比推导高度', () => {
    const result = convert(
      makeGradient(200, 100),
      { ...makeDefaultSettings(), targetW: 64 },
      MC_DYE_PALETTE,
    );
    expect(result.grid.w).toBe(64);
    expect(result.grid.h).toBe(32);
  });

  it('显式指定高度时不做推导', () => {
    const result = convert(
      makeGradient(200, 100),
      { ...makeDefaultSettings(), targetW: 32, targetH: 32 },
      MC_DYE_PALETTE,
    );
    expect(result.grid.w).toBe(32);
    expect(result.grid.h).toBe(32);
  });

  it('极小的目标尺寸也至少产出 1 格', () => {
    const result = convert(
      makeGradient(4000, 7),
      { ...makeDefaultSettings(), targetW: 4 },
      MC_DYE_PALETTE,
    );
    expect(result.grid.w).toBe(4);
    expect(result.grid.h).toBeGreaterThanOrEqual(1);
  });

  it('返回的 targetW/targetH 与实际网格一致（未裁剪时）', () => {
    const result = convert(makeGradient(120, 90), makeDefaultSettings(), MC_DYE_PALETTE);
    expect(result.targetW).toBe(result.grid.w);
    expect(result.targetH).toBe(result.grid.h);
    expect(result.trimmed).toBe(false);
  });
});

describe('convert / 调色板切换（回归）', () => {
  /**
   * 这是浏览器实测抓到的崩溃的回归测试：
   * 之前查找缓存是模块级单例，切到更小的调色板后取到越界索引，抛
   * 「Cannot read properties of undefined (reading '0')」。
   */
  it('依次用三种内置调色板转换，索引都不越界', () => {
    const source = makeGradient(96, 72);
    const settings = { ...makeDefaultSettings(), targetW: 48, dither: 'none' as const };

    for (const palette of BUILTIN_PALETTES) {
      const result = convert(source, settings, palette);
      expect(result.grid.indices.length).toBe(result.grid.w * result.grid.h);

      for (let i = 0; i < result.grid.indices.length; i += 1) {
        if (result.grid.alpha[i] === 0) continue;
        expect(
          result.grid.indices[i],
          `调色板 ${palette.id}（${palette.colors.length} 色）产生越界索引`,
        ).toBeLessThan(palette.colors.length);
      }
    }
  });

  it('从大到小反复切换不会抛错', () => {
    const source = makeGradient(64, 64);
    const settings = { ...makeDefaultSettings(), targetW: 32 };
    const sequence = [MC_DYE_PALETTE, MONO_PALETTE, MC_DYE_PALETTE, MONO_PALETTE];

    for (const palette of sequence) {
      expect(() => convert(source, settings, palette)).not.toThrow();
    }
  });

  it('所有抖动模式下切换调色板都安全', () => {
    const source = makeGradient(50, 40);
    for (const dither of ['atkinson', 'floyd', 'bayer4', 'none'] as const) {
      for (const palette of BUILTIN_PALETTES) {
        const settings = { ...makeDefaultSettings(), targetW: 24, dither };
        const result = convert(source, settings, palette);
        for (const idx of result.grid.indices) {
          expect(idx, `${palette.id} + ${dither}`).toBeLessThan(palette.colors.length);
        }
      }
    }
  });
});

describe('convert / 各调色板的用色数', () => {
  it('用色数不超过调色板容量', () => {
    const source = makeGradient(200, 200);
    for (const palette of BUILTIN_PALETTES) {
      const result = convert(source, makeDefaultSettings(), palette);
      expect(result.usedColors).toBeGreaterThan(0);
      expect(result.usedColors).toBeLessThanOrEqual(palette.colors.length);
    }
  });

  it('黑白板最多只用到 2 色', () => {
    const result = convert(
      makeGradient(64, 64),
      { ...makeDefaultSettings(), targetW: 40, dither: 'atkinson' },
      MONO_PALETTE,
    );
    expect(result.usedColors).toBeLessThanOrEqual(2);
  });
});

describe('convert / 预处理生效', () => {
  it('饱和度拉到 -100 后输出接近灰阶', () => {
    const source = makeGradient(40, 40);
    const settings = {
      ...makeDefaultSettings(),
      targetW: 20,
      dither: 'none' as const,
      preprocess: { ...makeDefaultSettings().preprocess, saturation: -100 },
    };
    const result = convert(source, settings, resolvePalette('gray-8'));

    // 灰阶调色板下，灰阶输入应精确命中某个灰阶色（R=G=B）
    const palette = resolvePalette('gray-8');
    for (let i = 0; i < result.grid.indices.length; i += 1) {
      const c = palette.colors[result.grid.indices[i]];
      expect(c[0]).toBe(c[1]);
      expect(c[1]).toBe(c[2]);
    }
  });

  it('alpha 阈值把低透明度像素清零', () => {
    const source = makeImage(4, 1, [
      [255, 0, 0, 10],
      [255, 0, 0, 100],
      [255, 0, 0, 200],
      [255, 0, 0, 255],
    ]);
    const settings = {
      ...makeDefaultSettings(),
      targetW: 4,
      targetH: 1,
      sampling: 'nearest' as const,
      preprocess: { ...makeDefaultSettings().preprocess, alphaThreshold: 128 },
    };
    const result = convert(source, settings, MC_DYE_PALETTE);
    expect(result.grid.alpha[0]).toBe(0);
    expect(result.grid.alpha[1]).toBe(0);
    expect(result.grid.alpha[2]).toBe(200);
    expect(result.grid.alpha[3]).toBe(255);
  });
});

describe('convert / trimTransparent', () => {
  it('裁掉四周透明边后尺寸收缩', () => {
    // 8×8 里只有中间 4×4 不透明
    const pixels: (readonly [number, number, number, number])[] = [];
    for (let y = 0; y < 8; y += 1) {
      for (let x = 0; x < 8; x += 1) {
        const inside = x >= 2 && x < 6 && y >= 2 && y < 6;
        pixels.push(inside ? RED : CLEAR);
      }
    }
    const settings = {
      ...makeDefaultSettings(),
      targetW: 8,
      targetH: 8,
      sampling: 'nearest' as const,
      trimTransparent: true,
    };
    const result = convert(makeImage(8, 8, pixels), settings, MC_DYE_PALETTE);

    expect(result.trimmed).toBe(true);
    expect(result.grid.w).toBe(4);
    expect(result.grid.h).toBe(4);
    // 报告的目标尺寸仍是裁剪前的，UI 据此提示用户尺寸已收缩
    expect(result.targetW).toBe(8);
    expect(result.targetH).toBe(8);
  });

  it('全不透明时尺寸不变', () => {
    const settings = { ...makeDefaultSettings(), targetW: 16, trimTransparent: true };
    const result = convert(makeGradient(32, 32), settings, MC_DYE_PALETTE);
    expect(result.trimmed).toBe(false);
    expect(result.grid.w).toBe(result.targetW);
  });
});

describe('convert / 确定性', () => {
  it('相同输入两次得到相同结果', () => {
    const source = makeGradient(80, 60);
    const settings = { ...makeDefaultSettings(), targetW: 32, dither: 'atkinson' as const };

    const a = convert(source, settings, MC_DYE_PALETTE);
    const b = convert(source, settings, MC_DYE_PALETTE);

    expect(Array.from(a.grid.indices)).toEqual(Array.from(b.grid.indices));
    expect(Array.from(a.grid.alpha)).toEqual(Array.from(b.grid.alpha));
  });

  it('不修改传入的源数据', () => {
    const source = makeGradient(20, 20);
    const before = Array.from(source.data);
    convert(
      source,
      {
        ...makeDefaultSettings(),
        preprocess: { ...makeDefaultSettings().preprocess, brightness: 50, sharpen: 60 },
      },
      MC_DYE_PALETTE,
    );
    expect(Array.from(source.data)).toEqual(before);
  });
});

describe('convert / fast 模式', () => {
  it('fast 等价于强制加权 RGB 距离', () => {
    const source = makeGradient(50, 50);
    const settings = { ...makeDefaultSettings(), distance: 'lab' as const, targetW: 24 };

    const fast = convert(source, settings, MC_DYE_PALETTE, { fast: true });
    const weighted = convert(
      source,
      { ...settings, distance: 'weighted' },
      MC_DYE_PALETTE,
    );

    expect(Array.from(fast.grid.indices)).toEqual(Array.from(weighted.grid.indices));
  });
});

describe('trimTransparent', () => {
  function gridFrom(w: number, h: number, opaque: (x: number, y: number) => boolean): PixelGrid {
    const grid = createGrid(w, h);
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        grid.alpha[i] = opaque(x, y) ? 255 : 0;
        grid.indices[i] = 1;
      }
    }
    return grid;
  }

  it('裁掉四周透明边并报告偏移', () => {
    const grid = gridFrom(10, 10, (x, y) => x >= 3 && x <= 6 && y >= 2 && y <= 5);
    const result = trimTransparent(grid);

    expect(result.changed).toBe(true);
    expect(result.grid.w).toBe(4);
    expect(result.grid.h).toBe(4);
    expect(result.offsetX).toBe(3);
    expect(result.offsetY).toBe(2);
  });

  it('全不透明时原样返回同一个对象', () => {
    const grid = gridFrom(4, 4, () => true);
    const result = trimTransparent(grid);
    expect(result.changed).toBe(false);
    expect(result.grid).toBe(grid);
  });

  it('全透明时也原样返回，不产出 0×0', () => {
    const grid = gridFrom(4, 4, () => false);
    const result = trimTransparent(grid);
    expect(result.changed).toBe(false);
    expect(result.grid.w).toBe(4);
    expect(result.grid.h).toBe(4);
  });

  it('只裁掉一侧', () => {
    const grid = gridFrom(6, 6, (x) => x < 3);
    const result = trimTransparent(grid);
    expect(result.grid.w).toBe(3);
    expect(result.grid.h).toBe(6);
    expect(result.offsetX).toBe(0);
  });

  it('保持索引与 alpha 的对应关系', () => {
    const grid = createGrid(4, 4);
    for (let i = 0; i < grid.indices.length; i += 1) grid.indices[i] = i % 3;
    grid.alpha[5] = 255; // 只留一格不透明
    const result = trimTransparent(grid);
    expect(result.grid.w).toBe(1);
    expect(result.grid.h).toBe(1);
    expect(result.grid.indices[0]).toBe(5 % 3);
    expect(result.grid.alpha[0]).toBe(255);
  });
});

describe('composite / 双层编辑模型', () => {
  function baseGrid(): PixelGrid {
    const grid = createGrid(3, 2);
    grid.indices.fill(0);
    grid.alpha.fill(255);
    return grid;
  }

  it('没有编辑层时直接返回底层对象', () => {
    const base = baseGrid();
    expect(composite(base, null)).toBe(base);
  });

  it('编辑层覆盖指定格子', () => {
    const base = baseGrid();
    const edit = createEditLayer(3, 2);
    edit.cells[1] = { index: 2, alpha: 128 };
    edit.cells[4] = { index: 1, alpha: 255 };

    const out = composite(base, edit);

    expect(out.indices[0]).toBe(0);
    expect(out.indices[1]).toBe(2);
    expect(out.alpha[1]).toBe(128);
    expect(out.indices[4]).toBe(1);
    expect(out.alpha[4]).toBe(255);
    expect(out.indices[2]).toBe(0);
  });

  it('不修改底层网格', () => {
    const base = baseGrid();
    const before = Array.from(base.indices);
    const edit = createEditLayer(3, 2);
    edit.cells[0] = { index: 2, alpha: 255 };

    const out = composite(base, edit);

    expect(Array.from(base.indices)).toEqual(before);
    expect(out).not.toBe(base);
  });

  it('null 格子走底层', () => {
    const base = baseGrid();
    const edit = createEditLayer(3, 2);
    // 只覆盖一格，其余为 null
    edit.cells[0] = { index: 2, alpha: 255 };

    const out = composite(base, edit);
    for (let i = 1; i < out.indices.length; i += 1) {
      expect(out.indices[i]).toBe(base.indices[i]);
      expect(out.alpha[i]).toBe(base.alpha[i]);
    }
  });

  it('编辑层尺寸与底层不一致时，不套用编辑层', () => {
    const base = baseGrid();
    const edit = createEditLayer(5, 5);
    edit.cells[0] = { index: 2, alpha: 255 };

    const out = composite(base, edit);

    expect(out.w).toBe(base.w);
    expect(out.h).toBe(base.h);
    expect(out.indices[0]).toBe(base.indices[0]);
  });
});

describe('createGrid / createEditLayer', () => {
  it('createGrid 分配正确长度并清零', () => {
    const grid = createGrid(7, 5);
    expect(grid.indices.length).toBe(35);
    expect(grid.alpha.length).toBe(35);
    expect(Array.from(grid.indices).every((v) => v === 0)).toBe(true);
  });

  it('createEditLayer 全部为 null（表示走底层）', () => {
    const edit = createEditLayer(4, 3);
    expect(edit.cells.length).toBe(12);
    expect(edit.cells.every((c) => c === null)).toBe(true);
  });

  it('createGrid 的初始 alpha 是 0（透明），不是 255', () => {
    // 若默认不透明，未写入的格子会渲染成黑色方块
    const grid = createGrid(2, 2);
    expect(Array.from(grid.alpha)).toEqual([0, 0, 0, 0]);
  });
});

describe('内置调色板', () => {
  it('resolvePalette 对未知 id 回退到默认板，不抛错', () => {
    expect(resolvePalette('does-not-exist').id).toBe(MC_DYE_PALETTE.id);
  });

  it('Minecraft 染料板是 16 色且无重复', () => {
    expect(MC_DYE_PALETTE.colors.length).toBe(16);
    const hexes = MC_DYE_PALETTE.colors.map((c) => `${c[0]},${c[1]},${c[2]}`);
    expect(new Set(hexes).size).toBe(16);
  });

  it('每个内置板都非空且颜色值合法', () => {
    for (const palette of BUILTIN_PALETTES) {
      expect(palette.colors.length).toBeGreaterThan(0);
      expect(palette.colors.length).toBeLessThanOrEqual(256);
      for (const c of palette.colors) {
        for (const v of c) {
          expect(Number.isInteger(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(255);
        }
      }
    }
  });

  it('黑白板恰好是黑与白', () => {
    expect(MONO_PALETTE.colors[0].slice(0, 3)).toEqual([0, 0, 0]);
    expect(MONO_PALETTE.colors[1].slice(0, 3)).toEqual([255, 255, 255]);
  });

  it('调色板颜色不包含透明（板内 alpha 一律 255）', () => {
    // alpha 由网格独立存储，调色板里出现透明色说明数据写错了
    for (const palette of BUILTIN_PALETTES) {
      for (const c of palette.colors) {
        expect(c[3]).toBe(255);
      }
    }
  });
});

describe('makeImage / 边界', () => {
  it('单像素图像可正常转换', () => {
    const result = convert(
      makeImage(1, 1, [BLUE]),
      { ...makeDefaultSettings(), targetW: 1, targetH: 1 },
      MC_DYE_PALETTE,
    );
    expect(result.grid.w).toBe(1);
    expect(result.grid.h).toBe(1);
    expect(result.grid.alpha[0]).toBe(255);
  });

  it('全透明图像转换后仍全透明', () => {
    const result = convert(
      makeImage(4, 4, new Array(16).fill(CLEAR) as never),
      { ...makeDefaultSettings(), targetW: 2, targetH: 2 },
      MC_DYE_PALETTE,
    );
    expect(Array.from(result.grid.alpha)).toEqual([0, 0, 0, 0]);
  });

  it('黑白棋盘格缩到 1×1 后 alpha 保持不透明', () => {
    const pixels: (readonly [number, number, number, number])[] = [];
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 4; x += 1) {
        pixels.push((x + y) % 2 === 0 ? WHITE : BLACK);
      }
    }
    const result = convert(
      makeImage(4, 4, pixels),
      { ...makeDefaultSettings(), targetW: 1, targetH: 1 },
      MC_DYE_PALETTE,
    );
    expect(result.grid.alpha[0]).toBe(255);
  });
});