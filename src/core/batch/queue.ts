/**
 * 批量队列的数据模型与纯状态迁移（M5）。
 *
 * 队列本身是「一堆待处理的文件 + 每项的状态」，转换循环写在 state 层，
 * 这里只放**纯函数**：进队、改状态、移除、汇总、参数合并。
 * 这样状态机可以被单测直接锁死 —— 批量处理最容易出的错是
 * 「某项卡在 converting 永远不动」「导出时把 error 项也算进去」这类静默问题。
 */

import type { ConvertSettings, Palette, PixelGrid } from '../types';

export type BatchStatus = 'pending' | 'converting' | 'done' | 'error';

/** 一项转换成功后留下的东西：渲染缩略图、导出 PNG、算名字都要用 */
export interface BatchResult {
  grid: PixelGrid;
  /** 产出这份网格时实际使用的调色板（k-means 限色下会与全局板不同） */
  palette: Palette;
  targetW: number;
  targetH: number;
  usedColors: number;
  trimmed: boolean;
  ms: number;
}

export interface BatchItem {
  id: string;
  file: File;
  /** 原始文件名，命名模板里的 `{name}` 用它 */
  fileName: string;
  /** 文件字节数，列表里显示用 */
  size: number;
  status: BatchStatus;
  result?: BatchResult;
  error?: string;
  /** 逐项参数覆盖：与全局 settings 合并后使用 */
  override?: Partial<ConvertSettings>;
  /** 列表缩略图（转换前的原图），移除时记得 close */
  thumb?: ImageBitmap;
}

export interface BatchSummary {
  total: number;
  pending: number;
  converting: number;
  done: number;
  error: number;
}

let itemSeq = 0;

function nextItemId(): string {
  itemSeq += 1;
  return `batch-${Date.now().toString(36)}-${itemSeq}`;
}

export function createBatchItem(file: File): BatchItem {
  return {
    id: nextItemId(),
    file,
    fileName: file.name || '未命名',
    size: file.size,
    status: 'pending',
  };
}

export function createBatchItems(files: readonly File[]): BatchItem[] {
  return files.map(createBatchItem);
}

/** 按 id 打补丁；id 不存在时原样返回，避免调用方还要先查一次 */
export function patchItem(
  items: readonly BatchItem[],
  id: string,
  patch: Partial<BatchItem>,
): BatchItem[] {
  let hit = false;
  const out = items.map((item) => {
    if (item.id !== id) return item;
    hit = true;
    return { ...item, ...patch };
  });
  return hit ? out : (items as BatchItem[]);
}

export function removeItem(items: readonly BatchItem[], id: string): BatchItem[] {
  return items.filter((item) => item.id !== id);
}

/** 把所有已完成/出错的项退回待处理，用于「参数改了，重跑一遍」 */
export function resetResults(items: readonly BatchItem[]): BatchItem[] {
  return items.map((item) =>
    item.status === 'pending'
      ? item
      : { ...item, status: 'pending' as const, result: undefined, error: undefined },
  );
}

/** 下一个待转换的项；都处理完了返回 null */
export function nextPendingItem(items: readonly BatchItem[]): BatchItem | null {
  return items.find((item) => item.status === 'pending') ?? null;
}

export function summarize(items: readonly BatchItem[]): BatchSummary {
  const out: BatchSummary = { total: items.length, pending: 0, converting: 0, done: 0, error: 0 };
  for (const item of items) out[item.status] += 1;
  return out;
}

/**
 * 全局参数 + 逐项覆盖 → 该项实际使用的参数。
 *
 * preprocess 要单独深合并：它是嵌套对象，浅合并会让覆盖项把
 * 另外几个预处理开关一起抹成 undefined。
 */
export function mergeSettings(
  base: ConvertSettings,
  override?: Partial<ConvertSettings>,
): ConvertSettings {
  if (!override) return base;
  return {
    ...base,
    ...override,
    preprocess: { ...base.preprocess, ...(override.preprocess ?? {}) },
  };
}

/**
 * 参数指纹：用来判断「队列里的结果是不是拿当前参数跑的」。
 * 用户改了参数却没重跑就直接导出，是这个功能里最容易踩的坑，
 * 面板据此提示一句「参数已变更，建议重跑」。
 */
export function settingsFingerprint(settings: ConvertSettings): string {
  return JSON.stringify(settings);
}
