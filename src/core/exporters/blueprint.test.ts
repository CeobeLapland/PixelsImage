import { afterEach, describe, expect, it, vi } from 'vitest';

import { makePalette } from '@/core/__testing__/fixtures';
import { createGrid, type PixelGrid } from '@/core/types';
import { colorKey, suggestBlockMap } from './blocks';
import {
  blueprintSource,
  buildBlockLegend,
  buildBlueprintCsv,
  planBlueprintPages,
  renderBlueprintPage,
  usedIndicesInRange,
  type BlueprintOptions,
} from './blueprint';

/** 用 MC 染料色的前四个，方便断言方块名 */
const WHITE: [number, number, number, number] = [249, 255, 254, 255];
const LIGHT_GRAY: [number, number, number, number] = [157, 157, 151, 255];
const GRAY: [number, number, number, number] = [71, 79, 82, 255];
const BLACK: [number, number, number, number] = [29, 29, 33, 255];
const PALETTE = makePalette('mc', [WHITE, LIGHT_GRAY, GRAY, BLACK]);
const BLOCKS = suggestBlockMap(PALETTE.colors);

const OPTIONS: BlueprintOptions = {
  cell: 8,
  pageCols: 0,
  pageRows: 0,
  rulerEvery: 4,
  oneBased: false,
  gridLines: true,
  title: 'hero',
};

function makeGrid(w: number, h: number, indices?: number[], alphas?: number[]): PixelGrid {
  const grid = createGrid(w, h);
  for (let i = 0; i < grid.indices.length; i += 1) {
    grid.indices[i] = indices ? (indices[i] ?? 0) : i % 4;
    grid.alpha[i] = alphas ? (alphas[i] ?? 255) : 255;
  }
  return grid;
}

describe('usedIndicesInRange', () => {
  it('只统计范围内的格子，且升序去重', () => {
    // 3×1：索引 2, 0, 2
    const grid = makeGrid(3, 1, [2, 0, 2]);
    expect(usedIndicesInRange(grid, 0, 0, 3, 1)).toEqual([0, 2]);
    expect(usedIndicesInRange(grid, 0, 0, 2, 1)).toEqual([0, 2]);
    expect(usedIndicesInRange(grid, 2, 0, 1, 1)).toEqual([2]);
  });

  it('透明格不计入 —— 那里不放方块，图例里也不该出现', () => {
    const grid = makeGrid(2, 1, [1, 2], [0, 255]);
    expect(usedIndicesInRange(grid, 0, 0, 2, 1)).toEqual([2]);
  });

  it('范围超出网格时自动夹住，不越界读', () => {
    const grid = makeGrid(2, 2);
    expect(() => usedIndicesInRange(grid, 1, 1, 10, 10)).not.toThrow();
  });
});

