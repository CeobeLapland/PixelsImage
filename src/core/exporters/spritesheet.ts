/**
 * 精灵图集打包（M6）。
 *
 * 输入是**一批像素图**（来自批量队列的已完成项），输出一张大图 + 一份坐标 JSON。
 * 之所以从批量队列取而不是「当前文档」：图集本来就是多图产物，
 * 单文档编辑器里一次只有一张图，做成单图图集没有意义。
 *
 * 布局与渲染都是纯 ImageData 运算，不碰 canvas，所以能在 node 里直接单测。
 */

import { trimTransparent } from '../assists/trim';
import { parseHex } from '../color/space';
import type { Palette, PixelGrid } from '../types';

export interface SpritesheetOptions {
  /** 每行放几个；0 = 自动（尽量接近正方形） */
  columns: number;
  /** 格子之间与四周的留白，像素 */
  padding: number;
  /** 每格先裁掉自己的透明边 */
  trim: boolean;
  /** 'transparent' 或 hex 底色 */
  background: 'transparent' | string;
}

export const DEFAULT_SPRITESHEET_OPTIONS: SpritesheetOptions = {
  columns: 0,
  padding: 1,
  trim: true,
  background: 'transparent',
};

export interface SheetTile {
  grid: PixelGrid;
  palette: Palette;
  /** 写进坐标 JSON 的名字 */
  name: string;
  /**
   * 原始帧时长（毫秒）。只有「从动图拆出来的帧」才有；
   * GIF / .ase 动画导出用它，缺省时回落为导出选项里的统一延时。
   */
  delayMs?: number;
}

/**
 * 一格在图集里的位置与尺寸。
 *
 * 给的是**槽位**（所有格子等大）而不是像素图自身的外接框 ——
 * 引擎播放序列帧时按固定帧尺寸取图，槽位等大才是它要的形式；
 * 图本身比槽位小的话在槽内居中。
 */
