/**
 * 画布绘制助手。
 *
 * 从 Viewport 里拆出来，因为画布现在是两层（像素层 + 覆盖层），
 * 共享的绘制逻辑再放在组件里就会变成一大坨。这里全部是纯绘制函数：
 * 输入坐标与尺寸，直接画到给定上下文，不读 store、不碰 React 状态。
 *
 * 颜色约定：覆盖层只用中性灰与琥珀色。琥珀（--accent）在本工具里
 * 专用于「当前操作」，不参与任何颜色判断（见 global.css 的说明）。
 */

export const CHECKER_SIZE = 8;
export const CHECKER_A = '#15181d';
export const CHECKER_B = '#1d2127';

/** 网格线只在格边长达到这个像素数时才画，否则会糊成一片摩尔纹 */
export const GRID_MIN_CELL = 4;
/** 一次绘制最多画多少条网格线（防御：超大网格 + 高倍缩放） */
const MAX_GRID_LINES = 600;

const GRID_MINOR = 'rgba(140,151,166,0.14)';
const GRID_MAJOR = 'rgba(140,151,166,0.36)';

export const ACCENT = '#e9a83c';
export const ACCENT_FILL = 'rgba(233,168,60,0.26)';
export const ACCENT_SOLID = 'rgba(233,168,60,0.55)';

/* ------------------------------------------------------------- 棋盘格底 */

let checkerTile: HTMLCanvasElement | null = null;
/**
 * 图案对象与创建它的上下文绑定，所以按上下文缓存而不是全局只存一个。
 * 用图案而不是逐格 fillRect：铺满一屏需要上万次 fillRect，鼠标每动一下
 * 都要重绘时这笔开销会直接变成掉帧。
 */
const checkerPatterns = new WeakMap<CanvasRenderingContext2D, CanvasPattern | null>();

function makeCheckerTile(): HTMLCanvasElement | null {
  if (checkerTile) return checkerTile;
  if (typeof document === 'undefined') return null;
  const size = CHECKER_SIZE * 2;
  const tile = document.createElement('canvas');
  tile.width = size;
  tile.height = size;
  const ctx = tile.getContext('2d');
  if (!ctx) return null;
  ctx.fillStyle = CHECKER_A;
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = CHECKER_B;
  ctx.fillRect(0, 0, CHECKER_SIZE, CHECKER_SIZE);
  ctx.fillRect(CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE);
  checkerTile = tile;
  return tile;
}

function getCheckerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const cached = checkerPatterns.get(ctx);
  if (cached !== undefined) return cached;
  const tile = makeCheckerTile();
  const pattern = tile ? ctx.createPattern(tile, 'repeat') : null;
  checkerPatterns.set(ctx, pattern);
  return pattern;
}

/** 半透明底：跟随图像原点绘制，平移时不会闪烁 */
export function drawChecker(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  viewW: number,
  viewH: number,
): void {
  if (w <= 0 || h <= 0) return;
  const x0 = Math.max(x, 0);
  const y0 = Math.max(y, 0);
  const x1 = Math.min(x + w, viewW);
  const y1 = Math.min(y + h, viewH);
  if (x1 <= x0 || y1 <= y0) return;

  const pattern = getCheckerPattern(ctx);
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  if (pattern) {
    // 图案原点跟着图像左上角，否则平移画布时棋盘格会「游动」
    ctx.translate(x, y);
    ctx.fillStyle = pattern;
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.fillStyle = CHECKER_A;
    ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
  }
  ctx.restore();
}

/* --------------------------------------------------------------- 网格线 */

export interface GridSpec {
  /** 图像原点的画布坐标 */
  ox: number;
  oy: number;
  /** 列数 / 行数 */
  cols: number;
  rows: number;
  /** 单格在屏幕上的边长 */
  cellW: number;
  cellH: number;
  /** 每隔几格画一条（大网格降采样，防摩尔纹） */
  step: number;
  /** 每隔几条强调一次 */
  majorEvery: number;
}

