/**
 * 自动描边 —— docs/ROADMAP.md M4。
 *
 * 纯计算：只返回「该写哪些格」，不碰输入、也不碰编辑层，由调用方一次性落库。
 * 这样撤销栈那边只需一次 applyEditWrites，画布预览也能直接拿返回值来画。
 *
 * 两个必须说清的口径：
 * 1. **透明由 alpha 独立表达**（见 types.ts），不是某个特殊索引，
 *    所以「非透明」一律判 readCell(...).alpha > 0。
 * 2. **值没变的格子要丢掉**：连点两次「描边」不该看到「改了 N 格」却什么都没变，
 *    更不该往撤销栈里塞一条空操作。
 */

import { readCell, type CellWrite } from '@/core/edit';
import type { EditLayer, PixelGrid } from '@/core/types';

export type OutlineMode = 'outside' | 'inside' | 'both';

export interface OutlineOptions {
  /** 轮廓颜色（调色板索引） */
  color: number;
  /** 是否含对角：true = 8 邻域（更粗、转角不断），false = 4 邻域（更细） */
  diagonal: boolean;
  /** outside = 只描外缘（默认，最常用）；inside = 只描内缘；both = 两侧都描 */
  mode?: OutlineMode;
  /** 轮廓的 alpha，默认 255 */
  alpha?: number;
  /** 只描绘制区域内的格子（默认 true），false 时允许写到网格外——一般用不到 */
  clipToGrid?: boolean;
}

/** 4 邻域：上下左右 */
const NEIGHBORS_4: ReadonlyArray<readonly [number, number]> = [
  [-1, 0],
  [1, 0],
  [0, -1],
  [0, 1],
];

/** 8 邻域：在 4 邻域基础上补四个对角 */
const NEIGHBORS_8: ReadonlyArray<readonly [number, number]> = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/**
 * 计算描边要写入的格子（不改动任何输入）。
 *
 * 关于 `clipToGrid`：CellWrite 只有 `index` 一个字段，表达不了「网格外的一格」，
 * 所以无论这个开关怎么设，产出都会被限制在 `0 .. w*h-1` 内 —— 传 false 目前与 true
 * 等价，保留该参数只为接口稳定，等以后真有「超界画布」时再扩展。
 */
export function planOutline(
  base: PixelGrid,
  edit: EditLayer | null,
  opts: OutlineOptions,
): CellWrite[] {
  const { w, h } = base;
  const n = w * h;
  const mode = opts.mode ?? 'outside';
  const color = Math.max(0, Math.round(opts.color));
  const alpha = opts.alpha ?? 255;
  const deltas = opts.diagonal ? NEIGHBORS_8 : NEIGHBORS_4;
  const wantOutside = mode === 'outside' || mode === 'both';
  const wantInside = mode === 'inside' || mode === 'both';

  // 邻居判定会反复读同一格，而 readCell 每次都要先判一次编辑层尺寸是否对齐，
  // 没必要逐格重复调用 —— 先把「是否非透明」缓存成一张表。
  const solid = new Uint8Array(n);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      solid[y * w + x] = readCell(base, edit, x, y).alpha > 0 ? 1 : 0;
    }
  }

  const writes: CellWrite[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      const isSolid = solid[i] === 1;

      let touchesSolid = false;
      let touchesEmpty = false;
      for (const [dx, dy] of deltas) {
        const nx = x + dx;
        const ny = y + dy;
        // 网格外不参与判定：它既不算「非透明」，也不算「空白」。
        // 否则整张图填满时会被内缘描一圈边框，而画布外本来也没有格可写。
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        if (solid[ny * w + nx] === 1) touchesSolid = true;
        else touchesEmpty = true;
        if (touchesSolid && touchesEmpty) break;
      }

      // inside 优先：透明与否互斥，两者本不会同时命中，这里只是把优先级写死
      const isInside = wantInside && isSolid && touchesEmpty;
      const isOutside = wantOutside && !isSolid && touchesSolid;
      if (!isInside && !isOutside) continue;

      // 值已经等于轮廓色就跳过 —— 这正是「连点两次」不产生空写入的原因
      const cur = readCell(base, edit, x, y);
      if (cur.index === color && cur.alpha === alpha) continue;

      writes.push({ index: i, cell: { index: color, alpha } });
    }
  }

  return writes;
}