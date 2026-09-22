/**
 * 编辑层（EditLayer）的低层操作 —— docs/DESIGN.md §3.4 / §5.2。
 *
 * 这些函数是「手工修改」这件事的唯一入口：工具、撤销栈、选区搬运
 * 都通过它们读写单元格，避免每处各写一遍索引计算。
 *
 * 两条约定贯穿本文件：
 * 1. **就地修改**。编辑层是热路径（每次 pointermove），不做拷贝。
 * 2. **改动前先记账**。写值前把该格的旧值记进 `Changes`，这是撤销栈的数据来源；
 *    同一格在一次操作里只记第一次，否则「先画后擦」会把中间态当成原值。
 */

import {
  TRANSPARENT_CELL,
  createEditLayer,
  type EditLayer,
  type PixelCell,
  type PixelGrid,
  type Rect,
} from './types';

/**
 * 一次操作（一次落笔 → 收笔）内的改动集合：
 * `格下标 → 改动前的值`（null = 该格原本没有手工覆盖）。
 * 用 Map 而不是数组：同一格被反复涂改时天然去重。
 */
export type Changes = Map<number, PixelCell | null>;

/** 一条可撤销的单元格改动（撤销用 before，重做用 after） */
export interface CellEdit {
  index: number;
  before: PixelCell | null;
  after: PixelCell | null;
}

/**
 * 读取某格当前生效的值：编辑层优先，其次底层，都没有则为全透明。
 *
 * 编辑层与底层尺寸不一致时（尺寸刚改、编辑层还没重采样的瞬间）忽略编辑层：
 * 两者的下标映射不同，硬读会取到完全不相干的一格。
 */
export function readCell(
  base: PixelGrid | null,
  edit: EditLayer | null,
  x: number,
  y: number,
): PixelCell {
  const layer = edit && (!base || (edit.w === base.w && edit.h === base.h)) ? edit : null;

  if (layer && x >= 0 && y >= 0 && x < layer.w && y < layer.h) {
    const cell = layer.cells[y * layer.w + x];
    if (cell) return { index: cell.index, alpha: cell.alpha };
  }
  if (base && x >= 0 && y >= 0 && x < base.w && y < base.h) {
    const i = y * base.w + x;
    return { index: base.indices[i], alpha: base.alpha[i] };
  }
  return { index: 0, alpha: 0 };
}

/**
 * 写入一格，并把改动前的值记进 changes。
 * `cell === null` 表示撤销这次覆盖（该格重新走底层）。
 */
export function writeCell(
  layer: EditLayer,
  i: number,
  cell: PixelCell | null,
  changes: Changes,
): void {
  if (i < 0 || i >= layer.cells.length) return;
  if (!changes.has(i)) changes.set(i, layer.cells[i] ?? null);
  // 复制一份：调用方常复用同一个对象（例如 TRANSPARENT_CELL）
  layer.cells[i] = cell === null ? null : { index: cell.index, alpha: cell.alpha };
}

/** 手工覆盖过的格子数（面板上的「手改 N 格」） */
export function countEdits(layer: EditLayer | null): number {
  if (!layer) return 0;
  let n = 0;
  for (const cell of layer.cells) if (cell) n += 1;
  return n;
}

/**
 * 合成后的每格「索引 + alpha」打包成一个整数（`index << 8 | alpha`），
 * 供洪水填充做连通判定。打包成一个数是为了比较便宜：
 * 逐格比两次字段也能用，但这里要给整张图建表，单值比较更省。
 */
export function compositeKeys(base: PixelGrid, edit: EditLayer | null): Uint32Array {
  const n = base.w * base.h;
  const out = new Uint32Array(n);
  const aligned = edit !== null && edit.w === base.w && edit.h === base.h;
  for (let i = 0; i < n; i += 1) {
    const cell = aligned ? (edit as EditLayer).cells[i] : null;
    const index = cell ? cell.index : base.indices[i];
    const alpha = cell ? cell.alpha : base.alpha[i];
    out[i] = (index << 8) | alpha;
  }
  return out;
}

