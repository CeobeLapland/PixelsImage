/**
 * 命令行参数解析的测试（cli/args.ts）。
 *
 * CLI 的报错质量几乎等于它的可用性：参数写错时给出一句「不认识 --widht」，
 * 比把拼错的选项当成文件名、最后报「没有可处理的 PNG」要好得多。
 * 所以这里最花篇幅的是**报错**那几个用例。
 */

import { describe, expect, it } from 'vitest';

import { makeDefaultSettings } from '../src/core/types';
import { mergeConfig, parseArgs, resolveSettings } from './args';

describe('parseArgs：基本形态', () => {
  it('没有参数时给帮助（而不是报错）', () => {
    expect(parseArgs([]).kind).toBe('help');
  });

  it('--help / -h', () => {
    expect(parseArgs(['--help']).kind).toBe('help');
    expect(parseArgs(['-h']).kind).toBe('help');
  });

  it('默认值：./out、默认模板、scale 1、不输出 JSON', () => {
    const parsed = parseArgs(['a.png']);
    expect(parsed.kind).toBe('run');
    if (parsed.kind !== 'run') return;
    expect(parsed.options.outDir).toBe('./out');
    expect(parsed.options.template).toBe('{name}_{w}x{h}.png');
    expect(parsed.options.scale).toBe(1);
    expect(parsed.options.json).toBe(false);
    expect(parsed.options.inputs).toEqual(['a.png']);
    // 没在命令行明确给出的项不进 overrides —— 否则会覆盖 --config 里的同名项
    expect(parsed.options.overrides).toEqual({});
    expect(parsed.options.preprocessOverrides).toEqual({});
  });

  it('多个位置参数按顺序进 inputs', () => {
    const parsed = parseArgs(['a.png', 'raw', 'b.png']);
    if (parsed.kind !== 'run') throw new Error('应当是 run');
    expect(parsed.options.inputs).toEqual(['a.png', 'raw', 'b.png']);
  });

  it('--json 是个开关，没有值', () => {
    const parsed = parseArgs(['a.png', '--json']);
    if (parsed.kind !== 'run') throw new Error('应当是 run');
    expect(parsed.options.json).toBe(true);
  });
});

describe('parseArgs：各项覆盖', () => {
  function run(argv: string[]) {
    const parsed = parseArgs(argv);
    if (parsed.kind !== 'run') throw new Error(`应当是 run，实际是 ${parsed.kind}`);
    return parsed.options;
  }

  it('--out / --name / --scale', () => {
    const o = run(['a.png', '--out', 'dist', '--name', '{index}_{name}.png', '--scale', '4']);
    expect(o.outDir).toBe('dist');
    expect(o.template).toBe('{index}_{name}.png');
    expect(o.scale).toBe(4);
  });

  it('--width / --height', () => {
    const o = run(['a.png', '--width', '48', '--height', '32']);
    expect(o.overrides.targetW).toBe(48);
    expect(o.overrides.targetH).toBe(32);
  });

  it('--height auto 是合法的', () => {
    const o = run(['a.png', '--height', 'auto']);
    expect(o.overrides.targetH).toBe('auto');
  });

  it('--palette 只改 paletteId', () => {
    const o = run(['a.png', '--palette', 'pico8']);
    expect(o.overrides.paletteId).toBe('pico8');
  });

  it('--colors 同时切到 kmeans 并设上限', () => {
    const o = run(['a.png', '--colors', '12']);
    expect(o.overrides.quantize).toBe('kmeans');
    expect(o.overrides.maxColors).toBe(12);
  });

  it('--sampling / --dither / --distance', () => {
    const o = run(['a.png', '--sampling', 'median', '--dither', 'floyd', '--distance', 'lab']);
    expect(o.overrides.sampling).toBe('median');
    expect(o.overrides.dither).toBe('floyd');
    expect(o.overrides.distance).toBe('lab');
  });

  it('--remove-bg / --bg-color / --tolerance', () => {
    const o = run(['a.png', '--remove-bg', 'edges', '--bg-color', '#00ff00', '--tolerance', '40']);
    expect(o.preprocessOverrides.removeBackground).toBe('edges');
    expect(o.preprocessOverrides.bgColor).toBe('#00ff00');
    expect(o.preprocessOverrides.bgTolerance).toBe(40);
  });

  it('--bg-color 不带 # 也会补上（否则面板里两个字段格式不一致）', () => {
    const o = run(['a.png', '--bg-color', 'ff00ff']);
    expect(o.preprocessOverrides.bgColor).toBe('#ff00ff');
  });

  it('--no-trim 关掉裁剪', () => {
    const o = run(['a.png', '--no-trim']);
    expect(o.overrides.trimTransparent).toBe(false);
  });

  it('--palette-file 与 --config 只是记路径，等 runCli 去读', () => {
    const o = run(['a.png', '--palette-file', 'pal.gpl', '--config', 'cfg.json']);
    expect(o.paletteFile).toBe('pal.gpl');
    expect(o.configPath).toBe('cfg.json');
  });
});

