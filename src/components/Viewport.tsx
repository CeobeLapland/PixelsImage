import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import type { SourceImage } from '@/core/types';
import { useApp } from '@/state/store';

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 64;
/** 适配窗口时四周留白 */
const FIT_PADDING = 44;
const CHECKER_SIZE = 8;
/** 源像素网格只在这个倍率以上绘制，否则会摩尔纹 */
const GRID_MIN_ZOOM = 8;

const CHECKER_A = '#15181d';
const CHECKER_B = '#1d2127';

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** 半透明底：跟随图像原点绘制，平移时不会闪烁 */
function drawChecker(
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

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  ctx.fillStyle = CHECKER_A;
  ctx.fillRect(x0, y0, x1 - x0, y1 - y0);

  ctx.fillStyle = CHECKER_B;
  const colStart = Math.floor((x0 - x) / CHECKER_SIZE);
  const colEnd = Math.ceil((x1 - x) / CHECKER_SIZE);
  const rowStart = Math.floor((y0 - y) / CHECKER_SIZE);
  const rowEnd = Math.ceil((y1 - y) / CHECKER_SIZE);
  for (let row = rowStart; row < rowEnd; row += 1) {
    for (let col = colStart; col < colEnd; col += 1) {
      if (Math.abs(row + col) % 2 !== 0) continue;
      ctx.fillRect(x + col * CHECKER_SIZE, y + row * CHECKER_SIZE, CHECKER_SIZE, CHECKER_SIZE);
    }
  }
  ctx.restore();
}

/** 源像素网格；每 8 格一条主线便于估尺寸 */
function drawSourceGrid(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  iw: number,
  ih: number,
  zoom: number,
  viewW: number,
  viewH: number,
): void {
  const left = Math.max(x, 0);
  const right = Math.min(x + iw * zoom, viewW);
  const top = Math.max(y, 0);
  const bottom = Math.min(y + ih * zoom, viewH);
  if (right <= left || bottom <= top) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, iw * zoom, ih * zoom);
  ctx.clip();
  ctx.lineWidth = 1;

  const iStart = Math.max(0, Math.floor((0 - x) / zoom));
  const iEnd = Math.min(iw, Math.ceil((viewW - x) / zoom));
  for (let i = iStart; i <= iEnd; i += 1) {
    const px = Math.round(x + i * zoom) + 0.5;
    ctx.strokeStyle = i % 8 === 0 ? 'rgba(140,151,166,0.34)' : 'rgba(140,151,166,0.12)';
    ctx.beginPath();
    ctx.moveTo(px, top);
    ctx.lineTo(px, bottom);
    ctx.stroke();
  }

  const jStart = Math.max(0, Math.floor((0 - y) / zoom));
  const jEnd = Math.min(ih, Math.ceil((viewH - y) / zoom));
  for (let j = jStart; j <= jEnd; j += 1) {
    const py = Math.round(y + j * zoom) + 0.5;
    ctx.strokeStyle = j % 8 === 0 ? 'rgba(140,151,166,0.34)' : 'rgba(140,151,166,0.12)';
    ctx.beginPath();
    ctx.moveTo(left, py);
    ctx.lineTo(right, py);
    ctx.stroke();
  }

  ctx.restore();
}

