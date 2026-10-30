/**
 * 局部换板 / 局部量化（M9）。
 *
 * 「转换」面板的参数是**全图**的：改一次抖动或换一块调色板，整张图都会重算。
 * 但实际做素材时常需要「主体用写实板、背景用灰阶板」—— 两个区域用两套色板。
 *
 * 关键约束：网格里每格只存**调色板索引**，没有独立 RGB。
 * 所以「选区换板」不能只把索引换成另一块板的颜色 —— 那样整张图都会变。
 * 正确做法是**把目标板实际用到的颜色并进当前板**（追加在末尾，复用已有的同色），
 * 再把选区格子改指向这些新槽位。已有格子的索引一个都不动，所以其余区域保持原样。
 *
 * 抖动在**选区自己的坐标系**里做：误差扩散不会跨出选区，
 * 所以选区边缘的过渡会比「全图一起抖动」略硬 —— 局部操作的固有代价。
 */

import { quantizeInto } from './quantize';
import type { CellWrite } from '../edit';
import type { DistanceMode, DitherMode, Palette, PixelGrid, Rect, RGBA } from '../types';
import { PALETTE_MAX_COLORS } from '../types';

export interface LocalRequantizeRequest {
  palette: Palette;
  distance: DistanceMode;
  dither: DitherMode;
  /** 0-1 */
  ditherStrength: number;
}

export interface RequantizeOptions extends LocalRequantizeRequest {
  /** 网格坐标；超出网格的部分会被裁掉 */
  region: Rect;
}

export interface LocalRequantizeResult {
  /** 需要追加到当前调色板末尾的颜色（与已有色相同的不在其中） */
  addedColors: RGBA[];
  /** 写入编辑层的格子；索引已经换算成「追加后」的最终索引 */
  writes: CellWrite[];
  /** 选区里实际用到几种目标色 */
  usedColors: number;
}

/** 与网格求交；完全在网格外时返回 0 尺寸 */
export function clampRegion(region: Rect, w: number, h: number): Rect {
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(w, Math.floor(region.x + region.w));
  const y1 = Math.min(h, Math.floor(region.y + region.h));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}

/** 颜色身份：调色板索引不能跨板比较，只能按 RGB 认 */
function colorKey(color: RGBA): string {
  return `${color[0]},${color[1]},${color[2]}`;
}

/**
 * 「选区内要改成什么、当前板要追加哪些颜色」。
 *
 * `grid` 传的是**合成结果**（含已有的手工修改）：局部操作应当基于你眼前看到的颜色，
 * 而不是底层那次转换的原始结果。
 */
export function planLocalRequantize(
  grid: PixelGrid,
  currentPalette: Palette,
  options: RequantizeOptions,
): LocalRequantizeResult {
  const region = clampRegion(options.region, grid.w, grid.h);
  const empty: LocalRequantizeResult = { addedColors: [], writes: [], usedColors: 0 };
  if (region.w <= 0 || region.h <= 0) return empty;
  if (options.palette.colors.length === 0) return empty;
  if (currentPalette.colors.length === 0) return empty;

  const w = region.w;
  const h = region.h;

  /* 1. 把选区渲染成一小块 RGBA，供量化复用（抖动需要浮点误差缓冲） */
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const src = (region.y + y) * grid.w + (region.x + x);
      const o = (y * w + x) * 4;
      const alpha = grid.alpha[src] as number;
      if (alpha === 0) continue; // 透明格保持 0，量化也会跳过它
      const index = Math.min(grid.indices[src] as number, currentPalette.colors.length - 1);
      const color = currentPalette.colors[index] as RGBA;
      data[o] = color[0];
      data[o + 1] = color[1];
      data[o + 2] = color[2];
      data[o + 3] = alpha;
    }
  }

  /* 2. 量化（含抖动）。与整图转换走同一个函数，行为不会漂 */
  const target = {
    indices: new Uint8Array(w * h),
    alpha: new Uint8Array(w * h),
  };
  quantizeInto(
    { width: w, height: h, data },
    {
      palette: options.palette.colors,
      distance: options.distance,
      dither: options.dither,
      ditherStrength: options.ditherStrength,
    },
    target,
  );

  /* 3. 选区内用到了哪些目标色（透明格不算） */
  const used = new Uint8Array(options.palette.colors.length);
  let usedColors = 0;
  for (let i = 0; i < w * h; i += 1) {
    if ((target.alpha[i] as number) === 0) continue;
    const index = target.indices[i] as number;
    if (used[index] === 0) {
      used[index] = 1;
      usedColors += 1;
    }
  }
  if (usedColors === 0) return empty;

  /* 4. 目标色 → 当前板索引：已有同色就复用，否则排队追加 */
  const existing = new Map<string, number>();
  currentPalette.colors.forEach((color, index) => {
    const key = colorKey(color);
    if (!existing.has(key)) existing.set(key, index);
  });

  const addedColors: RGBA[] = [];
  const addedIndex = new Map<string, number>();
  const targetToFinal = new Int32Array(options.palette.colors.length).fill(-1);

  for (let t = 0; t < options.palette.colors.length; t += 1) {
    if (used[t] === 0) continue;
    const color = options.palette.colors[t] as RGBA;
    const key = colorKey(color);

    let final = existing.get(key);
    if (final === undefined) {
      final = addedIndex.get(key);
      if (final === undefined) {
        final = currentPalette.colors.length + addedColors.length;
        addedColors.push([color[0], color[1], color[2], 255]);
        addedIndex.set(key, final);
      }
    }
    targetToFinal[t] = final;
  }

  if (currentPalette.colors.length + addedColors.length > PALETTE_MAX_COLORS) {
    throw new Error(
      `当前调色板 ${currentPalette.colors.length} 色，选区还需要 ${addedColors.length} 个新色，` +
        `超过 ${PALETTE_MAX_COLORS} 色上限。换一块更接近当前板的调色板，或先合并近似色`,
    );
  }

  /* 5. 只收集真正改变了的格子 */
  const writes: CellWrite[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const src = (region.y + y) * grid.w + (region.x + x);
      const i = y * w + x;
      const alpha = grid.alpha[src] as number;
      if (alpha === 0) continue;

      const next = targetToFinal[target.indices[i] as number] as number;
      /*
       * 不能直接比索引号：换板之后「0 号色」在两块板里通常是完全不同的颜色。
       * 只有两边**颜色一样**才算「没有变化」—— 这时写进去只会白记一条手改。
       */
      const oldIndex = Math.min(grid.indices[src] as number, currentPalette.colors.length - 1);
      const oldColor = currentPalette.colors[oldIndex] as RGBA;
      const newColor = next < currentPalette.colors.length
        ? (currentPalette.colors[next] as RGBA)
        : addedColors[next - currentPalette.colors.length] as RGBA;
      if (oldColor[0] === newColor[0] && oldColor[1] === newColor[1] && oldColor[2] === newColor[2]) {
        continue;
      }

      writes.push({ index: src, cell: { index: next, alpha } });
    }
  }

  return { addedColors, writes, usedColors };
}
