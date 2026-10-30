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

import { DEFAULT_NAME_TEMPLATE, buildBatchNames } from '@/core/batch/naming';
import {
  parsePresets,
  serializePresets,
  uniquePresetName,
  type BatchPreset,
} from '@/core/batch/presets';
import {
  createBatchItem,
  mergeSettings,
  nextPendingItem,
  patchItem,
  removeItem,
  resetResults,
  settingsFingerprint,
  summarize,
  type BatchItem,
} from '@/core/batch/queue';
import { createZip, type ZipEntry } from '@/core/batch/zip';
import { applyCellEdits, applyEditWrites, changesToEdits, cloneEditLayer, countEdits, resampleEditLayer, writeCell, type CellEdit, type CellWrite } from '@/core/edit';
import { composite } from '@/core/composite';
import { buildLightnessLadder, nearestLadderIndex } from '@/core/color/ladder';
import { planLocalRequantize, type LocalRequantizeRequest } from '@/core/color/requantize';
import { countUsedColors } from '@/core/color/quantize';
import { toHex } from '@/core/color/space';
import { decodeImage, blobToDataUrl, dataUrlToBlob, formatBytes, isProbablyImage, loadSourceImage, makeThumbnail, MAX_ANIMATION_FRAMES, sniffImage, splitAnimatedFrames } from '@/core/image';
import { checkSeams, type SeamReport } from '@/core/assists/tile';
import { countSolidCells, planOutline, type OutlineOptions } from '@/core/assists/outline';
import { planShade, type ShadeOptions } from '@/core/assists/shade';
import { copyPngToClipboard, copyTextToClipboard } from '@/core/exporters/clipboard';
import { sanitizeBlockMap, suggestBlockMap, type BlockMap } from '@/core/exporters/blocks';
import { downloadBlob, exportGridPng } from '@/core/exporters/png';
import {
  DEFAULT_EXPORTER_ID,
  getExporter,
  mergeOptionValues,
  numOf,
  paletteHexText,
  stemOf,
  strOf,
  type ExportContext,
  type ExportOptionValues,
} from '@/core/exporters/registry';
import { BUILTIN_PALETTES, DEFAULT_PALETTE_ID, resolvePalette } from '@/palettes/builtin';
import { mergeSimilarColors, remapEditLayer, remapGridIndices, sortColors, type SortKey } from '@/palettes/ops';
import {
  parseConvertPresets,
  serializeConvertPresets,
  type ConvertPreset,
} from '@/core/presets';
import {
  buildProject,
  buildProjectName,
  describeProject,
  parseProject,
  serializeProject,
} from '@/core/project';
import { buildBatchZip, getBatchConverter } from './batch';
import {
  createEditLayer,
  makeDefaultSettings,
  PALETTE_MAX_COLORS,
  type ConvertSettings,
  type PreprocessSettings,
  type Palette,
  type PixelCell,
  type PixelDocument,
  type EditLayer,
  type PixelGrid,
  type RGBA,
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
  /**
   * 导入时拿到的原始文件/Blob。
   *
   * 留着它是为了存档：`.pixproj` 要把源图内嵌进去，而**原始文件字节**比
   * 「把解码后的像素重新编码成 PNG」小得多（一张 JPEG 照片差 3–5 倍）。
   * 浏览器对 File 通常是磁盘句柄而非常驻内存，所以留着它本身几乎不占内存。
   */
  sourceBlob: File | Blob | null;
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

/**
 * 调色板引擎（M3）。
 *
 * 三类操作的区别很关键：
 * - **全局换色**：改写格子（写进编辑层）→ 进撤销栈、可持久；
 * - **改色 / 排序 / 合并**：改的是调色板本身 → 不入撤销栈（与转换参数同理），
 *   但要**同步重映射索引**，否则底图与编辑层会指错槽位；
 * - **内置板只读**：任何要改颜色的操作都先分叉成一份自定义板，
 *   避免污染共享的内置数据（否则两块画布会互相串味）。
 */
export interface PaletteSlice {
  /** 自定义调色板（提色 / 导入 / 编辑内置板的产物），持久化在 localStorage */
  customPalettes: Record<string, Palette | undefined>;

  /** 把全图中索引为 `from` 的格子改成 `to`；写进编辑层，可撤销 */
  replaceColor: (from: number, to: number) => void;
  /** 改某一槽的颜色；改内置板会先分叉出一份自定义板 */
  editPaletteColor: (index: number, color: RGBA) => void;
  /** 排序调色板（分叉内置板 + 重映射索引） */
  sortPalette: (key: SortKey) => void;
  /** 合并近似色（分叉内置板 + 重映射索引） */
  mergePaletteColors: (tolerance: number) => void;
  /** 新增一块自定义板并切过去 */
  addCustomPalette: (palette: Palette) => void;
  /**
   * 为调色板里某个颜色生成「明度阶梯」，追加到当前板末尾并选中离原色最近的一档。
   *
   * 直接在 LAB 里改 L*（见 core/color/ladder.ts），所以是同色相的一串明暗。
   * 追加而不插入：追加不会改变已有槽位的索引，底图与编辑层一个字都不用动；
   * 插入则要整体重映射，为了「排序好看」付这个代价不值。
   */
  addLightnessLadder: (index: number, steps: number) => void;
  /**
   * 把一批颜色追加到当前板末尾（同色不重复追加）。
   * 追加不改已有索引，所以底图与编辑层都不用重映射。
   */
  appendPaletteColors: (colors: readonly RGBA[], note?: string) => void;
  /** 重命名自定义板；重名会自动加序号 */
  renamePalette: (id: string, name: string) => void;
  /** 删除自定义板；删的若正是当前板则切回默认板 */
  removeCustomPalette: (id: string) => void;
}

/**
 * 智能辅助（M4）。
 *
 * 这些操作都是「算一批格子 → 一次性写进编辑层 → 记成一条撤销记录」，
 * 与画笔走同一套记账路径，所以每一个都能 Ctrl+Z 撤销。
 * 它们**改的是手改层**而不是底图：底图是转换参数的产物，改它下次调参就白改了。
 */
export interface AssistSlice {
  /** 3×3 平铺预览（画布按九宫格重复绘制，看无缝效果） */
  tilePreview: boolean;
  setTilePreview: (v: boolean) => void;
  /** 最近一次接缝检查结果；null = 还没检查过 */
  seam: SeamReport | null;
  setSeam: (report: SeamReport | null) => void;

  runOutline: (opts: OutlineOptions) => void;
  runShade: (opts: ShadeOptions) => void;
  /**
   * 局部换板：把选区内的格子按目标调色板重新映射（可带抖动），
   * 用到的目标色追加到当前板末尾；其余格子保持原样，结果可撤销。
   */
  requantizeSelection: (request: LocalRequantizeRequest) => void;
  /** 检查平铺接缝，结果存进 `seam` 供画布标注 */
  runSeamCheck: () => void;
}

/**
 * 批量处理（M5）。
 *
 * **参数是独立的一份**（`batchSettings`），不与编辑器共用。
 * 这是踩过的坑：一开始想直接复用「转换」面板那套参数，看起来省事，
 * 但批量在后台出素材时，编辑器的参数随时会被你调着试效果 ——
 * 两边互相串改，最后既不知道批量用的什么参数，刚调好的预览也被改了。
 * 独立一份 + 一个「从当前参数同步」按钮，代价只是多点一下。
 *
 * 队列项的参数 = `batchSettings` + 该项的 `override`。存差异而不是存全量：
 * 绝大多数图共用一套参数，只有个别图需要单独改尺寸。
 *
 * 转换用的是**独立的** Worker（见 state/batch.ts），所以批量在后台跑的时候，
 * 编辑器里的单图预览照常可调、互不打断。
 */
export interface BatchSlice {
  batchItems: BatchItem[];
  /** 批量专用的转换参数 */
  batchSettings: ConvertSettings;
  /** 命名模板，占位符见 core/batch/naming.ts */
  batchTemplate: string;
  /** 导出放大倍数 */
  batchScale: number;
  /** 透明区是否压白底 */
  batchOpaque: boolean;
  batchRunning: boolean;
  /** 跑这一轮时用的参数指纹：与当前参数不一致就说明「结果已过期」 */
  batchRunFingerprint: string | null;
  /** 正在编辑器里单独微调的队列项 */
  batchActiveId: string | null;
  /** 并排对比视图是否打开 */
  compareOpen: boolean;
  batchPresets: BatchPreset[];

  setCompareOpen: (open: boolean) => void;

  /** 加入队列；顺便生成缩略图（失败也不影响入队） */
  addBatchFiles: (files: readonly File[]) => Promise<void>;
  removeBatchItem: (id: string) => void;
  clearBatch: () => void;
  /** 设置某一项的逐项参数覆盖 */
  patchBatchItem: (id: string, patch: Partial<ConvertSettings>) => void;
  clearBatchOverride: (id: string) => void;
  patchBatchSettings: (patch: Partial<ConvertSettings>) => void;
  patchBatchPreprocess: (patch: Partial<PreprocessSettings>) => void;
  setBatchTemplate: (template: string) => void;
  setBatchScale: (scale: number) => void;
  setBatchOpaque: (opaque: boolean) => void;
  /** 把「转换」面板里当前这套参数抄过来当批量参数 */
  syncBatchSettings: () => void;
  runBatch: () => Promise<void>;
  stopBatch: () => void;
  /** 已完成的项退回待处理，用于改完参数重跑 */
  resetBatchResults: () => void;
  /** 把该项的源图与参数送进主编辑器单独微调 */
  editBatchItem: (id: string) => Promise<void>;
  /**
   * 把编辑器里当前这张图（**含手工修改**）写回队列项，作为它的导出内容。
   *
   * 为什么需要显式一步：手改住在编辑层里，队列项手里只有一份「参数产物」的网格。
   * 不写回的话，用户在编辑器里改了半天、导出 zip 却还是原样 —— 属于静默丢改动，
   * 绝不能靠「记得回单图导出」这种约定来兜。
   */
  commitEditorToBatch: (id: string) => void;
  exportBatchZip: () => Promise<void>;
  saveBatchPreset: (name: string) => void;
  applyBatchPreset: (id: string) => void;
  removeBatchPreset: (id: string) => void;
}

/**
 * 导出（M6）。
 *
 * 选项值按导出器 id 分开存：切来切去不会互相覆盖（图集的「每行几格」
 * 和蓝图的「每格像素」是两个完全不同的概念）。
 * 选项的**定义**在 core/exporters/registry.ts 的 schema 里，这里只存值 ——
 * 于是「面板限制 1–64 而导出器按 1–32 处理」这种对不上的情况不可能发生。
 */
export interface ExportSlice {
  exporting: boolean;
  /** 当前选中的导出器 id */
  exporterId: string;
  /** 各导出器的选项值，键是导出器 id */
  exportOptions: Record<string, ExportOptionValues | undefined>;
  /** 多文件产出是否打成一个 zip（分页蓝图一导就是好几张，逐个下载会被浏览器拦） */
  exportPackZip: boolean;
  /** 调色板颜色（RRGGBB 大写）→ 方块 id 的用户覆盖 */
  blockMap: BlockMap;
  /** 导出完成后最近一次的说明文字，显示在按钮下方 */
  lastExportNote: string | null;

  setExporter: (id: string) => void;
  patchExportOptions: (patch: ExportOptionValues) => void;
  setExportPackZip: (v: boolean) => void;
  /** 改某个颜色对应的方块 */
  setBlockFor: (colorKey: string, blockId: string) => void;
  /** 全部退回「自动挑最接近的方块」 */
  resetBlockMap: () => void;
  runExport: () => Promise<void>;
  /** 把当前像素图（按 PNG 导出器的倍数/底色设置）复制到剪贴板 */
  copyPngAsImage: () => Promise<void>;
  copyPaletteText: () => Promise<void>;
}

/**
 * 存档与预设（M7）。
 *
 * 存档把**源图内嵌**进 `.pixproj`（理由见 core/project.ts 的注释），
 * 所以存/读都要编解码一次图片，放在主线程会卡一下 —— 用一个 busy 标记
 * 让按钮变成「正在处理…」，用户至少知道它在干活。
 */
export interface ProjectSlice {
  /** 最近一次存档的时间；null = 本次会话还没存过 */
  projectSavedAt: number | null;
  projectBusy: boolean;
  convertPresets: ConvertPreset[];
  /** 快捷键帮助面板开关 */
  shortcutsOpen: boolean;

  setShortcutsOpen: (open: boolean) => void;
  saveProject: () => Promise<void>;
  loadProjectFile: (file: File) => Promise<void>;
  saveConvertPreset: (name: string) => void;
  applyConvertPreset: (id: string) => void;
  removeConvertPreset: (id: string) => void;
  /** 抹掉工作区（图 / 结果 / 队列），但不动预设这些用户数据 */
  clearWorkspace: () => void;
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

  /**
   * 转换已降级到主线程（Web Worker 不可用或崩了）。
   *
   * 由 usePipeline 在每次拿到结果时同步。之所以要显式暴露到 UI：
   * 降级后界面**只是变卡**，不提示的话用户会以为是图太大或者自己电脑不行。
   */
  workerFallback: boolean;
}

export type AppStore = SourceSlice &
  DocSlice &
  ConvertSlice &
  SettingsSlice &
  EditSlice &
  PaletteSlice &
  AssistSlice &
  BatchSlice &
  ExportSlice &
  ProjectSlice &
  ToolSlice &
  UiSlice;

/* ------------------------------------------------------------ 常量与工具 */

const TOAST_TTL = 6000;
let toastSeq = 0;
let paletteSeq = 0;
/** 批量跑批的轮次标记：自增即表示「上一轮作废」（用户点了停止） */
let batchRunToken = 0;

const IDENTITY_VIEW: ViewTransform = { zoom: 1, panX: 0, panY: 0 };

/** 自定义调色板的持久化键。带版本号：将来结构变了可以另起一个键，不必写迁移代码 */
const PALETTE_STORAGE_KEY = 'pixelsimage.palettes.v1';

function loadCustomPalettes(): Record<string, Palette | undefined> {
  try {
    // 测试跑在 node 里，没有 localStorage；这里必须容错而不是依赖调用方判断
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(PALETTE_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, Palette | undefined> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      const p = value as Palette;
      // 存进去的数据可能是旧版本或被手改过，形状不对就整条丢掉
      if (p && typeof p.id === 'string' && Array.isArray(p.colors) && p.colors.length > 0) {
        out[id] = { ...p, builtin: false, source: p.source ?? 'custom' };
      }
    }
    return out;
  } catch {
    return {};
  }
}

function saveCustomPalettes(customs: Record<string, Palette | undefined>): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(PALETTE_STORAGE_KEY, JSON.stringify(customs));
  } catch {
    // 隐私模式或配额满：存不下就算了，绝不让持久化失败影响当前操作
  }
}

