/**
 * 绘图工具 —— docs/DESIGN.md §5.1。
 *
 * 每个工具都是一组纯函数式的回调，只做两件事：算出要写哪些格子、
 * 通过 writeCell 写进编辑层。**不持有状态**：一次拖拽的起点/终点由调用方
 * （state/paint.ts）保管，所以工具可以被反复复用、也容易单测。
 *
 * 工具不碰画布：预览以「格子列表」的形式返回，由覆盖层决定怎么画。
 * 这条约束让整个 tools/ 目录与 core/ 一样保持零 DOM 依赖。
 */

import { compositeKeys, moveRegion, writeCell } from '../edit';
import {
  TRANSPARENT_CELL,
  type EditLayer,
  type GridPoint,
  type PixelCell,
  type PixelGrid,
  type Rect,
  type SymmetryMode,
  type ToolId,
} from '../types';
import { floodFillPoints, shapePoints } from './geometry';
import type { Changes } from '../edit';

/** 工具的行为类别，决定调用方怎么驱动它 */
export type ToolKind = 'paint' | 'shape' | 'pick' | 'select';

/** 对称镜像需要的最小上下文（覆盖层画笔刷也用它） */
export interface SymmetryOpts {
  w: number;
  h: number;
  brushSize: number;
  symmetry: SymmetryMode;
}

export interface ToolContext extends SymmetryOpts {
  base: PixelGrid;
  layer: EditLayer;
  /** 当前前景色 = 调色板索引 */
  foreground: number;
  /** 形状工具：填充还是描边 */
  shapeFill: boolean;
  /** 选区移动工具用 */
  selection: Rect | null;
}

export interface Tool {
  id: ToolId;
  label: string;
  /** 快捷键提示 */
  key: string;
  kind: ToolKind;
  /** 一句话说明，显示在面板与 tooltip 里 */
  hint: string;
  /** 落笔即时生效（铅笔 / 橡皮 / 油漆桶） */
  down?(ctx: ToolContext, changes: Changes, p: GridPoint): void;
  /** 拖拽中增量生效（自由绘制） */
  drag?(ctx: ToolContext, changes: Changes, from: GridPoint, to: GridPoint): void;
  /** 抬起时一次性生效（形状、选区搬运） */
  commit?(ctx: ToolContext, changes: Changes, from: GridPoint, to: GridPoint): void;
  /** 拖拽预览要标记的格子（形状工具）；返回空数组表示没有预览 */
  preview?(ctx: ToolContext, from: GridPoint, to: GridPoint): GridPoint[];
}

/* ------------------------------------------------------------ 笔刷与对称 */

/**
 * 笔刷覆盖的格子。
 *
 * 尺寸 n 的笔刷是一个 n×n 方块，**以落点为中心**（n=2 时偏右下，
 * 因为偶数尺寸没有真正的中心格）。选中心而不是左上角对齐：
 * 画对称图形时光标所在的格始终被画到，手感才符合直觉。
 */
export function brushFootprint(p: GridPoint, opts: SymmetryOpts): GridPoint[] {
  const n = Math.max(1, Math.round(opts.brushSize));
  const off = Math.floor((n - 1) / 2);
  const base: GridPoint[] = [];
  for (let dy = 0; dy < n; dy += 1) {
    for (let dx = 0; dx < n; dx += 1) {
      base.push({ x: p.x - off + dx, y: p.y - off + dy });
    }
  }
  return mirrorPoints(base, opts);
}

/**
 * 按对称模式展开一组格子，并去重，同时裁掉越界的点。
 *
 * 约定：`x` = 沿竖直中轴左右镜像，`y` = 沿水平中轴上下镜像。
 *
 * 越界裁剪放在这里而不是留给调用方：覆盖层直接用返回值画笔刷光标，
 * 若不裁，笔刷贴到画布边缘时光标会画到图像外面去。
 * 去重也是必要的 —— 笔刷压在中轴上时镜像点会与原位置重合。
 */
export function mirrorPoints(points: readonly GridPoint[], opts: SymmetryOpts): GridPoint[] {
  const mode = opts.symmetry;
  const flipX = mode === 'x' || mode === 'xy';
  const flipY = mode === 'y' || mode === 'xy';
  const out: GridPoint[] = [];
  const seen = new Set<number>();

  for (const p of points) {
    const xs = flipX ? [p.x, opts.w - 1 - p.x] : [p.x];
    const ys = flipY ? [p.y, opts.h - 1 - p.y] : [p.y];
    for (const x of xs) {
      for (const y of ys) {
        // 用下标做键，而不是 "x,y" 字符串：这个函数在拖拽热路径上
        if (x < 0 || y < 0 || x >= opts.w || y >= opts.h) continue;
        const key = y * opts.w + x;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ x, y });
      }
    }
  }
  return out;
}

/** 把一组格子写入编辑层（越界忽略，并自动展开对称镜像） */
function paintPoints(
  ctx: ToolContext,
  changes: Changes,
  points: readonly GridPoint[],
  cell: PixelCell,
  symmetric = true,
): void {
  const list = symmetric ? mirrorPoints(points, ctx) : points;
  for (const p of list) {
    if (p.x < 0 || p.y < 0 || p.x >= ctx.w || p.y >= ctx.h) continue;
    writeCell(ctx.layer, p.y * ctx.w + p.x, cell, changes);
  }
}

