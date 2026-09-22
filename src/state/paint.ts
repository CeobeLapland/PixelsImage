/**
 * 笔画控制器：把「指针事件 → core 工具 → 编辑层 + 撤销栈」串起来。
 *
 * 放在 state/ 而不是 core/，因为它必须在 React 之外读写 store。
 * 同一时刻只可能有一个笔画（指针事件天然串行），所以模块级变量足够，
 * 不需要引入额外对象或生命周期。
 *
 * 分工：
 * - 工具只算「该写哪些格子」并就地写进编辑层；
 * - 本模块负责开合一次操作，并在收笔时把改动结算成一条撤销记录；
 * - 画布负责把指针坐标换成格坐标。
 */

import { changesToEdits, readCell, type Changes } from '@/core/edit';
import { TOOLS, type ToolContext } from '@/core/tools';
import {
  normalizeRect,
  rectContains,
  type GridPoint,
  type Rect,
  type ToolId,
} from '@/core/types';
import { useApp } from './store';

/** 拖拽的语义，决定松手时该做什么 */
type StrokeMode = 'paint' | 'shape' | 'marquee' | 'move' | 'pick';

interface Stroke {
  toolId: ToolId;
  mode: StrokeMode;
  changes: Changes;
  /** 落笔点 */
  start: GridPoint;
  /** 上一次的位置（自由绘制用来补点） */
  last: GridPoint;
  /** 选区搬运的抓取点 */
  grab: GridPoint;
}

let stroke: Stroke | null = null;
/** Alt 取色的临时笔画：按下的瞬间切换工具，抬起后恢复原工具 */
let altPicking = false;

export function isStroking(): boolean {
  return stroke !== null;
}

export function isAltPicking(): boolean {
  return altPicking;
}

/* ------------------------------------------------------------------ 上下文 */

function makeContext(): ToolContext | null {
  const s = useApp.getState();
  const base = s.baseGrid;
  const layer = s.editLayer;
  if (!base || !layer || base.w !== layer.w || base.h !== layer.h) return null;
  // 调色板换小时索引可能越界；越界后渲染会被钳到最后一个色，
  // 于是「画出来是那个颜色、存的却是另一个索引」。这里先夹住。
  const last = Math.max(0, s.palette.colors.length - 1);
  return {
    w: base.w,
    h: base.h,
    base,
    layer,
    brushSize: s.brushSize,
    symmetry: s.symmetry,
    foreground: Math.min(s.foreground, last),
    shapeFill: s.shapeFill,
    selection: s.selection,
  };
}

function clampToGrid(p: GridPoint, w: number, h: number): GridPoint {
  return {
    x: p.x < 0 ? 0 : p.x >= w ? w - 1 : p.x,
    y: p.y < 0 ? 0 : p.y >= h ? h - 1 : p.y,
  };
}

/* ------------------------------------------------------------------ 操作 */

/**
 * 落笔。
 * @param p 格坐标（画布已换算，可能越界，这里再钳一次）
 * @param alt 是否按住 Alt（临时取色）
 * @returns 是否成功开始（没有网格结果时返回 false，调用方负责提示）
 */
export function beginStroke(p: GridPoint, alt: boolean): boolean {
  const ctx = makeContext();
  if (!ctx) return false;

  const store = useApp.getState();
  const toolId: ToolId = alt ? 'eyedropper' : store.tool;
  const tool = TOOLS[toolId];
  const q = clampToGrid(p, ctx.w, ctx.h);

  if (tool.kind === 'pick') {
    altPicking = alt;
    const cell = readCell(ctx.base, ctx.layer, q.x, q.y);
    store.setForeground(cell.index);
    stroke = { toolId, mode: 'pick', changes: new Map(), start: q, last: q, grab: q };
    return true;
  }

  if (tool.kind === 'select') {
    // 落在已有选区内部 = 搬运；否则重新框选
    const inside = ctx.selection !== null && rectContains(ctx.selection, q.x, q.y);
    stroke = {
      toolId,
      mode: inside ? 'move' : 'marquee',
      changes: new Map(),
      start: q,
      last: q,
      grab: q,
    };
    if (!inside) store.setSelection(normalizeRect(q, q));
    return true;
  }

  stroke = {
    toolId,
    mode: tool.kind === 'shape' ? 'shape' : 'paint',
    changes: new Map(),
    start: q,
    last: q,
    grab: q,
  };
  tool.down?.(ctx, stroke.changes, q);
  store.touchEditLayer();
  return true;
}