/** 新建一块自定义板的 id */
function nextCustomId(): string {
  paletteSeq += 1;
  return `custom-${Date.now().toString(36)}-${paletteSeq}`;
}

/** 批处理预设的持久化键。与调色板同理，带版本号 */
const BATCH_PRESET_STORAGE_KEY = 'pixelsimage.batchPresets.v1';

function loadBatchPresets(): BatchPreset[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(BATCH_PRESET_STORAGE_KEY);
    return raw ? parsePresets(raw) : [];
  } catch {
    return [];
  }
}

function saveBatchPresets(presets: readonly BatchPreset[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(BATCH_PRESET_STORAGE_KEY, serializePresets(presets));
  } catch {
    // 存不下就算了，绝不让持久化失败影响当前操作（与调色板同一策略）
  }
}

/**
 * 导出设置的持久化。
 *
 * 方块映射表尤其需要存：那是用户一个个挑出来的手工结果，
 * 刷新一次就没了的话，没人愿意去配第二遍。
 */
const EXPORT_STORAGE_KEY = 'pixelsimage.export.v1';

interface StoredExportSettings {
  exporterId?: string;
  options?: Record<string, ExportOptionValues | undefined>;
  packZip?: boolean;
  blockMap?: Record<string, unknown>;
}

function loadExportSettings(): StoredExportSettings {
  try {
    if (typeof localStorage === 'undefined') return {};
    const raw = localStorage.getItem(EXPORT_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as StoredExportSettings;
  } catch {
    return {};
  }
}

function saveExportSettings(settings: StoredExportSettings): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(EXPORT_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 同上：存不下不影响当前操作
  }
}

