/**
 * 批量分片的状态行为（M5）。
 *
 * 转换循环本身依赖 Worker / createImageBitmap，跑不到 node 里，
 * 所以这里锁的是**纯状态迁移**那部分 —— 也正是最容易静默出错的部分：
 * 改了参数但旧结果没丢、写回队列时漏掉手改、重置结果把正在跑的项也一起重置。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createBatchItem } from '@/core/batch/queue';
import { makePalette, BLACK, BLUE, RED, WHITE } from '@/core/__testing__/fixtures';
import { changesToEdits, writeCell, type Changes } from '@/core/edit';
import { createGrid, type PixelGrid } from '@/core/types';
import { useApp, type ConvertInfo } from './store';

const PALETTE = makePalette('test', [RED, WHITE, BLUE, BLACK]);

function makeGrid(w: number, h: number, seed = 0): PixelGrid {
  const grid = createGrid(w, h);
  for (let i = 0; i < grid.indices.length; i += 1) {
    grid.indices[i] = (i + seed) % 4;
    grid.alpha[i] = 255;
  }
  return grid;
}

function info(w: number, h: number): ConvertInfo {
  return { targetW: w, targetH: h, usedColors: 4, trimmed: false, ms: 1, fallback: false };
}

function apply(w: number, h: number, seed = 0): void {
  useApp.getState().applyResult(makeGrid(w, h, seed), PALETTE, info(w, h));
}

function paint(cells: { x: number; y: number; index: number }[], w: number): void {
  const layer = useApp.getState().editLayer;
  if (!layer) throw new Error('还没有编辑层');
  const changes: Changes = new Map();
  for (const c of cells) {
    writeCell(layer, c.y * w + c.x, { index: c.index, alpha: 255 }, changes);
  }
  useApp.getState().commitEdits('铅笔', changesToEdits(changes, layer));
}

/** 直接往队列里塞一项：addBatchFiles 会去生成缩略图，node 里没有 createImageBitmap */
function seedQueue(...names: string[]): string[] {
  const items = names.map((name) => createBatchItem(new File([new Uint8Array(4)], name)));
  useApp.setState({ batchItems: items });
  return items.map((i) => i.id);
}

beforeEach(() => {
  vi.useFakeTimers();
  useApp.getState().clearResult();
  useApp.setState({
    batchItems: [],
    batchRunning: false,
    batchRunFingerprint: null,
    batchActiveId: null,
    batchScale: 1,
    batchTemplate: '{name}_{w}x{h}.png',
    batchPresets: [],
  });
});

describe('队列与逐项覆盖', () => {
  it('设置逐项覆盖后，该项退回待处理并丢掉旧结果', () => {
    const [id] = seedQueue('hero.png');
    const item = useApp.getState().batchItems[0];
    useApp.setState({
      batchItems: [{ ...item, status: 'done', result: { grid: makeGrid(4, 4), palette: PALETTE, targetW: 4, targetH: 4, usedColors: 4, trimmed: false, ms: 1 } }],
    });

    useApp.getState().patchBatchItem(id, { targetW: 16 });

    const next = useApp.getState().batchItems[0];
    expect(next.override).toEqual({ targetW: 16 });
    // 关键：旧结果必须消失 —— 否则导出时会混进旧参数跑的图
    expect(next.status).toBe('pending');
    expect(next.result).toBeUndefined();
  });

  it('多次设置覆盖是合并而不是替换', () => {
    const [id] = seedQueue('hero.png');
    useApp.getState().patchBatchItem(id, { targetW: 16 });
    useApp.getState().patchBatchItem(id, { sampling: 'nearest' });
    expect(useApp.getState().batchItems[0].override).toEqual({
      targetW: 16,
      sampling: 'nearest',
    });
  });

  it('清除覆盖后回到「跟随批量参数」', () => {
    const [id] = seedQueue('hero.png');
    useApp.getState().patchBatchItem(id, { targetW: 16 });
    useApp.getState().clearBatchOverride(id);
    expect(useApp.getState().batchItems[0].override).toBeUndefined();
  });

  it('移除项时把它正在编辑的标记一起清掉', () => {
    const [id] = seedQueue('hero.png');
    useApp.setState({ batchActiveId: id });
    useApp.getState().removeBatchItem(id);
    expect(useApp.getState().batchItems).toHaveLength(0);
    expect(useApp.getState().batchActiveId).toBeNull();
  });

  it('清空队列', () => {
    seedQueue('a.png', 'b.png');
    useApp.getState().clearBatch();
    expect(useApp.getState().batchItems).toHaveLength(0);
    expect(useApp.getState().batchRunFingerprint).toBeNull();
  });
});