describe('planBlueprintPages', () => {
  it('不分页时只有一页，尺寸覆盖整张图', () => {
    const pages = planBlueprintPages(makeGrid(16, 12), OPTIONS);
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatchObject({ index: 1, total: 1, cellX: 0, cellY: 0, cellW: 16, cellH: 12 });
  });

  it('按每页格数切分，行列各算一遍', () => {
    const pages = planBlueprintPages(makeGrid(10, 10), { ...OPTIONS, pageCols: 4, pageRows: 4 });
    // ceil(10/4) = 3 → 3×3 = 9 页
    expect(pages).toHaveLength(9);
    expect(pages.every((p) => p.total === 9)).toBe(true);
    expect(pages.map((p) => p.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it('边缘页只覆盖剩下的部分，不做空白补齐', () => {
    const pages = planBlueprintPages(makeGrid(10, 10), { ...OPTIONS, pageCols: 4, pageRows: 4 });
    expect(pages[2]).toMatchObject({ cellX: 8, cellY: 0, cellW: 2, cellH: 4 });
    expect(pages[8]).toMatchObject({ cellX: 8, cellY: 8, cellW: 2, cellH: 2 });
  });

  it('先横向铺满再换行', () => {
    const pages = planBlueprintPages(makeGrid(10, 10), { ...OPTIONS, pageCols: 4, pageRows: 4 });
    expect(pages[1].cellX).toBe(4);
    expect(pages[1].cellY).toBe(0);
    expect(pages[3].cellX).toBe(0);
    expect(pages[3].cellY).toBe(4);
  });

  it('画布宽度随格数线性增长（网格足够宽时）', () => {
    const narrow = planBlueprintPages(makeGrid(40, 4), { ...OPTIONS, cell: 10 })[0];
    const wide = planBlueprintPages(makeGrid(44, 4), { ...OPTIONS, cell: 10 })[0];
    expect(wide.canvasW - narrow.canvasW).toBe(4 * 10);
  });

  it('网格区与图例区都必须落在画布内', () => {
    // 小图（内容区比一列图例还窄）与大图各验一次
    for (const cols of [4, 8, 32, 64]) {
      const plan = planBlueprintPages(makeGrid(cols, 4), { ...OPTIONS, cell: 10 })[0];
      expect(plan.gridX).toBeGreaterThan(0);
      expect(plan.gridX + plan.cellW * 10).toBeLessThanOrEqual(plan.canvasW);
      expect(plan.legendX + plan.legendCols * plan.legendEntryW).toBeLessThanOrEqual(plan.canvasW);
      expect(plan.legendY).toBeGreaterThan(plan.gridY);
      expect(plan.legendY).toBeLessThan(plan.canvasH);
    }
  });

  it('小图时画布被图例撑宽，而不是把方块名裁掉', () => {
    // 4 格 × 10px 的网格只有 40px 宽，一列图例要 168px
    const plan = planBlueprintPages(makeGrid(4, 4), { ...OPTIONS, cell: 10 })[0];
    expect(plan.legendEntryW).toBeGreaterThanOrEqual(168);
    expect(plan.canvasW).toBeGreaterThan(plan.gridX + plan.cellW * 10);
  });

  it('每页只列自己范围内用到的颜色', () => {
    // 4×2：上半索引 0，下半索引 1
    const grid = makeGrid(4, 2, [0, 0, 0, 0, 1, 1, 1, 1]);
    const pages = planBlueprintPages(grid, { ...OPTIONS, pageCols: 4, pageRows: 1 });
    expect(pages).toHaveLength(2);
    expect(pages[0].usedIndices).toEqual([0]);
    expect(pages[1].usedIndices).toEqual([1]);
  });

  it('图例行数影响画布高度', () => {
    // 一页 4 格，用满 4 种颜色 → 图例列数有限，行数 > 1
    const grid = makeGrid(4, 1, [0, 1, 2, 3]);
    const many = planBlueprintPages(grid, { ...OPTIONS, cell: 4 })[0];
    const one = planBlueprintPages(makeGrid(1, 1, [0]), { ...OPTIONS, cell: 4 })[0];
    expect(many.canvasH).toBeGreaterThan(one.canvasH);
  });
});

describe('buildBlueprintCsv', () => {
  const csvOptions = { skipTransparent: true, yAxis: 'up' as const, z: 0, header: true };

  it('每格一行，形如 x,y,z,block', () => {
    const csv = buildBlueprintCsv(makeGrid(2, 2), PALETTE, {}, BLOCKS, csvOptions);
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe('x,y,z,block');
    expect(lines).toHaveLength(5);
    expect(lines[1]).toBe('0,1,0,white_wool'); // 第一行 → y 最大
    expect(lines[4]).toBe('1,0,0,black_wool');
  });

  it('yAxis=up 时图的第一行在最高处（MC 里 y 越大越高）', () => {
    const csv = buildBlueprintCsv(makeGrid(1, 3, [0, 1, 2]), PALETTE, {}, BLOCKS, csvOptions);
    const ys = csv
      .trimEnd()
      .split('\n')
      .slice(1)
      .map((l) => Number(l.split(',')[1]));
    expect(ys).toEqual([2, 1, 0]);
  });

  it('yAxis=down 时图的第一行在最低处', () => {
    const csv = buildBlueprintCsv(makeGrid(1, 3, [0, 1, 2]), PALETTE, {}, BLOCKS, {
      ...csvOptions,
      yAxis: 'down',
    });
    const ys = csv
      .trimEnd()
      .split('\n')
      .slice(1)
      .map((l) => Number(l.split(',')[1]));
    expect(ys).toEqual([0, 1, 2]);
  });

  it('跳过透明格', () => {
    const grid = makeGrid(3, 1, [0, 1, 2], [255, 0, 255]);
    const lines = buildBlueprintCsv(grid, PALETTE, {}, BLOCKS, csvOptions).trimEnd().split('\n');
    expect(lines).toHaveLength(3); // 表头 + 2 格
    expect(lines.some((l) => l.startsWith('1,'))).toBe(false);
  });

  it('不跳过透明格时保留那些行', () => {
    const grid = makeGrid(3, 1, [0, 1, 2], [255, 0, 255]);
    const lines = buildBlueprintCsv(grid, PALETTE, {}, BLOCKS, {
      ...csvOptions,
      skipTransparent: false,
    })
      .trimEnd()
      .split('\n');
    expect(lines).toHaveLength(4);
  });

  it('z 与表头可配', () => {
    const csv = buildBlueprintCsv(makeGrid(1, 1), PALETTE, {}, BLOCKS, { ...csvOptions, z: 12, header: false });
    expect(csv.trimEnd()).toBe('0,0,12,white_wool');
  });

  it('用户映射覆盖建议值 —— 图例与 CSV 必须同步', () => {
    const map = { [colorKey(WHITE)]: 'snow_block' };
    const csv = buildBlueprintCsv(makeGrid(1, 1, [0]), PALETTE, map, BLOCKS, csvOptions);
    expect(csv).toContain('snow_block');
  });

  it('末尾带换行，追加内容时不会粘在一起', () => {
    expect(buildBlueprintCsv(makeGrid(1, 1), PALETTE, {}, BLOCKS, csvOptions).endsWith('\n')).toBe(true);
  });
});

describe('buildBlockLegend', () => {
  it('只列用到的色号，并给出 hex 与方块名', () => {
    const legend = buildBlockLegend(makeGrid(2, 1, [0, 3]), PALETTE, {}, BLOCKS);
    expect(legend).toContain('#0');
    expect(legend).toContain('#f9fffe');
    expect(legend).toContain('white_wool');
    expect(legend).toContain('black_wool');
    expect(legend).not.toContain('#1 '); // 没用到的不列
  });

  it('透明格不计入', () => {
    const legend = buildBlockLegend(makeGrid(2, 1, [0, 3], [255, 0]), PALETTE, {}, BLOCKS);
    expect(legend).toContain('white_wool');
    expect(legend).not.toContain('black_wool');
  });

  it('与 CSV 里的 block 一致 —— 这是验收标准里那条「一一对应」', () => {
    const grid = makeGrid(2, 2);
    const legend = buildBlockLegend(grid, PALETTE, {}, BLOCKS);
    const csv = buildBlueprintCsv(grid, PALETTE, {}, BLOCKS, {
      skipTransparent: true,
      yAxis: 'up',
      z: 0,
      header: true,
    });
    const csvBlocks = new Set(
      csv
        .trimEnd()
        .split('\n')
        .slice(1)
        .map((l) => l.split(',')[3]),
    );
    for (const block of csvBlocks) {
      expect(legend).toContain(block);
    }
  });
});

describe('blueprintSource', () => {
  it('裁剪开启时去掉四周透明边', () => {
    const grid = createGrid(4, 4);
    grid.indices.fill(0);
    grid.alpha.fill(0);
    grid.alpha[1 * 4 + 1] = 255;
    grid.alpha[1 * 4 + 2] = 255;
    grid.alpha[2 * 4 + 1] = 255;
    grid.alpha[2 * 4 + 2] = 255;

    expect(blueprintSource(grid, true).w).toBe(2);
    expect(blueprintSource(grid, false).w).toBe(4);
  });
});

/* -------------------------------------------------------------- 绘制坐标 */

/*
 * 用替身 canvas 把 renderBlueprintPage 的**绘制坐标**测出来。
 *
 * 这不是在测浏览器怎么画，而是在测「我自己算的坐标对不对」——
 * 格子是不是画在 gridX + c*cell、透明格有没有被漏画、图例有没有落在画布外，
 * 这些用肉眼看不出来，但错了整张图纸就是废的。
 */

interface FillCall {
  x: number;
  y: number;
  w: number;
  h: number;
  style: string;
}

class FakeCtx {
  fillStyle = '#000000';
  strokeStyle = '#000000';
  lineWidth = 1;
  font = '';
  textAlign = 'left';
  textBaseline = 'alphabetic';
  fills: FillCall[] = [];
  texts: string[] = [];

  fillRect(x: number, y: number, w: number, h: number): void {
    this.fills.push({ x, y, w, h, style: this.fillStyle });
  }
  strokeRect(): void {}
  fillText(text: string): void {
    this.texts.push(text);
  }
  measureText(text: string): { width: number } {
    // 近似等宽：每个字符 6px。测的是布局而不是字体度量
    return { width: text.length * 6 };
  }
  getImageData(_x: number, _y: number, w: number, h: number): ImageData {
    return new ImageData(w, h);
  }
}

let lastCtx: FakeCtx | null = null;

function installFakeCanvas(): void {
  class FakeOffscreenCanvas {
    width: number;
    height: number;
    private ctx: FakeCtx;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
      this.ctx = new FakeCtx();
      lastCtx = this.ctx;
    }
    getContext(): FakeCtx {
      return this.ctx;
    }
  }
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
}

afterEach(() => {
  vi.unstubAllGlobals();
  lastCtx = null;
});

/** 找出所有「格子大小」的填充 —— 其余都是网格线与色块边框 */
function cellFills(ctx: FakeCtx, cell: number): FillCall[] {
  return ctx.fills.filter((f) => f.w === cell && f.h === cell);
}

describe('renderBlueprintPage 的绘制坐标', () => {
  const opts: BlueprintOptions = { ...OPTIONS, cell: 10, gridLines: false };

  it('返回的画布尺寸与布局一致', () => {
    installFakeCanvas();
    const grid = makeGrid(3, 2);
    const plan = planBlueprintPages(grid, opts)[0];
    const data = renderBlueprintPage(plan, grid, PALETTE, {}, BLOCKS, opts);
    expect(data.width).toBe(plan.canvasW);
    expect(data.height).toBe(plan.canvasH);
  });

  it('每格画在自己的坐标上，尺寸等于每格像素', () => {
    installFakeCanvas();
    const grid = makeGrid(3, 2);
    const plan = planBlueprintPages(grid, opts)[0];
    renderBlueprintPage(plan, grid, PALETTE, {}, BLOCKS, opts);

    const cells = cellFills(lastCtx as FakeCtx, 10);
    expect(cells).toHaveLength(6);
    // 顺序是行优先：先第一行三格
    expect(cells[0]).toMatchObject({ x: plan.gridX, y: plan.gridY });
    expect(cells[1]).toMatchObject({ x: plan.gridX + 10, y: plan.gridY });
    expect(cells[2]).toMatchObject({ x: plan.gridX + 20, y: plan.gridY });
    expect(cells[3]).toMatchObject({ x: plan.gridX, y: plan.gridY + 10 });
  });

  it('格子用的是调色板里的颜色', () => {
    installFakeCanvas();
    const grid = makeGrid(2, 1, [0, 1]);
    const plan = planBlueprintPages(grid, opts)[0];
    renderBlueprintPage(plan, grid, PALETTE, {}, BLOCKS, opts);
    const cells = cellFills(lastCtx as FakeCtx, 10);
    expect(cells[0].style).toBe('#f9fffe');
    expect(cells[1].style).toBe('#9d9d97');
  });

  it('透明格不画 —— 那里本来就没有方块', () => {
    installFakeCanvas();
    const grid = makeGrid(3, 1, [0, 1, 2], [255, 0, 255]);
    const plan = planBlueprintPages(grid, opts)[0];
    renderBlueprintPage(plan, grid, PALETTE, {}, BLOCKS, opts);
    // 只剩两格被画
    expect(cellFills(lastCtx as FakeCtx, 10)).toHaveLength(2);
  });

  it('分页时按本页的格偏移取色', () => {
    installFakeCanvas();
    // 4×1，索引 0,1,2,3；每页 2 列 → 第二页应画索引 2 与 3 的颜色
    const grid = makeGrid(4, 1, [0, 1, 2, 3]);
    const pages = planBlueprintPages(grid, { ...opts, pageCols: 2, pageRows: 1 });
    renderBlueprintPage(pages[1], grid, PALETTE, {}, BLOCKS, opts);
    const cells = cellFills(lastCtx as FakeCtx, 10);
    expect(cells[0].style).toBe('#474f52'); // GRAY
    expect(cells[1].style).toBe('#1d1d21'); // BLACK
  });

  it('图例里的色块与文字都落在画布内', () => {
    installFakeCanvas();
    const grid = makeGrid(4, 1, [0, 1, 2, 3]);
    const plan = planBlueprintPages(grid, opts)[0];
    renderBlueprintPage(plan, grid, PALETTE, {}, BLOCKS, opts);
    const ctx = lastCtx as FakeCtx;

    // 12px 的色块是图例项；它们都必须在画布范围内
    const swatches = ctx.fills.filter((f) => f.w === 12 && f.h === 12);
    expect(swatches).toHaveLength(plan.usedIndices.length);
    for (const s of swatches) {
      expect(s.x).toBeGreaterThanOrEqual(0);
      expect(s.x + s.w).toBeLessThanOrEqual(plan.canvasW);
      expect(s.y).toBeGreaterThanOrEqual(0);
      expect(s.y + s.h).toBeLessThanOrEqual(plan.canvasH);
    }
  });

  it('图例文字带上色号与方块名 —— 这是照着搭的关键信息', () => {
    installFakeCanvas();
    const grid = makeGrid(1, 1, [0]);
    const plan = planBlueprintPages(grid, opts)[0];
    renderBlueprintPage(plan, grid, PALETTE, {}, BLOCKS, opts);
    const legendText = (lastCtx as FakeCtx).texts.find((t) => t.startsWith('#0'));
    expect(legendText).toContain('#f9fffe');
    expect(legendText).toContain('白色羊毛');
  });

  it('用户改过的映射会出现在图例里（与 CSV 同一份数据）', () => {
    installFakeCanvas();
    const grid = makeGrid(1, 1, [0]);
    const plan = planBlueprintPages(grid, opts)[0];
    renderBlueprintPage(plan, grid, PALETTE, { [colorKey(WHITE)]: 'snow_block' }, BLOCKS, opts);
    const legendText = (lastCtx as FakeCtx).texts.find((t) => t.startsWith('#0'));
    expect(legendText).toContain('雪块');
  });

  it('标尺数字按 rulerEvery 出现，且 oneBased 会整体加一', () => {
    installFakeCanvas();
    const grid = makeGrid(8, 8);
    const zero = planBlueprintPages(grid, { ...opts, rulerEvery: 4 })[0];
    renderBlueprintPage(zero, grid, PALETTE, {}, BLOCKS, { ...opts, rulerEvery: 4 });
    const zeroTexts = (lastCtx as FakeCtx).texts;

    installFakeCanvas();
    const one = planBlueprintPages(grid, { ...opts, rulerEvery: 4 })[0];
    renderBlueprintPage(one, grid, PALETTE, {}, BLOCKS, { ...opts, rulerEvery: 4, oneBased: true });
    const oneTexts = (lastCtx as FakeCtx).texts;

    // 0 基里列标尺应含 "0" 与 "4"，1 基里变成 "1" 与 "5"
    expect(zeroTexts).toContain('0');
    expect(zeroTexts).toContain('4');
    expect(oneTexts).toContain('1');
    expect(oneTexts).toContain('5');
    expect(oneTexts).not.toContain('0');
  });
});