/**
 * 命令行批量转换（M7）。
 *
 * 它复用 `src/core/` 那一整套纯逻辑（流水线、调色板、命名模板），
 * 但**不碰任何 DOM**：图片编解码用同目录下的 png.ts（基于 node:zlib）。
 *
 * 分工：
 *   args.ts  —— 解析参数（纯函数，可单测）
 *   png.ts   —— PNG 编解码（可单测）
 *   index.ts —— 读文件、跑转换、写文件（真正的 IO）
 *
 * 为什么不直接跑 TS 源码而要打包：`src/` 里用的是 `@/` 别名与无扩展名的相对导入，
 * node 的裸 TS 支持（type stripping）不认这些；用 esbuild 打成单文件最省事。
 * 见 package.json 的 `build:cli`。
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join, extname } from 'node:path';

import { applyNameTemplate, dedupeFileNames } from '../src/core/batch/naming';
import { parseArgs, resolveSettings, USAGE, type CliOptions } from './args';
import { gridToRgba, upscaleNearestRgba } from '../src/core/composite';
import { buildGridJson, serializeGridJson } from '../src/core/exporters/gridJson';
import { decodePng, encodePng } from './png';
import { convert } from '../src/core/pipeline';
import { BUILTIN_PALETTES, resolvePalette } from '../src/palettes/builtin';
import { parsePaletteText } from '../src/palettes/parse';
import type { ConvertSettings, Palette, PixelGrid, RGBAImage } from '../src/core/types';

/* ---------------------------------------------------------------- 依赖注入口 */

/**
 * 极小的注入面：测试里可以把 fs 换成内存实现，
 * 这样「目录展开」「命名去重」「坏图不中断」这些行为都能在纯 node 里测，
 * 不必真的往磁盘写东西（虽然也能写，但那样测得更慢、还要清理）。
 */
export interface CliIo {
  readFile: (path: string) => Buffer;
  writeFile: (path: string, data: Buffer | string) => void;
  mkdir: (path: string) => void;
  listDir: (path: string) => string[];
  isDirectory: (path: string) => boolean;
  log: (line: string) => void;
}

export const nodeIo: CliIo = {
  readFile: (path) => readFileSync(path),
  writeFile: (path, data) => writeFileSync(path, data),
  mkdir: (path) => {
    mkdirSync(path, { recursive: true });
  },
  listDir: (path) => readdirSync(path),
  isDirectory: (path) => {
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  },
  log: (line) => {
    // eslint 不在这里管；CLI 的输出就是这个
    process.stdout.write(`${line}\n`);
  },
};

/* ------------------------------------------------------------------ 工具 */

/** 目录只收 PNG；命令行不支持 JPEG 是有意为之（见 usage 里的说明） */
export function expandInputs(inputs: readonly string[], io: CliIo): string[] {
  const out: string[] = [];
  for (const input of inputs) {
    if (io.isDirectory(input)) {
      for (const name of io.listDir(input)) {
        if (extname(name).toLowerCase() !== '.png') continue;
        out.push(join(input, name));
      }
    } else {
      out.push(input);
    }
  }
  return out;
}

/** 把调色板文本文件读成调色板对象；解析失败就抛，带上文件名 */
function paletteFromFile(path: string, io: CliIo): Palette {
  const text = io.readFile(path).toString('utf8');
  const parsed = parsePaletteText(text, basename(path));
  if (!parsed || parsed.length === 0) {
    throw new Error(`调色板文件里没读到任何颜色：${path}`);
  }
  return {
    id: `file-${basename(path)}`,
    name: basename(path).replace(/\.[^.]+$/, ''),
    colors: parsed,
    builtin: false,
    source: 'custom',
  };
}

/** 一次转换的中间产物：还没落盘，因为文件名要用到裁剪后的网格尺寸 */
interface Conversion {
  grid: PixelGrid;
  palette: Palette;
  sourceName: string;
  usedColors: number;
}

/** 读图 + 转换，不写文件（命名要等拿到 grid.w/grid.h 才能算） */
function convertFile(
  path: string,
  settings: ConvertSettings,
  palette: Palette,
  io: CliIo,
): Conversion {
  const decoded = decodePng(io.readFile(path));
  const image: RGBAImage = { width: decoded.width, height: decoded.height, data: decoded.data };

  const result = convert(image, settings, palette);
  return {
    // k-means 限色时调色板是现场生成的，必须用回传那块来渲染，否则索引对不上
    grid: result.grid,
    palette: result.generatedPalette ?? palette,
    sourceName: basename(path),
    usedColors: result.usedColors,
  };
}

