import { describe, expect, it } from 'vitest';

import {
  changesToEdits,
  cloneEditLayer,
  compositeKeys,
  countEdits,
  moveRegion,
  readCell,
  resampleEditLayer,
  writeCell,
  type Changes,
} from './edit';
import { createEditLayer, createGrid, type EditLayer, type PixelGrid } from './types';

/** 底层网格：索引按 i%4，全部不透明 */
function makeBase(w: number, h: number): PixelGrid {
  const grid = createGrid(w, h);
  for (let i = 0; i < grid.indices.length; i += 1) {
    grid.indices[i] = i % 4;
    grid.alpha[i] = 255;
  }
  return grid;
}

describe('readCell', () => {
  it('编辑层优先于底层', () => {
    const base = makeBase(2, 1); // [0, 1]
    const edit = createEditLayer(2, 1);
    edit.cells[1] = { index: 3, alpha: 128 };

    expect(readCell(base, edit, 0, 0)).toEqual({ index: 0, alpha: 255 });
    expect(readCell(base, edit, 1, 0)).toEqual({ index: 3, alpha: 128 });
  });

  it('越界返回全透明而不是抛错', () => {
    const base = makeBase(2, 2);
    expect(readCell(base, null, 9, 9)).toEqual({ index: 0, alpha: 0 });
    expect(readCell(null, null, 0, 0)).toEqual({ index: 0, alpha: 0 });
  });

  it('编辑层尺寸不一致时退回底层', () => {
    // 尺寸变更后尚未重采样的瞬间会出现这种状态
    const base = makeBase(4, 4);
    const stale = createEditLayer(2, 2);
    stale.cells[0] = { index: 3, alpha: 255 };
    expect(readCell(base, stale, 0, 0)).toEqual({ index: 0, alpha: 255 });
  });
});

describe('writeCell 与 Changes 记账', () => {
  it('记录改动前的值，同一格只记第一次', () => {
    const layer = createEditLayer(2, 1);
    const changes: Changes = new Map();

    writeCell(layer, 0, { index: 1, alpha: 255 }, changes);
    writeCell(layer, 0, { index: 2, alpha: 255 }, changes);

    expect(layer.cells[0]).toEqual({ index: 2, alpha: 255 });
    // 撤销要回到「没被改过」的状态，而不是回到中间态
    expect(changes.get(0)).toBeNull();
    expect(changes.size).toBe(1);
  });

  it('写 null 表示撤销覆盖，恢复到走底层', () => {
    const layer = createEditLayer(1, 1);
    const changes: Changes = new Map();
    layer.cells[0] = { index: 1, alpha: 255 };

    writeCell(layer, 0, null, changes);

    expect(layer.cells[0]).toBeNull();
    expect(changes.get(0)).toEqual({ index: 1, alpha: 255 });
  });

  it('写入时复制对象，避免调用方复用同一个格子对象', () => {
    const layer = createEditLayer(1, 1);
    const shared = { index: 1, alpha: 255 };
    writeCell(layer, 0, shared, new Map());
    shared.index = 3;
    expect(layer.cells[0]?.index).toBe(1);
  });

  it('越界下标被忽略', () => {
    const layer = createEditLayer(1, 1);
    const changes: Changes = new Map();
    writeCell(layer, 5, { index: 1, alpha: 255 }, changes);
    expect(changes.size).toBe(0);
    expect(layer.cells[0]).toBeNull();
  });
});

describe('changesToEdits', () => {
  it('丢掉改回原值的空操作', () => {
    const layer = createEditLayer(2, 1);
    const changes: Changes = new Map();
    // 画了又擦回去
    writeCell(layer, 0, { index: 1, alpha: 255 }, changes);
    writeCell(layer, 0, null, changes);
    // 真的改了
    writeCell(layer, 1, { index: 2, alpha: 255 }, changes);

    const edits = changesToEdits(changes, layer);
    expect(edits).toHaveLength(1);
    expect(edits[0]).toEqual({ index: 1, before: null, after: { index: 2, alpha: 255 } });
  });

  it('记录 before / after 两侧，重做才有依据', () => {
    const layer = createEditLayer(1, 1);
    layer.cells[0] = { index: 1, alpha: 255 };
    const changes: Changes = new Map();
    writeCell(layer, 0, { index: 3, alpha: 40 }, changes);

    expect(changesToEdits(changes, layer)[0]).toEqual({
      index: 0,
      before: { index: 1, alpha: 255 },
      after: { index: 3, alpha: 40 },
    });
  });
});

describe('countEdits / cloneEditLayer', () => {
  it('只数非空格子', () => {
    const layer = createEditLayer(3, 1);
    expect(countEdits(layer)).toBe(0);
    layer.cells[1] = { index: 1, alpha: 255 };
    expect(countEdits(layer)).toBe(1);
    expect(countEdits(null)).toBe(0);
  });

  it('克隆是深拷贝，改克隆不影响原件', () => {
    const layer = createEditLayer(2, 1);
    layer.cells[0] = { index: 1, alpha: 255 };
    const copy = cloneEditLayer(layer);
    copy.cells[0] = { index: 2, alpha: 255 };
    copy.cells[1] = { index: 3, alpha: 255 };

    expect(layer.cells[0]?.index).toBe(1);
    expect(layer.cells[1]).toBeNull();
    expect(copy.cells[0]).not.toBe(layer.cells[0]);
  });
});

