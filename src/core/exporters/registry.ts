/**
 * 导出器注册表（M6）。
 *
 * 每个导出器自带一份**选项 schema**，面板照着它自动渲染控件 ——
 * 这是 DESIGN §7 定下的做法。好处很实在：加一个导出器只要写一个对象，
 * 不用再动面板；选项的默认值、范围、提示文案只有一处定义，
 * 不会出现「面板限制了 1–64 而导出器按 1–32 处理」这种对不上的情况。
 *
 * 分层：本模块只依赖 core/（以及 palettes/ 的序列化），不 import React。
 */

import { baseNameOf, sanitizeFileName } from '../batch/naming';
import { toHex } from '../color/space';
import type { Palette, PixelGrid } from '../types';
import {
  blueprintSource,
  buildBlockLegend,
  buildBlueprintCsv,
  DEFAULT_BLUEPRINT_CSV_OPTIONS,
  DEFAULT_BLUEPRINT_OPTIONS,
  renderBlueprintPages,
  type BlueprintCsvOptions,
  type BlueprintOptions,
} from './blueprint';
import type { BlockMap } from './blocks';
import {
  buildGridJson,
  serializeGridJson,
  type GridJsonOptions,
} from './gridJson';
import { buildExportName, exportGridPng, imageDataToPngBlob } from './png';
import {
  buildSheetManifest,
  planSpritesheet,
  renderSpritesheet,
  type SheetTile,
  type SpritesheetOptions,
} from './spritesheet';

/* ------------------------------------------------------------------ 选项 */

export interface NumberExportOption {
  kind: 'number';
  key: string;
  label: string;
  hint?: string;
  min: number;
  max: number;
  /** 选项都是整数：面板用的是同一个数字输入控件 */
  default: number;
}

export interface ToggleExportOption {
  kind: 'toggle';
  key: string;
  label: string;
  hint?: string;
  default: boolean;
}

export interface SelectExportOption {
  kind: 'select';
  key: string;
  label: string;
  hint?: string;
  options: readonly { value: string; label: string }[];
  default: string;
}

export type ExportOption = NumberExportOption | ToggleExportOption | SelectExportOption;

export type ExportOptionValue = number | boolean | string;
export type ExportOptionValues = Record<string, ExportOptionValue>;

/* -------------------------------------------------------------- 执行上下文 */

export interface ExportFile {
  name: string;
  blob: Blob;
}

export interface ExportContext {
  /** 当前文档的**合成**网格（含手工修改）；没有转换结果时为 null */
  grid: PixelGrid | null;
  palette: Palette;
  /** 源文件名，用来推导导出名 */
  sourceName: string;
  /** 批量队列里已完成的项，供图集使用 */
  batchTiles: readonly SheetTile[];
  /** 用户改过的方块映射 */
  blockMap: BlockMap;
  /** 由当前调色板现算的方块建议映射 */
  suggestedBlocks: BlockMap;
}

export interface ExportResult {
  files: ExportFile[];
  /** 给用户的一句话说明（可选） */
  note?: string;
}

export interface Exporter {
  id: string;
  label: string;
  description: string;
  /** 需要什么输入才能跑 */
  needs: 'grid' | 'batch';
  options: readonly ExportOption[];
  run: (ctx: ExportContext, values: ExportOptionValues) => Promise<ExportResult>;
}

/* -------------------------------------------------------------- 取值助手 */

/*
 * 选项值来自 UI 状态，理论上类型是对的；但同一份值会被写进 localStorage
 * 再读回来，所以这里一律带兜底 —— 拿到 undefined / 类型不对时退回默认值，
 * 而不是把 NaN 传进流水线里。
 */

export function numOf(values: ExportOptionValues, key: string, fallback: number): number {
  const raw = values[key];
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
}

export function boolOf(values: ExportOptionValues, key: string, fallback: boolean): boolean {
  const raw = values[key];
  return typeof raw === 'boolean' ? raw : fallback;
}

