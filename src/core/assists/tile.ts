/**
 * 平铺接缝检查。
 *
 * 用途：给「要做成可无缝平铺的贴图」这个场景把关。把网格左右、上下对折比一遍，
 * 边界上颜色对不上就说明平铺时会出现一条可见的缝。
 *
 * 判定用「索引 + alpha 完全相同」，与洪水填充的口径一致：调色板是离散的，
 * 索引相同必然同色。注意半透明边缘对不齐同样算缝 —— 贴图软件里那种
 * 「颜色一样但一边更透」也是能看出来的。
 */

import { readCell } from '../edit';
import type { EditLayer, PixelGrid } from '../types';

export interface SeamReport {
  /**
   * 左右接缝上对不上的一对格下标（左列与右列，交替出现）。
   * 保留成对信息是为了能在画布上把「哪两格对不上」直接标出来。
   */
  horizontal: number[];
  /** 上下接缝上对不上的格下标（上边与下边，交替出现） */
  vertical: number[];
  /** 对不上的格数（成对计数，一对算一处） */
  mismatches: number;
  /** 参与比对的格数（左右 h 对 + 上下 w 对），用于给匹配率 */
  total: number;
}

/**
 * 检查左右/上下边界的匹配情况。
 * 宽或高为 1 时那一侧的接缝自己对自己，恒等匹配（平铺一列/一行没有接缝可言）。
 */
export function checkSeams(base: PixelGrid, edit: EditLayer | null): SeamReport {
  const { w, h } = base;
  const horizontal: number[] = [];
  const vertical: number[] = [];

  for (let y = 0; y < h; y += 1) {
    const left = readCell(base, edit, 0, y);
    const right = readCell(base, edit, w - 1, y);
    if (left.index !== right.index || left.alpha !== right.alpha) {
      horizontal.push(y * w, y * w + (w - 1));
    }
  }

  for (let x = 0; x < w; x += 1) {
    const top = readCell(base, edit, x, 0);
    const bottom = readCell(base, edit, x, h - 1);
    if (top.index !== bottom.index || top.alpha !== bottom.alpha) {
      vertical.push(x, (h - 1) * w + x);
    }
  }

  return {
    horizontal,
    vertical,
    mismatches: horizontal.length / 2 + vertical.length / 2,
    total: h + w,
  };
}