describe('resampleEditLayer', () => {
  it('尺寸不变时返回等值的新对象（调用方可能继续就地改写它）', () => {
    const layer = createEditLayer(2, 2);
    layer.cells[3] = { index: 1, alpha: 255 };
    const out = resampleEditLayer(layer, 2, 2);
    expect(out).not.toBe(layer);
    expect(out.cells[3]).toEqual({ index: 1, alpha: 255 });
  });

  it('放大后格子落在对应的相对位置', () => {
    const layer = createEditLayer(2, 2);
    layer.cells[0] = { index: 1, alpha: 255 }; // 左上
    layer.cells[3] = { index: 2, alpha: 255 }; // 右下

    const out = resampleEditLayer(layer, 4, 4);
    expect(out.w).toBe(4);
    expect(out.h).toBe(4);
    expect(countEdits(out)).toBe(2);
    // 左上格中心映射到 (0,0) 与 (1,1) 之间 → 取 (1,1)
    expect(out.cells[1 * 4 + 1]).toEqual({ index: 1, alpha: 255 });
    expect(out.cells[3 * 4 + 3]).toEqual({ index: 2, alpha: 255 });
  });

  it('缩小后仍然保留（就近合并）', () => {
    const layer = createEditLayer(4, 4);
    for (let i = 0; i < layer.cells.length; i += 1) {
      layer.cells[i] = { index: 1, alpha: 255 };
    }
    const out = resampleEditLayer(layer, 2, 2);
    expect(countEdits(out)).toBe(4);
  });

  it('尺寸为 0 时钳到 1×1，不会产生空数组', () => {
    const layer = createEditLayer(3, 3);
    layer.cells[0] = { index: 1, alpha: 255 };
    const out = resampleEditLayer(layer, 0, 0);
    expect(out.w).toBe(1);
    expect(out.h).toBe(1);
    expect(out.cells).toHaveLength(1);
  });
});

describe('moveRegion（选区搬运）', () => {
  it('源区清空、目标区拿到搬运当时的合成值', () => {
    const base = makeBase(4, 1); // 索引 0 1 2 3
    const layer = createEditLayer(4, 1);
    const changes: Changes = new Map();

    moveRegion(base, layer, changes, { x: 0, y: 0, w: 2, h: 1 }, 2, 0);

    // 源区被写透明
    expect(readCell(base, layer, 0, 0)).toEqual({ index: 0, alpha: 0 });
    expect(readCell(base, layer, 1, 0)).toEqual({ index: 0, alpha: 0 });
    // 目标区是被搬过来的底层色，而不是底层原本的值
    expect(readCell(base, layer, 2, 0)).toEqual({ index: 0, alpha: 255 });
    expect(readCell(base, layer, 3, 0)).toEqual({ index: 1, alpha: 255 });
  });

  it('源与目标重叠时不会把刚写入的值当成源值', () => {
    const base = makeBase(4, 1);
    const layer = createEditLayer(4, 1);
    moveRegion(base, layer, new Map(), { x: 0, y: 0, w: 2, h: 1 }, 1, 0);

    expect(readCell(base, layer, 0, 0)).toEqual({ index: 0, alpha: 0 });
    expect(readCell(base, layer, 1, 0)).toEqual({ index: 0, alpha: 255 });
    expect(readCell(base, layer, 2, 0)).toEqual({ index: 1, alpha: 255 });
  });

  it('搬出画布的部分被丢弃，不会环绕到另一侧', () => {
    const base = makeBase(3, 1);
    const layer = createEditLayer(3, 1);
    moveRegion(base, layer, new Map(), { x: 0, y: 0, w: 2, h: 1 }, -1, 0);

    // 只有 (1,0) 能落到 (0,0)，(0,0) 越界丢弃
    expect(readCell(base, layer, 0, 0)).toEqual({ index: 1, alpha: 255 });
    expect(readCell(base, layer, 2, 0)).toEqual({ index: 2, alpha: 255 });
  });

  it('搬运不会丢掉未被手改过的格子的底层色', () => {
    // 这是「剪切-粘贴」与「置透明」最容易混淆的地方
    const base = makeBase(2, 1);
    const layer = createEditLayer(2, 1);
    moveRegion(base, layer, new Map(), { x: 0, y: 0, w: 2, h: 1 }, 0, 0);
    expect(readCell(base, layer, 0, 0)).toEqual({ index: 0, alpha: 255 });
    expect(readCell(base, layer, 1, 0)).toEqual({ index: 1, alpha: 255 });
  });
});

describe('compositeKeys', () => {
  it('把索引与 alpha 打包成一个可比较的数', () => {
    const base = makeBase(2, 1); // [0,1]
    const layer = createEditLayer(2, 1);
    layer.cells[1] = { index: 5, alpha: 7 };

    const keys = compositeKeys(base, layer);
    expect(keys[0]).toBe((0 << 8) | 255);
    expect(keys[1]).toBe((5 << 8) | 7);
  });

  it('编辑层尺寸不一致时退回底层', () => {
    const base = makeBase(2, 2);
    const stale: EditLayer = createEditLayer(1, 1);
    stale.cells[0] = { index: 9, alpha: 1 };
    const keys = compositeKeys(base, stale);
    expect(keys[0]).toBe((0 << 8) | 255);
    expect(keys).toHaveLength(4);
  });
});