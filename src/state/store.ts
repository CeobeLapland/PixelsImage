/**
 * 应用状态（Zustand）。
 *
 * 分片对应 docs/DESIGN.md §9：
 *   source   —— 源图与解码状态
 *   doc      —— 工作文档（M7 存档用）
 *   convert  —— 转换结果与调色板
 *   settings —— 转换参数
 *   edit     —— 手工编辑层、选区、撤销栈（M2）
 *   tool     —— 编辑器工具
 *   ui       —— 视图、光标、提示
 *
 * 之所以用 Zustand 而非 React state：画布事件与 core/ 的工具函数需要
 * 在 React 之外读写状态（useApp.getState()）。
 */

import { create, type StateCreator } from 'zustand';

import { applyCellEdits, cloneEditLayer, countEdits, resampleEditLayer, type CellEdit } from '@/core/edit';
import { isProbablyImage, loadSourceImage } from '@/core/image';
import { DEFAULT_PALETTE_ID, resolvePalette } from '@/palettes/builtin';
import {
  createEditLayer,
  makeDefaultSettings,
  type ConvertSettings,
  type PreprocessSettings,
  type Palette,
  type PixelCell,
  type PixelDocument,
  type EditLayer,
  type PixelGrid,
  type Rect,
  type SourceImage,
  type SymmetryMode,
  type ToolId,
} from '@/core/types';
import {
  createHistory,
  pushHistory,
  stepBack,
  stepForward,
  type HistoryState,
} from './history';

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

/** 光标所在的格及其取值（状态栏读数） */
export interface HoverInfo {
  x: number;
  y: number;
  /** 该格当前生效的调色板索引 */
  index: number;
  alpha: number;
}

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

export interface ConvertSlice {
  /** 当前调色板对象（由 settings.paletteId 解析得到） */
  palette: Palette;
  setPalette: (palette: Palette) => void;

  baseGrid: PixelGrid | null;
  info: ConvertInfo | null;
  converting: boolean;
  convertError: string | null;

  /**
   * 落库一次转换结果。调色板随结果一起写入（docs/DESIGN.md 决策 13），
   * 网格尺寸变化时按比例重采样手工编辑层，保证「调参不毁手改」。
   */
  applyResult: (grid: PixelGrid, palette: Palette, info: ConvertInfo) => void;
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

/**
 * 手工编辑 —— 双层编辑模型（docs/DESIGN.md §3.4）在状态层的落地。
 *
 * 编辑层**就地修改**（每次 pointermove 都可能写），因此内容变化不会改变
 * 它的对象引用；`editVersion` 就是给渲染方看的版本号，谁依赖它就跟着重绘。
 */
export interface EditSlice {
  /** 当前网格尺寸下的手工编辑层 */
  editLayer: EditLayer | null;
  /**
   * 手工编辑的基准层：始终是「上一次真正动手编辑时的尺寸与内容」。
   *
   * 尺寸变更时从它重采样，而不是在已经重采样过的结果上再采一次 ——
   * 拖动「目标格数」滑块会连续触发十几次转换，逐次重采样会把手工编辑
   * 一路抹平。有了基准层，反复拖动尺寸只在最终落点产生一次重采样。
   */
  editOrigin: { w: number; h: number; layer: EditLayer } | null;
  /** 手工覆盖过的格子数，面板与状态栏显示用 */
  editedCount: number;
  /** 编辑层内容版本号：自增即代表需要重绘 */
  editVersion: number;

  selection: Rect | null;
  /** 原图半透明叠加（描线对照用），仅在「仅结果」视图生效 */
  overlaySource: boolean;
  overlayOpacity: number;

  history: HistoryState;

