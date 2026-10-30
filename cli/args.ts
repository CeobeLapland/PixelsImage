/**
 * 命令行参数解析。
 *
 * 单独一个文件、纯函数：这样才能在 node 里直接单测「写错一个参数会不会给出
 * 看得懂的报错」，而不是靠手敲命令行试。CLI 的报错质量几乎等于它的可用性。
 */

import { makeDefaultSettings, type ConvertSettings } from '../src/core/types';
import type {
  DitherMode,
  DistanceMode,
  PreprocessSettings,
  SamplingMode,
} from '../src/core/types';

export const DEFAULT_TEMPLATE = '{name}_{w}x{h}.png';

export const USAGE = `pixcli —— PixelsImage 命令行批量转换

用法：
  pixcli <图片或目录...> --out <输出目录> [选项]

输入：
  可以给多个 PNG 文件，也可以给目录（只读该目录下一层的 *.png）
  注意：命令行只支持 PNG。JPEG / WebP 请先在浏览器版里转成 PNG，或自己转码。

常用选项：
  --out <dir>            输出目录（默认 ./out）
  --width <n>            目标格数（宽），默认 64
  --height <auto|n>      目标格数（高），默认 auto（按原图比例）
  --scale <n>            放大倍数，默认 1
  --palette <id>         调色板 id，默认 mc-dye。可选：
                         ${'mc-dye / mc-concrete / gray-8 / mono / pico8 / gameboy / nes / c64 / db16'}
  --palette-file <path>  从 .hex / .gpl 文件读调色板（优先于 --palette）
  --sampling <mode>      nearest / area / dominant / median（默认 area）
  --dither <mode>        none / atkinson / floyd / sierra / bayer2 / bayer4 / bayer8
  --distance <mode>      rgb / weighted / lab（默认 weighted）
  --colors <n>           改用 k-means 限色 n 色（覆盖 --palette）
  --remove-bg <mode>     edges / all / none（默认 none）—— 按颜色去背景
  --bg-color <hex>       去背景的底色（默认 #ffffff）
  --tolerance <n>        去背景容差 0-96（默认 24）
  --no-trim              不裁掉四周透明边（默认裁）
  --name <template>      命名模板，默认 ${DEFAULT_TEMPLATE}
                         可用占位符：{name} {w} {h} {scale} {index}
  --json                 同时输出每张图的网格 JSON（与浏览器版同格式）
  --config <path>        从 JSON 读一份转换参数，命令行选项会覆盖它
  --help                 显示这份说明

示例：
  pixcli ./raw --out ./px --width 32 --palette mc-dye --dither atkinson --scale 4
  pixcli a.png b.png --out ./px --colors 16 --remove-bg edges --json
`;

export interface CliOptions {
  /** 输入路径（文件或目录，目录在 run 时展开） */
  inputs: string[];
  outDir: string;
  template: string;
  scale: number;
  /** 是否同时输出网格 JSON */
  json: boolean;
  /** 从文件读的调色板（优先于 settings.paletteId）；null = 用内置板 */
  paletteFile: string | null;
  /** 参数文件路径；由 runCli 读取并与下面的 override 合并 */
  configPath: string | null;
  /** 命令行上**明确给出**的参数 */
  overrides: Partial<ConvertSettings>;
  preprocessOverrides: Partial<PreprocessSettings>;
}

export type ParseResult =
  | { kind: 'help' }
  | { kind: 'error'; message: string }
  | { kind: 'run'; options: CliOptions };

/**
 * 最终参数 = 默认值 ← config 文件 ← 命令行上明确给出的项。
 *
 * 之所以要三层而不是「命令行直接覆盖默认值」：`--config` 的意义就是「这一批都用这套」，
 * 而临时想改一项就加个 flag —— 如果 flag 和 config 都改了同一个字段，
 * 后写的（命令行）应该赢，这是所有 CLI 的惯例。
 */
export function resolveSettings(
  config: unknown,
  overrides: Partial<ConvertSettings>,
  preprocessOverrides: Partial<PreprocessSettings>,
): ConvertSettings {
  // 命令行的默认「裁掉四周透明边」与网页版相反：批量出素材时，
  // 每张图外面带一圈透明没有任何用处，只会让尺寸对不齐；
  // 网页版不裁是因为画布上还要看完整构图。想保留就用 --no-trim。
  const base = mergeConfig({ ...makeDefaultSettings(), trimTransparent: true }, config);
  return {
    ...base,
    ...overrides,
    preprocess: { ...base.preprocess, ...preprocessOverrides },
  };
}

const SAMPLING: readonly SamplingMode[] = ['nearest', 'area', 'dominant', 'median'];
const DITHER: readonly DitherMode[] = [
  'none',
  'atkinson',
  'floyd',
  'sierra',
  'bayer2',
  'bayer4',
  'bayer8',
];
const DISTANCE: readonly DistanceMode[] = ['rgb', 'weighted', 'lab'];

function isOneOf<T extends string>(value: string, list: readonly T[]): value is T {
  return (list as readonly string[]).includes(value);
}

/** 把 --config 读到的 JSON 合进默认参数；只认已知字段，preprocess 深合并 */
export function mergeConfig(base: ConvertSettings, raw: unknown): ConvertSettings {
  // 数组也是 object，但它不是一份参数 —— 展开会把 0/1/2 当成字段名混进去
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const cfg = raw as Partial<ConvertSettings>;
  return {
    ...base,
    ...cfg,
    preprocess: { ...base.preprocess, ...(cfg.preprocess ?? {}) },
  };
}

