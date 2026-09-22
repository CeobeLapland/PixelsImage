import { describe, expect, it } from 'vitest';

import { planOutline } from '@/core/assists/outline';
import { bandSlots, planShade } from '@/core/assists/shade';
import { makePalette } from '@/core/__testing__/fixtures';
import { createEditLayer, createGrid, type PixelGrid, type RGBA } from '@/core/types';

/* ------------------------------------------------------------ 小工具 */

/** 直接构造 core 的网格：indices 按行优先给定，alpha 默认全不透明 */
function makeGrid(
  w: number,
  h: number,
  indices: readonly number[],
  alpha?: readonly number[],
): PixelGrid {
  const grid = createGrid(w, h);
  grid.indices.set(indices);
  if (alpha) grid.alpha.set(alpha);
  else grid.alpha.fill(255);
  return grid;
}

/** 5×5 网格里放一个 3×3 实心方块（索引 1），其余透明 */
function blockGrid(): PixelGrid {
  const grid = createGrid(5, 5);
  for (let y = 1; y <= 3; y += 1) {
    for (let x = 1; x <= 3; x += 1) {
      grid.indices[y * 5 + x] = 1;
      grid.alpha[y * 5 + x] = 255;
    }
  }
  return grid;
}

/**
 * 中间 3×3 挖空的 5×5：洞四周的一圈（12 格）先涂成 outlineColor，其余实心格是 otherColor。
 * 用来验证「值已经是轮廓色 → 不写入」。
 */
function holeGrid(outlineColor: number, otherColor: number): PixelGrid {
  const grid = createGrid(5, 5);
  grid.alpha.fill(255);
  for (let y = 0; y < 5; y += 1) {
    for (let x = 0; x < 5; x += 1) {
      const i = y * 5 + x;
      if (x >= 1 && x <= 3 && y >= 1 && y <= 3) {
        grid.alpha[i] = 0; // 洞
        continue;
      }
      const onRim =
        (x === 0 && y >= 1 && y <= 3) ||
        (x === 4 && y >= 1 && y <= 3) ||
        (y === 0 && x >= 1 && x <= 3) ||
        (y === 4 && x >= 1 && x <= 3);
      grid.indices[i] = onRim ? outlineColor : otherColor;
    }
  }
  return grid;
}

/** 只取写入下标并升序，便于断言集合 */
function indicesOf(writes: readonly { index: number }[]): number[] {
  return writes.map((w) => w.index).sort((a, b) => a - b);
}

/* ============================================================ 自动描边 */

describe('planOutline · 外缘', () => {
  it('4 邻域只描上下左右，8 邻域才带上四个对角', () => {
    const grid = blockGrid();
    const four = planOutline(grid, null, { color: 2, diagonal: false });
    const eight = planOutline(grid, null, { color: 2, diagonal: true });

    // 3×3 方块外一圈：4 邻域 12 格（不含四角），8 邻域 16 格
    expect(four).toHaveLength(12);
    expect(eight).toHaveLength(16);

    const corners = [0, 4, 20, 24]; // (0,0) (4,0) (0,4) (4,4)
    for (const c of corners) expect(indicesOf(four)).not.toContain(c);
    for (const c of corners) expect(indicesOf(eight)).toContain(c);
  });

  it('3×3 实心方块在 5×5 网格里，8 邻域的外缘恰好是 5×5 的一圈（16 格）', () => {
    const writes = planOutline(blockGrid(), null, { color: 2, diagonal: true });

    expect(writes).toHaveLength(16);
    expect(new Set(indicesOf(writes)).size).toBe(16); // 没有重复写入同一格
    // 外缘是「新增」：方块内部的 9 格不在结果里
    for (let y = 1; y <= 3; y += 1) {
      for (let x = 1; x <= 3; x += 1) expect(indicesOf(writes)).not.toContain(y * 5 + x);
    }
    expect(writes.every((w) => w.cell?.index === 2 && w.cell?.alpha === 255)).toBe(true);
  });

  it('贴边形状不越界，填满整张图时外缘为空', () => {
    // 填满：没有任何透明格，自然没有外缘可描
    const full = makeGrid(4, 4, new Array<number>(16).fill(1));
    expect(planOutline(full, null, { color: 2, diagonal: false })).toEqual([]);
    expect(planOutline(full, null, { color: 2, diagonal: true })).toEqual([]);

    // 贴着左上角的 3×3 方块：结果必须全部落在网格内
    const corner = createGrid(5, 5);
    for (let y = 0; y < 3; y += 1) {
      for (let x = 0; x < 3; x += 1) {
        corner.indices[y * 5 + x] = 1;
        corner.alpha[y * 5 + x] = 255;
      }
    }
    const writes = planOutline(corner, null, { color: 2, diagonal: false });
    expect(writes).toHaveLength(6);
    expect(writes.every((w) => w.index >= 0 && w.index < 25)).toBe(true);
  });

  it('外缘描完后不会再描第二遍（连点两次不会重复产生写入）', () => {
    const grid = blockGrid();
    const opts = { color: 2, diagonal: true };
    const first = planOutline(grid, null, opts);
    expect(first).toHaveLength(16);

    // 把结果写进编辑层：8 邻域正好占满 5×5，整张图不再有透明格
    const edit = createEditLayer(5, 5);
    for (const w of first) edit.cells[w.index] = w.cell;

    expect(planOutline(grid, edit, opts)).toEqual([]);
  });
});

