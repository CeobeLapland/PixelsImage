/**
 * 应用状态（Zustand）。
 *
 * 分片对应 docs/DESIGN.md §9：
 *   source   —— 源图与解码状态
 *   doc      —— 工作文档（M1 起填充）
 *   settings —— 转换参数
 *   tool     —— 编辑器工具
 *   ui       —— 视图、光标、提示
 *
 * 之所以用 Zustand 而非 React state：画布事件与 core/ 的工具函数需要
 * 在 React 之外读写状态（useApp.getState()）。
 */

import { create, type StateCreator } from 'zustand';

import { isProbablyImage, loadSourceImage } from '@/core/image';
import { DEFAULT_PALETTE_ID, resolvePalette } from '@/palettes/builtin';
import {
  makeDefaultSettings,
  type ConvertSettings,
  type PreprocessSettings,
  type Palette,
  type PixelDocument,
  type PixelGrid,
  type SourceImage,
  type SymmetryMode,
  type ToolId,
} from '@/core/types';

/* ------------------------------------------------------------------ 类型 */

export type SourceStatus = 'idle' | 'decoding' | 'ready' | 'error';
export type ToastKind = 'info' | 'warn' | 'error';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

/** 画布视图变换：zoom 为像素放大倍率，pan 为图像左上角在画布中的偏移 */
export interface ViewTransform {
  zoom: number;
  panX: number;
  panY: number;
}

/** 对比视图模式 */
export type CompareMode = 'split' | 'sideBySide' | 'result' | 'source';

/** 一次转换的产出信息 */
export interface ConvertInfo {
  targetW: number;
  targetH: number;
  usedColors: number;
  trimmed: boolean;
  ms: number;
  /** 是否走了主线程降级路径 */
  fallback: boolean;
}

export interface SourceSlice {
  source: SourceImage | null;
  sourceStatus: SourceStatus;
  sourceError: string | null;
  loadSource: (file: File | Blob, fallbackName?: string) => Promise<void>;
  clearSource: () => void;
}

export interface DocSlice {
  doc: PixelDocument | null;
  setDoc: (doc: PixelDocument | null) => void;
}

/** 转换结果（M1）。编辑层在 M2 接入后会并入 PixelDocument。 */
export interface ConvertSlice {
  /** 当前调色板对象（由 settings.paletteId 解析得到） */
  palette: Palette;
  setPalette: (palette: Palette) => void;

  baseGrid: PixelGrid | null;
  /** 供 canvas 绘制的位图，与 baseGrid 同步更新 */
  resultBitmap: ImageBitmap | null;
  info: ConvertInfo | null;
  converting: boolean;
  convertError: string | null;

  applyResult: (grid: PixelGrid, bitmap: ImageBitmap, info: ConvertInfo) => void;
  setConverting: (converting: boolean) => void;
  setConvertError: (message: string | null) => void;
  clearResult: () => void;
}

export interface SettingsSlice {
  settings: ConvertSettings;
  patchSettings: (patch: Partial<ConvertSettings>) => void;
  patchPreprocess: (patch: Partial<PreprocessSettings>) => void;
  resetSettings: () => void;
}

export interface ToolSlice {
  tool: ToolId;
  brushSize: number;
  symmetry: SymmetryMode;
  /** 前景色 = 调色板索引 */
  foreground: number;
  setTool: (tool: ToolId) => void;
  setBrushSize: (size: number) => void;
  setSymmetry: (mode: SymmetryMode) => void;
  setForeground: (index: number) => void;
}

export interface UiSlice {
  view: ViewTransform;
  setView: (patch: Partial<ViewTransform>) => void;
  /** 光标所在的源图像素坐标；移出画布时为 null */
  cursor: { x: number; y: number } | null;
  setCursor: (p: { x: number; y: number } | null) => void;
  showGrid: boolean;
  setShowGrid: (v: boolean) => void;
  panelCollapsed: boolean;
  togglePanel: () => void;
  busy: string | null;
  setBusy: (label: string | null) => void;
  toasts: Toast[];
  pushToast: (kind: ToastKind, text: string) => void;
  dismissToast: (id: number) => void;

  compareMode: CompareMode;
  setCompareMode: (mode: CompareMode) => void;
  /** 侧滑分割线的位置，0-1，相对画布宽度 */
  splitPos: number;
  setSplitPos: (v: number) => void;
  /**
   * 用户正在拖动某个控件。
   * 转换时据此判断是否降级到快速模式（跳过 CIELAB），见 docs/DESIGN.md §8。
   */
  interacting: boolean;
  setInteracting: (v: boolean) => void;
}

export type AppStore = SourceSlice &
  DocSlice &
  ConvertSlice &
  SettingsSlice &
  ToolSlice &
  UiSlice;

/* ------------------------------------------------------------ 常量与工具 */

const TOAST_TTL = 6000;
let toastSeq = 0;

const IDENTITY_VIEW: ViewTransform = { zoom: 1, panX: 0, panY: 0 };