/** 转换预设的持久化键 */
const CONVERT_PRESET_STORAGE_KEY = 'pixelsimage.convertPresets.v1';

function loadConvertPresets(): ConvertPreset[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(CONVERT_PRESET_STORAGE_KEY);
    return raw ? parseConvertPresets(raw) : [];
  } catch {
    return [];
  }
}

function saveConvertPresets(presets: readonly ConvertPreset[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(CONVERT_PRESET_STORAGE_KEY, serializeConvertPresets(presets));
  } catch {
    // 存不下就算了
  }
}

/**
 * 在已有名字之外找一个不重名的。
 *
 * 重名不是纯粹的观感问题：下拉框里冒出两个「导入的调色板」时，用户根本分不清
 * 哪块是哪块，删错一块就再也找不回来了。所以**任何登记入口都过一遍这里**。
 * 序号用半角括号：中文全角括号太宽，在窄面板里会被截断。
 */
function uniqueName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} (${n})`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base} (${Date.now().toString(36)})`;
}

/** 剥掉「（已编辑）」与「 (2)」这类自动后缀，得到干净的基础名 */
function stripEditSuffix(name: string): string {
  let out = name;
  for (let i = 0; i < 4; i += 1) {
    const next = out.replace(/（已编辑）$/, '').replace(/ \(\d+\)$/, '');
    if (next === out) break;
    out = next;
  }
  return out.trim() || name;
}

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
  sourceBlob: null,

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
      set({ source, sourceStatus: 'ready', sourceError: null, doc: null, sourceBlob: file });
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
    set({
      source: null,
      sourceStatus: 'idle',
      sourceError: null,
      doc: null,
      sourceBlob: null,
      cursor: null,
      hover: null,
    });
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
    // 限色模式回传的板可能比上一块短，前景/背景索引要跟着夹住
    const lastColor = Math.max(0, palette.colors.length - 1);

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
      foreground: Math.min(get().foreground, lastColor),
      background: Math.min(get().background, lastColor),
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