describe('planOutline · 内缘', () => {
  it('内缘把形状的边圈染色，正中心不动', () => {
    const writes = planOutline(blockGrid(), null, {
      color: 2,
      diagonal: false,
      mode: 'inside',
    });

    // 3×3 方块的内圈 = 它的 8 个边缘格；正中心 (2,2) 四邻域全是实心，不在结果里
    expect(indicesOf(writes)).toEqual([6, 7, 8, 11, 13, 16, 17, 18]);
    expect(indicesOf(writes)).not.toContain(12);
    expect(writes.every((w) => w.cell?.index === 2 && w.cell?.alpha === 255)).toBe(true);
  });

  it('完全不透明的实心图没有内缘可描', () => {
    const full = makeGrid(4, 4, new Array<number>(16).fill(1));
    expect(planOutline(full, null, { color: 2, diagonal: false, mode: 'inside' })).toEqual([]);
    expect(planOutline(full, null, { color: 2, diagonal: true, mode: 'inside' })).toEqual([]);
  });

  it('值已经等于轮廓色的格子会被跳过，不会产生空写入', () => {
    const grid = holeGrid(2, 1); // 洞四周一圈已经是轮廓色 2
    expect(planOutline(grid, null, { color: 2, diagonal: false, mode: 'inside' })).toEqual([]);

    // 把其中一格改成别的颜色 → 它才是真正需要描的那一格
    grid.indices[1] = 1; // (1,0)
    expect(indicesOf(planOutline(grid, null, { color: 2, diagonal: false, mode: 'inside' }))).toEqual(
      [1],
    );
  });

  it('编辑层里手改成透明的格子会被算作透明区', () => {
    const grid = blockGrid();
    const edit = createEditLayer(5, 5);
    edit.cells[12] = { index: 0, alpha: 0 }; // 用户手动擦了方块正中心

    const writes = planOutline(grid, edit, { color: 2, diagonal: false });
    const idx = indicesOf(writes);
    expect(idx).toHaveLength(13); // 原来的 12 格外加被擦空的中心
    expect(idx).toContain(12);
    expect(writes.find((w) => w.index === 12)?.cell).toEqual({ index: 2, alpha: 255 });
  });
});

/* ========================================================== 自动明暗分层 */

// 同一色相、不同亮度的红 —— 用来验证「只压明暗、不改色相」
const DEEP_RED: RGBA = [120, 0, 0, 255]; //  亮度 0.100
const MID_RED: RGBA = [200, 40, 40, 255]; //  亮度 0.290
const BRIGHT_RED: RGBA = [255, 80, 80, 255]; // 亮度 0.460
const PALE_RED: RGBA = [255, 175, 175, 255]; // 亮度 0.753
const VERY_DARK_RED: RGBA = [40, 0, 0, 255]; // 亮度 0.033

const BLACK_C: RGBA = [0, 0, 0, 255]; // 亮度 0，纯黑
const WHITE_C: RGBA = [255, 255, 255, 255]; // 亮度 1，纯白
const GRAY_128: RGBA = [128, 128, 128, 255]; // 亮度 0.502
const GRAY_159: RGBA = [159, 159, 159, 255]; // 亮度 0.624，正落在中间档目标 0.625 上
const GRAY_30: RGBA = [30, 30, 30, 255];
const GRAY_40: RGBA = [40, 40, 40, 255];
const GRAY_48: RGBA = [48, 48, 48, 255];
const GREEN_LOW: RGBA = [0, 90, 0, 255]; //  亮度 0.252
const GREEN_MID: RGBA = [0, 128, 0, 255]; // 亮度 0.359
const GRAY_MID: RGBA = [92, 92, 92, 255]; // 亮度 0.361，与 GREEN_MID 几乎同亮度

const SHADE_OPTS = { darkMax: 0.33, lightMin: 0.66 };