export function strOf(values: ExportOptionValues, key: string, fallback: string): string {
  const raw = values[key];
  return typeof raw === 'string' ? raw : fallback;
}

/** 导出名的词干：源文件名去掉扩展名并清掉非法字符 */
export function stemOf(sourceName: string): string {
  return sanitizeFileName(baseNameOf(sourceName)) || 'pixels';
}

/* ------------------------------------------------------------------ 工具 */

/** 网格里是否真的用到了某个颜色（导出调色板/图例时只列用得上的） */
function usedColorsOf(grid: PixelGrid, palette: Palette): Palette['colors'] {
  const seen = new Set<number>();
  for (let i = 0; i < grid.indices.length; i += 1) {
    if (grid.alpha[i] === 0) continue;
    seen.add(grid.indices[i]);
  }
  return [...seen].sort((a, b) => a - b).map((i) => palette.colors[i]).filter(Boolean);
}

function textFile(name: string, text: string): ExportFile {
  return { name, blob: new Blob([text], { type: 'text/plain;charset=utf-8' }) };
}

/* -------------------------------------------------------------- 各导出器 */

const BACKGROUND_OPTIONS = [
  { value: 'transparent', label: '透明' },
  { value: '#ffffff', label: '白底' },
  { value: '#000000', label: '黑底' },
] as const;

const pngExporter: Exporter = {
  id: 'png',
  label: 'PNG 图片',
  description: '当前像素图，整数倍最近邻放大，不会有插值模糊',
  needs: 'grid',
  options: [
    { kind: 'number', key: 'scale', label: '放大倍数', min: 1, max: 64, default: 1, hint: '1 = 每格 1 像素' },
    { kind: 'select', key: 'background', label: '背景', options: BACKGROUND_OPTIONS, default: 'transparent' },
  ],
  async run(ctx, values) {
    if (!ctx.grid) throw new Error('还没有转换结果');
    const scale = Math.round(numOf(values, 'scale', 1));
    const background = strOf(values, 'background', 'transparent');
    const blob = await exportGridPng(ctx.grid, ctx.palette, { scale, background });
    return { files: [{ name: buildExportName(ctx.sourceName, ctx.grid, scale), blob }] };
  },
};

const gridJsonExporter: Exporter = {
  id: 'gridJson',
  label: '网格 JSON',
  description: 'w / h / 调色板 / 每格索引，给程序消费',
  needs: 'grid',
  options: [
    {
      kind: 'toggle',
      key: 'alwaysAlpha',
      label: '总是写入 alpha 通道',
      hint: '关掉时只在存在半透明像素时才写',
      default: false,
    },
    { kind: 'toggle', key: 'includePalette', label: '写入调色板色值', default: true },
  ],
  async run(ctx, values) {
    if (!ctx.grid) throw new Error('还没有转换结果');
    const options: GridJsonOptions = {
      alwaysAlpha: boolOf(values, 'alwaysAlpha', false),
      includePalette: boolOf(values, 'includePalette', true),
    };
    const json = buildGridJson(ctx.grid, ctx.palette, ctx.sourceName, options);
    const alphaNote = json.alpha ? '含 alpha 通道' : '全不透明，已省略 alpha';
    return {
      files: [textFile(`${stemOf(ctx.sourceName)}.json`, serializeGridJson(json))],
      note: `${ctx.grid.w}×${ctx.grid.h} · ${alphaNote}`,
    };
  },
};

