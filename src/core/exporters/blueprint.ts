/**
 * Minecraft 建造蓝图（M6）。
 *
 * 目标：一张 32×32 的像素图 → 打印出来能照着在游戏里搭起来。
 * 所以它和「像素图导出」是两回事：要的是**可读的施工图**，不是好看的效果图。
 *
 * 三样产出：
 * - 分页 PNG：网格 + 行列坐标标尺 + 本页色号图例
 * - `x,y,z,block` CSV：程序/表格可读的施工清单
 * - 色号对照表：色号 ↔ hex ↔ 方块名，用来核对图例与 CSV 是否一一对应
 *
 * 布局与 CSV 是纯函数（可单测）；只有 PNG 需要 canvas 画文字。
 */

import { trimTransparent } from '../assists/trim';
import { toHex } from '../color/space';
import type { Palette, PixelGrid, RGBA } from '../types';
import { resolveBlock, type BlockMap } from './blocks';

/* ------------------------------------------------------------------ 选项 */

export interface BlueprintOptions {
  /** 每格画多少像素 */
  cell: number;
  /** 每页最多放多少列 / 行格 */
  pageCols: number;
  pageRows: number;
  /** 每几格标一次坐标 */
  rulerEvery: number;
  /** 坐标从 1 开始（对着图纸数格子时更自然） */
  oneBased: boolean;
  /** 画格子之间的分隔线 */
  gridLines: boolean;
  /** 页眉标题 */
  title: string;
}

export const DEFAULT_BLUEPRINT_OPTIONS: BlueprintOptions = {
  cell: 16,
  pageCols: 32,
  pageRows: 32,
  rulerEvery: 4,
  oneBased: false,
  gridLines: true,
  title: '',
};

/** 版面常量。渲染与布局共用，改一处即可 */
const PAD = 16;
const TITLE_H = 30;
const RULER = 22;
const LEGEND_GAP = 14;
const LEGEND_ROW_H = 20;
const LEGEND_ENTRY_W = 168;

/* ------------------------------------------------------------------ 布局 */

export interface BlueprintPagePlan {
  /** 页号，1 起 */
  index: number;
  total: number;
  /** 本页覆盖的格范围 */
  cellX: number;
  cellY: number;
  cellW: number;
  cellH: number;
  canvasW: number;
  canvasH: number;
  /** 网格区左上角在画布中的位置 */
  gridX: number;
  gridY: number;
  /** 图例区：起始 x、起始 y、列数、每列宽度 */
  legendX: number;
  legendY: number;
  legendCols: number;
  legendEntryW: number;
  /** 本页用到的调色板索引（升序）。图例只列这些 —— 每页自洽，单独打印一页也看得懂 */
  usedIndices: number[];
}

/** 收集一段格范围里实际用到的调色板索引，升序 */
export function usedIndicesInRange(
  grid: PixelGrid,
  cellX: number,
  cellY: number,
  cellW: number,
  cellH: number,
): number[] {
  const seen = new Set<number>();
  const maxX = Math.min(grid.w, cellX + cellW);
  const maxY = Math.min(grid.h, cellY + cellH);
  for (let y = Math.max(0, cellY); y < maxY; y += 1) {
    for (let x = Math.max(0, cellX); x < maxX; x += 1) {
      const i = y * grid.w + x;
      if (grid.alpha[i] === 0) continue;
      seen.add(grid.indices[i]);
    }
  }
  return [...seen].sort((a, b) => a - b);
}