describe('planShade · 把明暗压成三档', () => {
  it('中亮度的红提亮、很亮的红压暗，都落到亮红（色相不变）', () => {
    const palette = makePalette('reds', [DEEP_RED, MID_RED, BRIGHT_RED, PALE_RED]);
    const grid = makeGrid(2, 1, [1, 3]); // 中亮度的红、很亮的红
    // 中间档目标亮度 = (0.2 + 0.8) / 2 = 0.5：中红(0.29) 提亮、淡红(0.75) 压暗，
    // 缩放后都离亮红最近 —— 全程没离开红色系
    expect(planShade(grid, null, palette, { darkMax: 0.2, lightMin: 0.8 })).toEqual([
      { index: 0, cell: { index: 2, alpha: 255 } },
      { index: 1, cell: { index: 2, alpha: 255 } },
    ]);
  });

  it('很暗的红提亮后落到深红', () => {
    const palette = makePalette('reds', [DEEP_RED, MID_RED, BRIGHT_RED, VERY_DARK_RED]);
    const grid = makeGrid(1, 1, [3]); // 唯一一格：很暗的红（调色板索引 3）
    // 暗档目标亮度 = 0.5 / 2 = 0.25：提亮后离深红(0.10) 最近，而不是离它自己最近
    expect(planShade(grid, null, palette, { darkMax: 0.5, lightMin: 0.8 })).toEqual([
      { index: 0, cell: { index: 0, alpha: 255 } },
    ]);
  });

  it('色相保持：中亮度的绿提亮后落到绿，而不是同亮度的灰', () => {
    const palette = makePalette('green-gray', [GREEN_LOW, GREEN_MID, GRAY_MID]);
    const grid = makeGrid(1, 1, [0]);
    // GRAY_MID(0.361) 与落点 GREEN_MID(0.359) 亮度几乎相同，色相却完全不同：
    // 缩放后的绿仍然离绿最近，说明这一步保住的是色相、压掉的是明暗
    expect(planShade(grid, null, palette, { darkMax: 0.7, lightMin: 0.9 })).toEqual([
      { index: 0, cell: { index: 1, alpha: 255 } },
    ]);
  });

  it('纯黑格与纯白格被跳过（缩放到哪都是灰，色相无从谈起）', () => {
    const palette = makePalette('bw', [BLACK_C, WHITE_C, GRAY_128]);
    const grid = makeGrid(3, 1, [0, 1, 2]);
    expect(planShade(grid, null, palette, SHADE_OPTS)).toEqual([]);
  });

  it('已经接近目标亮度的格子不写入，偏离的会被拉到目标档', () => {
    const palette = makePalette('grays', [GRAY_159, GRAY_128]);
    const grid = makeGrid(2, 1, [0, 1]);
    // 中间档目标 = (0.5 + 0.75) / 2 = 0.625：159 已经在那儿（不动），128 被提亮过去
    expect(planShade(grid, null, palette, { darkMax: 0.5, lightMin: 0.75 })).toEqual([
      { index: 1, cell: { index: 0, alpha: 255 } },
    ]);
  });

  it('全暗色的调色板：提亮后收敛到最亮的那一档色', () => {
    const palette = makePalette('all-dark', [BLACK_C, GRAY_30, GRAY_40, GRAY_48]);
    const grid = makeGrid(4, 1, [0, 1, 2, 3]);
    // 暗档目标亮度 0.2（约等于中灰 51）：几个深灰都朝它提亮，落到最接近的 48；
    // 纯黑跳过，48 本就在目标附近也保持不变
    expect(planShade(grid, null, palette, { darkMax: 0.4, lightMin: 0.7 })).toEqual([
      { index: 1, cell: { index: 3, alpha: 255 } },
      { index: 2, cell: { index: 3, alpha: 255 } },
    ]);
  });

  it('透明格不动，写入保留原 alpha', () => {
    const palette = makePalette('grays', [GRAY_159, GRAY_128]);
    const grid = makeGrid(2, 1, [1, 1], [200, 0]); // 第二格全透明
    expect(planShade(grid, null, palette, { darkMax: 0.5, lightMin: 0.75 })).toEqual([
      { index: 0, cell: { index: 0, alpha: 200 } },
    ]);
  });

  it('阈值交叉时钳到合法范围，不抛错', () => {
    const palette = makePalette('reds', [DEEP_RED, MID_RED, BRIGHT_RED, PALE_RED]);
    const crossed = { darkMax: 0.8, lightMin: 0.2 }; // darkMax > lightMin

    const stats = bandSlots(palette, crossed);
    expect(stats.midSlots).toBe(0); // lightMin 被抬到 darkMax → 没有中间调
    expect(stats.darkSlots + stats.midSlots + stats.lightSlots).toBe(palette.colors.length);

    const grid = makeGrid(4, 1, [0, 1, 2, 3]);
    expect(() => planShade(grid, null, palette, crossed)).not.toThrow();
    expect(planShade(grid, null, palette, crossed)).toHaveLength(3);
  });

  it('bandSlots 描述的是调色板的明暗分布，数量之和等于颜色数', () => {
    const palette = makePalette('reds', [DEEP_RED, MID_RED, BRIGHT_RED, PALE_RED]);
    const stats = bandSlots(palette, SHADE_OPTS);
    expect(stats.darkSlots).toBe(2); // 深红 0.100、中红 0.290
    expect(stats.midSlots).toBe(1); // 亮红 0.460
    expect(stats.lightSlots).toBe(1); // 淡红 0.753
    expect(stats.darkSlots + stats.midSlots + stats.lightSlots).toBe(palette.colors.length);
  });

  it('结果确定：同一输入两次得到相同的写入', () => {
    const palette = makePalette('reds', [DEEP_RED, MID_RED, BRIGHT_RED, PALE_RED]);
    const grid = makeGrid(4, 1, [0, 1, 2, 3]);
    const opts = { darkMax: 0.2, lightMin: 0.8 };
    expect(planShade(grid, null, palette, opts)).toEqual(planShade(grid, null, palette, opts));
  });
});