const spritesheetExporter: Exporter = {
  id: 'spritesheet',
  label: '精灵图集',
  description: '把批量队列里已完成的图打包成一张大图，附坐标 JSON',
  needs: 'batch',
  options: [
    { kind: 'number', key: 'columns', label: '每行几格', min: 0, max: 32, default: 0, hint: '0 = 自动排成接近正方形' },
    { kind: 'number', key: 'padding', label: '留白', min: 0, max: 8, default: 1, hint: '像素' },
    { kind: 'toggle', key: 'trim', label: '裁掉每格的透明边', default: true },
    { kind: 'select', key: 'background', label: '背景', options: BACKGROUND_OPTIONS, default: 'transparent' },
  ],
  async run(ctx, values) {
    if (ctx.batchTiles.length === 0) {
      throw new Error('批量队列里还没有已完成的图，先去「批量处理」跑一轮');
    }
    const options: SpritesheetOptions = {
      columns: Math.round(numOf(values, 'columns', 0)),
      padding: Math.round(numOf(values, 'padding', 1)),
      trim: boolOf(values, 'trim', true),
      background: strOf(values, 'background', 'transparent'),
    };
    const layout = planSpritesheet(ctx.batchTiles, options);
    const blob = await imageDataToPngBlob(renderSpritesheet(layout, ctx.batchTiles, options));
    const stem = stemOf(ctx.sourceName);
    return {
      files: [
        { name: `${stem}_sheet.png`, blob },
        textFile(
          `${stem}_sheet.json`,
          `${JSON.stringify(buildSheetManifest(layout), null, 2)}\n`,
        ),
      ],
      note: `${ctx.batchTiles.length} 格 · 图集 ${layout.w}×${layout.h}px · ${layout.columns} 列`,
    };
  },
};

const blueprintPngExporter: Exporter = {
  id: 'blueprintPng',
  label: '建造蓝图 PNG',
  description: '带行列标尺与色号图例的施工图，可直接打印',
  needs: 'grid',
  options: [
    { kind: 'number', key: 'cell', label: '每格像素', min: 4, max: 64, default: DEFAULT_BLUEPRINT_OPTIONS.cell },
    { kind: 'number', key: 'pageCols', label: '每页列数', min: 0, max: 128, default: DEFAULT_BLUEPRINT_OPTIONS.pageCols, hint: '0 = 不分页' },
    { kind: 'number', key: 'pageRows', label: '每页行数', min: 0, max: 128, default: DEFAULT_BLUEPRINT_OPTIONS.pageRows, hint: '0 = 不分页' },
    { kind: 'number', key: 'rulerEvery', label: '每隔几格标坐标', min: 1, max: 16, default: DEFAULT_BLUEPRINT_OPTIONS.rulerEvery },
    { kind: 'toggle', key: 'oneBased', label: '坐标从 1 开始', default: false },
    { kind: 'toggle', key: 'gridLines', label: '画网格线', default: true },
    { kind: 'toggle', key: 'trim', label: '先裁掉透明边', hint: '免得图纸上留一圈空白', default: true },
  ],
  async run(ctx, values) {
    if (!ctx.grid) throw new Error('还没有转换结果');
    const options: BlueprintOptions = {
      cell: Math.round(numOf(values, 'cell', DEFAULT_BLUEPRINT_OPTIONS.cell)),
      pageCols: Math.round(numOf(values, 'pageCols', DEFAULT_BLUEPRINT_OPTIONS.pageCols)),
      pageRows: Math.round(numOf(values, 'pageRows', DEFAULT_BLUEPRINT_OPTIONS.pageRows)),
      rulerEvery: Math.round(numOf(values, 'rulerEvery', DEFAULT_BLUEPRINT_OPTIONS.rulerEvery)),
      oneBased: boolOf(values, 'oneBased', false),
      gridLines: boolOf(values, 'gridLines', true),
      title: ctx.sourceName,
    };
    const source = blueprintSource(ctx.grid, boolOf(values, 'trim', true));
    const pages = renderBlueprintPages(source, ctx.palette, ctx.blockMap, ctx.suggestedBlocks, options);
    const stem = stemOf(ctx.sourceName);

    const files: ExportFile[] = [];
    for (const page of pages) {
      const blob = await imageDataToPngBlob(page.data);
      files.push({ name: `${stem}_blueprint${page.name ? `_${page.name}` : ''}.png`, blob });
    }
    // 色号对照表跟着图纸一起给：验收要求「图例色号与 CSV 的 block 一一对应」，
    // 而 PNG 里的图例没法用文本工具比对
    files.push(
      textFile(`${stem}_blueprint_legend.txt`, buildBlockLegend(source, ctx.palette, ctx.blockMap, ctx.suggestedBlocks)),
    );
    return {
      files,
      note: `${source.w}×${source.h} 格 · ${pages.length} 页 · 用到 ${usedColorsOf(source, ctx.palette).length} 种颜色`,
    };
  },
};