/** 深拷贝一份编辑层（用于「基准层」快照与尺寸变更重采样） */
export function cloneEditLayer(layer: EditLayer): EditLayer {
  return {
    w: layer.w,
    h: layer.h,
    cells: layer.cells.map((c) => (c ? { index: c.index, alpha: c.alpha } : null)),
  };
}

/**
 * 把 changes 结算成撤销栈用的 CellEdit 列表。
 * 只改回原值的格子（画了又擦回去）会被丢掉 —— 否则撤销栈里会堆一批
 * 「撤销一次什么都看不出来」的空操作。
 */
export function changesToEdits(changes: Changes, layer: EditLayer): CellEdit[] {
  const edits: CellEdit[] = [];
  for (const [index, before] of changes) {
    const after = layer.cells[index] ?? null;
    if (sameCell(before, after)) continue;
    edits.push({ index, before, after });
  }
  return edits;
}

function sameCell(a: PixelCell | null, b: PixelCell | null): boolean {
  if (a === null || b === null) return a === b;
  return a.index === b.index && a.alpha === b.alpha;
}

/**
 * 撤销/重做：把 edits 的某一侧写回编辑层。
 * `side='before'` 用于撤销，`'after'` 用于重做。
 */
export function applyCellEdits(layer: EditLayer, edits: readonly CellEdit[], side: 'before' | 'after'): void {
  for (const edit of edits) {
    if (edit.index < 0 || edit.index >= layer.cells.length) continue;
    const cell = side === 'before' ? edit.before : edit.after;
    layer.cells[edit.index] = cell ? { index: cell.index, alpha: cell.alpha } : null;
  }
}

/**
 * 尺寸变更时把编辑层重采样到新的网格尺寸。
 *
 * 用最近邻（格中心映射）而非区域平均：手改的每一格都是一个明确意图，
 * 平均会把它稀释成一个中间色，那不是用户画的东西。
 *
 * 注意本函数是**无损往返的前提**：调用方必须始终从「原始尺寸的那一份」
 * 重采样，而不是在已经重采样的结果上再采一次（拖动目标格数滑块会连采十几次，
 * 逐次抹平手改）。see store 中的 editOrigin。
 */
export function resampleEditLayer(layer: EditLayer, w: number, h: number): EditLayer {
  const nw = Math.max(1, Math.round(w));
  const nh = Math.max(1, Math.round(h));
  if (layer.w === nw && layer.h === nh) return cloneEditLayer(layer);

  const out = createEditLayer(nw, nh);
  for (let y = 0; y < layer.h; y += 1) {
    for (let x = 0; x < layer.w; x += 1) {
      const cell = layer.cells[y * layer.w + x];
      if (!cell) continue;
      const nx = Math.min(nw - 1, Math.floor(((x + 0.5) * nw) / layer.w));
      const ny = Math.min(nh - 1, Math.floor(((y + 0.5) * nh) / layer.h));
      out.cells[ny * nw + nx] = { index: cell.index, alpha: cell.alpha };
    }
  }
  return out;
}

/**
 * 选区搬运（选区移动工具）：把 rect 内的内容整体搬到偏移 (dx, dy) 处。
 *
 * 语义是「剪切-粘贴」：
 * - 源区一律写成透明（否则搬走以后底层颜色会在原位露出来）；
 * - 目标区写入搬运**当时**读到的合成值（含底层色），所以搬运不会丢失没有手改过的格子。
 *
 * 必须先把源区快照下来再写，否则源与目标重叠时会把刚写进去的值当成源值。
 */
export function moveRegion(
  base: PixelGrid | null,
  layer: EditLayer,
  changes: Changes,
  rect: Rect,
  dx: number,
  dy: number,
): void {
  const { w, h } = layer;
  interface Move {
    from: number;
    to: number;
    cell: PixelCell;
  }
  const moves: Move[] = [];

  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      moves.push({ from: y * w + x, to: ny * w + nx, cell: readCell(base, layer, x, y) });
    }
  }

  for (const m of moves) writeCell(layer, m.from, TRANSPARENT_CELL, changes);
  for (const m of moves) writeCell(layer, m.to, m.cell, changes);
}