export function parseArgs(argv: readonly string[]): ParseResult {
  const inputs: string[] = [];
  let outDir = './out';
  let template = DEFAULT_TEMPLATE;
  let scale = 1;
  let json = false;
  let paletteFile: string | null = null;
  let configPath: string | null = null;
  /** 命令行上明确给过的参数，等 runCli 读完 config 后再叠上去 */
  const overrides: Partial<ConvertSettings> = {};
  const preprocessOverrides: Partial<PreprocessSettings> = {};

  if (argv.length === 0) return { kind: 'help' };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    const next = (): string | null => {
      const value = argv[i + 1];
      if (value === undefined) return null;
      i += 1;
      return value;
    };
    const badNumber = (): ParseResult => ({
      kind: 'error',
      message: `${arg} 需要一个数字，但没给或给了别的值`,
    });

    switch (arg) {
      case '--help':
      case '-h':
        return { kind: 'help' };

      case '--out': {
        const v = next();
        if (v === null) return { kind: 'error', message: '--out 缺少目录名' };
        outDir = v;
        break;
      }
      case '--name': {
        const v = next();
        if (v === null) return { kind: 'error', message: '--name 缺少模板' };
        template = v;
        break;
      }
      case '--scale': {
        const v = next();
        if (v === null) return badNumber();
        const n = Number(v);
        if (!Number.isFinite(n) || n < 1) return badNumber();
        scale = Math.round(n);
        break;
      }
      case '--width': {
        const v = next();
        if (v === null) return badNumber();
        const n = Number(v);
        if (!Number.isFinite(n) || n < 2) return badNumber();
        overrides.targetW = Math.round(n);
        break;
      }
      case '--height': {
        const v = next();
        if (v === null) return badNumber();
        if (v === 'auto') {
          overrides.targetH = 'auto';
          break;
        }
        const n = Number(v);
        if (!Number.isFinite(n) || n < 2) return badNumber();
        overrides.targetH = Math.round(n);
        break;
      }
      case '--palette': {
        const v = next();
        if (v === null) return { kind: 'error', message: '--palette 缺少 id' };
        overrides.paletteId = v;
        break;
      }
      case '--palette-file': {
        const v = next();
        if (v === null) return { kind: 'error', message: '--palette-file 缺少路径' };
        paletteFile = v;
        break;
      }
      case '--colors': {
        const v = next();
        if (v === null) return badNumber();
        const n = Number(v);
        if (!Number.isFinite(n) || n < 2 || n > 256) {
          return { kind: 'error', message: '--colors 需要在 2-256 之间' };
        }
        overrides.quantize = 'kmeans';
        overrides.maxColors = Math.round(n);
        break;
      }
      case '--sampling': {
        const v = next();
        if (v === null || !isOneOf(v, SAMPLING)) {
          return { kind: 'error', message: `--sampling 只能是 ${SAMPLING.join(' / ')}` };
        }
        overrides.sampling = v;
        break;
      }
      case '--dither': {
        const v = next();
        if (v === null || !isOneOf(v, DITHER)) {
          return { kind: 'error', message: `--dither 只能是 ${DITHER.join(' / ')}` };
        }
        overrides.dither = v;
        break;
      }
      case '--distance': {
        const v = next();
        if (v === null || !isOneOf(v, DISTANCE)) {
          return { kind: 'error', message: `--distance 只能是 ${DISTANCE.join(' / ')}` };
        }
        overrides.distance = v;
        break;
      }
      case '--remove-bg': {
        const v = next();
        if (v === null || !isOneOf(v, ['edges', 'all', 'none'] as const)) {
          return { kind: 'error', message: '--remove-bg 只能是 edges / all / none' };
        }
        preprocessOverrides.removeBackground = v;
        break;
      }
      case '--bg-color': {
        const v = next();
        if (v === null || !/^#?[0-9a-fA-F]{6}$/.test(v)) {
          return { kind: 'error', message: '--bg-color 需要 #rrggbb 形式的色值' };
        }
        preprocessOverrides.bgColor = v.startsWith('#') ? v : `#${v}`;
        break;
      }
      case '--tolerance': {
        const v = next();
        if (v === null) return badNumber();
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 96) {
          return { kind: 'error', message: '--tolerance 需要在 0-96 之间' };
        }
        preprocessOverrides.bgTolerance = Math.round(n);
        break;
      }
      case '--no-trim':
        overrides.trimTransparent = false;
        break;
      case '--json':
        json = true;
        break;
      case '--config': {
        const v = next();
        if (v === null) return { kind: 'error', message: '--config 缺少路径' };
        configPath = v;
        break;
      }
      default:
        if (arg.startsWith('--')) {
          return { kind: 'error', message: `不认识的选项 ${arg}（用 --help 看用法）` };
        }
        inputs.push(arg);
    }
  }


  if (inputs.length === 0) {
    return { kind: 'error', message: '没有给输入文件（用 --help 看用法）' };
  }

  return {
    kind: 'run',
    options: {
      inputs,
      outDir,
      template,
      scale,
      json,
      paletteFile,
      configPath,
      overrides,
      preprocessOverrides,
    },
  };
}
