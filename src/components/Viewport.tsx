import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { compositeInto, gridToRgba } from '@/core/composite';
import { readCell } from '@/core/edit';
import { TOOLS, brushFootprint } from '@/core/tools';
import { createGrid, type EditLayer, type Palette, type PixelGrid, type SourceImage } from '@/core/types';
import { beginStroke, cancelStroke, endStroke, isStroking, moveStroke, strokePreview } from '@/state/paint';
import { useApp } from '@/state/store';
import {
  ACCENT,
  ACCENT_FILL,
  ACCENT_SOLID,
  dashedRect,
  drawChecker,
  drawGrid,
  fillCells,
  outlineCell,
  thinRect,
} from './canvasDraw';

const MIN_ZOOM = 0.02;
const MAX_ZOOM = 64;
/** 适配窗口时四周留白 */
const FIT_PADDING = 44;
/** 源像素网格只在这个倍率以上绘制（没有转换结果时才使用） */
const SOURCE_GRID_MIN_ZOOM = 8;
/** 大网格降采样画网格线的阈值 */
const GRID_COARSE_THRESHOLD = 128;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

interface PanSession {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

/** 光标位置的三种读数：源像素、格坐标，以及是否能在此落笔 */
interface PointerLoc {
  sourceX: number;
  sourceY: number;
  cellX: number;
  cellY: number;
  inImage: boolean;
}

interface GridBuffer {
  canvas: HTMLCanvasElement;
  grid: PixelGrid;
  imageData: ImageData;
}

export function Viewport({ source }: { source: SourceImage }): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const baseRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const panRef = useRef<PanSession | null>(null);
  const strokePointerRef = useRef<number | null>(null);
  const needFitRef = useRef(true);
  const spaceRef = useRef(false);
  const gridBufferRef = useRef<GridBuffer | null>(null);

  const [panning, setPanning] = useState(false);
  const [spaceDown, setSpaceDown] = useState(false);
  const [box, setBox] = useState({ w: 0, h: 0 });
  const [splitDragging, setSplitDragging] = useState(false);

  const view = useApp((s) => s.view);
  const showGrid = useApp((s) => s.showGrid);
  const mode = useApp((s) => s.compareMode);
  const splitPos = useApp((s) => s.splitPos);
  const baseGrid = useApp((s) => s.baseGrid);
  const palette = useApp((s) => s.palette);
  const editLayer = useApp((s) => s.editLayer);
  const editVersion = useApp((s) => s.editVersion);
  const selection = useApp((s) => s.selection);
  const overlaySource = useApp((s) => s.overlaySource);
  const overlayOpacity = useApp((s) => s.overlayOpacity);
  const tool = useApp((s) => s.tool);
  const brushSize = useApp((s) => s.brushSize);
  const symmetry = useApp((s) => s.symmetry);

  const previewW = source.previewBitmap.width;
  const previewH = source.previewBitmap.height;
  const gridW = baseGrid?.w ?? 0;
  const gridH = baseGrid?.h ?? 0;
  const hasResult = baseGrid !== null;

  /** 是否处于可落笔的视图：并排模式没有共用坐标，仅原图模式没有网格 */
  const canDraw = hasResult && (mode === 'result' || mode === 'split');
  const toolInfo = TOOLS[tool];

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

  /* ------------------------------------------------------ 坐标反查 */

  const locate = useCallback(
    (clientX: number, clientY: number): PointerLoc | null => {
      const el = containerRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const { zoom, panX, panY } = useApp.getState().view;
      const ix = Math.floor((clientX - rect.left - panX) / zoom);
      const iy = Math.floor((clientY - rect.top - panY) / zoom);
      const inImage = ix >= 0 && iy >= 0 && ix < previewW && iy < previewH;
      const gx = gridW > 0 ? Math.floor((ix / previewW) * gridW) : -1;
      const gy = gridH > 0 ? Math.floor((iy / previewH) * gridH) : -1;
      const scale = source.previewScale;
      return {
        sourceX: Math.floor(ix * scale),
        sourceY: Math.floor(iy * scale),
        cellX: gx,
        cellY: gy,
        inImage,
      };
    },
    [previewW, previewH, gridW, gridH, source.previewScale],
  );