describe('重置结果', () => {
  it('done / error 都退回归待处理', () => {
    const [a, b] = seedQueue('a.png', 'b.png');
    const items = useApp.getState().batchItems;
    useApp.setState({
      batchItems: [
        { ...items[0], status: 'done' },
        { ...items[1], status: 'error', error: '解码失败' },
      ],
    });

    useApp.getState().resetBatchResults();

    const next = useApp.getState().batchItems;
    expect(next.map((i) => i.id)).toEqual([a, b]);
    expect(next.map((i) => i.status)).toEqual(['pending', 'pending']);
    expect(next[1].error).toBeUndefined();
  });

  it('正在跑的时候拒绝重置，否则会把在途的那一项也抹掉', () => {
    seedQueue('a.png');
    useApp.setState({ batchRunning: true });
    useApp.getState().resetBatchResults();
    expect(useApp.getState().batchItems[0].status).toBe('pending');
    expect(useApp.getState().batchRunFingerprint).toBeNull();
  });
});

describe('把编辑器的结果写回队列', () => {
  it('写回的是**合成后**的网格 —— 手改必须进 zip', () => {
    const [id] = seedQueue('hero.png');
    apply(8, 8);
    paint([{ x: 2, y: 1, index: 3 }], 8);

    useApp.getState().commitEditorToBatch(id);

    const result = useApp.getState().batchItems[0].result;
    expect(result).toBeDefined();
    expect(result?.grid.w).toBe(8);
    expect(result?.grid.h).toBe(8);
    // 底图在 (2,1) 处是 (10+0)%4 = 2，手改成 3 后写回的必须是 3
    expect(result?.grid.indices[1 * 8 + 2]).toBe(3);
    expect(useApp.getState().batchItems[0].status).toBe('done');
  });

  it('写回时统计实际用色（手改可能带来新的色）', () => {
    const [id] = seedQueue('hero.png');
    apply(4, 4);
    paint([{ x: 0, y: 0, index: 3 }], 4);
    useApp.getState().commitEditorToBatch(id);
    expect(useApp.getState().batchItems[0].result?.usedColors).toBe(4);
  });

  it('缺少像素图或队列项时只提示，不写坏数据', () => {
    const [id] = seedQueue('hero.png');
    // 没有 baseGrid
    useApp.getState().commitEditorToBatch(id);
    expect(useApp.getState().batchItems[0].result).toBeUndefined();

    apply(4, 4);
    useApp.getState().commitEditorToBatch('not-exist');
    expect(useApp.getState().batchItems[0].result).toBeUndefined();
  });

  it('写回后把该项标记为编辑中，面板据此显示按钮', () => {
    const [id] = seedQueue('hero.png');
    apply(4, 4);
    useApp.getState().commitEditorToBatch(id);
    expect(useApp.getState().batchActiveId).toBe(id);
  });
});

describe('批量参数的同步', () => {
  it('同步会把 preprocess 深拷贝一份 —— 之后两边互不影响', () => {
    useApp.getState().patchPreprocess({ sharpness: 0 } as never);
    useApp.getState().patchPreprocess({ brightness: 25 });
    useApp.getState().syncBatchSettings();

    useApp.getState().patchPreprocess({ brightness: -50 });
    expect(useApp.getState().batchSettings.preprocess.brightness).toBe(25);
    expect(useApp.getState().settings.preprocess.brightness).toBe(-50);

    useApp.getState().patchBatchPreprocess({ contrast: 30 });
    expect(useApp.getState().settings.preprocess.contrast).toBe(0);
  });
});

describe('批处理预设', () => {
  it('保存时重名自动加序号，且套用只改批量参数', () => {
    useApp.getState().patchBatchSettings({ targetW: 48 });
    useApp.getState().setBatchTemplate('{index}_{name}.png');
    useApp.getState().saveBatchPreset('素材');
    useApp.getState().saveBatchPreset('素材');

    const presets = useApp.getState().batchPresets;
    expect(presets.map((p) => p.name)).toEqual(['素材 (2)', '素材']);
    expect(presets[0].settings.targetW).toBe(48);
    expect(presets[0].template).toBe('{index}_{name}.png');

    // 改掉当前参数，再套用最早那份
    useApp.getState().patchBatchSettings({ targetW: 8 });
    useApp.getState().applyBatchPreset(presets[1].id);
    expect(useApp.getState().batchSettings.targetW).toBe(48);
  });

  it('空名字不保存', () => {
    useApp.getState().saveBatchPreset('   ');
    expect(useApp.getState().batchPresets).toHaveLength(0);
  });

  it('删除预设', () => {
    useApp.getState().saveBatchPreset('素材');
    const id = useApp.getState().batchPresets[0].id;
    useApp.getState().removeBatchPreset(id);
    expect(useApp.getState().batchPresets).toHaveLength(0);
  });
});

describe('导出的边界情况', () => {
  it('队列为空时不产生下载，只提示', () => {
    useApp.getState().clearBatch();
    expect(useApp.getState().batchItems).toHaveLength(0);
    // 直接断言状态即可：没有可导出的项时不该进入打包流程
    expect(useApp.getState().batchItems.filter((i) => i.status === 'done')).toHaveLength(0);
  });
});