/** 绘制格网。格边长太小或线太多时自动放弃，宁可没有网格也不要一片灰 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  spec: GridSpec,
  viewW: number,
  viewH: number,
): void {
  const { ox, oy, cols, rows, cellW, cellH, step, majorEvery } = spec;
  if (cellW < GRID_MIN_CELL || cellH < GRID_MIN_CELL) return;

  const left = Math.max(ox, 0);
  const top = Math.max(oy, 0);
  const right = Math.min(ox + cols * cellW, viewW);
  const bottom = Math.min(oy + rows * cellH, viewH);
  if (right <= left || bottom <= top) return;

  const iStart = Math.max(0, Math.floor((left - ox) / cellW));
  const iEnd = Math.min(cols, Math.ceil((right - ox) / cellW));
  const jStart = Math.max(0, Math.floor((top - oy) / cellH));
  const jEnd = Math.min(rows, Math.ceil((bottom - oy) / cellH));
  const lineCount = (iEnd - iStart) / step + (jEnd - jStart) / step;
  if (lineCount > MAX_GRID_LINES) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(ox, oy, cols * cellW, rows * cellH);
  ctx.clip();
  ctx.lineWidth = 1;

  const first = (from: number): number => Math.ceil(from / step) * step;

  for (let i = first(iStart); i <= iEnd; i += step) {
    const px = Math.round(ox + i * cellW) + 0.5;
    ctx.strokeStyle = i % majorEvery === 0 ? GRID_MAJOR : GRID_MINOR;
    ctx.beginPath();
    ctx.moveTo(px, top);
    ctx.lineTo(px, bottom);
    ctx.stroke();
  }

  for (let j = first(jStart); j <= jEnd; j += step) {
    const py = Math.round(oy + j * cellH) + 0.5;
    ctx.strokeStyle = j % majorEvery === 0 ? GRID_MAJOR : GRID_MINOR;
    ctx.beginPath();
    ctx.moveTo(left, py);
    ctx.lineTo(right, py);
    ctx.stroke();
  }

  ctx.restore();
}

/* ----------------------------------------------------------- 格子高亮 */

/** 按格子列表填充（形状预览、笔刷足迹） */
export function fillCells(
  ctx: CanvasRenderingContext2D,
  points: readonly { x: number; y: number }[],
  ox: number,
  oy: number,
  cellW: number,
  cellH: number,
  fill: string,
): void {
  if (points.length === 0) return;
  ctx.save();
  ctx.fillStyle = fill;
  for (const p of points) {
    ctx.fillRect(ox + p.x * cellW, oy + p.y * cellH, cellW, cellH);
  }
  ctx.restore();
}

/** 给单个格子描一圈边（笔刷光标用；格太小时退化成 3px 的方框） */
export function outlineCell(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  cellW: number,
  cellH: number,
  ox: number,
  oy: number,
  color: string,
): void {
  const cx = ox + x * cellW;
  const cy = oy + y * cellH;
  const size = Math.max(3, Math.min(cellW, cellH));
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  ctx.strokeRect(Math.round(cx) + 0.5, Math.round(cy) + 0.5, Math.round(size) - 1, Math.round(size) - 1);
  ctx.restore();
}

/** 虚线框：先铺一层深色再叠亮色，保证压在任何底色上都看得清 */
export function dashedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  const rx = Math.round(x) + 0.5;
  const ry = Math.round(y) + 0.5;
  const rw = Math.max(1, Math.round(w) - 1);
  const rh = Math.max(1, Math.round(h) - 1);

  ctx.save();
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = 'rgba(0,0,0,0.6)';
  ctx.lineDashOffset = 0;
  ctx.strokeRect(rx, ry, rw, rh);
  ctx.strokeStyle = color;
  ctx.lineDashOffset = 4;
  ctx.strokeRect(rx, ry, rw, rh);
  ctx.restore();
}

/** 实线细框（图像边界、选区搬运目标框） */
export function thinRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
): void {
  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = color;
  ctx.strokeRect(
    Math.round(x) - 0.5,
    Math.round(y) - 0.5,
    Math.round(w) + 1,
    Math.round(h) + 1,
  );
  ctx.restore();
}