  /** 分割线左半边是原图，不允许在那边落笔，否则画的是看不见的地方 */
  const inDrawArea = useCallback(
    (clientX: number): boolean => {
      if (mode !== 'split') return true;
      const el = containerRef.current;
      if (!el) return true;
      const rect = el.getBoundingClientRect();
      return clientX - rect.left >= splitPos * rect.width;
    },
    [mode, splitPos],
  );

  const reportCursor = useCallback(
    (clientX: number, clientY: number) => {
      const store = useApp.getState();
      const loc = locate(clientX, clientY);
      if (!loc || !loc.inImage) {
        if (store.cursor) store.setCursor(null);
        if (store.hover) store.setHover(null);
        return;
      }
      if (store.cursor?.x !== loc.sourceX || store.cursor?.y !== loc.sourceY) {
        store.setCursor({ x: loc.sourceX, y: loc.sourceY });
      }

      const grid = store.baseGrid;
      if (!grid || loc.cellX < 0 || loc.cellY < 0 || loc.cellX >= grid.w || loc.cellY >= grid.h) {
        if (store.hover) store.setHover(null);
        return;
      }
      const cell = readCell(grid, store.editLayer, loc.cellX, loc.cellY);
      const prev = store.hover;
      if (
        prev &&
        prev.x === loc.cellX &&
        prev.y === loc.cellY &&
        prev.index === cell.index &&
        prev.alpha === cell.alpha
      ) {
        return;
      }
      store.setHover({ x: loc.cellX, y: loc.cellY, index: cell.index, alpha: cell.alpha });
    },
    [locate],
  );

  /* ------------------------------------------------------ 滚轮缩放 */

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (isStroking()) return;
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

  /* ------------------------------------------------------ 缩放快捷键 */

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