  clearEditLayer: () => void;
  setSelection: (rect: Rect | null) => void;
  setOverlaySource: (v: boolean) => void;
  setOverlayOpacity: (v: number) => void;
  /** 工具已就地改了 editLayer，这里只通知重绘（不进撤销栈） */
  touchEditLayer: () => void;
  /** 收笔：把一次操作的改动建成撤销记录 */
  commitEdits: (label: string, edits: CellEdit[]) => void;
  undo: () => void;
  redo: () => void;
}

export interface ToolSlice {
  tool: ToolId;
  brushSize: number;
  symmetry: SymmetryMode;
  /** 前景色 = 调色板索引 */
  foreground: number;
  /** 背景色 = 调色板索引，X 键与前景交换 */
  background: number;
  /** 矩形/椭圆是否填充 */
  shapeFill: boolean;
  setTool: (tool: ToolId) => void;
  setBrushSize: (size: number) => void;
  setSymmetry: (mode: SymmetryMode) => void;
  setForeground: (index: number) => void;
  setBackground: (index: number) => void;
  swapColors: () => void;
  setShapeFill: (v: boolean) => void;
}

export interface UiSlice {
  view: ViewTransform;
  setView: (patch: Partial<ViewTransform>) => void;
  /** 光标所在的源图像素坐标；移出画布时为 null */
  cursor: { x: number; y: number } | null;
  setCursor: (p: { x: number; y: number } | null) => void;
  /** 光标所在的格与取值（有网格结果时才有） */
  hover: HoverInfo | null;
  setHover: (h: HoverInfo | null) => void;
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
  EditSlice &
  ToolSlice &
  UiSlice;

/* ------------------------------------------------------------ 常量与工具 */

const TOAST_TTL = 6000;
let toastSeq = 0;

const IDENTITY_VIEW: ViewTransform = { zoom: 1, panX: 0, panY: 0 };

/** 编辑层尺寸未变时返回原对象：拖参数滑块时每帧都会走到这里，克隆不起 */
function layerForSize(
  current: EditLayer | null,
  origin: { w: number; h: number; layer: EditLayer } | null,
  w: number,
  h: number,
): EditLayer {
  if (current && current.w === w && current.h === h) return current;
  if (origin) return resampleEditLayer(origin.layer, w, h);
  return createEditLayer(w, h);
}

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
    set({ source: null, sourceStatus: 'idle', sourceError: null, doc: null, cursor: null, hover: null });
  },
});

const createDocSlice: StateCreator<AppStore, [], [], DocSlice> = (set) => ({
  doc: null,
  setDoc: (doc) => set({ doc }),
});

