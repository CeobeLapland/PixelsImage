/**
 * 项目存档（M7）：`.pixproj`。
 *
 * 目标（ROADMAP 的验收标准）：**关掉浏览器再打开，能完整还原上次的工作状态，含手改**。
 *
 * 两条设计决定：
 *
 * 1. **源图内嵌进文件**，而不是存个引用。
 *    浏览器里没法记住「上次那个文件的本地路径」—— File 对象不允许序列化路径，
 *    而 File System Access API 又要求用户重新授权。存引用的话，
 *    用户第二天打开存档会看到「请重新选择原图」，那这个存档基本等于没用。
 *    内嵌的代价是文件大（一张 1920×1080 的源图约 8MB，PNG 压缩后小些），
 *    所以存的是**源数据本身重新编码的 PNG**，不是原始文件字节（原始 JPEG 也可能很大）。
 *
 * 2. **编辑层稀疏存**（CSR 三数组），不存整张 `(PixelCell|null)[]`。
 *    512×512 的编辑层直接用 JSON 数组存要 26 万个 null 字面量；
 *    手改通常只有几百格，稀疏存能让这一段缩小三个数量级。
 */

import { toHex } from './color/space';
import { createEditLayer, makeDefaultSettings, type ConvertSettings, type EditLayer, type Palette, type PixelCell, type PixelGrid, type RGBA } from './types';
import { coerceSettings } from './presets';

/** 存档格式版本。结构变了就升这个数，读的时候按它决定要不要兼容 */
export const PROJECT_VERSION = 2;
export const PROJECT_EXTENSION = '.pixproj';

export interface SerializedEditLayer {
  w: number;
  h: number;
  /** 被改过的格子下标，升序 */
  rows: number[];
  /** 每格的调色板索引 / 不透明度，与 rows 等长 */
  index: number[];
  alpha: number[];
}

export interface SerializedProject {
  version: number;
  savedAt: number;
  /** 源图名（不含扩展名），用于恢复导出命名 */
  name: string;
  /** 源数据重新编码的 PNG，base64 的 data URL */
  source: string;
  /** 源图原始尺寸（未降采样前） */
  originalWidth: number;
  originalHeight: number;
  settings: ConvertSettings;
  palette: Palette;
  /** 转换结果；没转换过时为 null */
  baseGrid: SerializedGrid | null;
  edit: SerializedEditLayer | null;
}

export interface SerializedGrid {
  w: number;
  h: number;
  /** 索引用调色板里出现过的值 —— 直接数组，简单可读 */
  indices: number[];
  alpha: number[];
}

/* ------------------------------------------------------------ 编辑层 */

export function serializeEditLayer(layer: EditLayer | null): SerializedEditLayer | null {
  if (!layer) return null;

  const rows: number[] = [];
  const index: number[] = [];
  const alpha: number[] = [];

  for (let i = 0; i < layer.cells.length; i += 1) {
    const cell = layer.cells[i];
    if (!cell) continue;
    rows.push(i);
    index.push(cell.index);
    alpha.push(cell.alpha);
  }

  // 一个字都没改过就不必写这一段，省下读档时的一次重建
  if (rows.length === 0) return null;
  return { w: layer.w, h: layer.h, rows, index, alpha };
}

/**
 * 反序列化编辑层。
 *
 * 三个数组长度不一致、索引越界、格数对不上尺寸，一律当损坏处理并返回 null ——
 * 返回一个「部分可用」的编辑层比返回 null 更危险：读档后画面上会少几格手改，
 * 而用户完全不知道少了什么。
 */
export function deserializeEditLayer(raw: unknown): EditLayer | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Partial<SerializedEditLayer>;
  if (typeof data.w !== 'number' || typeof data.h !== 'number') return null;
  if (!Number.isInteger(data.w) || !Number.isInteger(data.h)) return null;
  if (data.w <= 0 || data.h <= 0) return null;
  if (!Array.isArray(data.rows) || !Array.isArray(data.index) || !Array.isArray(data.alpha)) {
    return null;
  }
  if (data.rows.length !== data.index.length || data.rows.length !== data.alpha.length) return null;

  const total = data.w * data.h;
  const layer = createEditLayer(data.w, data.h);

  for (let k = 0; k < data.rows.length; k += 1) {
    const i = data.rows[k];
    if (!Number.isInteger(i) || i < 0 || i >= total) return null;
    const idx = data.index[k];
    const a = data.alpha[k];
    if (typeof idx !== 'number' || typeof a !== 'number') return null;
    layer.cells[i] = {
      index: Math.max(0, Math.min(255, Math.round(idx))),
      alpha: Math.max(0, Math.min(255, Math.round(a))),
    } satisfies PixelCell;
  }

  return layer;
}

/* -------------------------------------------------------------- 网格 */

export function serializeGrid(grid: PixelGrid): SerializedGrid {
  return {
    w: grid.w,
    h: grid.h,
    indices: Array.from(grid.indices),
    alpha: Array.from(grid.alpha),
  };
}

export function deserializeGrid(raw: unknown): PixelGrid | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Partial<SerializedGrid>;
  if (typeof data.w !== 'number' || typeof data.h !== 'number') return null;
  if (!Number.isInteger(data.w) || !Number.isInteger(data.h) || data.w <= 0 || data.h <= 0) {
    return null;
  }
  if (!Array.isArray(data.indices) || !Array.isArray(data.alpha)) return null;
  const total = data.w * data.h;
  if (data.indices.length !== total || data.alpha.length !== total) return null;

  const indices = new Uint8Array(total);
  const alpha = new Uint8Array(total);
  for (let i = 0; i < total; i += 1) {
    const idx = data.indices[i];
    const a = data.alpha[i];
    if (typeof idx !== 'number' || typeof a !== 'number') return null;
    indices[i] = Math.max(0, Math.min(255, Math.round(idx)));
    alpha[i] = Math.max(0, Math.min(255, Math.round(a)));
  }

  return { w: data.w, h: data.h, indices, alpha };
}