  /* 空格拖拽平移：按住空格期间左键也用于平移 */
  useEffect(() => {
    const down = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      if (!spaceRef.current) {
        spaceRef.current = true;
        setSpaceDown(true);
      }
    };
    const up = (event: KeyboardEvent) => {
      if (event.code !== 'Space') return;
      spaceRef.current = false;
      setSpaceDown(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);

  /* ------------------------------------------------------ 像素层绘制 */

  const ensureGridBuffer = (w: number, h: number): GridBuffer => {
    const current = gridBufferRef.current;
    if (current && current.grid.w === w && current.grid.h === h) return current;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const next: GridBuffer = { canvas, grid: createGrid(w, h), imageData: new ImageData(w, h) };
    gridBufferRef.current = next;
    return next;
  };

  /** 把合成后的网格画进离屏小画布（尺寸 = 网格尺寸，放大交给 drawImage） */
  const renderGridCanvas = (
    grid: PixelGrid,
    edit: EditLayer | null,
    pal: Palette,
  ): HTMLCanvasElement => {
    const buffer = ensureGridBuffer(grid.w, grid.h);
    const ctx = buffer.canvas.getContext('2d');
    if (!ctx) return buffer.canvas;
    compositeInto(grid, edit, buffer.grid);
    gridToRgba(buffer.grid, pal, buffer.imageData.data);
    ctx.putImageData(buffer.imageData, 0, 0);
    return buffer.canvas;
  };

  const renderBase = useCallback(() => {
    const canvas = baseRef.current;
    const el = containerRef.current;
    if (!canvas || !el) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (!cw || !ch) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelW = Math.round(cw * dpr);
    const pixelH = Math.round(ch * dpr);
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const store = useApp.getState();
    const grid = store.baseGrid;
    const pixel = grid ? renderGridCanvas(grid, store.editLayer, store.palette) : null;

    /* ---- 并排模式：各占一半，各自适配 ---- */
    if (mode === 'sideBySide' && grid && pixel) {
      const gap = 12;
      const halfW = (cw - gap * 2) / 2;

      const drawFitted = (
        image: CanvasImageSource | null,
        iw: number,
        ih: number,
        x: number,
        y: number,
        w: number,
        h: number,
        pixelated: boolean,
      ) => {
        const k = Math.min(w / iw, h / ih);
        const dw = iw * k;
        const dh = ih * k;
        const dx = x + (w - dw) / 2;
        const dy = y + (h - dh) / 2;
        drawChecker(ctx, dx, dy, dw, dh, cw, ch);
        if (image) {
          ctx.imageSmoothingEnabled = !pixelated && k < 1;
          ctx.drawImage(image, dx, dy, dw, dh);
        }
        thinRect(ctx, dx, dy, dw, dh, 'rgba(124,140,162,0.45)');
      };

      drawFitted(source.previewBitmap, previewW, previewH, gap, gap, halfW, ch - gap * 2, false);
      drawFitted(pixel, grid.w, grid.h, gap * 2 + halfW, gap, halfW, ch - gap * 2, true);

      ctx.fillStyle = 'rgba(140,151,166,0.85)';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.fillText('原图', gap + halfW / 2, 12);
      ctx.fillText(`像素图 ${grid.w}×${grid.h}`, gap * 2 + halfW + halfW / 2, 12);
      return;
    }

    /* ---- 共用视图：侧滑分割 / 仅结果 / 仅原图 ---- */
    const dw = previewW * view.zoom;
    const dh = previewH * view.zoom;
    const x = view.panX;
    const y = view.panY;

    drawChecker(ctx, x, y, dw, dh, cw, ch);

    if (mode === 'result' && grid && pixel) {
      const cellSize = dw / grid.w;
      ctx.imageSmoothingEnabled = cellSize < 1;
      ctx.drawImage(pixel, x, y, dw, dh);
    } else if (mode === 'split' && grid && pixel) {
      const splitX = splitPos * cw;

      // 左半：原图
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, splitX, ch);
      ctx.clip();
      ctx.imageSmoothingEnabled = view.zoom < 1;
      ctx.drawImage(source.previewBitmap, x, y, dw, dh);
      ctx.restore();

      // 右半：像素图
      ctx.save();
      ctx.beginPath();
      ctx.rect(splitX, 0, cw - splitX, ch);
      ctx.clip();
      const cellSize = dw / grid.w;
      ctx.imageSmoothingEnabled = cellSize < 1;
      ctx.drawImage(pixel, x, y, dw, dh);
      ctx.restore();

      // 分割线
      ctx.strokeStyle = 'rgba(233,168,60,0.9)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(splitX) + 0.5, 0);
      ctx.lineTo(Math.round(splitX) + 0.5, ch);
      ctx.stroke();
    } else {
      ctx.imageSmoothingEnabled = view.zoom < 1;
      ctx.drawImage(source.previewBitmap, x, y, dw, dh);
    }

    /* ---- 原图叠加：描线时对照细节用（只作用于「仅结果」视图） ---- */
    if (overlaySource && grid && mode === 'result') {
      ctx.save();
      ctx.globalAlpha = overlayOpacity;
      ctx.imageSmoothingEnabled = view.zoom < 1;
      ctx.drawImage(source.previewBitmap, x, y, dw, dh);
      ctx.restore();
    }

    // 图像边界
    thinRect(ctx, x, y, dw, dh, 'rgba(124,140,162,0.45)');
  }, [source, view, mode, splitPos, overlaySource, overlayOpacity, previewW, previewH, box.w, box.h, baseGrid, editLayer, palette, editVersion]);

  useEffect(renderBase, [renderBase]);

  /* ------------------------------------------------------ 覆盖层绘制 */

  const renderOverlay = useCallback(() => {
    const canvas = overlayRef.current;
    const el = containerRef.current;
    if (!canvas || !el) return;
    const cw = el.clientWidth;
    const ch = el.clientHeight;
    if (!cw || !ch) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelW = Math.round(cw * dpr);
    const pixelH = Math.round(ch * dpr);
    if (canvas.width !== pixelW || canvas.height !== pixelH) {
      canvas.width = pixelW;
      canvas.height = pixelH;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);

    const store = useApp.getState();
    const zoom = store.view.zoom;
    const x = store.view.panX;
    const y = store.view.panY;
    const dw = previewW * zoom;
    const dh = previewH * zoom;
    const grid = store.baseGrid;

    /* ---- 网格线 ---- */
    if (store.showGrid) {
      if (grid) {
        const cellW = dw / grid.w;
        const cellH = dh / grid.h;
        const step = grid.w > GRID_COARSE_THRESHOLD || grid.h > GRID_COARSE_THRESHOLD ? 4 : 1;
        drawGrid(
          ctx,
          { ox: x, oy: y, cols: grid.w, rows: grid.h, cellW, cellH, step, majorEvery: step * 8 },
          cw,
          ch,
        );
      } else if (zoom >= SOURCE_GRID_MIN_ZOOM) {
        drawGrid(
          ctx,
          {
            ox: x,
            oy: y,
            cols: previewW,
            rows: previewH,
            cellW: zoom,
            cellH: zoom,
            step: 1,
            majorEvery: 8,
          },
          cw,
          ch,
        );
      }
    }

    if (!grid) return;
    const cellW = dw / grid.w;
    const cellH = dh / grid.h;

    /* ---- 选区与拖动预览 ---- */
    const preview = strokePreview();
    if (preview?.points) {
      fillCells(ctx, preview.points, x, y, cellW, cellH, ACCENT_SOLID);
    }
    if (store.selection) {
      const sx = store.selection;
      dashedRect(
        ctx,
        x + sx.x * cellW,
        y + sx.y * cellH,
        sx.w * cellW,
        sx.h * cellH,
        'rgba(255,255,255,0.9)',
      );
    }
    if (preview?.rect) {
      const r = preview.rect;
      thinRect(ctx, x + r.x * cellW, y + r.y * cellH, r.w * cellW, r.h * cellH, ACCENT);
    }

    /* ---- 笔刷光标 ---- */
    const hover = store.hover;
    const drawable = store.compareMode === 'result' || store.compareMode === 'split';
    if (hover && drawable && !isStroking()) {
      const activeTool = TOOLS[store.tool];
      if (activeTool.kind === 'pick') {
        outlineCell(ctx, hover.x, hover.y, cellW, cellH, x, y, ACCENT);
      } else if (activeTool.kind === 'select') {
        outlineCell(ctx, hover.x, hover.y, cellW, cellH, x, y, 'rgba(255,255,255,0.5)');
      } else {
        const footprint = brushFootprint(hover, {
          w: grid.w,
          h: grid.h,
          brushSize: store.brushSize,
          symmetry: store.symmetry,
        });
        fillCells(ctx, footprint, x, y, cellW, cellH, ACCENT_FILL);
        // 只给落点那一格描边，否则对称镜像的每一格都在闪
        outlineCell(ctx, hover.x, hover.y, cellW, cellH, x, y, ACCENT);
      }
    }
  }, [previewW, previewH, box.w, box.h]);

  useEffect(renderOverlay, [renderOverlay]);

  /** 画笔/光标变化要立刻反映到覆盖层，但 hover 是每帧都变的 store 值，
   *  让它进依赖会让整个组件跟着重渲染 —— 所以走命令式调用。 */
  const renderOverlayRef = useRef(renderOverlay);
  renderOverlayRef.current = renderOverlay;

  useEffect(() => {
    renderOverlayRef.current();
  }, [showGrid, selection, tool, brushSize, symmetry, editVersion, view, mode, splitPos, baseGrid, editLayer]);

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

  /* ------------------------------------------------------ 指针交互 */

  const interactive = mode !== 'sideBySide';

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const wantPan = event.button === 1 || spaceRef.current;

    /* 左键落笔：仅在有网格结果、且不在原图那一侧时 */
    if (event.button === 0 && !wantPan && canDraw) {
      const loc = locate(event.clientX, event.clientY);
      if (loc && loc.inImage && inDrawArea(event.clientX)) {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        strokePointerRef.current = event.pointerId;
        const started = beginStroke({ x: loc.cellX, y: loc.cellY }, event.altKey);
        if (!started) {
          useApp.getState().pushToast('warn', '还没有像素图：先调一下转换参数生成结果');
        }
        renderOverlayRef.current();
        return;
      }
    }

    if (event.button !== 0 && event.button !== 1) return;
    if (!interactive) return;

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
    reportCursor(event.clientX, event.clientY);

    /* 正在进行笔画：只更新笔画，不平移 */
    if (strokePointerRef.current === event.pointerId) {
      const loc = locate(event.clientX, event.clientY);
      if (loc) moveStroke({ x: loc.cellX, y: loc.cellY });
      renderOverlayRef.current();
      return;
    }

    const pan = panRef.current;
    if (pan && pan.pointerId === event.pointerId) {
      useApp.getState().setView({
        panX: pan.originX + (event.clientX - pan.startX),
        panY: pan.originY + (event.clientY - pan.startY),
      });
    }
    renderOverlayRef.current();
  };