const createConvertSlice: StateCreator<AppStore, [], [], ConvertSlice> = (set, get) => ({
  palette: resolvePalette(DEFAULT_PALETTE_ID),
  setPalette: (palette) =>
    set((s) => {
      // 换到更小的调色板时，前景/背景索引可能越界。
      // 越界的索引不会报错，只会静默渲染成最后一个色 —— 那比崩溃更难发现。
      const last = Math.max(0, palette.colors.length - 1);
      return {
        palette,
        foreground: Math.min(s.foreground, last),
        background: Math.min(s.background, last),
      };
    }),

  baseGrid: null,
  info: null,
  converting: false,
  convertError: null,

  applyResult: (grid, palette, info) => {
    const previous = get().editLayer;
    const sizeChanged = !previous || previous.w !== grid.w || previous.h !== grid.h;
    const edits = previous ? countEdits(previous) : 0;
    const nextLayer = sizeChanged
      ? layerForSize(previous, get().editOrigin, grid.w, grid.h)
      : previous;

    set({
      baseGrid: grid,
      palette,
      info,
      converting: false,
      convertError: null,
      editLayer: nextLayer,
      editedCount: sizeChanged ? countEdits(nextLayer) : get().editedCount,
      // 尺寸变了选区就没意义了
      selection: sizeChanged ? null : get().selection,
      editVersion: get().editVersion + 1,
    });

    if (sizeChanged && edits > 0) {
      get().pushToast(
        'info',
        `网格尺寸变为 ${grid.w}×${grid.h}，${edits} 个手工修改已按比例重采样`,
      );
    }
  },

  setConverting: (converting) => set({ converting }),
  setConvertError: (message) => set({ convertError: message, converting: false }),

  clearResult: () =>
    set({
      baseGrid: null,
      info: null,
      convertError: null,
      converting: false,
      editLayer: null,
      editOrigin: null,
      editedCount: 0,
      editVersion: 0,
      selection: null,
      history: createHistory(),
      hover: null,
    }),
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

const createEditSlice: StateCreator<AppStore, [], [], EditSlice> = (set, get) => ({
  editLayer: null,
  editOrigin: null,
  editedCount: 0,
  editVersion: 0,
  selection: null,
  overlaySource: false,
  overlayOpacity: 0.45,
  history: createHistory(),

  clearEditLayer: () => {
    const layer = get().editLayer;
    if (!layer) return;
    const edits: CellEdit[] = [];
    for (let i = 0; i < layer.cells.length; i += 1) {
      const cell: PixelCell | null = layer.cells[i] ?? null;
      if (!cell) continue;
      edits.push({ index: i, before: cell, after: null });
    }
    if (edits.length === 0) {
      get().pushToast('info', '当前没有手工修改的格子');
      return;
    }
    // 'after' 侧是 null → 清空；撤销时写回 'before' 侧即可恢复
    applyCellEdits(layer, edits, 'after');
    get().commitEdits('清空编辑层', edits);
    get().pushToast('info', `已清空 ${edits.length} 个手工修改的格子（可撤销）`);
  },

  setSelection: (selection) => set({ selection }),
  setOverlaySource: (overlaySource) => set({ overlaySource }),
  setOverlayOpacity: (v) => set({ overlayOpacity: v < 0 ? 0 : v > 1 ? 1 : v }),

  touchEditLayer: () => set((s) => ({ editVersion: s.editVersion + 1 })),

  commitEdits: (label, edits) => {
    if (edits.length === 0) return;
    const layer = get().editLayer;
    const base = get().baseGrid;
    set((s) => ({
      history: pushHistory(s.history, { label, edits }),
      editedCount: countEdits(layer),
      editVersion: s.editVersion + 1,
      // 动手之后的尺寸就是新的基准尺寸
      editOrigin: layer && base ? { w: layer.w, h: layer.h, layer: cloneEditLayer(layer) } : s.editOrigin,
    }));
  },

  undo: () => {
    const state = get();
    const step = stepBack(state.history);
    if (!step || !state.editLayer) {
      state.pushToast('info', '没有可撤销的操作');
      return;
    }
    applyCellEdits(state.editLayer, step.edits, 'before');
    set((s) => ({
      history: step.state,
      editedCount: countEdits(s.editLayer),
      editVersion: s.editVersion + 1,
    }));
  },

  redo: () => {
    const state = get();
    const step = stepForward(state.history);
    if (!step || !state.editLayer) {
      state.pushToast('info', '没有可重做的操作');
      return;
    }
    applyCellEdits(state.editLayer, step.edits, 'after');
    set((s) => ({
      history: step.state,
      editedCount: countEdits(s.editLayer),
      editVersion: s.editVersion + 1,
    }));
  },
});

const createToolSlice: StateCreator<AppStore, [], [], ToolSlice> = (set) => ({
  tool: 'pencil',
  brushSize: 1,
  symmetry: 'none',
  foreground: 0,
  background: 1,
  shapeFill: false,

  setTool: (tool) => set({ tool }),
  setBrushSize: (brushSize) => set({ brushSize: Math.max(1, Math.min(4, Math.round(brushSize))) }),
  setSymmetry: (symmetry) => set({ symmetry }),
  setForeground: (foreground) =>
    set({ foreground: foreground < 0 ? 0 : Math.round(foreground) }),
  setBackground: (background) => set({ background: background < 0 ? 0 : Math.round(background) }),
  swapColors: () => set((s) => ({ foreground: s.background, background: s.foreground })),
  setShapeFill: (shapeFill) => set({ shapeFill }),
});

const createUiSlice: StateCreator<AppStore, [], [], UiSlice> = (set, get) => ({
  view: { ...IDENTITY_VIEW },
  setView: (patch) => set((s) => ({ view: { ...s.view, ...patch } })),

  cursor: null,
  setCursor: (cursor) => set({ cursor }),

  hover: null,
  setHover: (hover) => set({ hover }),

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
  ...createEditSlice(...args),
  ...createToolSlice(...args),
  ...createUiSlice(...args),
}));