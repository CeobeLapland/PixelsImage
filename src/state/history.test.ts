import { describe, expect, it } from 'vitest';

import type { CellEdit } from '@/core/edit';
import {
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  createHistory,
  pushHistory,
  stepBack,
  stepForward,
  undoDepth,
  type HistoryState,
} from './history';

function edit(index: number, before: number | null, after: number | null): CellEdit {
  return {
    index,
    before: before === null ? null : { index: before, alpha: 255 },
    after: after === null ? null : { index: after, alpha: 255 },
  };
}

function push(state: HistoryState, label: string, index = 0): HistoryState {
  return pushHistory(state, { label, edits: [edit(index, 0, 1)] });
}

describe('pushHistory', () => {
  it('入栈后 cursor 指向栈顶', () => {
    let state = createHistory();
    state = push(state, '铅笔');
    expect(state.entries).toHaveLength(1);
    expect(state.cursor).toBe(1);
    expect(undoDepth(state)).toBe(1);
    expect(canUndo(state)).toBe(true);
    expect(canRedo(state)).toBe(false);
  });

  it('撤销过两步后再入栈会截断重做分支', () => {
    let state = createHistory();
    state = push(state, 'a');
    state = push(state, 'b');
    state = push(state, 'c');

    state = (stepBack(state) as { state: HistoryState }).state;
    state = (stepBack(state) as { state: HistoryState }).state;
    expect(state.cursor).toBe(1);
    expect(canRedo(state)).toBe(true);

    state = push(state, 'd');
    expect(state.entries.map((e) => e.label)).toEqual(['a', 'd']);
    expect(state.cursor).toBe(2);
    expect(canRedo(state)).toBe(false);
  });

  it('超过容量后丢最旧的，栈顶始终是最新一步', () => {
    let state = createHistory();
    for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) state = push(state, `op${i}`);

    expect(state.entries).toHaveLength(HISTORY_LIMIT);
    expect(state.entries[0]?.label).toBe('op5');
    expect(state.entries[state.entries.length - 1]?.label).toBe(`op${HISTORY_LIMIT + 4}`);
    expect(state.cursor).toBe(HISTORY_LIMIT);
  });
});

describe('stepBack / stepForward', () => {
  it('空栈时返回 null，不抛错', () => {
    expect(stepBack(createHistory())).toBeNull();
    expect(stepForward(createHistory())).toBeNull();
  });

  it('撤销给出 before 侧，重做给出 after 侧', () => {
    let state = push(createHistory(), '铅笔', 3);
    const back = stepBack(state);
    expect(back?.edits[0]?.before).toEqual({ index: 0, alpha: 255 });
    expect(back?.label).toBe('铅笔');
    state = back!.state;

    const forward = stepForward(state);
    expect(forward?.edits[0]?.after).toEqual({ index: 1, alpha: 255 });
    expect(forward?.state.cursor).toBe(1);
  });

  it('撤销到底后不能再撤，也不越界', () => {
    let state = push(createHistory(), 'a');
    state = (stepBack(state) as { state: HistoryState }).state;
    expect(state.cursor).toBe(0);
    expect(stepBack(state)).toBeNull();
    expect(canUndo(state)).toBe(false);
  });

  it('重做到顶后不能再重做', () => {
    let state = push(createHistory(), 'a');
    state = (stepBack(state) as { state: HistoryState }).state;
    state = (stepForward(state) as { state: HistoryState }).state;
    expect(stepForward(state)).toBeNull();
    expect(canRedo(state)).toBe(false);
  });

  it('反复撤销重做后位置一致', () => {
    let state = createHistory();
    state = push(state, 'a');
    state = push(state, 'b');

    for (let i = 0; i < 6; i += 1) {
      const back = stepBack(state);
      if (back) state = back.state;
      const forward = stepForward(state);
      if (forward) state = forward.state;
    }
    expect(state.cursor).toBe(2);
    expect(state.entries).toHaveLength(2);
  });
});