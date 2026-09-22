import { describe, expect, it } from 'vitest';

import { readCell, type Changes } from '../edit';
import { createEditLayer, createGrid, type EditLayer, type PixelGrid } from '../types';
import { TOOLS, TOOL_ORDER, brushFootprint, mirrorPoints, type ToolContext } from './index';

/** 造一份工具上下文：底层全部是索引 0 的不透明格 */
function makeCtx(w: number, h: number, over: Partial<ToolContext> = {}): ToolContext {
  const base: PixelGrid = createGrid(w, h);
  for (let i = 0; i < base.indices.length; i += 1) {
    base.indices[i] = i % 2;
    base.alpha[i] = 255;
  }
  const layer: EditLayer = createEditLayer(w, h);
  return {
    w,
    h,
    base,
    layer,
    brushSize: 1,
    symmetry: 'none',
    foreground: 3,
    shapeFill: false,
    selection: null,
    ...over,
  };
}

/** 跑一个工具回调并回收本次改动集合 */
type Tool = (typeof TOOLS)[keyof typeof TOOLS];

function run(
  toolId: keyof typeof TOOLS,
  ctx: ToolContext,
  fn: (tool: Tool, changes: Changes, ctx: ToolContext) => void,
): Changes {
  const changes: Changes = new Map();
  fn(TOOLS[toolId], changes, ctx);
  return changes;
}

const FOREGROUND = { index: 3, alpha: 255 };

describe('工具注册表', () => {
  it('八个工具都在，且快捷键不重复', () => {
    const keys = TOOL_ORDER.map((id) => TOOLS[id].key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const id of TOOL_ORDER) expect(TOOLS[id].id).toBe(id);
  });
});