export function planBlueprintPages(
  grid: PixelGrid,
  options: BlueprintOptions,
): BlueprintPagePlan[] {
  const cell = Math.max(2, Math.round(options.cell));
  // 0 或负数表示「不分页」：一页放下整张图
  const pageCols = options.pageCols > 0 ? Math.round(options.pageCols) : grid.w;
  const pageRows = options.pageRows > 0 ? Math.round(options.pageRows) : grid.h;

  const cols = Math.ceil(grid.w / pageCols);
  const rows = Math.ceil(grid.h / pageRows);
  const total = Math.max(1, cols * rows);

  const plans: BlueprintPagePlan[] = [];
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cellX = col * pageCols;
      const cellY = row * pageRows;
      const cellW = Math.min(pageCols, grid.w - cellX);
      const cellH = Math.min(pageRows, grid.h - cellY);

      const usedIndices = usedIndicesInRange(grid, cellX, cellY, cellW, cellH);

      const gridW = cellW * cell;
      const gridRight = PAD + RULER + gridW;
      const contentW = RULER + gridW;

      /*
       * 图例区宽度要单独算，而且可能反过来撑宽整张画布。
       *
       * 一开始只按「网格有多宽」算列数，小图（比如 8×8）就出事：
       * 内容区只有 150px，一列图例要 168px，文字直接被画布边缘裁掉 ——
       * 而且裁掉的是方块名，正好是图纸最有用的那部分。
       */
      const legendCols = Math.max(1, Math.floor(contentW / LEGEND_ENTRY_W));
      const legendEntryW = Math.max(LEGEND_ENTRY_W, contentW / legendCols);
      const legendRows = Math.max(1, Math.ceil(usedIndices.length / legendCols));

      const legendY = PAD + TITLE_H + RULER + cellH * cell + LEGEND_GAP;
      const legendBottom = legendY + legendRows * LEGEND_ROW_H;

      plans.push({
        index: plans.length + 1,
        total,
        cellX,
        cellY,
        cellW,
        cellH,
        gridX: PAD + RULER,
        gridY: PAD + TITLE_H + RULER,
        legendX: PAD,
        legendY,
        legendCols,
        legendEntryW,
        // 画布宽度取「网格右侧」与「图例右侧」的较大者，两边都不会被裁
        canvasW: Math.max(gridRight, PAD + legendCols * legendEntryW) + PAD,
        canvasH: legendBottom + PAD,
        usedIndices,
      });
    }
  }

  return plans;
}

/* -------------------------------------------------------------------- CSV */

export interface BlueprintCsvOptions {
  /** 跳过透明格（那里本来就没有方块） */
  skipTransparent: boolean;
  /**
   * Y 轴方向。
   * 图片第一行是「上面」，而 Minecraft 里 y 越大越高，
   * 所以 'up' 会把第一行映射到 y = 格数-1，照着搭不会上下颠倒。
   */
  yAxis: 'up' | 'down';
  /** 所有方块放在哪一层 */
  z: number;
  /** 是否写表头 */
  header: boolean;
}

export const DEFAULT_BLUEPRINT_CSV_OPTIONS: BlueprintCsvOptions = {
  skipTransparent: true,
  yAxis: 'up',
  z: 0,
  header: true,
};