const createPaletteSlice: StateCreator<AppStore, [], [], PaletteSlice> = (set, get) => {
  /** 把一块板复制成可写的新自定义板（内置板是共享常量，绝不能就地改） */
  const forkPalette = (p: Palette): Palette => ({
    ...p,
    id: nextCustomId(),
    // 反复分叉时名字不该越滚越长（X（已编辑）（已编辑）…），所以先剥掉旧后缀
    name: p.builtin ? `${stripEditSuffix(p.name)}（已编辑）` : p.name,
    builtin: false,
    source: 'custom',
  });

  /** 拿到一块「可写」的调色板：内置板先分叉 */
  const writable = (): Palette => {
    const current = get().palette;
    return current.builtin ? forkPalette(current) : current;
  };

  /** 落库一块自定义板并切过去 */
  const registerAndSelect = (palette: Palette, silent = false): void => {
    // 重名先去重：内置板的名字也算「已占用」，否则自定义板会顶掉内置板的名字辨识度
    const customs = get().customPalettes;
    const name = uniqueName(palette.name, [
      ...Object.values(customs).map((p) => p?.name ?? ''),
      ...BUILTIN_PALETTES.map((p) => p.name),
    ]);
    const named = name === palette.name ? palette : { ...palette, name };

    const next = { ...customs, [named.id]: named };
    saveCustomPalettes(next);
    set((s) => ({
      customPalettes: next,
      palette: named,
      settings: { ...s.settings, paletteId: named.id },
      // 新板可能更短，前景/背景索引要跟着夹住
      foreground: Math.min(s.foreground, named.colors.length - 1),
      background: Math.min(s.background, named.colors.length - 1),
    }));
    if (!silent) {
      get().pushToast(
        'info',
        `已保存为自定义调色板「${named.name}」（${named.colors.length} 色）`,
      );
    }
  };

  /** 落库一次调色板变更；`forked` 表示它是一块刚分叉出来的新板 */
  const commitPalette = (palette: Palette, forked: boolean, note?: string): void => {
    if (forked) {
      registerAndSelect(palette, true);
    } else {
      const customs = { ...get().customPalettes, [palette.id]: palette };
      saveCustomPalettes(customs);
      set({ customPalettes: customs, palette });
    }
    if (note) get().pushToast('info', note);
  };

  /**
   * 排序 / 合并这类会改变槽位顺序的操作：必须把底图与编辑层一起重映射。
   * 底图的改写是「临时」的（下次转换会按新调色板重算）；
   * 编辑层的改写是「永久」的 —— 漏掉它画面看起来正常，但手改的格子会突然变色。
   */
  const applyRemap = (colors: RGBA[], map: readonly number[], note: string): void => {
    const state = get();
    const base = state.baseGrid;
    const layer = state.editLayer;
    if (base) remapGridIndices(base, map);
    if (layer) remapEditLayer(layer, map);

    const target = writable();
    commitPalette({ ...target, colors }, target !== state.palette, note);
    // 渲染走 store.palette + 网格，两者都变了，必须让画布重绘
    set((s) => ({ editVersion: s.editVersion + 1 }));
  };

  return {
    customPalettes: loadCustomPalettes(),

    replaceColor: (from, to) => {
      const state = get();
      const base = state.baseGrid;
      const layer = state.editLayer;
      if (!base || !layer) {
        state.pushToast('warn', '还没有像素图，无法换色');
        return;
      }
      if (from === to) return;

      const changes = new Map<number, PixelCell | null>();
      for (let i = 0; i < base.indices.length; i += 1) {
        const cell = layer.cells[i] ?? null;
        const index = cell ? cell.index : base.indices[i];
        const alpha = cell ? cell.alpha : base.alpha[i];
        if (index !== from) continue;
        // 写进编辑层而不是改底图：底图下次转换就会被重算冲掉，
        // 而编辑层是持久的，并且天然走撤销栈
        writeCell(layer, i, { index: to, alpha }, changes);
      }

      const edits = changesToEdits(changes, layer);
      if (edits.length === 0) {
        state.pushToast('info', `图里没有用到 #${from} 的格子`);
        return;
      }
      state.commitEdits(`换色 #${from} → #${to}`, edits);
      state.pushToast('info', `已把 ${edits.length} 格从 #${from} 换成 #${to}（可撤销）`);
    },

    editPaletteColor: (index, color) => {
      const current = get().palette;
      if (index < 0 || index >= current.colors.length) return;

      const target = writable();
      const colors = target.colors.slice();
      colors[index] = color;
      // 改色不改变任何索引的含义，所以不需要重映射
      commitPalette({ ...target, colors }, target !== current);
      set((s) => ({ editVersion: s.editVersion + 1 }));
    },

    sortPalette: (key) => {
      const state = get();
      const { colors, map } = sortColors(state.palette.colors, key);
      applyRemap(
        colors,
        map,
        `调色板已按${key === 'luminance' ? '明度' : '色相'}排序${state.palette.builtin ? '（已生成自定义板）' : ''}`,
      );
    },

    mergePaletteColors: (tolerance) => {
      const state = get();
      const before = state.palette.colors.length;
      const { colors, map } = mergeSimilarColors(state.palette.colors, tolerance);
      const merged = before - colors.length;
      if (merged <= 0) {
        state.pushToast('info', '没有距离在容差内的颜色可合并，试试调大容差');
        return;
      }
      applyRemap(
        colors,
        map,
        `已合并 ${merged} 个近似色，调色板 ${before} → ${colors.length} 色`,
      );
    },

    addCustomPalette: (palette) => {
      // 一定换新 id：提色结果是按参数命名的（kmeans-16），直接沿用会互相覆盖
      registerAndSelect({
        ...palette,
        id: nextCustomId(),
        builtin: false,
        source: palette.source ?? 'custom',
      });
    },

    addLightnessLadder: (index, steps) => {
      const state = get();
      const color = state.palette.colors[index];
      if (!color) return;

      const ladder = buildLightnessLadder(color, { steps });
      const target = writable();
      const offset = target.colors.length;
      const next: Palette = { ...target, colors: [...target.colors, ...ladder] };
      commitPalette(
        next,
        target !== state.palette,
        `已为 ${toHex(color[0], color[1], color[2])} 追加 ${ladder.length} 档明暗（第 ${offset + 1}–${offset + ladder.length} 色）`,
      );

      // 前景色落到离原色最近的那一档：用户刚点的颜色不该被抢走
      set({
        foreground: offset + nearestLadderIndex(ladder, color),
        background: Math.min(state.background, next.colors.length - 1),
      });
    },

    appendPaletteColors: (colors, note) => {
      if (colors.length === 0) return;
      const state = get();
      const target = writable();

      // 同色不重复追加：否则一次局部换板会把板里塞进一堆看不见的重复色
      const seen = new Set(target.colors.map((c) => `${c[0]},${c[1]},${c[2]}`));
      const fresh: RGBA[] = [];
      for (const color of colors) {
        const key = `${color[0]},${color[1]},${color[2]}`;
        if (seen.has(key)) continue;
        seen.add(key);
        fresh.push(color);
      }
      if (fresh.length === 0) return;
      if (target.colors.length + fresh.length > PALETTE_MAX_COLORS) {
        get().pushToast('warn', `追加后会超过 ${PALETTE_MAX_COLORS} 色上限，已取消`);
        return;
      }

      const next: Palette = { ...target, colors: [...target.colors, ...fresh] };
      commitPalette(next, target !== state.palette, note);
      set((s) => ({ background: Math.min(s.background, next.colors.length - 1) }));
    },

    renamePalette: (id, rawName) => {
      const state = get();
      const target = state.customPalettes[id];
      if (!target) return;

      const trimmed = rawName.trim();
      if (trimmed === '') return;
      // 改名时要把「自己」从占用名单里排除，否则改回原名会被误判为重名
      const name = uniqueName(trimmed, [
        ...Object.values(state.customPalettes)
          .filter((p) => p && p.id !== id)
          .map((p) => p?.name ?? ''),
        ...BUILTIN_PALETTES.map((p) => p.name),
      ]);

      const renamed: Palette = { ...target, name };
      const customs = { ...state.customPalettes, [id]: renamed };
      saveCustomPalettes(customs);
      set({
        customPalettes: customs,
        // 改的正是当前板时，同步显示
        palette: state.palette.id === id ? renamed : state.palette,
      });
      if (name !== trimmed) {
        state.pushToast('info', `已有同名调色板，已重命名为「${name}」`);
      }
    },

    removeCustomPalette: (id) => {
      const state = get();
      if (!state.customPalettes[id]) return;
      const customs = { ...state.customPalettes };
      delete customs[id];
      saveCustomPalettes(customs);

      // 正在用这块板：切回默认板，否则界面会拿着一个悬空 id 渲染
      if (state.settings.paletteId === id) {
        const fallback = resolvePalette(DEFAULT_PALETTE_ID);
        set((s) => ({
          customPalettes: customs,
          palette: fallback,
          settings: { ...s.settings, paletteId: fallback.id },
          foreground: Math.min(s.foreground, fallback.colors.length - 1),
          background: Math.min(s.background, fallback.colors.length - 1),
        }));
      } else {
        set({ customPalettes: customs });
      }
      state.pushToast('info', '已删除该自定义调色板');
    },
  };
};

