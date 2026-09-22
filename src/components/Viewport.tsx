import { useCallback, useEffect, useRef, useState, type JSX, type PointerEvent as ReactPointerEvent } from 'react';

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

  const view = useApp((s) => s.view);
  const showGrid = useApp((s) => s.showGrid);

  const previewW = source.previewBitmap.width;
  const previewH = source.previewBitmap.height;

  /* 尺寸跟随容器 */
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* 适配窗口 */
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

  /* 换图后请求一次适配（等容器量到尺寸再执行） */
  useEffect(() => {
    needFitRef.current = true;
  }, [source]);

  useEffect(() => {
    if (!needFitRef.current || !box.w || !box.h) return;
    needFitRef.current = false;
    fit();
  }, [box.w, box.h, fit]);

  /* 以视口中心为锚点缩放 */
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
    useApp.getState().setView({
      zoom: next,
      panX: cx - ix * next,
      panY: cy - iy * next,
    });
  }, []);

  /* 1:1 原尺寸并居中 */
  const zoomTo100 = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    useApp.getState().setView({
      zoom: 1,
      panX: (el.clientWidth - previewW) / 2,
      panY: (el.clientHeight - previewH) / 2,
    });
  }, [previewW, previewH]);

  /* 光标位置 → 源像素坐标 */
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

  /* 滚轮缩放：以光标为锚点。需要非被动监听才能 preventDefault */
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
      useApp.getState().setView({
        zoom: next,
        panX: mx - ix * next,
        panY: my - iy * next,
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  /* 视图快捷键：0 = 适配窗口，1 = 1:1，+/- = 缩放 */
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

  /* 平移拖拽 */
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    // M0 左键暂时用于平移；M2 起左键交给绘图工具，平移改用中键 / 空格
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

  /* 绘制 */
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

    const dw = previewW * view.zoom;
    const dh = previewH * view.zoom;
    const x = view.panX;
    const y = view.panY;

    drawChecker(ctx, x, y, dw, dh, cw, ch);

    ctx.imageSmoothingEnabled = view.zoom < 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source.previewBitmap, x, y, dw, dh);

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
  }, [source, view, showGrid, box.w, box.h, previewW, previewH]);

  return (
    <div
      ref={containerRef}
      className={`viewport${panning ? ' viewport--panning' : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPan}
      onPointerCancel={endPan}
      onPointerLeave={(event) => {
        endPan(event);
        useApp.getState().setCursor(null);
      }}
    >
      <canvas ref={canvasRef} className="viewport__canvas" />
      <div className="viewport__hud">
        <span>
          缩放 <b>{view.zoom >= 1 ? view.zoom.toFixed(2) : view.zoom.toFixed(3)}×</b>
        </span>
        <span>·</span>
        <span>滚轮缩放 · 拖拽平移</span>
      </div>
      <div className="viewport__controls">
        <button
          type="button"
          className="btn btn--icon"
          onClick={() => zoomBy(1 / 1.5)}
          title="缩小（-）"
          aria-label="缩小"
        >
          −
        </button>
        <button
          type="button"
          className="btn btn--icon"
          onClick={() => zoomBy(1.5)}
          title="放大（+）"
          aria-label="放大"
        >
          +
        </button>
        <button type="button" className="btn" onClick={fit} title="适配窗口（0）">
          适配
        </button>
        <button type="button" className="btn" onClick={zoomTo100} title="原尺寸（1）">
          1:1
        </button>
      </div>
    </div>
  );
}