const blueprintCsvExporter: Exporter = {
  id: 'blueprintCsv',
  label: '建造清单 CSV',
  description: 'x,y,z,block —— 每个方块的坐标与方块名',
  needs: 'grid',
  options: [
    { kind: 'toggle', key: 'skipTransparent', label: '跳过透明格', default: true, hint: '透明处不放方块' },
    {
      kind: 'select',
      key: 'yAxis',
      label: 'Y 轴方向',
      hint: 'Minecraft 里 y 越大越高',
      options: [
        { value: 'up', label: '图上第一行在最高处' },
        { value: 'down', label: '图上第一行在最低处' },
      ],
      default: 'up',
    },
    { kind: 'number', key: 'z', label: '所在层 z', min: -64, max: 320, default: 0 },
    { kind: 'toggle', key: 'header', label: '写入表头', default: true },
  ],
  async run(ctx, values) {
    if (!ctx.grid) throw new Error('还没有转换结果');
    const options: BlueprintCsvOptions = {
      skipTransparent: boolOf(values, 'skipTransparent', DEFAULT_BLUEPRINT_CSV_OPTIONS.skipTransparent),
      yAxis: strOf(values, 'yAxis', 'up') === 'down' ? 'down' : 'up',
      z: Math.round(numOf(values, 'z', 0)),
      header: boolOf(values, 'header', true),
    };
    const csv = buildBlueprintCsv(ctx.grid, ctx.palette, ctx.blockMap, ctx.suggestedBlocks, options);
    const stem = stemOf(ctx.sourceName);
    const rows = Math.max(0, csv.trimEnd().split('\n').length - (options.header ? 1 : 0));
    return {
      files: [
        textFile(`${stem}_blueprint.csv`, csv),
        textFile(`${stem}_blueprint_legend.txt`, buildBlockLegend(ctx.grid, ctx.palette, ctx.blockMap, ctx.suggestedBlocks)),
      ],
      note: `${rows} 个方块`,
    };
  },
};

/* ------------------------------------------------------------------ 注册表 */

export const EXPORTERS: readonly Exporter[] = [
  pngExporter,
  gridJsonExporter,
  spritesheetExporter,
  blueprintPngExporter,
  blueprintCsvExporter,
];

export const DEFAULT_EXPORTER_ID = pngExporter.id;

export function getExporter(id: string): Exporter | undefined {
  return EXPORTERS.find((e) => e.id === id);
}

/** 一个导出器的全部选项默认值 */
export function defaultOptionValues(exporter: Exporter): ExportOptionValues {
  const out: ExportOptionValues = {};
  for (const option of exporter.options) out[option.key] = option.default;
  return out;
}

/**
 * 把存下来的选项与默认值合并。
 *
 * 按 **schema 的 key** 逐个取，而不是简单展开合并：
 * 选项可能在新版本里被改名或删掉，直接 `{...defaults, ...stored}` 会让
 * 那些已经没用的字段一路留在状态里，再被写回存储 —— 越积越多且没人敢删。
 */
export function mergeOptionValues(
  exporter: Exporter,
  stored: ExportOptionValues | undefined,
): ExportOptionValues {
  const out: ExportOptionValues = {};
  for (const option of exporter.options) {
    const value = stored?.[option.key];
    out[option.key] = value === undefined ? option.default : value;
  }
  return out;
}

/** 调色板 hex 文本，供「复制到剪贴板」用 */
export function paletteHexText(palette: Palette): string {
  return palette.colors.map((c) => toHex(c[0], c[1], c[2])).join('\n');
}
