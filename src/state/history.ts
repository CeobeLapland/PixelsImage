/**
 * 撤销栈 —— docs/DESIGN.md §5.2。
 *
 * 三个关键决定：
 *
 * 1. **一次操作 = 一次 onDown → onUp**。拖一笔只入栈一条记录，
 *    而不是每个 pointermove 一条（否则画一条长线要按 100 次 Ctrl+Z）。
 * 2. **只存被改动的格子**（稀疏的 CellEdit 列表），不存整张网格。
 *    32×32 全图也就 1KB，稀疏化是为了将来上大尺寸。
 * 3. **转换参数变更不入栈**。它改的是 baseGrid（可重算的底层），
 *    与手工编辑是两个维度的历史 —— 想回到上一套参数，调回去即可。
 *
 * 本模块是纯函数，不依赖 store 也不依赖 React，便于直接单测。
 */

import type { CellEdit } from '@/core/edit';

export interface HistoryEntry {
  /** 显示给用户的操作名，例如「铅笔」「清空编辑层」 */
  label: string;
  edits: CellEdit[];
}

/**
 * `cursor` = 下一次撤销要回退的那条记录的下标，
 * 因此 `entries.length - cursor` 就是可重做的步数。
 */
export interface HistoryState {
  entries: HistoryEntry[];
  cursor: number;
}

/** 环形容量：超过后丢最旧的 */
export const HISTORY_LIMIT = 100;

export function createHistory(): HistoryState {
  return { entries: [], cursor: 0 };
}

/** 入栈一次操作。若当前不在栈顶（撤销过几步），先截断重做分支 */
export function pushHistory(state: HistoryState, entry: HistoryEntry): HistoryState {
  const kept = state.entries.slice(0, state.cursor);
  kept.push(entry);

  const overflow = kept.length - HISTORY_LIMIT;
  if (overflow > 0) {
    return { entries: kept.slice(overflow), cursor: kept.length - overflow };
  }
  return { entries: kept, cursor: kept.length };
}

export interface StepResult {
  state: HistoryState;
  edits: readonly CellEdit[];
  label: string;
}

/** 撤销一步：返回需要写回 `before` 值的 edits；无可撤销时返回 null */
export function stepBack(state: HistoryState): StepResult | null {
  if (state.cursor <= 0) return null;
  const entry = state.entries[state.cursor - 1];
  if (!entry) return null;
  return { state: { ...state, cursor: state.cursor - 1 }, edits: entry.edits, label: entry.label };
}

/** 重做一步：返回需要写回 `after` 值的 edits；无可重做时返回 null */
export function stepForward(state: HistoryState): StepResult | null {
  const entry = state.entries[state.cursor];
  if (!entry) return null;
  return { state: { ...state, cursor: state.cursor + 1 }, edits: entry.edits, label: entry.label };
}

export function canUndo(state: HistoryState): boolean {
  return state.cursor > 0;
}

export function canRedo(state: HistoryState): boolean {
  return state.cursor < state.entries.length;
}

/** 可撤销的总步数（状态栏显示用） */
export function undoDepth(state: HistoryState): number {
  return state.cursor;
}