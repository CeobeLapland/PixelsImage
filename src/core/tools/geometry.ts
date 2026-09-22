/**
 * 图形光栅化：把「起点 → 终点」的拖拽转成一串格坐标。
 *
 * 全部是纯函数，不碰编辑层也不碰画布 —— 预览和落笔用的是同一份结果，
 * 所以「拖拽时看到的形状」与「松手后画出来的形状」不可能不一致。
 *
 * 坐标可能落在网格外（例如拖到画布边缘之外）：这里只负责算，
 * 越界的点由写入方（core/tools）裁掉。这样形状算法本身不必关心边界。
 */

import type { GridPoint } from '../types';

/** 把 b 到 a 的偏移限制在网格内，避免拖出画布时形状无限延伸 */
export function clampPoint(p: GridPoint, w: number, h: number): GridPoint {
  return {
    x: p.x < 0 ? 0 : p.x >= w ? w - 1 : p.x,
    y: p.y < 0 ? 0 : p.y >= h ? h - 1 : p.y,
  };
}

/**
 * Bresenham 直线。
 * 拖拽画线必须用它补点：pointermove 在快速拖动时一次能跨十几格，
 * 只写当前格会画出一串断点。
 */
export function linePoints(a: GridPoint, b: GridPoint): GridPoint[] {
  const points: GridPoint[] = [];
  let x0 = a.x;
  let y0 = a.y;
  const x1 = b.x;
  const y1 = b.y;

  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;

  // 上限防御：正常情况下由 clampPoint 保证步数 = max(dx, dy) + 1
  const limit = dx - dy + 2;
  for (let guard = 0; guard <= limit; guard += 1) {
    points.push({ x: x0, y: y0 });
    if (x0 === x1 && y0 === y1) break;
    const e2 = err * 2;
    if (e2 >= dy) {
      err += dy;
      x0 += sx;
    }
    if (e2 <= dx) {
      err += dx;
      y0 += sy;
    }
  }
  return points;
}

/** 矩形：包围盒四边，宽高为 1 时退化成一条线（不会重复输出同一格） */
export function rectOutlinePoints(a: GridPoint, b: GridPoint): GridPoint[] {
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  const points: GridPoint[] = [];

  for (let x = left; x <= right; x += 1) {
    points.push({ x, y: top });
    if (bottom !== top) points.push({ x, y: bottom });
  }
  for (let y = top + 1; y < bottom; y += 1) {
    points.push({ x: left, y });
    if (right !== left) points.push({ x: right, y });
  }
  return points;
}

/** 矩形：整个包围盒 */
export function rectFillPoints(a: GridPoint, b: GridPoint): GridPoint[] {
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  const points: GridPoint[] = [];

  for (let y = top; y <= bottom; y += 1) {
    for (let x = left; x <= right; x += 1) points.push({ x, y });
  }
  return points;
}

/**
 * 椭圆：先在整个包围盒上按「格中心是否落在椭圆内」生成掩码，
 * 再按需要取掩码本身（填充）或掩码的边界（描边）。
 *
 * 之所以不用中点椭圆算法：那套算法给的是「数学上的细线」，在小尺寸
 * （3×3 ～ 8×8，正是像素画的常用区间）会出现断开与不对称；
 * 掩码法在任意尺寸下都左右上下对称，描边也天然闭合。
 */
function ellipseMask(a: GridPoint, b: GridPoint): { left: number; top: number; mask: boolean[]; w: number; h: number } {
  const left = Math.min(a.x, b.x);
  const right = Math.max(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const bottom = Math.max(a.y, b.y);
  const w = right - left + 1;
  const h = bottom - top + 1;

  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const rx = w / 2;
  const ry = h / 2;
  const mask = new Array<boolean>(w * h).fill(false);

  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      if (nx * nx + ny * ny <= 1) mask[y * w + x] = true;
    }
  }
  return { left, top, mask, w, h };
}

export function ellipseFillPoints(a: GridPoint, b: GridPoint): GridPoint[] {
  const { left, top, mask, w, h } = ellipseMask(a, b);
  const points: GridPoint[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (mask[y * w + x]) points.push({ x: left + x, y: top + y });
    }
  }
  return points;
}

export function ellipseOutlinePoints(a: GridPoint, b: GridPoint): GridPoint[] {
  const { left, top, mask, w, h } = ellipseMask(a, b);
  const at = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= w || y >= h ? false : (mask[y * w + x] ?? false);

  const points: GridPoint[] = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (!mask[y * w + x]) continue;
      // 四邻域里只要有一个空位，这一格就是轮廓
      if (at(x - 1, y) && at(x + 1, y) && at(x, y - 1) && at(x, y + 1)) continue;
      points.push({ x: left + x, y: top + y });
    }
  }
  return points;
}

/** 形状工具的统一入口：按类型与「填充/描边」给出要写入的格子 */
export function shapePoints(
  a: GridPoint,
  b: GridPoint,
  shape: 'line' | 'rect' | 'ellipse',
  fill: boolean,
): GridPoint[] {
  if (shape === 'line') return linePoints(a, b);
  if (shape === 'rect') return fill ? rectFillPoints(a, b) : rectOutlinePoints(a, b);
  return fill ? ellipseFillPoints(a, b) : ellipseOutlinePoints(a, b);
}

/**
 * 油漆桶：4 邻域洪水填充。
 *
 * 判定用「合成后的 索引 + alpha 完全相同」，而不是颜色距离阈值：
 * 调色板是离散的，同一索引必然同色，索引不同则本来就该算作不同区域；
 * 阈值法反而会把相邻的两个近似色块糊在一起（M3 的全局换色也依赖索引相等）。
 */
export function floodFillPoints(
  key: Uint32Array | Int32Array | number[],
  w: number,
  h: number,
  start: GridPoint,
): GridPoint[] {
  if (w <= 0 || h <= 0) return [];
  const sx = start.x;
  const sy = start.y;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return [];

  const target = key[sy * w + sx] ?? 0;
  const visited = new Uint8Array(w * h);
  const points: GridPoint[] = [];
  const stack: number[] = [sy * w + sx];

  while (stack.length > 0) {
    const i = stack.pop() as number;
    if (visited[i]) continue;
    visited[i] = 1;
    if ((key[i] ?? 0) !== target) continue;

    const x = i % w;
    const y = (i - x) / w;
    points.push({ x, y });

    if (x > 0) stack.push(i - 1);
    if (x < w - 1) stack.push(i + 1);
    if (y > 0) stack.push(i - w);
    if (y < h - 1) stack.push(i + w);
  }
  return points;
}