const createAssistSlice: StateCreator<AppStore, [], [], AssistSlice> = (set, get) => {
  /**
   * 把一批待写入的格子落库成一次可撤销的操作。
   * 描边 / 明暗分层 / 将来别的自动辅助都走这里，行为完全一致：
   * 没有可改动的地方就只提示，不往撤销栈里塞空记录。
   */
  const applyWrites = (label: string, writes: readonly CellWrite[]): void => {
    const layer = get().editLayer;
    if (!layer) {
      get().pushToast('warn', '还没有像素图，先用不了自动辅助');
      return;
    }
    if (writes.length === 0) {
      get().pushToast('info', `${label}：没有需要改动的地方`);
      return;
    }

    const changes = new Map<number, PixelCell | null>();
    applyEditWrites(layer, writes, changes);
    const edits = changesToEdits(changes, layer);
    if (edits.length === 0) {
      get().pushToast('info', `${label}：这些格子已经符合目标状态`);
      return;
    }
    get().commitEdits(label, edits);
    get().pushToast('info', `${label}：已处理 ${edits.length} 格（可撤销）`);
  };

  return {
    tilePreview: false,
    setTilePreview: (tilePreview) => set({ tilePreview }),
    seam: null,
    setSeam: (seam) => set({ seam }),

    runOutline: (opts) => {
      const { baseGrid, editLayer } = get();
      if (!baseGrid) {
        get().pushToast('warn', '还没有像素图，先调一下转换参数');
        return;
      }
      const writes = planOutline(baseGrid, editLayer, opts);
      if (writes.length === 0) {
        const solid = countSolidCells(baseGrid, editLayer);
        const total = baseGrid.w * baseGrid.h;
        const mode = opts.mode ?? 'outside';
        // 「没效果」这个反馈里最常见的其实是「这张图没有透明区域」：
        // 外缘描边要有空白可画，整张实心时它正确地什么也不做。
        // 直接说清楚，比让人以为功能坏了强。
        if (solid === total && (mode === 'outside' || mode === 'both')) {
          get().pushToast(
            'warn',
            '这张图没有透明区域（整张都是实心），外缘描边无处可画。想给形状勾边请选「内缘」',
          );
          return;
        }
        if (solid === 0) {
          get().pushToast('warn', '这张图全是透明格，没有形状可描边');
          return;
        }
        get().pushToast('info', '自动描边：形状边缘已经都是这个颜色了');
        return;
      }
      applyWrites('自动描边', writes);
    },

    runShade: (opts) => {
      const { baseGrid, editLayer, palette } = get();
      if (!baseGrid) {
        get().pushToast('warn', '还没有像素图，先调一下转换参数');
        return;
      }
      applyWrites('自动明暗分层', planShade(baseGrid, editLayer, palette, opts));
    },

    requantizeSelection: (request) => {
      const state = get();
      const { baseGrid, editLayer, selection } = state;
      if (!baseGrid || !editLayer) {
        state.pushToast('warn', '还没有像素图，先调一下转换参数');
        return;
      }
      if (!selection) {
        state.pushToast('warn', '先在画布上用「选区」工具（M）框一块区域');
        return;
      }

      // 以「眼前看到的」为准：局部操作基于合成结果，而不是底层那次转换
      const grid = composite(baseGrid, editLayer);

      let result;
      try {
        result = planLocalRequantize(grid, state.palette, { ...request, region: selection });
      } catch (err) {
        state.pushToast('warn', err instanceof Error ? err.message : String(err));
        return;
      }

      if (result.writes.length === 0) {
        state.pushToast('info', '局部换板：选区里的颜色已经和目标板一致');
        return;
      }

      // 先追加颜色（不改已有索引），再把格子指向新槽位
      if (result.addedColors.length > 0) get().appendPaletteColors(result.addedColors);

      applyWrites(
        result.addedColors.length > 0
          ? `局部换板（板 +${result.addedColors.length} 色）`
          : '局部换板',
        result.writes,
      );
    },

    runSeamCheck: () => {
      const { baseGrid, editLayer } = get();
      if (!baseGrid) {
        get().pushToast('warn', '还没有像素图，无从检查接缝');
        return;
      }
      const report = checkSeams(baseGrid, editLayer);
      set({ seam: report });
      if (report.mismatches === 0) {
        get().pushToast('info', `接缝检查通过：${report.total} 对边界全部对得上，可以无缝平铺`);
      } else {
        get().pushToast(
          'warn',
          `发现 ${report.mismatches} 处接缝不匹配（已在画布上标出），平铺时会出现可见的缝`,
        );
      }
    },
  };
};