/* ------------------------------------------------------------------ 分片 */

const createSourceSlice: StateCreator<AppStore, [], [], SourceSlice> = (set, get) => ({
  source: null,
  sourceStatus: 'idle',
  sourceError: null,

  async loadSource(file, fallbackName) {
    if (file instanceof File && !isProbablyImage(file)) {
      get().pushToast('error', `「${file.name}」不是图片文件`);
      return;
    }

    set({ sourceStatus: 'decoding', sourceError: null });
    try {
      const source = await loadSourceImage(file, fallbackName);
      // 换图即作废旧结果，避免编辑层与新图尺寸不一致
      get().clearResult();
      set({ source, sourceStatus: 'ready', sourceError: null, doc: null });
      if (source.truncated) {
        get().pushToast(
          'warn',
          `原图 ${source.originalWidth}×${source.originalHeight} 超出处理上限，已降采样为 ${source.imageData.width}×${source.imageData.height}`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : '解码失败';
      set({ sourceStatus: 'error', sourceError: message });
      get().pushToast('error', message);
    }
  },

  clearSource() {
    const current = get().source;
    if (current) current.previewBitmap.close();
    get().clearResult();
    set({ source: null, sourceStatus: 'idle', sourceError: null, doc: null, cursor: null });
  },
});

const createDocSlice: StateCreator<AppStore, [], [], DocSlice> = (set) => ({
  doc: null,
  setDoc: (doc) => set({ doc }),
});

const createConvertSlice: StateCreator<AppStore, [], [], ConvertSlice> = (set, get) => ({
  palette: resolvePalette(DEFAULT_PALETTE_ID),
  setPalette: (palette) => set({ palette }),

  baseGrid: null,
  resultBitmap: null,
  info: null,
  converting: false,
  convertError: null,

  applyResult: (grid, bitmap, info) => {
    // 手动释放上一张位图，否则长时间调参会一直累积显存
    const previous = get().resultBitmap;
    if (previous && previous !== bitmap) previous.close();
    set({ baseGrid: grid, resultBitmap: bitmap, info, converting: false, convertError: null });
  },

  setConverting: (converting) => set({ converting }),
  setConvertError: (message) => set({ convertError: message, converting: false }),

  clearResult: () => {
    const previous = get().resultBitmap;
    if (previous) previous.close();
    set({ baseGrid: null, resultBitmap: null, info: null, convertError: null, converting: false });
  },
});

const createSettingsSlice: StateCreator<AppStore, [], [], SettingsSlice> = (set) => ({
  settings: makeDefaultSettings(),

  patchSettings: (patch) => set((s) => ({ settings: { ...s.settings, ...patch } })),

  patchPreprocess: (patch) =>
    set((s) => ({
      settings: { ...s.settings, preprocess: { ...s.settings.preprocess, ...patch } },
    })),

  resetSettings: () => set({ settings: makeDefaultSettings() }),
});

const createToolSlice: StateCreator<AppStore, [], [], ToolSlice> = (set) => ({
  tool: 'pencil',
  brushSize: 1,
  symmetry: 'none',
  foreground: 0,

  setTool: (tool) => set({ tool }),
  setBrushSize: (brushSize) => set({ brushSize: Math.max(1, Math.min(4, Math.round(brushSize))) }),
  setSymmetry: (symmetry) => set({ symmetry }),
  setForeground: (foreground) => set({ foreground: Math.max(0, Math.round(foreground)) }),
});

const createUiSlice: StateCreator<AppStore, [], [], UiSlice> = (set, get) => ({
  view: { ...IDENTITY_VIEW },
  setView: (patch) => set((s) => ({ view: { ...s.view, ...patch } })),

  cursor: null,
  setCursor: (cursor) => set({ cursor }),

  showGrid: true,
  setShowGrid: (showGrid) => set({ showGrid }),

  panelCollapsed: false,
  togglePanel: () => set((s) => ({ panelCollapsed: !s.panelCollapsed })),

  busy: null,
  setBusy: (busy) => set({ busy }),

  toasts: [],
  pushToast: (kind, text) => {
    toastSeq += 1;
    const toast: Toast = { id: toastSeq, kind, text };
    set((s) => ({ toasts: [...s.toasts, toast] }));
    setTimeout(() => get().dismissToast(toast.id), TOAST_TTL);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),

  compareMode: 'split',
  setCompareMode: (compareMode) => set({ compareMode }),

  splitPos: 0.5,
  setSplitPos: (v) => set({ splitPos: v < 0 ? 0 : v > 1 ? 1 : v }),

  interacting: false,
  setInteracting: (interacting) => set({ interacting }),
});

/* --------------------------------------------------------------- 组装 */

export const useApp = create<AppStore>()((...args) => ({
  ...createSourceSlice(...args),
  ...createDocSlice(...args),
  ...createConvertSlice(...args),
  ...createSettingsSlice(...args),
  ...createToolSlice(...args),
  ...createUiSlice(...args),
}));