interface PanSession {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

export function Viewport({ source }: { source: SourceImage }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const panRef = useRef<PanSession | null>(null);
  const needFitRef = useRef(true);
  const [panning, setPanning] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [splitDragging, setSplitDragging] = useState(false);

  const view = useApp((s) => s.view);
  const showGrid = useApp((s) => s.showGrid);
  const mode = useApp((s) => s.compareMode);
  const splitPos = useApp((s) => s.splitPos);
  const resultBitmap = useApp((s) => s.resultBitmap);
  const resultGrid = useApp((s) => s.baseGrid);

  const previewW = source.previewBitmap.width;
  const previewH = source.previewBitmap.height;

  /* ------------------------------------------------------ 尺寸与视图 */

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const fit = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (!cw || !ch) return;
    const zoom = clamp(
      Math.min((cw - FIT_PADDING * 2) / previewW, (ch - FIT_PADDING * 2) / previewH),
      MIN_ZOOM,
      MAX_ZOOM,
    );
    useApp.getState().setView({
      zoom,
      panX: (cw - previewW * zoom) / 2,
      panY: (ch - previewH * zoom) / 2,
    });
  }, [previewW, previewH]);

  useEffect(() => {
    needFitRef.current = true;
  }, [source]);

  useEffect(() => {
    if (!needFitRef.current || !box.w || !box.h) return;
    needFitRef.current = false;
    fit();
  }, [box.w, box.h, fit]);

  const zoomBy = useCallback((factor: number) => {
    const el = containerRef.current;
    if (!el) return;
    const cx = el.clientWidth / 2;
    const cy = el.clientHeight / 2;
    const { zoom, panX, panY } = useApp.getState().view;
    const next = clamp(zoom * factor, MIN_ZOOM, MAX_ZOOM);
    if (next === zoom) return;
    const ix = (cx - panX) / zoom;
    const iy = (cy - panY) / zoom;
    useApp.getState().setView({ zoom: next, panX: cx - ix * next, panY: cy - iy * next });
  }, []);

  const zoomTo100 = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    useApp.getState().setView({
      zoom: 1,
      panX: (el.clientWidth - previewW) / 2,
      panY: (el.clientHeight - previewH) / 2,
    });
  }, [previewW, previewH]);

  /* ------------------------------------------------------ 光标读数 */

  const reportCursor = useCallback(
    (clientX: number, clientY: number) => {
      const el = containerRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const { zoom, panX, panY } = useApp.getState().view;
      const ix = Math.floor((clientX - rect.left - panX) / zoom);
      const iy = Math.floor((clientY - rect.top - panY) / zoom);
      if (ix < 0 || iy < 0 || ix >= previewW || iy >= previewH) {
        useApp.getState().setCursor(null);
        return;
      }
      const scale = source.previewScale;
      useApp.getState().setCursor({ x: Math.floor(ix * scale), y: Math.floor(iy * scale) });
    },
    [previewW, previewH, source.previewScale],
  );

  /* ------------------------------------------------------ 滚轮缩放 */

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = event.clientX - rect.left;
      const my = event.clientY - rect.top;
      const { zoom, panX, panY } = useApp.getState().view;
      const next = clamp(zoom * Math.exp(-event.deltaY * 0.0015), MIN_ZOOM, MAX_ZOOM);
      if (next === zoom) return;
      const ix = (mx - panX) / zoom;
      const iy = (my - panY) / zoom;
      useApp.getState().setView({ zoom: next, panX: mx - ix * next, panY: my - iy * next });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /* ------------------------------------------------------ 快捷键 */

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      if (event.key === '0') {
        event.preventDefault();
        fit();
      } else if (event.key === '1') {
        event.preventDefault();
        zoomTo100();
      } else if (event.key === '+' || event.key === '=') {
        event.preventDefault();
        zoomBy(1.5);
      } else if (event.key === '-' || event.key === '_') {
        event.preventDefault();
        zoomBy(1 / 1.5);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fit, zoomBy, zoomTo100]);

  /* ------------------------------------------------------ 分割线拖拽 */

  const splitFromClientX = useCallback((clientX: number) => {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    useApp.getState().setSplitPos((clientX - rect.left) / rect.width);
  }, []);

  const onSplitDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setSplitDragging(true);
    splitFromClientX(event.clientX);
  };

  const onSplitMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!splitDragging) return;
    event.stopPropagation();
    splitFromClientX(event.clientX);
  };

  const onSplitUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!splitDragging) return;
    event.stopPropagation();
    setSplitDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  /* ------------------------------------------------------ 平移 */

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== 1) return;
    const { panX, panY } = useApp.getState().view;
    panRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: panX,
      originY: panY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setPanning(true);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      useApp.getState().setView({
        panX: pan.originX + (event.clientX - pan.startX),
        panY: pan.originY + (event.clientY - pan.startY),
      });
    }
    reportCursor(event.clientX, event.clientY);
  };

  const endPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    const pan = panRef.current;
    if (!pan || pan.pointerId !== event.pointerId) return;
    panRef.current = null;
    setPanning(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  /* ------------------------------------------------------ 绘制 */

  useEffect(() => {
    const canvas = canvasRef.current;
    const el = containerRef.current;
    if (!canvas || !el) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (!cw || !ch) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const hasResult = resultBitmap !== null && resultGrid !== null;

    /* ---- 并排模式：各占一半，各自适配 ---- */
    if (mode === 'sideBySide' && hasResult) {
      const gap = 12;
      const halfW = (cw - gap * 2) / 2;

      const drawFitted = (
        bitmap: ImageBitmap | null,
        gw: number | null,
        x: number,
        y: number,
        w: number,
        h: number,
        pixelated: boolean,
      ) => {
        const iw = gw ?? previewW;
        const ih = gw !== null && resultGrid ? resultGrid.h : previewH;
        const k = Math.min(w / iw, h / ih);
        const dw = iw * k;
        const dh = ih * k;
        const dx = x + (w - dw) / 2;
        const dy = y + (h - dh) / 2;
        drawChecker(ctx, dx, dy, dw, dh, cw, ch);
        if (bitmap) {
          ctx.imageSmoothingEnabled = !pixelated && k < 1;
          ctx.drawImage(bitmap, dx, dy, dw, dh);
        }
        ctx.lineWidth = 1;
        ctx.strokeStyle = 'rgba(124,140,162,0.45)';
        ctx.strokeRect(
          Math.round(dx) - 0.5,
          Math.round(dy) - 0.5,
          Math.round(dw) + 1,
          Math.round(dh) + 1,
        );
      };

      drawFitted(source.previewBitmap, null, gap, gap, halfW, ch - gap * 2, false);
      drawFitted(resultBitmap, resultGrid?.w ?? null, gap * 2 + halfW, gap, halfW, ch - gap * 2, true);

      ctx.fillStyle = 'rgba(140,151,166,0.85)';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('原图', gap + halfW / 2, 12);
      ctx.fillText(
        `像素图 ${resultGrid?.w ?? 0}×${resultGrid?.h ?? 0}`,
        gap * 2 + halfW + halfW / 2,
        12,
      );
      return;
    }

    /* ---- 共用视图：侧滑分割 / 仅结果 / 仅原图 ---- */
    const dw = previewW * view.zoom;
    const dh = previewH * view.zoom;
    const x = view.panX;
    const y = view.panY;

    const showSourceOnly = mode === 'source' || !hasResult;

    drawChecker(ctx, x, y, dw, dh, cw, ch);

    if (mode === 'result' && hasResult) {
      // 只看结果：整块都画结果
      const cellSize = dw / resultGrid.w;
      ctx.imageSmoothingEnabled = cellSize < 1;
      ctx.drawImage(resultBitmap, x, y, dw, dh);
    } else if (mode === 'split' && hasResult) {
      const splitX = splitPos * cw;

      // 左半：原图
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, splitX, ch);
      ctx.clip();
      ctx.imageSmoothingEnabled = view.zoom < 1;
      ctx.drawImage(source.previewBitmap, x, y, dw, dh);
      ctx.restore();

      // 右半：结果
      ctx.save();
      ctx.beginPath();
      ctx.rect(splitX, 0, cw - splitX, ch);
      ctx.clip();
      const cellSize = dw / resultGrid.w;
      ctx.imageSmoothingEnabled = cellSize < 1;
      ctx.drawImage(resultBitmap, x, y, dw, dh);
      ctx.restore();

      // 分割线
      ctx.strokeStyle = 'rgba(233,168,60,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(splitX) + 0.5, 0);
      ctx.lineTo(Math.round(splitX) + 0.5, ch);
      ctx.stroke();
    } else if (showSourceOnly) {
      ctx.imageSmoothingEnabled = view.zoom < 1;
      ctx.drawImage(source.previewBitmap, x, y, dw, dh);
    }

    // 图像边界
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(124,140,162,0.45)';
    ctx.strokeRect(
      Math.round(x) - 0.5,
      Math.round(y) - 0.5,
      Math.round(dw) + 1,
      Math.round(dh) + 1,
    );

    if (showGrid && view.zoom >= GRID_MIN_ZOOM) {
      drawSourceGrid(ctx, x, y, previewW, previewH, view.zoom, cw, ch);
    }
  }, [
    source,
    view,
    showGrid,
    box.w,
    box.h,
    previewW,
    previewH,
    mode,
    splitPos,
    resultBitmap,
    resultGrid,
  ]);

  const interactive = mode !== 'sideBySide';

  return (
    <div
      ref={containerRef}
      className={`viewport${panning ? ' viewport--panning' : ''}${interactive ? '' : ' viewport--static'}`}
      onPointerDown={interactive ? onPointerDown : undefined}
      onPointerMove={interactive ? onPointerMove : undefined}
      onPointerUp={interactive ? endPan : undefined}
      onPointerCancel={interactive ? endPan : undefined}
      onPointerLeave={(event) => {
        if (interactive) endPan(event);
        useApp.getState().setCursor(null);
      }}
    >
      <canvas ref={canvasRef} className="viewport__canvas" />

      {mode === 'split' && resultBitmap && (
        <div
          className="splitter"
          style={{ left: `${splitPos * 100}%` }}
          onPointerDown={onSplitDown}
          onPointerMove={onSplitMove}
          onPointerUp={onSplitUp}
          onPointerCancel={onSplitUp}
          role="separator"
          aria-label="对照分割线"
          aria-orientation="vertical"
          aria-valuenow={Math.round(splitPos * 100)}
        >
          <span className="splitter__grip" />
        </div>
      )}

      <div className="viewport__hud">
        <span>
          缩放 <b>{view.zoom >= 1 ? view.zoom.toFixed(2) : view.zoom.toFixed(3)}×</b>
        </span>
        <span>·</span>
        <span>
          {mode === 'split'
            ? '左原图 / 右像素图'
            : mode === 'result'
              ? '仅像素图'
              : mode === 'source'
                ? '仅原图'
                : '并排对照'}
        </span>
      </div>

      <div className="viewport__controls">
        <button
          type="button"
          className="btn btn--icon"
          onClick={() => zoomBy(1 / 1.5)}
          disabled={!interactive}
          title="缩小（-）"
          aria-label="缩小"
        >
          −
        </button>
        <button
          type="button"
          className="btn btn--icon"
          onClick={() => zoomBy(1.5)}
          disabled={!interactive}
          title="放大（+）"
          aria-label="放大"
        >
          +
        </button>
        <button
          type="button"
          className="btn"
          onClick={fit}
          disabled={!interactive}
          title="适配窗口（0）"
        >
          适配
        </button>
        <button
          type="button"
          className="btn"
          onClick={zoomTo100}
          disabled={!interactive}
          title="原尺寸（1）"
        >
          1:1
        </button>
      </div>
    </div>
  );
}