const createBatchSlice: StateCreator<AppStore, [], [], BatchSlice> = (set, get) => ({
  batchItems: [],
  batchSettings: makeDefaultSettings(),
  batchTemplate: DEFAULT_NAME_TEMPLATE,
  batchScale: 1,
  batchOpaque: false,
  batchRunning: false,
  batchRunFingerprint: null,
  batchActiveId: null,
  compareOpen: false,
  batchPresets: loadBatchPresets(),

  setCompareOpen: (compareOpen) => set({ compareOpen }),

  addBatchFiles: async (files) => {
    /*
     * 动图（GIF / WebP / APNG）先拆成逐帧 PNG 再入队：队列的顺序就是播放顺序，
     * 每帧带上它在源动图里的时长，GIF / .ase 导出时能还原原始节奏。
     * 拆不出来就退化成单张 —— 不因为一个怪文件把整批挡在门外。
     *
     * 格式判断一律**看文件头字节**（sniffImage），不看扩展名：动图被另存成 `.jpg`
     * 是常有的事，只看名字会把它当静态图、静默只取第一帧。
     */
    const items: BatchItem[] = [];
    let animations = 0;
    let animationFrames = 0;
    let truncatedCount = 0;
    let rejected = 0;
    const failures: string[] = [];

    for (const file of files) {
      let sniff: Awaited<ReturnType<typeof sniffImage>> = null;
      try {
        sniff = await sniffImage(file);
      } catch {
        sniff = null;
      }

      // 文件头认不出、名字也不像图片 → 跳过（名字像图片的仍交给解码器，由它给出错误）
      if (!sniff && !isProbablyImage(file)) {
        rejected += 1;
        continue;
      }

      if (sniff?.mayAnimate) {
        try {
          const split = await splitAnimatedFrames(file, MAX_ANIMATION_FRAMES, sniff);
          if (split) {
            animations += 1;
            animationFrames += split.frames.length;
            if (split.truncated) truncatedCount += 1;
            for (const frame of split.frames) items.push(createBatchItem(frame.file, frame.delayMs));
            continue;
          }
        } catch (err) {
          failures.push(`${file.name}：${err instanceof Error ? err.message : String(err)}`);
        }
      }
      items.push(createBatchItem(file));
    }

    if (items.length === 0) {
      get().pushToast('warn', '没有可识别的图片文件');
      return;
    }

    set((s) => ({ batchItems: [...s.batchItems, ...items] }));

    const parts = [
      `已加入 ${items.length} 项`,
      animations > 0 ? `其中 ${animations} 个动图拆成 ${animationFrames} 帧` : '',
      rejected > 0 ? `跳过 ${rejected} 个非图片文件` : '',
      truncatedCount > 0 ? `有动图超过 ${MAX_ANIMATION_FRAMES} 帧，只取了前面部分` : '',
    ].filter(Boolean);
    get().pushToast('info', parts.join('，'));
    if (failures.length > 0) get().pushToast('warn', failures[0] as string);

    // 缩略图异步补上：解码失败就留空，UI 退化成文件名占位，不影响入队
    for (const item of items) {
      void makeThumbnail(item.file).then((thumb) => {
        if (!thumb) return;
        // 队列可能已经被清空或该项已被移除，这里要再确认一次
        if (!get().batchItems.some((i) => i.id === item.id)) {
          thumb.close();
          return;
        }
        set((s) => ({ batchItems: patchItem(s.batchItems, item.id, { thumb }) }));
      });
    }
  },

  removeBatchItem: (id) => {
    const target = get().batchItems.find((i) => i.id === id);
    target?.thumb?.close();
    set((s) => ({
      batchItems: removeItem(s.batchItems, id),
      batchActiveId: s.batchActiveId === id ? null : s.batchActiveId,
    }));
  },

  clearBatch: () => {
    for (const item of get().batchItems) item.thumb?.close();
    set({ batchItems: [], batchActiveId: null, batchRunFingerprint: null });
  },

  patchBatchItem: (id, patch) =>
    set((s) => {
      const target = s.batchItems.find((i) => i.id === id);
      if (!target) return {};
      return {
        batchItems: patchItem(s.batchItems, id, {
          override: { ...target.override, ...patch },
          // 参数变了，这一项上次的结果就不算数了 —— 否则导出时会把旧结果也打进去
          status: target.status === 'converting' ? 'converting' : 'pending',
          result: undefined,
          error: undefined,
        }),
      };
    }),

  clearBatchOverride: (id) =>
    set((s) => {
      const target = s.batchItems.find((i) => i.id === id);
      if (!target || !target.override) return {};
      return {
        batchItems: patchItem(s.batchItems, id, {
          override: undefined,
          status: target.status === 'converting' ? 'converting' : 'pending',
          result: undefined,
          error: undefined,
        }),
      };
    }),

  patchBatchSettings: (patch) => set((s) => ({ batchSettings: { ...s.batchSettings, ...patch } })),

  patchBatchPreprocess: (patch) =>
    set((s) => ({
      batchSettings: {
        ...s.batchSettings,
        preprocess: { ...s.batchSettings.preprocess, ...patch },
      },
    })),

  setBatchTemplate: (batchTemplate) => set({ batchTemplate }),
  setBatchScale: (batchScale) =>
    set({ batchScale: Math.max(1, Math.min(64, Math.round(batchScale) || 1)) }),
  setBatchOpaque: (batchOpaque) => set({ batchOpaque }),

  syncBatchSettings: () => {
    const settings = get().settings;
    // 深拷贝一份 preprocess：两边共享同一个嵌套对象的话，
    // 之后在任一侧改预处理开关都会把另一侧悄悄带上
    set({ batchSettings: { ...settings, preprocess: { ...settings.preprocess } } });
    get().pushToast('info', '已把当前转换参数同步为批量参数');
  },

  runBatch: async () => {
    if (get().batchRunning) return;
    if (get().batchItems.length === 0) {
      get().pushToast('warn', '队列是空的，先加入几张图');
      return;
    }
    if (!nextPendingItem(get().batchItems)) {
      get().pushToast('info', '没有待处理的项，可以先「重置结果」再重跑');
      return;
    }

    batchRunToken += 1;
    const token = batchRunToken;
    // 这一轮用哪套参数：一开始就定下来，跑到一半改参数不影响已开跑的这一轮，
    // 否则同一批图里会出现两套参数，事后完全无法解释
    const base = get().batchSettings;
    const fingerprint = settingsFingerprint(base);
    set({ batchRunning: true, batchRunFingerprint: fingerprint });

    const converter = getBatchConverter();
    const started = performance.now();
    let failures = 0;

    try {
      for (;;) {
        if (token !== batchRunToken) break;
        const item = nextPendingItem(get().batchItems);
        if (!item) break;

        set((s) => ({ batchItems: patchItem(s.batchItems, item.id, { status: 'converting' }) }));

        try {
          const merged = mergeSettings(base, item.override);
          const decoded = await decodeImage(item.file);
          if (token !== batchRunToken) break;

          const palette = resolvePalette(merged.paletteId, get().customPalettes);
          const outcome = await converter.convert(
            {
              width: decoded.imageData.width,
              height: decoded.imageData.height,
              data: decoded.imageData.data,
            },
            merged,
            palette,
          );
          if (token !== batchRunToken) break;

          set((s) => ({
            batchItems: patchItem(s.batchItems, item.id, {
              status: 'done',
              error: undefined,
              result: {
                grid: outcome.grid,
                palette: outcome.palette,
                targetW: outcome.targetW,
                targetH: outcome.targetH,
                usedColors: outcome.usedColors,
                trimmed: outcome.trimmed,
                ms: outcome.ms,
              },
            }),
          }));
        } catch (err) {
          failures += 1;
          // 单张失败不该中断整批：记下原因继续跑，最后一起汇报
          set((s) => ({
            batchItems: patchItem(s.batchItems, item.id, {
              status: 'error',
              error: err instanceof Error ? err.message : '转换失败',
            }),
          }));
        }
      }
    } finally {
      // 被停止时，正在转的那一项退回待处理，不然它会永远停在「转换中」
      set((s) => ({
        batchRunning: false,
        batchItems: s.batchItems.map((i) =>
          i.status === 'converting' ? { ...i, status: 'pending' as const } : i,
        ),
      }));
    }

    if (token !== batchRunToken) {
      get().pushToast('info', '已停止批量转换');
      return;
    }

    const stats = summarize(get().batchItems);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    get().pushToast(
      failures > 0 ? 'warn' : 'info',
      `批量转换完成：成功 ${stats.done} 张、失败 ${failures} 张，用时 ${seconds} 秒`,
    );
  },

  stopBatch: () => {
    if (!get().batchRunning) return;
    batchRunToken += 1;
  },

  resetBatchResults: () => {
    if (get().batchRunning) {
      get().pushToast('warn', '正在转换中，先停止再重置');
      return;
    }
    const before = get().batchItems.length;
    set((s) => ({ batchItems: resetResults(s.batchItems), batchRunFingerprint: null }));
    get().pushToast('info', `已把 ${before} 项退回待处理`);
  },

  editBatchItem: async (id) => {
    const item = get().batchItems.find((i) => i.id === id);
    if (!item) return;
    // 参数先算好：loadSource 会把上一张的结果清掉，之后 pipeline 会自动按这些参数重算
    const merged = mergeSettings(get().batchSettings, item.override);
    set({ batchActiveId: id });
    await get().loadSource(item.file);
    if (get().sourceStatus === 'error') return;
    get().patchSettings(merged);
    get().pushToast('info', `已在编辑器中打开「${item.fileName}」，参数取自批量设置`);
  },

  commitEditorToBatch: (id) => {
    const state = get();
    const item = state.batchItems.find((i) => i.id === id);
    if (!item) {
      state.pushToast('warn', '这项已经不在队列里了');
      return;
    }
    const { baseGrid, editLayer, palette, info } = state;
    if (!baseGrid) {
      state.pushToast('warn', '编辑器里还没有像素图');
      return;
    }

    // 取合成结果：手改必须进 zip，这与单图导出的口径一致（DESIGN 决策 19）
    const grid = composite(baseGrid, editLayer);
    set((s) => ({
      batchItems: patchItem(s.batchItems, id, {
        status: 'done',
        error: undefined,
        result: {
          grid,
          palette,
          targetW: grid.w,
          targetH: grid.h,
          usedColors: countUsedColors(grid.indices, grid.alpha),
          trimmed: info?.trimmed ?? false,
          ms: info?.ms ?? 0,
        },
      }),
      batchActiveId: id,
    }));
    state.pushToast(
      'info',
      state.editedCount > 0
        ? `已把「${item.fileName}」含 ${state.editedCount} 格手改的结果写回队列`
        : `已把「${item.fileName}」的结果写回队列`,
    );
  },

  exportBatchZip: async () => {
    const done = get().batchItems.filter((i) => i.status === 'done' && i.result);
    if (done.length === 0) {
      get().pushToast('warn', '还没有转换完成的图片，先跑一轮批量转换');
      return;
    }
    try {
      const pkg = await buildBatchZip(get().batchItems, {
        template: get().batchTemplate,
        scale: get().batchScale,
        background: get().batchOpaque ? '#ffffff' : 'transparent',
      });
      downloadBlob(pkg.blob, pkg.fileName);
      get().pushToast('info', `已打包 ${pkg.imageCount} 张 PNG（含调色板与 report.txt）`);
    } catch (err) {
      get().pushToast('error', err instanceof Error ? err.message : '打包失败');
    }
  },

  saveBatchPreset: (rawName) => {
    const name = rawName.trim();
    if (name === '') return;
    const state = get();
    const finalName = uniquePresetName(name, state.batchPresets.map((p) => p.name));
    const preset: BatchPreset = {
      id: `batch-preset-${Date.now().toString(36)}-${state.batchPresets.length}`,
      name: finalName,
      template: state.batchTemplate,
      scale: state.batchScale,
      opaque: state.batchOpaque,
      // 深拷贝 preprocess：预设要能独立于当前状态存在
      settings: { ...state.batchSettings, preprocess: { ...state.batchSettings.preprocess } },
      savedAt: Date.now(),
    };
    const next = [preset, ...state.batchPresets];
    saveBatchPresets(next);
    set({ batchPresets: next });
    get().pushToast('info', `已保存批处理预设「${finalName}」`);
  },

  applyBatchPreset: (id) => {
    const preset = get().batchPresets.find((p) => p.id === id);
    if (!preset) return;
    set({
      batchSettings: { ...preset.settings, preprocess: { ...preset.settings.preprocess } },
      batchTemplate: preset.template,
      batchScale: preset.scale,
      batchOpaque: preset.opaque,
    });
    get().pushToast('info', `已套用批处理预设「${preset.name}」`);
  },

  removeBatchPreset: (id) => {
    const state = get();
    if (!state.batchPresets.some((p) => p.id === id)) return;
    const next = state.batchPresets.filter((p) => p.id !== id);
    saveBatchPresets(next);
    set({ batchPresets: next });
    state.pushToast('info', '已删除该批处理预设');
  },
});

