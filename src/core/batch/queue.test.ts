import { describe, expect, it } from 'vitest';

import { makeDefaultSettings } from '@/core/types';
import {
  createBatchItems,
  mergeSettings,
  nextPendingItem,
  patchItem,
  removeItem,
  resetResults,
  settingsFingerprint,
  summarize,
  type BatchItem,
} from './queue';

const files = (...names: string[]) => names.map((name) => new File([new Uint8Array(4)], name));

describe('createBatchItems', () => {
  it('每项都是 pending，且 id 互不相同', () => {
    const items = createBatchItems(files('a.png', 'b.png', 'c.png'));
    expect(items.map((i) => i.status)).toEqual(['pending', 'pending', 'pending']);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
  });

  it('记录文件名与大小', () => {
    const items = createBatchItems(files('hero.png'));
    expect(items[0].fileName).toBe('hero.png');
    expect(items[0].size).toBe(4);
  });
});

describe('patchItem / removeItem', () => {
  const items = createBatchItems(files('a.png', 'b.png'));

  it('按 id 打补丁，其余项保持不变', () => {
    const next = patchItem(items, items[1].id, { status: 'done' });
    expect(next[0].status).toBe('pending');
    expect(next[1].status).toBe('done');
    expect(next[0]).toBe(items[0]); // 未命中的项连引用都不换
  });

  it('id 不存在时原样返回', () => {
    expect(patchItem(items, 'nope', { status: 'done' })).toBe(items);
  });

  it('移除只影响目标项', () => {
    const next = removeItem(items, items[0].id);
    expect(next.map((i) => i.fileName)).toEqual(['b.png']);
  });
});

describe('resetResults', () => {
  it('把 done / error 退回 pending，并清掉结果与错误', () => {
    const base = createBatchItems(files('a.png', 'b.png'));
    const withResults: BatchItem[] = [
      { ...base[0], status: 'done', result: { grid: { w: 1, h: 1, indices: new Uint8Array(1), alpha: new Uint8Array(1) }, palette: { id: 'p', name: 'p', colors: [] }, targetW: 1, targetH: 1, usedColors: 1, trimmed: false, ms: 1 } },
      { ...base[1], status: 'error', error: '解码失败' },
    ];

    const next = resetResults(withResults);
    expect(next.map((i) => i.status)).toEqual(['pending', 'pending']);
    expect(next[0].result).toBeUndefined();
    expect(next[1].error).toBeUndefined();
  });

  it('已经是 pending 的项连引用都不换（避免无谓的重渲染）', () => {
    const items = createBatchItems(files('a.png'));
    expect(resetResults(items)[0]).toBe(items[0]);
  });
});

describe('summarize / nextPendingItem', () => {
  const base = createBatchItems(files('a.png', 'b.png', 'c.png', 'd.png'));
  const items: BatchItem[] = [
    { ...base[0], status: 'done' },
    { ...base[1], status: 'error' },
    { ...base[2], status: 'converting' },
    { ...base[3], status: 'pending' },
  ];

  it('按状态计数', () => {
    expect(summarize(items)).toEqual({ total: 4, pending: 1, converting: 1, done: 1, error: 1 });
  });

  it('空队列计数全为 0', () => {
    expect(summarize([])).toEqual({ total: 0, pending: 0, converting: 0, done: 0, error: 0 });
  });

  it('取第一个 pending —— error 项不会被自动重试', () => {
    expect(nextPendingItem(items)?.id).toBe(base[3].id);
  });

  it('没有 pending 时返回 null', () => {
    expect(nextPendingItem([{ ...base[0], status: 'done' }])).toBeNull();
  });
});

describe('mergeSettings', () => {
  const base = makeDefaultSettings();

  it('没有覆盖时直接返回原对象（省一次拷贝）', () => {
    expect(mergeSettings(base)).toBe(base);
  });

  it('覆盖顶层字段', () => {
    const merged = mergeSettings(base, { targetW: 128 });
    expect(merged.targetW).toBe(128);
    expect(merged.sampling).toBe(base.sampling);
  });

  it('preprocess 是深合并 —— 只改一项不能把其余开关抹掉', () => {
    const merged = mergeSettings(base, { preprocess: { brightness: 20 } as never });
    expect(merged.preprocess.brightness).toBe(20);
    expect(merged.preprocess.alphaThreshold).toBe(base.preprocess.alphaThreshold);
    expect(merged.preprocess.sharpen).toBe(base.preprocess.sharpen);
  });

  it('不修改传入的对象', () => {
    const before = JSON.stringify(base);
    mergeSettings(base, { targetW: 8, preprocess: { contrast: 5 } as never });
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe('settingsFingerprint', () => {
  it('参数相同则指纹相同，改一处则不同', () => {
    const a = makeDefaultSettings();
    const b = makeDefaultSettings();
    expect(settingsFingerprint(a)).toBe(settingsFingerprint(b));
    expect(settingsFingerprint({ ...a, targetW: a.targetW + 1 })).not.toBe(settingsFingerprint(a));
  });

  it('preprocess 的变化也能被识别', () => {
    const a = makeDefaultSettings();
    const b = mergeSettings(a, { preprocess: { sharpen: 30 } as never });
    expect(settingsFingerprint(b)).not.toBe(settingsFingerprint(a));
  });
});