export interface SheetPlacement {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SheetLayout {
  w: number;
  h: number;
  columns: number;
  rows: number;
  /** 槽位尺寸（等大） */
  cellW: number;
  cellH: number;
  placements: SheetPlacement[];
}

/** 图集里每个格子实际画的尺寸：可选先裁掉透明边 */
function tileSize(tile: SheetTile, trim: boolean): { w: number; h: number } {
  if (!trim) return { w: tile.grid.w, h: tile.grid.h };
  const result = trimTransparent(tile.grid);
  return { w: result.grid.w, h: result.grid.h };
}

/**
 * 自动列数：取接近正方形的排法。
 * 之所以不用「固定每行 8 个」之类的硬编码：图集可能只有 3 张，也可能有 200 张，
 * 前者会拉成一条横线，后者会拉成一条竖线，两边都不好看也不好用。
 */
function autoColumns(count: number): number {
  return Math.max(1, Math.ceil(Math.sqrt(count)));
}

export function planSpritesheet(
  tiles: readonly SheetTile[],
  options: SpritesheetOptions,
): SheetLayout {
  const pad = Math.max(0, Math.round(options.padding));

  if (tiles.length === 0) {
    // 空图集也要给一个合法尺寸：ImageData 不允许 0 宽高
    return { w: Math.max(1, pad * 2), h: Math.max(1, pad * 2), columns: 0, rows: 0, cellW: 0, cellH: 0, placements: [] };
  }

  let cellW = 0;
  let cellH = 0;
  for (const tile of tiles) {
    const size = tileSize(tile, options.trim);
    if (size.w > cellW) cellW = size.w;
    if (size.h > cellH) cellH = size.h;
  }

  const requested = Math.round(options.columns);
  const columns = Math.min(tiles.length, requested > 0 ? requested : autoColumns(tiles.length));
  const rows = Math.ceil(tiles.length / columns);

  const placements: SheetPlacement[] = tiles.map((tile, i) => ({
    name: tile.name,
    x: pad + (i % columns) * (cellW + pad),
    y: pad + Math.floor(i / columns) * (cellH + pad),
    w: cellW,
    h: cellH,
  }));

  return {
    w: pad * 2 + columns * cellW + (columns - 1) * pad,
    h: pad * 2 + rows * cellH + (rows - 1) * pad,
    columns,
    rows,
    cellW,
    cellH,
    placements,
  };
}

/** 坐标 JSON：程序侧按名字查帧位置 */
export interface SheetManifest {
  sheet: { w: number; h: number; columns: number; rows: number };
  frames: { name: string; x: number; y: number; w: number; h: number }[];
}

export function buildSheetManifest(layout: SheetLayout): SheetManifest {
  return {
    sheet: {
      w: layout.w,
      h: layout.h,
      columns: layout.columns,
      rows: layout.rows,
    },
    frames: layout.placements.map((p) => ({ name: p.name, x: p.x, y: p.y, w: p.w, h: p.h })),
  };
}

/**
 * source-over 混合写入一个像素。
 *
 * 透明底时它自然退化成「直接写入」（目标 alpha 为 0 → 结果就是源色与源 alpha），
 * 所以不需要为两种底色写两份分支。
 */
function blendPixel(
  dst: Uint8ClampedArray,
  o: number,
  r: number,
  g: number,
  b: number,
  a: number,
): void {
  if (a === 0) return;
  if (a === 255) {
    dst[o] = r;
    dst[o + 1] = g;
    dst[o + 2] = b;
    dst[o + 3] = 255;
    return;
  }
  const sa = a / 255;
  const da = dst[o + 3] / 255;
  const outA = sa + da * (1 - sa);
  if (outA === 0) return;
  dst[o] = (r * sa + dst[o] * da * (1 - sa)) / outA;
  dst[o + 1] = (g * sa + dst[o + 1] * da * (1 - sa)) / outA;
  dst[o + 2] = (b * sa + dst[o + 2] * da * (1 - sa)) / outA;
  dst[o + 3] = outA * 255;
}

/** 铺底色（'transparent' 时什么也不做） */
function fillBackground(data: Uint8ClampedArray, hex: string): void {
  const parsed = parseHex(hex);
  if (!parsed) return;
  for (let o = 0; o < data.length; o += 4) {
    data[o] = parsed[0];
    data[o + 1] = parsed[1];
    data[o + 2] = parsed[2];
    data[o + 3] = 255;
  }
}

export function renderSpritesheet(
  layout: SheetLayout,
  tiles: readonly SheetTile[],
  options: SpritesheetOptions,
): ImageData {
  const data = new Uint8ClampedArray(layout.w * layout.h * 4);
  if (options.background !== 'transparent') fillBackground(data, options.background);

  for (let i = 0; i < tiles.length; i += 1) {
    const tile = tiles[i];
    const slot = layout.placements[i];
    if (!slot) continue;

    const source = options.trim ? trimTransparent(tile.grid).grid : tile.grid;
    const colors = tile.palette.colors;
    const last = colors.length - 1;

    // 图比槽位小时居中：贴着左上角会让整张图集看起来歪的
    const offsetX = slot.x + Math.floor((slot.w - source.w) / 2);
    const offsetY = slot.y + Math.floor((slot.h - source.h) / 2);

    for (let y = 0; y < source.h; y += 1) {
      for (let x = 0; x < source.w; x += 1) {
        const si = y * source.w + x;
        const a = source.alpha[si];
        if (a === 0) continue;
        // 索引越界时钳到最后一个色，避免整块变黑（与 composite 同一口径）
        const idx = source.indices[si] > last ? last : source.indices[si];
        const c = colors[idx];
        if (!c) continue;
        const o = ((offsetY + y) * layout.w + offsetX + x) * 4;
        blendPixel(data, o, c[0], c[1], c[2], a);
      }
    }
  }

  return new ImageData(data, layout.w, layout.h);
}