/** 拖拽中。返回是否改动了编辑层（画布据此决定要不要重绘像素层） */
export function moveStroke(p: GridPoint): boolean {
  const active = stroke;
  if (!active) return false;
  const ctx = makeContext();
  if (!ctx) return false;

  const q = clampToGrid(p, ctx.w, ctx.h);
  const tool = TOOLS[active.toolId];

  switch (active.mode) {
    case 'pick': {
      const cell = readCell(ctx.base, ctx.layer, q.x, q.y);
      useApp.getState().setForeground(cell.index);
      break;
    }
    case 'marquee': {
      useApp.getState().setSelection(normalizeRect(active.start, q));
      break;
    }
    case 'paint': {
      tool.drag?.(ctx, active.changes, active.last, q);
      break;
    }
    // shape / move 只更新预览，格子由覆盖层画，收笔时才真正写入
    default:
      break;
  }

  active.last = q;
  if (active.mode === 'paint') {
    useApp.getState().touchEditLayer();
    return true;
  }
  return false;
}

/**
 * 收笔：形状与选区搬运在这里一次性写入，然后整体结算成一条撤销记录。
 */
export function endStroke(): void {
  const active = stroke;
  stroke = null;
  altPicking = false;
  if (!active) return;

  const ctx = makeContext();
  if (!ctx) return;

  const tool = TOOLS[active.toolId];
  if (active.mode === 'shape') {
    tool.commit?.(ctx, active.changes, active.start, active.last);
  } else if (active.mode === 'move') {
    const dx = active.last.x - active.grab.x;
    const dy = active.last.y - active.grab.y;
    tool.commit?.(ctx, active.changes, active.grab, active.last);
    // 搬运之后选区跟着内容一起走：否则松手瞬间选区留在原地、
    // 内容却跑到别处，用户会以为选区丢了
    if ((dx !== 0 || dy !== 0) && ctx.selection) {
      useApp.getState().setSelection({
        x: ctx.selection.x + dx,
        y: ctx.selection.y + dy,
        w: ctx.selection.w,
        h: ctx.selection.h,
      });
    }
  } else if (active.mode === 'pick') {
    return;
  }

  finish(active, ctx);
}

/** 指针被系统中断：把已经写进去的改动全部回滚，不留半截笔画 */
export function cancelStroke(): void {
  const active = stroke;
  stroke = null;
  altPicking = false;
  if (!active || active.changes.size === 0) return;

  const layer = useApp.getState().editLayer;
  if (layer) {
    for (const [index, before] of active.changes) {
      layer.cells[index] = before ? { index: before.index, alpha: before.alpha } : null;
    }
  }
  useApp.getState().touchEditLayer();
}

function finish(active: Stroke, ctx: ToolContext): void {
  const edits = changesToEdits(active.changes, ctx.layer);
  const store = useApp.getState();

  if (edits.length === 0) {
    // 例如形状只拖了一格、或原地搬运：不改数据也不占撤销栈
    store.touchEditLayer();
    return;
  }
  const label = active.mode === 'move' ? '选区搬运' : TOOLS[active.toolId].label;
  store.commitEdits(label, edits);
}

/* ------------------------------------------------------------------ 预览 */

export interface StrokePreview {
  /** 形状待写入的格子 */
  points: GridPoint[] | null;
  /** 选区搬运的目标框 */
  rect: Rect | null;
}

/** 覆盖层用：当前笔画的可视化预览 */
export function strokePreview(): StrokePreview | null {
  const active = stroke;
  if (!active) return null;
  const ctx = makeContext();
  if (!ctx) return null;

  if (active.mode === 'shape') {
    const points = TOOLS[active.toolId].preview?.(ctx, active.start, active.last) ?? null;
    return { points, rect: null };
  }
  if (active.mode === 'move' && ctx.selection) {
    const dx = active.last.x - active.grab.x;
    const dy = active.last.y - active.grab.y;
    return {
      points: null,
      rect: { x: ctx.selection.x + dx, y: ctx.selection.y + dy, w: ctx.selection.w, h: ctx.selection.h },
    };
  }
  // 框选过程本身就是在改 store 里的选区，覆盖层直接画选区即可，不再重复预览
  return null;
}

/* ---------------------------------------------------------------- 选区删除 */

/** Delete / Backspace：清空选区内的格子（同样进撤销栈） */
export function clearSelectionCells(): void {
  const ctx = makeContext();
  const rect = ctx?.selection;
  if (!ctx || !rect) return;

  const changes: Changes = new Map();
  const indices: number[] = [];
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      if (x < 0 || y < 0 || x >= ctx.w || y >= ctx.h) continue;
      indices.push(y * ctx.w + x);
    }
  }
  // 用撤销栈写回 after 的方式表达：这里直接写，再结算成一次操作
  for (const i of indices) {
    if (!changes.has(i)) changes.set(i, ctx.layer.cells[i] ?? null);
    ctx.layer.cells[i] = { index: 0, alpha: 0 };
  }

  const edits = changesToEdits(changes, ctx.layer);
  const store = useApp.getState();
  if (edits.length === 0) return;
  store.commitEdits('清空选区', edits);
}