  const finishStroke = (event: ReactPointerEvent<HTMLDivElement>, canceled: boolean) => {
    if (strokePointerRef.current !== event.pointerId) return false;
    strokePointerRef.current = null;
    if (canceled) cancelStroke();
    else endStroke();
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    renderOverlayRef.current();
    return true;
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

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (finishStroke(event, false)) return;
    endPan(event);
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (finishStroke(event, true)) return;
    endPan(event);
  };

  const crosshair = canDraw && tool !== 'eyedropper' && tool !== 'select';
  const cursor = panning ? 'grabbing' : spaceDown ? 'grab' : crosshair ? 'crosshair' : 'default';

  const modeLabel =
    mode === 'split'
      ? '左原图 / 右像素图'
      : mode === 'result'
        ? '仅像素图'
        : mode === 'source'
          ? '仅原图'
          : '并排对照';

  return (
    <div
      ref={containerRef}
      className={`viewport${panning ? ' viewport--panning' : ''}${interactive ? '' : ' viewport--static'}`}
      style={{ cursor }}
      onPointerDown={interactive ? onPointerDown : undefined}
      onPointerMove={interactive ? onPointerMove : undefined}
      onPointerUp={interactive ? onPointerUp : undefined}
      onPointerCancel={interactive ? onPointerCancel : undefined}
      onPointerLeave={(event) => {
        if (strokePointerRef.current !== null) return;
        if (panRef.current) endPan(event);
        if (useApp.getState().cursor) useApp.getState().setCursor(null);
        if (useApp.getState().hover) useApp.getState().setHover(null);
        renderOverlayRef.current();
      }}
    >
      <canvas ref={baseRef} className="viewport__canvas" />
      <canvas ref={overlayRef} className="viewport__overlay" />

      {mode === 'split' && hasResult && (
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
        <span>{modeLabel}</span>
        {canDraw && (
          <>
            <span>·</span>
            <span>
              <b>{toolInfo.label}</b>
            </span>
            <span>
              笔刷 <b>{brushSize}</b>
            </span>
            {symmetry !== 'none' && <span>对称</span>}
            {spaceDown && <span>平移中</span>}
          </>
        )}
      </div>

      {hasResult && !canDraw && (
        <div className="viewport__notice">
          {mode === 'sideBySide' ? '并排视图不响应绘制' : '「仅原图」视图下不能绘制'}
        </div>
      )}

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