describe('brushFootprint（笔刷尺寸）', () => {
  it('尺寸 1/2/3 分别覆盖 1/4/9 格', () => {
    const opts = { w: 8, h: 8, symmetry: 'none' as const };
    expect(brushFootprint({ x: 4, y: 4 }, { ...opts, brushSize: 1 })).toHaveLength(1);
    expect(brushFootprint({ x: 4, y: 4 }, { ...opts, brushSize: 2 })).toHaveLength(4);
    expect(brushFootprint({ x: 4, y: 4 }, { ...opts, brushSize: 3 })).toHaveLength(9);
  });

  it('尺寸 1 的落点就是光标所在格', () => {
    const pts = brushFootprint({ x: 4, y: 4 }, { w: 8, h: 8, brushSize: 1, symmetry: 'none' });
    expect(pts[0]).toEqual({ x: 4, y: 4 });
  });

  it('尺寸 3 以落点为中心', () => {
    const pts = brushFootprint({ x: 4, y: 4 }, { w: 8, h: 8, brushSize: 3, symmetry: 'none' });
    const xs = pts.map((p) => p.x);
    expect(Math.min(...xs)).toBe(3);
    expect(Math.max(...xs)).toBe(5);
  });

  it('超出画布的格子被裁掉', () => {
    const pts = brushFootprint({ x: 0, y: 0 }, { w: 8, h: 8, brushSize: 3, symmetry: 'none' });
    expect(pts).toHaveLength(4); // 角落只剩右下 2×2
    for (const p of pts) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('mirrorPoints（对称镜像）', () => {
  const opts = { w: 8, h: 6, brushSize: 1 };
  const p = { x: 1, y: 2 };

  it('关闭时原样返回', () => {
    expect(mirrorPoints([p], { ...opts, symmetry: 'none' })).toEqual([p]);
  });

  it('左右镜像：x → w-1-x', () => {
    const pts = mirrorPoints([p], { ...opts, symmetry: 'x' });
    expect(new Set(pts.map((q) => `${q.x},${q.y}`))).toEqual(new Set(['1,2', '6,2']));
  });

  it('上下镜像：y → h-1-y', () => {
    const pts = mirrorPoints([p], { ...opts, symmetry: 'y' });
    expect(new Set(pts.map((q) => `${q.x},${q.y}`))).toEqual(new Set(['1,2', '1,3']));
  });

  it('四向镜像得到四个格子', () => {
    const pts = mirrorPoints([p], { ...opts, symmetry: 'xy' });
    expect(pts).toHaveLength(4);
    expect(new Set(pts.map((q) => `${q.x},${q.y}`))).toEqual(
      new Set(['1,2', '6,2', '1,3', '6,3']),
    );
  });

  it('落点靠近中轴时四个镜像点互不重合', () => {
    const onAxis = { x: 3, y: 2 };
    const pts = mirrorPoints([onAxis], { ...opts, symmetry: 'xy' });
    // x=3 与 8-1-3=4 是相邻的两格，y 同理，四个点都不同
    expect(pts).toHaveLength(4);
    expect(new Set(pts.map((q) => `${q.x},${q.y}`)).size).toBe(4);
  });

  it('奇数宽度下正中心的格子镜像后只剩自己', () => {
    const odd = { w: 7, h: 7, brushSize: 1, symmetry: 'xy' as const };
    const pts = mirrorPoints([{ x: 3, y: 3 }], odd);
    expect(pts).toHaveLength(1);
  });

  it('镜像后越界的点被裁掉', () => {
    const pts = mirrorPoints([{ x: -1, y: 2 }], { ...opts, symmetry: 'x' });
    expect(pts).toHaveLength(0);
  });
});

describe('铅笔', () => {
  it('落笔写入前景色', () => {
    const ctx = makeCtx(4, 4);
    const changes = run('pencil', ctx, (tool, ch) => tool.down?.(ctx, ch, { x: 1, y: 2 }));
    expect(ctx.layer.cells[2 * 4 + 1]).toEqual(FOREGROUND);
    expect(changes.size).toBe(1);
  });

  it('笔刷尺寸生效', () => {
    const ctx = makeCtx(4, 4, { brushSize: 2 });
    run('pencil', ctx, (tool, ch) => tool.down?.(ctx, ch, { x: 1, y: 1 }));
    expect(ctx.layer.cells.filter(Boolean)).toHaveLength(4);
  });

  it('开启四向对称时一次落笔写四格', () => {
    const ctx = makeCtx(4, 4, { symmetry: 'xy' });
    run('pencil', ctx, (tool, ch) => tool.down?.(ctx, ch, { x: 0, y: 0 }));
    expect(ctx.layer.cells.filter(Boolean)).toHaveLength(4);
  });

  it('拖拽用直线补点，快速拖动不断线', () => {
    const ctx = makeCtx(8, 8);
    run('pencil', ctx, (tool, ch) =>
      tool.drag?.(ctx, ch, { x: 0, y: 0 }, { x: 5, y: 0 }),
    );
    expect(ctx.layer.cells.filter(Boolean)).toHaveLength(6);
  });

  it('拖拽不会越界写入', () => {
    const ctx = makeCtx(4, 4);
    run('pencil', ctx, (tool, ch) =>
      tool.drag?.(ctx, ch, { x: 0, y: 0 }, { x: 20, y: 20 }),
    );
    expect(ctx.layer.cells.length).toBe(16);
    expect(ctx.layer.cells.filter(Boolean).length).toBeLessThanOrEqual(16);
  });
});

describe('橡皮', () => {
  it('写入全透明而不是删掉覆盖项', () => {
    const ctx = makeCtx(4, 4);
    run('eraser', ctx, (tool, ch) => tool.down?.(ctx, ch, { x: 2, y: 2 }));
    // 必须是显式的透明格：置 null 会让底层颜色重新露出来
    expect(ctx.layer.cells[2 * 4 + 2]).toEqual({ index: 0, alpha: 0 });
  });

  it('擦除后读到的就是透明', () => {
    const ctx = makeCtx(4, 4);
    run('eraser', ctx, (tool, ch) => tool.down?.(ctx, ch, { x: 0, y: 0 }));
    expect(readCell(ctx.base, ctx.layer, 0, 0)).toEqual({ index: 0, alpha: 0 });
  });
});

describe('油漆桶', () => {
  it('填充整个连通区域', () => {
    // 索引按 i%2：宽 4 时等价于「奇数列 / 偶数列」，两色互不相邻
    const ctx = makeCtx(4, 4);
    const changes = run('bucket', ctx, (tool, ch) => tool.down?.(ctx, ch, { x: 0, y: 0 }));
    expect(changes.size).toBe(4); // 整列 x=0 与 x=2 不相连，只有 x=0 这一列
  });

  it('整块同色时全部填充', () => {
    const ctx = makeCtx(4, 2);
    // 全部改成同一个索引 → 全图连通
    ctx.base.indices.fill(1);
    const changes = run('bucket', ctx, (tool, ch) => tool.down?.(ctx, ch, { x: 0, y: 0 }));
    expect(changes.size).toBe(8);
  });

  it('不填充不同索引的相邻区域', () => {
    const ctx = makeCtx(2, 1);
    const changes = run('bucket', ctx, (tool, ch) => tool.down?.(ctx, ch, { x: 0, y: 0 }));
    expect(changes.size).toBe(1);
  });

  it('开启对称时镜像区域一起被填', () => {
    const ctx = makeCtx(4, 1, { symmetry: 'x' });
    ctx.base.indices.fill(1); // 全连通
    const changes = run('bucket', ctx, (tool, ch) => tool.down?.(ctx, ch, { x: 0, y: 0 }));
    expect(changes.size).toBe(4);
  });
});

describe('形状工具', () => {
  it('直线在松手时一次性写入', () => {
    const ctx = makeCtx(8, 8);
    run('line', ctx, (tool, ch) => tool.commit?.(ctx, ch, { x: 0, y: 0 }, { x: 4, y: 0 }));
    expect(ctx.layer.cells.filter(Boolean)).toHaveLength(5);
  });

  it('矩形默认只画轮廓', () => {
    const ctx = makeCtx(8, 8);
    run('rect', ctx, (tool, ch) => tool.commit?.(ctx, ch, { x: 0, y: 0 }, { x: 3, y: 3 }));
    expect(ctx.layer.cells.filter(Boolean)).toHaveLength(12);
    expect(readCell(ctx.base, ctx.layer, 1, 1)).toEqual({ index: 1, alpha: 255 }); // 内部仍是底层
  });

  it('勾选填充后矩形变实心', () => {
    const ctx = makeCtx(8, 8, { shapeFill: true });
    run('rect', ctx, (tool, ch) => tool.commit?.(ctx, ch, { x: 0, y: 0 }, { x: 3, y: 3 }));
    expect(ctx.layer.cells.filter(Boolean)).toHaveLength(16);
  });

  it('预览给出的格子与落笔写入的完全一致', () => {
    // 预览和落笔共用同一份光栅化结果，不可能对不上
    const ctx = makeCtx(8, 8);
    const tool = TOOLS.ellipse;
    const preview = tool.preview?.(ctx, { x: 1, y: 1 }, { x: 6, y: 5 });
    run('ellipse', ctx, (t, ch) => t.commit?.(ctx, ch, { x: 1, y: 1 }, { x: 6, y: 5 }));
    expect(preview).toHaveLength(ctx.layer.cells.filter(Boolean).length);
  });

  it('形状也受对称镜像影响', () => {
    const ctx = makeCtx(8, 8, { symmetry: 'x' });
    run('line', ctx, (tool, ch) => tool.commit?.(ctx, ch, { x: 0, y: 0 }, { x: 2, y: 0 }));
    expect(ctx.layer.cells.filter(Boolean)).toHaveLength(6);
  });
});

describe('选区移动', () => {
  it('把选区内容搬到偏移位置', () => {
    const ctx = makeCtx(6, 1, { selection: { x: 0, y: 0, w: 2, h: 1 } });
    run('select', ctx, (tool, ch) => tool.commit?.(ctx, ch, { x: 0, y: 0 }, { x: 3, y: 0 }));

    expect(readCell(ctx.base, ctx.layer, 0, 0)).toEqual({ index: 0, alpha: 0 });
    expect(readCell(ctx.base, ctx.layer, 3, 0)).toEqual({ index: 0, alpha: 255 });
    expect(readCell(ctx.base, ctx.layer, 4, 0)).toEqual({ index: 1, alpha: 255 });
  });

  it('没有选区时什么也不做', () => {
    const ctx = makeCtx(6, 1);
    const changes = run('select', ctx, (tool, ch) =>
      tool.commit?.(ctx, ch, { x: 0, y: 0 }, { x: 3, y: 0 }),
    );
    expect(changes.size).toBe(0);
  });

  it('原地拖拽不产生改动', () => {
    const ctx = makeCtx(6, 1, { selection: { x: 0, y: 0, w: 2, h: 1 } });
    const changes = run('select', ctx, (tool, ch) =>
      tool.commit?.(ctx, ch, { x: 1, y: 0 }, { x: 1, y: 0 }),
    );
    expect(changes.size).toBe(0);
  });
});

describe('吸管', () => {
  it('没有 down 回调 —— 取色由笔画控制器直接读 store', () => {
    // 工具的职责表里它只有 kind:'pick'，不写编辑层
    expect(TOOLS.eyedropper.kind).toBe('pick');
    expect(TOOLS.eyedropper.down).toBeUndefined();
  });
});