/** 前景色单元格（不透明） */
function foregroundCell(ctx: ToolContext): PixelCell {
  return { index: Math.max(0, Math.round(ctx.foreground)), alpha: 255 };
}

/* --------------------------------------------------------------- 工具定义 */

const pencil: Tool = {
  id: 'pencil',
  label: '铅笔',
  key: 'B',
  kind: 'paint',
  hint: '画前景色；笔刷 1–4 格，开启对称时镜像同步落笔',
  down(ctx, changes, p) {
    paintPoints(ctx, changes, brushFootprint(p, ctx), foregroundCell(ctx));
  },
  drag(ctx, changes, from, to) {
    // 用直线补点：快速拖动时 pointermove 一次能跨好几格，只画当前格会断线
    const path = linePath(from, to);
    for (const p of path) paintPoints(ctx, changes, brushFootprint(p, ctx), foregroundCell(ctx));
  },
};

const eraser: Tool = {
  id: 'eraser',
  label: '橡皮',
  key: 'E',
  kind: 'paint',
  hint: '把格子改为全透明（写入编辑层，可撤销、不受重算影响）',
  down(ctx, changes, p) {
    paintPoints(ctx, changes, brushFootprint(p, ctx), TRANSPARENT_CELL);
  },
  drag(ctx, changes, from, to) {
    for (const p of linePath(from, to)) {
      paintPoints(ctx, changes, brushFootprint(p, ctx), TRANSPARENT_CELL);
    }
  },
};

const bucket: Tool = {
  id: 'bucket',
  label: '油漆桶',
  key: 'G',
  kind: 'paint',
  hint: '同索引同透明度的连通区域整体填成前景色（含对称镜像区）',
  down(ctx, changes, p) {
    if (p.x < 0 || p.y < 0 || p.x >= ctx.w || p.y >= ctx.h) return;
    const keys = compositeKeys(ctx.base, ctx.layer);
    const region = floodFillPoints(keys, ctx.w, ctx.h, p);
    // 填充结果也走对称展开：填左半边背景时右半边同步被填，这才是对称的语义
    paintPoints(ctx, changes, region, foregroundCell(ctx));
  },
};

const eyedropper: Tool = {
  id: 'eyedropper',
  label: '吸管',
  key: 'I',
  kind: 'pick',
  hint: '取该格当前生效的调色板索引为前景色（按住 Alt 临时切换）',
};

const line: Tool = {
  id: 'line',
  label: '直线',
  key: 'L',
  kind: 'shape',
  hint: '拖拽画直线，松手落笔',
  preview(ctx, from, to) {
    return mirrorPoints(shapePoints(from, to, 'line', false), ctx);
  },
  commit(ctx, changes, from, to) {
    paintPoints(ctx, changes, shapePoints(from, to, 'line', false), foregroundCell(ctx));
  },
};

const rect: Tool = {
  id: 'rect',
  label: '矩形',
  key: 'R',
  kind: 'shape',
  hint: '拖拽画矩形；勾选「填充形状」则实心',
  preview(ctx, from, to) {
    return mirrorPoints(shapePoints(from, to, 'rect', ctx.shapeFill), ctx);
  },
  commit(ctx, changes, from, to) {
    paintPoints(ctx, changes, shapePoints(from, to, 'rect', ctx.shapeFill), foregroundCell(ctx));
  },
};

const ellipse: Tool = {
  id: 'ellipse',
  label: '椭圆',
  key: 'O',
  kind: 'shape',
  hint: '拖拽决定包围盒；勾选「填充形状」则实心',
  preview(ctx, from, to) {
    return mirrorPoints(shapePoints(from, to, 'ellipse', ctx.shapeFill), ctx);
  },
  commit(ctx, changes, from, to) {
    paintPoints(
      ctx,
      changes,
      shapePoints(from, to, 'ellipse', ctx.shapeFill),
      foregroundCell(ctx),
    );
  },
};

const select: Tool = {
  id: 'select',
  label: '选区移动',
  key: 'M',
  kind: 'select',
  hint: '拖空白处框选；在选区内拖拽搬运内容（剪切-粘贴）；Delete 清空选区',
  commit(ctx, changes, from, to) {
    if (!ctx.selection) return;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (dx === 0 && dy === 0) return;
    moveRegion(ctx.base, ctx.layer, changes, ctx.selection, dx, dy);
  },
};

/* ------------------------------------------------------------- 补点工具 */

/** 拖拽补点：起点等于终点时只返回该点 */
function linePath(from: GridPoint, to: GridPoint): GridPoint[] {
  if (from.x === to.x && from.y === to.y) return [to];
  return shapePoints(from, to, 'line', false);
}

/* --------------------------------------------------------------- 注册表 */

export const TOOLS: Record<ToolId, Tool> = {
  pencil,
  eraser,
  bucket,
  eyedropper,
  line,
  rect,
  ellipse,
  select,
};

export const TOOL_ORDER: readonly ToolId[] = [
  'pencil',
  'eraser',
  'bucket',
  'eyedropper',
  'line',
  'rect',
  'ellipse',
  'select',
];

export function getTool(id: ToolId): Tool {
  return TOOLS[id];
}