describe('parseArgs：报错', () => {
  function errorOf(argv: string[]): string {
    const parsed = parseArgs(argv);
    if (parsed.kind !== 'error') throw new Error(`应当是 error，实际是 ${parsed.kind}`);
    return parsed.message;
  }

  it('拼错的选项不会被当成文件名', () => {
    expect(errorOf(['a.png', '--widht', '32'])).toContain('--widht');
  });

  it('缺值', () => {
    expect(errorOf(['a.png', '--out'])).toContain('--out');
    expect(errorOf(['a.png', '--name'])).toContain('--name');
    expect(errorOf(['a.png', '--config'])).toContain('--config');
  });

  it('数字不合法：0、负数、非数字', () => {
    expect(errorOf(['a.png', '--scale', '0'])).toContain('--scale');
    expect(errorOf(['a.png', '--width', '-3'])).toContain('--width');
    expect(errorOf(['a.png', '--height', 'abc'])).toContain('--height');
  });

  it('枚举值不合法时把可选项列出来', () => {
    expect(errorOf(['a.png', '--dither', 'floyd-steinberg'])).toContain('none / atkinson');
    expect(errorOf(['a.png', '--sampling', 'lanczos'])).toContain('nearest / area');
    expect(errorOf(['a.png', '--remove-bg', 'flood'])).toContain('edges / all / none');
  });

  it('--colors 与 --tolerance 越界', () => {
    expect(errorOf(['a.png', '--colors', '1'])).toContain('2-256');
    expect(errorOf(['a.png', '--colors', '300'])).toContain('2-256');
    expect(errorOf(['a.png', '--tolerance', '200'])).toContain('0-96');
  });

  it('--bg-color 不是 6 位十六进制', () => {
    expect(errorOf(['a.png', '--bg-color', 'green'])).toContain('#rrggbb');
  });

  it('只有选项没有输入', () => {
    expect(errorOf(['--out', 'dist'])).toContain('没有给输入');
  });
});

describe('参数合并：默认 ← config ← 命令行', () => {
  it('config 里的字段会被采用', () => {
    const settings = resolveSettings({ targetW: 24, sampling: 'median' }, {}, {});
    expect(settings.targetW).toBe(24);
    expect(settings.sampling).toBe('median');
  });

  it('命令行给的项赢过 config', () => {
    const settings = resolveSettings({ targetW: 24, dither: 'atkinson' }, { targetW: 48 }, {});
    expect(settings.targetW).toBe(48);
    expect(settings.dither).toBe('atkinson');
  });

  it('preprocess 是深合并，不是整体替换', () => {
    const settings = resolveSettings(
      { preprocess: { removeBackground: 'edges', bgTolerance: 40 } },
      {},
      { bgColor: '#00ff00' },
    );
    // config 里的两项还在，命令行的 bgColor 也叠上了
    expect(settings.preprocess.removeBackground).toBe('edges');
    expect(settings.preprocess.bgTolerance).toBe(40);
    expect(settings.preprocess.bgColor).toBe('#00ff00');
  });

  it('config 是 null 或垃圾时退回默认值', () => {
    // 命令行的默认多一项「裁透明边」，与网页版相反（见 resolveSettings 的注释）
    const defaults = { ...makeDefaultSettings(), trimTransparent: true };
    expect(resolveSettings(null, {}, {})).toEqual(defaults);
    expect(resolveSettings('not json', {}, {})).toEqual(defaults);
    expect(resolveSettings([1, 2, 3], {}, {})).toEqual(defaults);
  });

  it('--no-trim 能盖掉命令行的默认裁剪', () => {
    expect(resolveSettings(null, { trimTransparent: false }, {}).trimTransparent).toBe(false);
  });

  it('mergeConfig 保留默认的其余字段', () => {
    const merged = mergeConfig(makeDefaultSettings(), { targetW: 16 });
    expect(merged.targetW).toBe(16);
    expect(merged.paletteId).toBe(makeDefaultSettings().paletteId);
  });
});