const createExportSlice: StateCreator<AppStore, [], [], ExportSlice> = (set, get) => {
  const stored = loadExportSettings();

  /** 落库一次导出设置；调用方只传要改的字段 */
  const persist = (patch: Partial<StoredExportSettings>): void => {
    const state = get();
    saveExportSettings({
      exporterId: state.exporterId,
      options: state.exportOptions,
      packZip: state.exportPackZip,
      blockMap: state.blockMap,
      ...patch,
    });
  };

  /**
   * 组装导出上下文。
   *
   * `grid` 取的是**合成结果**（与单图导出同一口径）：手改必须进图纸，
   * 否则用户在编辑器里改了半天，导出的蓝图还是原样。
   */
  const buildContext = (): ExportContext => {
    const state = get();
    const grid = state.baseGrid ? composite(state.baseGrid, state.editLayer) : null;

    // 图集的帧名沿用批量那边的命名模板：用户已经为这批图定过名字了，
    // 图集里再另起一套规则只会让他重新对一遍
    const done = state.batchItems.filter((i) => i.status === 'done' && i.result);
    const sheetNames = buildBatchNames(
      state.batchTemplate,
      done.map((i) => ({
        name: i.fileName,
        w: i.result?.grid.w ?? 0,
        h: i.result?.grid.h ?? 0,
      })),
      1,
    );
    const batchTiles = done.map((item, i) => ({
      grid: item.result?.grid as PixelGrid,
      palette: item.result?.palette ?? state.palette,
      // 去掉 .png 后缀：manifest 里写的是「帧名」，不是文件名
      name: (sheetNames[i] ?? item.fileName).replace(/\.png$/i, ''),
      // 拆帧导入的原始时长：GIF / .ase 动画导出用它，普通图片是 undefined
      delayMs: item.delayMs,
    }));

    return {
      grid,
      palette: state.palette,
      sourceName: state.source?.name ?? 'pixels',
      batchTiles,
      blockMap: state.blockMap,
      suggestedBlocks: suggestBlockMap(state.palette.colors),
    };
  };

  return {
    exporting: false,
    exporterId: stored.exporterId ?? DEFAULT_EXPORTER_ID,
    exportOptions: stored.options ?? {},
    exportPackZip: stored.packZip ?? true,
    blockMap: sanitizeBlockMap(stored.blockMap),
    lastExportNote: null,

    setExporter: (exporterId) => {
      set({ exporterId, lastExportNote: null });
      persist({ exporterId });
    },

    patchExportOptions: (patch) => {
      const state = get();
      const next = {
        ...state.exportOptions,
        [state.exporterId]: { ...state.exportOptions[state.exporterId], ...patch },
      };
      set({ exportOptions: next });
      persist({ options: next });
    },

    setExportPackZip: (exportPackZip) => {
      set({ exportPackZip });
      persist({ packZip: exportPackZip });
    },

    setBlockFor: (key, blockId) => {
      const blockMap = { ...get().blockMap, [key]: blockId };
      set({ blockMap });
      persist({ blockMap });
    },

    resetBlockMap: () => {
      set({ blockMap: {} });
      persist({ blockMap: {} });
      get().pushToast('info', '方块映射已全部退回「自动挑最接近的方块」');
    },

    runExport: async () => {
      const exporter = getExporter(get().exporterId);
      if (!exporter) {
        get().pushToast('error', '找不到这个导出器');
        return;
      }
      if (exporter.needs === 'grid' && !get().baseGrid) {
        get().pushToast('warn', '还没有转换结果，先调一下转换参数');
        return;
      }
      if (exporter.needs === 'batch') {
        const ready = get().batchItems.some((i) => i.status === 'done' && i.result);
        if (!ready) {
          get().pushToast('warn', '先去「批量处理」跑一轮，图集要用队列里已完成的图');
          return;
        }
      }

      set({ exporting: true });
      try {
        const values = mergeOptionValues(exporter, get().exportOptions[exporter.id]);
        const result = await exporter.run(buildContext(), values);

        if (result.files.length === 0) {
          throw new Error('这个导出器没有产出任何文件');
        }

        if (result.files.length === 1 || !get().exportPackZip) {
          // 逐个下载：多个文件时浏览器可能弹「允许多个下载」，这是正常提示
          for (const file of result.files) {
            downloadBlob(file.blob, file.name);
            // 连续触发多次下载之间留一点间隔，太密集会被浏览器直接丢弃
            if (result.files.length > 1) await new Promise((r) => setTimeout(r, 120));
          }
        } else {
          const entries: ZipEntry[] = [];
          for (const file of result.files) {
            entries.push({ name: file.name, data: new Uint8Array(await file.blob.arrayBuffer()) });
          }
          const zip = createZip(entries);
          downloadBlob(
            new Blob([zip.slice().buffer as ArrayBuffer], { type: 'application/zip' }),
            `${stemOf(get().source?.name ?? 'pixels')}_${exporter.id}.zip`,
          );
        }

        const count = result.files.length;
        set({ lastExportNote: result.note ?? null });
        get().pushToast(
          'info',
          count === 1
            ? `已导出 ${result.files[0].name}${result.note ? `（${result.note}）` : ''}`
            : `已导出 ${count} 个文件${get().exportPackZip ? '（已打包成 zip）' : ''}`,
        );
      } catch (err) {
        get().pushToast('error', err instanceof Error ? err.message : '导出失败');
      } finally {
        set({ exporting: false });
      }
    },

    copyPngAsImage: async () => {
      const state = get();
      if (!state.baseGrid) {
        state.pushToast('warn', '还没有转换结果');
        return;
      }
      try {
        const pngExporter = getExporter('png');
        if (!pngExporter) throw new Error('找不到 PNG 导出器');
        const values = mergeOptionValues(pngExporter, state.exportOptions.png);
        const grid = composite(state.baseGrid, state.editLayer);
        const blob = await exportGridPng(grid, state.palette, {
          scale: Math.round(numOf(values, 'scale', 1)),
          background: strOf(values, 'background', 'transparent'),
        });
        await copyPngToClipboard(blob);
        state.pushToast('info', '像素图已复制到剪贴板');
      } catch (err) {
        state.pushToast('error', err instanceof Error ? err.message : '复制失败');
      }
    },

    copyPaletteText: async () => {
      const state = get();
      try {
        await copyTextToClipboard(paletteHexText(state.palette));
        state.pushToast('info', `已复制 ${state.palette.colors.length} 个色值到剪贴板`);
      } catch (err) {
        state.pushToast('error', err instanceof Error ? err.message : '复制失败');
      }
    },
  };
};