/* ------------------------------------------------------------ 调色板 */

/** 校验调色板；色值必须是 [r,g,b,a] 四元组 */
export function deserializePalette(raw: unknown): Palette | null {
  if (!raw || typeof raw !== 'object') return null;
  const data = raw as Partial<Palette> & { colors?: unknown };
  if (typeof data.id !== 'string' || data.id === '') return null;
  if (!Array.isArray(data.colors) || data.colors.length === 0) return null;

  const colors: RGBA[] = [];
  for (const entry of data.colors) {
    if (!Array.isArray(entry) || entry.length < 3) return null;
    const [r, g, b, a] = entry as number[];
    if ([r, g, b].some((v) => typeof v !== 'number' || !Number.isFinite(v))) return null;
    colors.push([
      clampByte(r),
      clampByte(g),
      clampByte(b),
      typeof a === 'number' && Number.isFinite(a) ? clampByte(a) : 255,
    ]);
  }

  return {
    id: data.id,
    name: typeof data.name === 'string' && data.name !== '' ? data.name : data.id,
    colors,
    builtin: false,
    source: 'custom',
  };
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/* -------------------------------------------------------------- 组装 */

export interface ProjectInput {
  /** 源图名 */
  name: string;
  /** 源数据的 data URL（PNG） */
  source: string;
  originalWidth: number;
  originalHeight: number;
  settings: ConvertSettings;
  palette: Palette;
  baseGrid: PixelGrid | null;
  editLayer: EditLayer | null;
  savedAt: number;
}

export function buildProject(input: ProjectInput): SerializedProject {
  return {
    version: PROJECT_VERSION,
    savedAt: input.savedAt,
    name: input.name,
    source: input.source,
    originalWidth: input.originalWidth,
    originalHeight: input.originalHeight,
    settings: input.settings,
    palette: input.palette,
    baseGrid: input.baseGrid ? serializeGrid(input.baseGrid) : null,
    edit: serializeEditLayer(input.editLayer),
  };
}

export function serializeProject(project: SerializedProject): string {
  return JSON.stringify(project);
}

export interface ParsedProject {
  project: SerializedProject;
  settings: ConvertSettings;
  palette: Palette;
  baseGrid: PixelGrid | null;
  editLayer: EditLayer | null;
}

/**
 * 解析存档。
 *
 * 版本号只用于**提示**（太新的存档可能有不认识的字段），不做拒绝：
 * 关键字段每个都单独校验过，能读出来就用，读不出来才报错。
 * 直接按版本号拒绝会让「在旧版本里打开新存档」变成一个死路。
 */
export function parseProject(text: string): ParsedProject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('存档不是合法的 JSON，可能已损坏');
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('存档结构不对');

  const raw = parsed as Partial<SerializedProject>;
  if (typeof raw.source !== 'string' || !raw.source.startsWith('data:image/')) {
    throw new Error('存档里没有可用的源图数据');
  }
  const palette = deserializePalette(raw.palette);
  if (!palette) throw new Error('存档里的调色板已损坏');

  const project: SerializedProject = {
    version: typeof raw.version === 'number' ? raw.version : 1,
    savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0,
    name: typeof raw.name === 'string' && raw.name !== '' ? raw.name : '未命名',
    source: raw.source,
    originalWidth: typeof raw.originalWidth === 'number' ? raw.originalWidth : 0,
    originalHeight: typeof raw.originalHeight === 'number' ? raw.originalHeight : 0,
    settings: coerceSettings(raw.settings),
    palette,
    baseGrid: (raw.baseGrid as SerializedGrid | null) ?? null,
    edit: (raw.edit as SerializedEditLayer | null) ?? null,
  };

  return {
    project,
    settings: project.settings,
    palette,
    baseGrid: deserializeGrid(raw.baseGrid),
    // 编辑层坏了不该让整份存档打不开：网格还能看，丢失的只是手改，且会提示
    editLayer: deserializeEditLayer(raw.edit),
  };
}

/** 由源图名推导存档文件名 */
export function buildProjectName(sourceName: string): string {
  const base = sourceName.replace(/\.[^.]+$/, '') || 'pixels';
  return `${base}${PROJECT_EXTENSION}`;
}

/** 人类可读的存档摘要，用于读档前提示 */
export function describeProject(project: SerializedProject): string {
  const when = project.savedAt ? new Date(project.savedAt).toLocaleString() : '未知时间';
  const grid = project.baseGrid ? `${project.baseGrid.w}×${project.baseGrid.h} 格` : '未转换';
  const edits = project.edit ? `${project.edit.rows.length} 格手改` : '无手改';
  return `${project.name} · ${grid} · ${edits} · 保存于 ${when}`;
}

/** 供导出器复用的 hex 文本（项目文件里色值用数组存，人看着不直观） */
export function paletteSummary(palette: Palette): string {
  return palette.colors
    .slice(0, 8)
    .map((c) => toHex(c[0], c[1], c[2]))
    .join(' ');
}

/** 默认设置备份：老存档没有 settings 字段时不会炸 */
export const PROJECT_FALLBACK_SETTINGS = makeDefaultSettings();