export function buildBlueprintCsv(
  grid: PixelGrid,
  palette: Palette,
  userMap: BlockMap,
  suggestedMap: BlockMap,
  options: BlueprintCsvOptions,
): string {
  const lines: string[] = [];
  if (options.header) lines.push('x,y,z,block');

  for (let y = 0; y < grid.h; y += 1) {
    for (let x = 0; x < grid.w; x += 1) {
      const i = y * grid.w + x;
      if (options.skipTransparent && grid.alpha[i] === 0) continue;
      const color: RGBA | undefined = palette.colors[grid.indices[i]];
      if (!color) continue;
      const block = resolveBlock(color, userMap, suggestedMap);
      const mcY = options.yAxis === 'up' ? grid.h - 1 - y : y;
      lines.push(`${x},${mcY},${options.z},${block?.id ?? ''}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

/**
 * 色号对照表。
 *
 * 单独给一份的原因：验收标准是「图例色号与 CSV 里的 block 一一对应」，
 * 而 PNG 里的图例没法用文本工具比对。这份表把两边的对应关系写成可搜索的文本。
 */
export function buildBlockLegend(
  grid: PixelGrid,
  palette: Palette,
  userMap: BlockMap,
  suggestedMap: BlockMap,
): string {
  const used = usedIndicesInRange(grid, 0, 0, grid.w, grid.h);
  const lines = ['# 色号  HEX     方块名 (block id)'];
  for (const index of used) {
    const color = palette.colors[index];
    if (!color) continue;
    const hex = toHex(color[0], color[1], color[2]);
    const block = resolveBlock(color, userMap, suggestedMap);
    lines.push(
      `#${String(index).padEnd(5)} ${hex}  ${block ? `${block.name} (${block.id})` : '（未映射）'}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/* ---------------------------------------------------------------- 渲染 PNG */

type AnyCanvas = OffscreenCanvas | HTMLCanvasElement;
type AnyCtx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

function createCanvas(w: number, h: number): AnyCtx2D {
  const canvas: AnyCanvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(w, h)
      : (() => {
          const el = document.createElement('canvas');
          el.width = w;
          el.height = h;
          return el;
        })();
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d') as AnyCtx2D | null;
  if (!ctx) throw new Error('无法创建 2D 绘图上下文');
  return ctx;
}

const INK = '#1b1f24';
const LINE = '#c8ccd2';
const LINE_SOFT = '#e6e9ed';
const PAPER = '#ffffff';

/**
 * 画一页蓝图。
 *
 * 用 canvas 的 fillText 而不是自绘点阵字体：图例里要写中文方块名，
 * 点阵字体覆盖不了；而且这是给人看的施工图，文字清晰比「零依赖」重要。
 * 代价是这一支没法在 node 里单测 —— 所以布局与 CSV 才刻意拆成了纯函数。
 */
export function renderBlueprintPage(
  plan: BlueprintPagePlan,
  grid: PixelGrid,
  palette: Palette,
  userMap: BlockMap,
  suggestedMap: BlockMap,
  options: BlueprintOptions,
): ImageData {
  const cell = Math.max(2, Math.round(options.cell));
  const ctx = createCanvas(plan.canvasW, plan.canvasH);

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, plan.canvasW, plan.canvasH);

  /* ---------------- 页眉 ---------------- */
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.font = '600 14px "Segoe UI", system-ui, sans-serif';
  const title = options.title.trim() === '' ? '像素图建造蓝图' : options.title.trim();
  ctx.fillText(title, PAD, PAD + 8);
  // 副标题接在标题实测宽度之后，而不是写死一个偏移：
  // 文件名长起来（`character_idle_south_32x32.png`）时，写死的偏移会让两段文字叠在一起
  const titleWidth = ctx.measureText(title).width;

  ctx.font = '12px "Cascadia Mono", Consolas, monospace';
  ctx.fillStyle = '#5b6674';
  const rangeText =
    plan.cellW === grid.w && plan.cellH === grid.h
      ? `${grid.w} × ${grid.h} 格`
      : `第 ${plan.cellX}–${plan.cellX + plan.cellW - 1} 列 / 第 ${plan.cellY}–${plan.cellY + plan.cellH - 1} 行`;
  const pageText = plan.total > 1 ? ` · 第 ${plan.index}/${plan.total} 页` : '';
  ctx.fillText(`${rangeText}${pageText} · 每格 ${cell}px`, PAD + titleWidth + 14, PAD + 8);

  /* ---------------- 行列标尺 ---------------- */
  ctx.font = '10px "Cascadia Mono", Consolas, monospace';
  ctx.fillStyle = '#5b6674';
  const every = Math.max(1, Math.round(options.rulerEvery));
  const label = (n: number) => String(options.oneBased ? n + 1 : n);

  ctx.textAlign = 'center';
  for (let c = 0; c < plan.cellW; c += 1) {
    const absolute = plan.cellX + c;
    if (absolute % every !== 0) continue;
    const cx = plan.gridX + c * cell + cell / 2;
    ctx.fillText(label(absolute), cx, plan.gridY - RULER / 2);
    ctx.fillStyle = LINE;
    ctx.fillRect(cx, plan.gridY - 6, 1, 6);
    ctx.fillStyle = '#5b6674';
  }

  ctx.textAlign = 'right';
  for (let r = 0; r < plan.cellH; r += 1) {
    const absolute = plan.cellY + r;
    if (absolute % every !== 0) continue;
    const cy = plan.gridY + r * cell + cell / 2;
    ctx.fillText(label(absolute), plan.gridX - 6, cy);
    ctx.fillStyle = LINE;
    ctx.fillRect(plan.gridX - 5, cy, 5, 1);
    ctx.fillStyle = '#5b6674';
  }

  /* ---------------- 格子 ---------------- */
  for (let r = 0; r < plan.cellH; r += 1) {
    for (let c = 0; c < plan.cellW; c += 1) {
      const gx = plan.cellX + c;
      const gy = plan.cellY + r;
      const i = gy * grid.w + gx;
      if (grid.alpha[i] === 0) continue; // 透明格留白：那里不放方块
      const color = palette.colors[grid.indices[i]];
      if (!color) continue;
      ctx.fillStyle = toHex(color[0], color[1], color[2]);
      ctx.fillRect(plan.gridX + c * cell, plan.gridY + r * cell, cell, cell);
    }
  }

  /* ---------------- 网格线 ---------------- */
  if (options.gridLines) {
    for (let c = 0; c <= plan.cellW; c += 1) {
      const x = plan.gridX + c * cell;
      // 每 4 格一条稍重的线，数格子时不用一个个数
      const major = (plan.cellX + c) % (every * 2) === 0;
      ctx.fillStyle = major ? LINE : LINE_SOFT;
      ctx.fillRect(x, plan.gridY, 1, plan.cellH * cell);
    }
    for (let r = 0; r <= plan.cellH; r += 1) {
      const y = plan.gridY + r * cell;
      const major = (plan.cellY + r) % (every * 2) === 0;
      ctx.fillStyle = major ? LINE : LINE_SOFT;
      ctx.fillRect(plan.gridX, y, plan.cellW * cell, 1);
    }
    // 外框压深一档，图纸边界一眼可见
    ctx.strokeStyle = '#8c97a6';
    ctx.lineWidth = 1;
    ctx.strokeRect(plan.gridX + 0.5, plan.gridY + 0.5, plan.cellW * cell - 1, plan.cellH * cell - 1);
  }

  /* ---------------- 图例 ---------------- */
  const legendTop = plan.legendY;

  ctx.font = '11px "Cascadia Mono", Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';

  plan.usedIndices.forEach((index, n) => {
    const color = palette.colors[index];
    if (!color) return;
    const col = n % plan.legendCols;
    const row = Math.floor(n / plan.legendCols);
    const ex = plan.legendX + col * plan.legendEntryW;
    const ey = legendTop + row * LEGEND_ROW_H + LEGEND_ROW_H / 2;

    const swatch = 12;
    ctx.fillStyle = toHex(color[0], color[1], color[2]);
    ctx.fillRect(ex, ey - swatch / 2, swatch, swatch);
    ctx.strokeStyle = '#8c97a6';
    ctx.lineWidth = 1;
    ctx.strokeRect(ex + 0.5, ey - swatch / 2 + 0.5, swatch - 1, swatch - 1);

    ctx.fillStyle = INK;
    const block = resolveBlock(color, userMap, suggestedMap);
    ctx.fillText(
      `#${index} ${toHex(color[0], color[1], color[2])} ${block ? block.name : '未映射'}`,
      ex + swatch + 6,
      ey,
    );
  });

  return ctx.getImageData(0, 0, plan.canvasW, plan.canvasH);
}

/**
 * 便捷封装：按选项把整张图渲染成若干页。
 * 单页时把 `trimTransparent` 的裁剪结果也算进去 —— 裁完再画，图纸上不会有一圈空白边。
 */
export function renderBlueprintPages(
  grid: PixelGrid,
  palette: Palette,
  userMap: BlockMap,
  suggestedMap: BlockMap,
  options: BlueprintOptions,
): { name: string; data: ImageData }[] {
  const pages = planBlueprintPages(grid, options);
  return pages.map((plan) => ({
    name: pages.length > 1 ? `p${plan.index}` : '',
    data: renderBlueprintPage(plan, grid, palette, userMap, suggestedMap, options),
  }));
}

/** 图纸用哪张网格：可选先裁掉四周透明边，免得浪费纸 */
export function blueprintSource(grid: PixelGrid, trim: boolean): PixelGrid {
  return trim ? trimTransparent(grid).grid : grid;
}