const createProjectSlice: StateCreator<AppStore, [], [], ProjectSlice> = (set, get) => ({
  projectSavedAt: null,
  projectBusy: false,
  convertPresets: loadConvertPresets(),
  shortcutsOpen: false,

  setShortcutsOpen: (shortcutsOpen) => set({ shortcutsOpen }),

  saveProject: async () => {
    const state = get();
    if (!state.source || !state.sourceBlob) {
      state.pushToast('warn', '还没有载入图片，没有可存档的内容');
      return;
    }

    set({ projectBusy: true });
    try {
      const dataUrl = await blobToDataUrl(state.sourceBlob);
      const project = buildProject({
        name: state.source.name,
        source: dataUrl,
        originalWidth: state.source.originalWidth,
        originalHeight: state.source.originalHeight,
        settings: state.settings,
        palette: state.palette,
        baseGrid: state.baseGrid,
        editLayer: state.editLayer,
        savedAt: Date.now(),
      });
      const blob = new Blob([serializeProject(project)], { type: 'application/json' });
      downloadBlob(blob, buildProjectName(state.source.name));
      set({ projectSavedAt: project.savedAt });
      state.pushToast(
        'info',
        `已存档 ${buildProjectName(state.source.name)}（${formatBytes(blob.size)}，含源图与 ${state.editedCount} 格手改）`,
      );
    } catch (err) {
      state.pushToast('error', err instanceof Error ? err.message : '存档失败');
    } finally {
      set({ projectBusy: false });
    }
  },

  loadProjectFile: async (file) => {
    const state = get();
    set({ projectBusy: true });
    try {
      const parsed = parseProject(await file.text());

      /* 先把源图读进来。这一步内部会 clearResult（换图必须作废旧结果），
         所以编辑层要在它**之后**才写入，否则会被一起清掉。 */
      const blob = await dataUrlToBlob(parsed.project.source);
      await get().loadSource(blob, parsed.project.name);
      if (get().sourceStatus !== 'ready') throw new Error('存档里的源图解码失败');

      // 源图是内嵌的 PNG，它的尺寸不等于「原始文件尺寸」，这两项要用存档里的值
      const loaded = get().source;
      if (loaded) {
        set({
          source: {
            ...loaded,
            bytes: blob.size,
            originalWidth: parsed.project.originalWidth || loaded.originalWidth,
            originalHeight: parsed.project.originalHeight || loaded.originalHeight,
          },
        });
      }

      /* 一次性把结果、编辑层、参数、调色板写进去。
         关键是**直接调 applyResult**，而不是等流水线重算 ——
         重算是异步的，编辑层会在结果到达之前被 applyResult 判定为「尺寸不符」而重建，
         手改就这么静默丢了。存档里本来就带了 baseGrid，不必再算一遍。

         editOrigin 先清空：applyResult 会据此建出一张与网格同尺寸的空编辑层，
         随后我们用手改层整个替换掉它。这样写比「先塞 origin 让它重采样一次」
         少一次无用功，意图也更直白。 */
      set({ settings: parsed.settings, palette: parsed.palette, editOrigin: null });

      if (parsed.baseGrid) {
        get().applyResult(parsed.baseGrid, parsed.palette, {
          targetW: parsed.baseGrid.w,
          targetH: parsed.baseGrid.h,
          usedColors: countUsedColors(parsed.baseGrid.indices, parsed.baseGrid.alpha),
          trimmed: false,
          ms: 0,
          fallback: false,
        });
      }

      const restored = parsed.editLayer;
      if (restored) {
        set({
          editLayer: restored,
          editOrigin: { w: restored.w, h: restored.h, layer: cloneEditLayer(restored) },
          editedCount: countEdits(restored),
          editVersion: get().editVersion + 1,
        });
      }

      set({ projectSavedAt: parsed.project.savedAt, batchActiveId: null });

      const lostEdits = parsed.project.edit !== null && restored === null;
      if (lostEdits) {
        state.pushToast('warn', '存档里的手改数据已损坏，已跳过；图与参数照常还原');
      } else {
        state.pushToast('info', `已打开存档：${describeProject(parsed.project)}`);
      }
    } catch (err) {
      state.pushToast('error', err instanceof Error ? err.message : '读取存档失败');
    } finally {
      set({ projectBusy: false });
    }
  },

  saveConvertPreset: (rawName) => {
    const name = rawName.trim();
    if (name === '') return;
    const state = get();
    const finalName = uniqueName(name, state.convertPresets.map((p) => p.name));
    const preset: ConvertPreset = {
      id: `convert-preset-${Date.now().toString(36)}-${state.convertPresets.length}`,
      name: finalName,
      settings: { ...state.settings, preprocess: { ...state.settings.preprocess } },
      savedAt: Date.now(),
    };
    const next = [preset, ...state.convertPresets];
    saveConvertPresets(next);
    set({ convertPresets: next });
    state.pushToast('info', `已保存转换预设「${finalName}」`);
  },

  applyConvertPreset: (id) => {
    const preset = get().convertPresets.find((p) => p.id === id);
    if (!preset) return;
    set({ settings: { ...preset.settings, preprocess: { ...preset.settings.preprocess } } });
    get().pushToast('info', `已套用转换预设「${preset.name}」`);
  },

  removeConvertPreset: (id) => {
    const state = get();
    if (!state.convertPresets.some((p) => p.id === id)) return;
    const next = state.convertPresets.filter((p) => p.id !== id);
    saveConvertPresets(next);
    set({ convertPresets: next });
    state.pushToast('info', '已删除该转换预设');
  },

  clearWorkspace: () => {
    const state = get();
    // 先关掉缩略图位图，否则清空后它们会一直挂着
    for (const item of state.batchItems) item.thumb?.close();
    state.clearSource();
    set({
      batchItems: [],
      batchActiveId: null,
      batchRunFingerprint: null,
      projectSavedAt: null,
      seam: null,
      view: { ...IDENTITY_VIEW },
    });
    state.pushToast('info', '工作区已清空（自定义调色板、预设、方块映射都保留着）');
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

  workerFallback: false,
});

/* --------------------------------------------------------------- 组装 */

export const useApp = create<AppStore>()((...args) => ({
  ...createSourceSlice(...args),
  ...createDocSlice(...args),
  ...createConvertSlice(...args),
  ...createSettingsSlice(...args),
  ...createEditSlice(...args),
  ...createPaletteSlice(...args),
  ...createAssistSlice(...args),
  ...createBatchSlice(...args),
  ...createExportSlice(...args),
  ...createProjectSlice(...args),
  ...createToolSlice(...args),
  ...createUiSlice(...args),
}));