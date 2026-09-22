/**
 * 批量转换的执行层（M5）。
 *
 * 两个职责，都刻意与 store 解耦：
 *
 * 1. **BatchConverter** —— 用一个**独立的** PipelineRunner 实例跑队列。
 *    为什么不能复用单图那个 `getPipelineRunner()`：它只持有「一张」源图，
 *    并且会把待处理请求合并成最新一条（那是为拖动滑块设计的）。
 *    批量往里塞图会把编辑器正在看的源图顶掉，两边的请求互相打断。
 *    再开一个 Worker 实例代价很小（同一份 worker 脚本，各自独立的模块作用域），
 *    换来的是「批量在后台跑，编辑器照常可用」。
 *
 * 2. **buildBatchZip** —— 把已完成项编码成 PNG、附上调色板与报告，打成一个 zip。
 */

import { buildBatchNames } from '@/core/batch/naming';
import type { BatchItem } from '@/core/batch/queue';
import { createZip, type ZipEntry } from '@/core/batch/zip';
import { exportGridPng } from '@/core/exporters/png';
import { serializeHexPalette } from '@/palettes/parse';
import { PipelineRunner, type ConvertOutcome } from '@/core/workers/client';
import type { ConvertSettings, Palette, RGBAImage } from '@/core/types';

/* ------------------------------------------------------------ 转换执行器 */

let sourceSeq = 0;

export class BatchConverter {
  private runner = new PipelineRunner();
  private waiting: {
    resolve: (outcome: ConvertOutcome) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor() {
    this.runner.subscribe(
      (outcome) => {
        const waiting = this.waiting;
        this.waiting = null;
        waiting?.resolve(outcome);
      },
      (message) => {
        const waiting = this.waiting;
        this.waiting = null;
        waiting?.reject(new Error(message));
      },
    );
  }

  /**
   * 转换一张图。必须**串行**调用（一次只等一个），
   * 因为 PipelineRunner 只维护一条在途请求；并行调用会互相顶掉。
   */
  convert(image: RGBAImage, settings: ConvertSettings, palette: Palette): Promise<ConvertOutcome> {
    if (this.waiting) {
      return Promise.reject(new Error('批量转换器正在处理上一张图，请勿并行调用'));
    }

    sourceSeq += 1;
    this.runner.setSource({
      id: `batch-${Date.now().toString(36)}-${sourceSeq}`,
      width: image.width,
      height: image.height,
      data: image.data,
    });

    return new Promise<ConvertOutcome>((resolve, reject) => {
      this.waiting = { resolve, reject };
      // fast=false：批量是「一次算准」，没有拖动滑块那种跟手要求
      this.runner.request(settings, palette, false);
    });
  }

  dispose(): void {
    this.runner.dispose();
  }
}

let singleton: BatchConverter | null = null;

export function getBatchConverter(): BatchConverter {
  if (!singleton) singleton = new BatchConverter();
  return singleton;
}

/* -------------------------------------------------------------- 打包导出 */

export interface BatchPackageOptions {
  template: string;
  scale: number;
  background: 'transparent' | string;
}

export interface BatchPackage {
  blob: Blob;
  /** 包内 PNG 张数 */
  imageCount: number;
  /** 建议的下载文件名 */
  fileName: string;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/** 两位补零，报告里读起来整齐 */
function two(n: number): string {
  return String(n).padStart(2, '0');
}

function stamp(date: Date): string {
  return (
    `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}` +
    `-${two(date.getHours())}${two(date.getMinutes())}`
  );
}

/**
 * 把已完成项打包成 zip。
 *
 * 内容三部分：
 * - 每张图的 PNG（按命名模板生成名字，已去重）
 * - 用到的调色板 `.hex`（k-means 限色下每张图的板可能不同，那就一块一个文件）
 * - `report.txt`：逐项尺寸/用色/耗时，以及「哪张图用了哪块板」
 */
export async function buildBatchZip(
  items: readonly BatchItem[],
  options: BatchPackageOptions,
): Promise<BatchPackage> {
  const done = items.filter((item) => item.status === 'done' && item.result);
  if (done.length === 0) throw new Error('队列里还没有转换完成的图片');

  const names = buildBatchNames(
    options.template,
    done.map((item) => ({
      name: item.fileName,
      w: item.result?.grid.w ?? 0,
      h: item.result?.grid.h ?? 0,
    })),
    options.scale,
  );

  const entries: ZipEntry[] = [];
  const rows: string[] = [];

  /* ---------------- 逐张 PNG ---------------- */
  for (let i = 0; i < done.length; i += 1) {
    const item = done[i];
    const result = item.result;
    if (!result) continue;
    const blob = await exportGridPng(result.grid, result.palette, {
      scale: options.scale,
      background: options.background,
    });
    entries.push({ name: names[i], data: new Uint8Array(await blob.arrayBuffer()) });
    rows.push(
      [
        pad(names[i], 28),
        pad(item.fileName, 24),
        pad(`${result.grid.w}×${result.grid.h}`, 10),
        pad(`${result.grid.w * options.scale}×${result.grid.h * options.scale}`, 12),
        pad(String(result.usedColors), 6),
        `${result.ms.toFixed(1)} ms`,
      ].join(' '),
    );
  }

  /* ---------------- 调色板 ---------------- */
  const palettes: Palette[] = [];
  for (const item of done) {
    const palette = item.result?.palette;
    if (palette && !palettes.some((p) => p.id === palette.id)) palettes.push(palette);
  }
  const paletteFileOf = new Map<string, string>();
  palettes.forEach((palette, i) => {
    const file = palettes.length === 1 ? 'palette.hex' : `palette-${i + 1}.hex`;
    paletteFileOf.set(palette.id, file);
    entries.push({
      name: file,
      data: new TextEncoder().encode(serializeHexPalette(palette.colors, palette.name)),
    });
  });

  /* ---------------- 报告 ---------------- */
  const now = new Date();
  const lines: string[] = [
    'PixelsImage 批量导出报告',
    `生成时间：${now.toLocaleString()}`,
    `图片数量：${rows.length}`,
    `放大倍数：${options.scale}×`,
    `背景：${options.background === 'transparent' ? '透明' : options.background}`,
    '',
    pad('导出文件', 28) +
      ' ' +
      pad('源文件', 24) +
      ' ' +
      pad('网格', 10) +
      ' ' +
      pad('输出像素', 12) +
      ' ' +
      pad('用色', 6) +
      '耗时',
    '-'.repeat(100),
    ...rows,
    '',
    '调色板：',
    ...palettes.map(
      (p) => `  ${paletteFileOf.get(p.id)}  ${p.name}（${p.colors.length} 色）`,
    ),
    '',
    '命名模板：' + options.template,
  ];
  entries.push({ name: 'report.txt', data: new TextEncoder().encode(lines.join('\n')) });

  const zip = createZip(entries, now);
  return {
    // 复制成独立缓冲：Uint8Array 的 buffer 可能带偏移，直接交给 Blob 会多传字节
    blob: new Blob([zip.slice().buffer as ArrayBuffer], { type: 'application/zip' }),
    imageCount: rows.length,
    fileName: `pixels-batch-${stamp(now)}.zip`,
  };
}