/**
 * 落盘：PNG（按 `--scale` 最近邻放大）+ 可选的同名 JSON。
 *
 * 名字由调用方算好传进来：整批的去重要跨文件统一做（见主循环的 taken），
 * 否则两个不同目录里的 `hero.png` 会静默覆盖同一个输出文件。
 */
function writeConversion(
  conv: Conversion,
  name: string,
  options: CliOptions,
  io: CliIo,
): void {
  const rgba = new Uint8ClampedArray(conv.grid.w * conv.grid.h * 4);
  gridToRgba(conv.grid, conv.palette, rgba);
  const scaled = upscaleNearestRgba(rgba, conv.grid.w, conv.grid.h, options.scale);
  io.writeFile(join(options.outDir, name), encodePng(scaled.data, scaled.width, scaled.height));

  if (!options.json) return;
  const jsonName = name.replace(/\.png$/i, '.json');
  const json = buildGridJson(conv.grid, conv.palette, conv.sourceName, {
    alwaysAlpha: false,
    includePalette: true,
  });
  io.writeFile(join(options.outDir, jsonName), serializeGridJson(json));
}

/* ------------------------------------------------------------------ 主流程 */

export interface RunOutcome {
  /** 0 = 全部成功；1 = 有失败 */
  code: number;
  ok: number;
  failed: number;
}

export function runCli(argv: readonly string[], io: CliIo = nodeIo): RunOutcome {
  return runCliInner(argv, io);
}

function runCliInner(argv: readonly string[], io: CliIo): RunOutcome {
  const parsed = parseArgs(argv);
  if (parsed.kind === 'help') {
    io.log(USAGE);
    return { code: 0, ok: 0, failed: 0 };
  }
  if (parsed.kind === 'error') {
    io.log(`参数错误：${parsed.message}`);
    io.log('');
    io.log('用 --help 查看用法。');
    return { code: 1, ok: 0, failed: 0 };
  }

  const options = parsed.options;

  let config: unknown = null;
  if (options.configPath) {
    try {
      config = JSON.parse(io.readFile(options.configPath).toString('utf8'));
    } catch (err) {
      io.log(`读不了参数文件 ${options.configPath}：${err instanceof Error ? err.message : err}`);
      return { code: 1, ok: 0, failed: 0 };
    }
  }

  const settings = resolveSettings(config, options.overrides, options.preprocessOverrides);

  let palette: Palette;
  if (options.paletteFile) {
    try {
      palette = paletteFromFile(options.paletteFile, io);
    } catch (err) {
      io.log(`调色板读取失败：${err instanceof Error ? err.message : err}`);
      return { code: 1, ok: 0, failed: 0 };
    }
  } else {
    palette = resolvePalette(settings.paletteId, {});
    // 内置表里没有就用第一块，并明说一句 —— 静默换板会让人以为参数没生效
    if (palette.id !== settings.paletteId) {
      const fallback = BUILTIN_PALETTES[0] as Palette;
      io.log(`没找到调色板「${settings.paletteId}」，改用「${fallback.name}」`);
      palette = fallback;
    }
  }

  const files = expandInputs(options.inputs, io);
  if (files.length === 0) {
    io.log('输入里没有可处理的 PNG。');
    return { code: 1, ok: 0, failed: 0 };
  }

  io.mkdir(options.outDir);

  let ok = 0;
  let failed = 0;
  const started = Date.now();
  /** 已占用的输出名（含 .json 之外的碰撞）；同名会加 _2、_3 后缀而不是覆盖 */
  const taken: string[] = [];

  for (let i = 0; i < files.length; i += 1) {
    const path = files[i] as string;
    try {
      const conv = convertFile(path, settings, palette, io);
      const raw = applyNameTemplate(options.template, {
        name: basename(path),
        w: conv.grid.w,
        h: conv.grid.h,
        scale: options.scale,
        index: i + 1,
      });
      // 把「已占用 + 这一张」一起过一遍去重，最后一项就是这张的最终名字
      const name = dedupeFileNames([...taken, raw])[taken.length] as string;
      taken.push(name);

      writeConversion(conv, name, options, io);
      ok += 1;
      io.log(
        `✓ ${basename(path)} → ${name} (${conv.grid.w}×${conv.grid.h}, ${conv.usedColors} 色)`,
      );
    } catch (err) {
      failed += 1;
      // 单张失败不中断整批：批量跑一晚上，不该因为一个坏文件全废
      io.log(`✗ ${basename(path)}：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const seconds = ((Date.now() - started) / 1000).toFixed(1);
  io.log('');
  io.log(`完成：成功 ${ok} 张，失败 ${failed} 张，用时 ${seconds} 秒 → ${options.outDir}`);
  return { code: failed > 0 ? 1 : 0, ok, failed };
}
