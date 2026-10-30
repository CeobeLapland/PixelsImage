/**
 * CLI 主流程的测试（cli/index.ts）。
 *
 * 用内存版 CliIo 跑，不写磁盘：要测的几件事（目录展开、跨文件命名去重、
 * 坏图不中断整批）都发生在「文件系统边界」上，把它们换成内存实现反而更难测错 ——
 * 而且真的往磁盘写会在并行跑测试时互相踩。
 */

import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CliIo, RunOutcome } from './index';
import { expandInputs, runCli } from './index';
import { decodePng, encodePng } from './png';

/* ---------------------------------------------------------------- 内存文件系统 */

interface MemFs {
  files: Map<string, Buffer | string>;
  dirs: Set<string>;
}

/** 造一张纯色的 RGBA PNG（w×h） */
function solidPng(width: number, height: number, rgba: readonly number[]): Buffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    data.set(rgba, i * 4);
  }
  return encodePng(data, width, height);
}

/** 左半、右半各一色的 PNG（用来测「只用调色板里的色」） */
function twoColorPng(width: number, height: number, left: number[], right: number[]): Buffer {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      data.set(x < width / 2 ? left : right, (y * width + x) * 4);
    }
  }
  return encodePng(data, width, height);
}

function memoryFs(initial: Record<string, Buffer | string>): MemFs {
  const files = new Map<string, Buffer | string>();
  const dirs = new Set<string>();
  for (const [path, value] of Object.entries(initial)) {
    files.set(path, value);
    dirs.add(dirname(path));
  }
  return { files, dirs };
}

function makeIo(fs: MemFs): { io: CliIo; logs: string[] } {
  const logs: string[] = [];
  const io: CliIo = {
    readFile: (path) => {
      const value = fs.files.get(path);
      if (value === undefined) throw new Error(`文件不存在：${path}`);
      return Buffer.isBuffer(value) ? value : Buffer.from(value);
    },
    writeFile: (path, data) => {
      fs.files.set(path, data);
      fs.dirs.add(dirname(path));
    },
    mkdir: (path) => {
      fs.dirs.add(path);
    },
    listDir: (path) => {
      const out: string[] = [];
      for (const key of fs.files.keys()) {
        if (dirname(key) === path) out.push(key.slice(path.length + 1));
      }
      return out;
    },
    isDirectory: (path) => fs.dirs.has(path),
    log: (line) => {
      logs.push(line);
    },
  };
  return { io, logs };
}

/** 直接问结果，省得每个用例都拆 RunOutcome */
function run(fs: MemFs, argv: string[]): { outcome: RunOutcome; logs: string[]; io: CliIo } {
  const { io, logs } = makeIo(fs);
  return { outcome: runCli(argv, io), logs, io };
}

/* ------------------------------------------------------------------- 用例 */

describe('expandInputs', () => {
  it('目录只收下一层的 .png，其他扩展名跳过', () => {
    const fs = memoryFs({
      [join('raw', 'a.png')]: 'x',
      [join('raw', 'b.PNG')]: 'x',
      [join('raw', 'note.txt')]: 'x',
      [join('raw', 'sub', 'c.png')]: 'x',
    });
    const { io } = makeIo(fs);
    expect(expandInputs(['raw'], io).sort()).toEqual(
      [join('raw', 'a.png'), join('raw', 'b.PNG')].sort(),
    );
  });

  it('文件参数原样保留（不检查扩展名，读的时候自然会报错）', () => {
    const { io } = makeIo(memoryFs({}));
    expect(expandInputs(['hero.jpg'], io)).toEqual(['hero.jpg']);
  });
});

describe('runCli：参数与帮助', () => {
  it('--help 打印用法并返回 0', () => {
    const { outcome, logs } = run(memoryFs({}), ['--help']);
    expect(outcome.code).toBe(0);
    expect(logs.join('\n')).toContain('pixcli');
  });

  it('没有参数给帮助', () => {
    const { outcome, logs } = run(memoryFs({}), []);
    expect(outcome.code).toBe(0);
    expect(logs.join('\n')).toContain('用法');
  });

  it('参数写错返回 1，且不写任何文件', () => {
    const fs = memoryFs({ [join('raw', 'a.png')]: solidPng(4, 4, [255, 0, 0, 255]) });
    const { outcome, logs } = run(fs, ['raw/a.png', '--widht', '32']);
    expect(outcome.code).toBe(1);
    expect(logs.join('\n')).toContain('--widht');
    expect(fs.files.has(join('out', 'a_4x4.png'))).toBe(false);
  });
});

describe('runCli：单张与目录', () => {
  it('转换一张，文件名按模板并带尺寸', () => {
    const source = join('raw', 'a.png');
    const fs = memoryFs({ [source]: solidPng(8, 8, [51, 102, 204, 255]) });
    const { outcome, logs } = run(fs, [source, '--out', 'out', '--width', '4']);

    expect(outcome).toMatchObject({ code: 0, ok: 1, failed: 0 });
    const outPath = join('out', 'a_4x4.png');
    expect(fs.files.has(outPath)).toBe(true);
    expect(decodePng(fs.files.get(outPath) as Buffer).width).toBe(4);
    // 日志要能看出「哪张进来、哪张出去」
    expect(logs.join('\n')).toContain('a_4x4.png');
  });

  it('目录输入会展开，非 PNG 不参与', () => {
    const fs = memoryFs({
      [join('raw', 'a.png')]: solidPng(4, 4, [255, 0, 0, 255]),
      [join('raw', 'b.png')]: solidPng(4, 4, [0, 255, 0, 255]),
      [join('raw', 'note.txt')]: 'hello',
    });
    const { outcome, logs } = run(fs, ['raw', '--out', 'out', '--width', '4']);
    expect(outcome).toMatchObject({ code: 0, ok: 2, failed: 0 });
    expect(fs.files.has(join('out', 'a_4x4.png'))).toBe(true);
    expect(fs.files.has(join('out', 'b_4x4.png'))).toBe(true);
    expect(logs).toHaveLength(2 + 2); // 两张的 ✓ + 空行 + 汇总
  });

  it('不同目录里的同名文件不会互相覆盖（加 _2）', () => {
    const fs = memoryFs({
      [join('one', 'hero.png')]: solidPng(4, 4, [255, 0, 0, 255]),
      [join('two', 'hero.png')]: solidPng(4, 4, [0, 0, 255, 255]),
    });
    const { outcome } = run(fs, [join('one', 'hero.png'), join('two', 'hero.png'), '--out', 'out', '--width', '4']);
    expect(outcome.ok).toBe(2);
    expect(fs.files.has(join('out', 'hero_4x4.png'))).toBe(true);
    expect(fs.files.has(join('out', 'hero_4x4_2.png'))).toBe(true);
  });

  it('--name 模板里的 {index} 从 1 开始', () => {
    const fs = memoryFs({
      [join('raw', 'a.png')]: solidPng(4, 4, [255, 0, 0, 255]),
      [join('raw', 'b.png')]: solidPng(4, 4, [0, 255, 0, 255]),
    });
    const { outcome } = run(fs, ['raw', '--out', 'out', '--width', '4', '--name', '{index}_{name}.png']);
    expect(outcome.ok).toBe(2);
    expect(fs.files.has(join('out', '1_a.png'))).toBe(true);
    expect(fs.files.has(join('out', '2_b.png'))).toBe(true);
  });

  it('--scale 只放大输出文件，不改网格尺寸', () => {
    const source = join('raw', 'a.png');
    const fs = memoryFs({ [source]: solidPng(4, 4, [10, 20, 30, 255]) });
    const { outcome } = run(fs, [source, '--out', 'out', '--width', '4', '--scale', '3']);
    expect(outcome.ok).toBe(1);
    const decoded = decodePng(fs.files.get(join('out', 'a_4x4.png')) as Buffer);
    expect(decoded.width).toBe(12);
    expect(decoded.height).toBe(12);
  });
});

describe('runCli：坏图与容错', () => {
  it('坏图只记失败，不影响其余文件', () => {
    const fs = memoryFs({
      [join('raw', 'bad.png')]: '这根本不是 PNG',
      [join('raw', 'good.png')]: solidPng(4, 4, [0, 128, 0, 255]),
    });
    const { outcome, logs } = run(fs, ['raw', '--out', 'out', '--width', '4']);
    expect(outcome).toMatchObject({ ok: 1, failed: 1, code: 1 });
    expect(logs.join('\n')).toContain('✗ bad.png');
    expect(fs.files.has(join('out', 'good_4x4.png'))).toBe(true);
  });

  it('目录里没有 PNG 时返回 1', () => {
    const fs = memoryFs({ [join('raw', 'note.txt')]: 'hi' });
    const { outcome, logs } = run(fs, ['raw', '--out', 'out']);
    expect(outcome.code).toBe(1);
    expect(logs.join('\n')).toContain('没有可处理的 PNG');
  });

  it('--config 文件读不了就整体退出', () => {
    const fs = memoryFs({ [join('raw', 'a.png')]: solidPng(4, 4, [1, 2, 3, 255]) });
    const { outcome, logs } = run(fs, ['raw', '--config', 'nope.json']);
    expect(outcome.code).toBe(1);
    expect(logs.join('\n')).toContain('读不了参数文件');
  });
});

describe('runCli：调色板', () => {
  it('--palette-file 优先于内置板，输出只含文件里的色', () => {
    const fs = memoryFs({
      [join('raw', 'a.png')]: twoColorPng(8, 8, [255, 0, 0, 255], [0, 255, 0, 255]),
      [join('pal.hex')]: '#FF0000\n#0000FF\n',
    });
    const { outcome } = run(fs, [
      'raw',
      '--out',
      'out',
      '--width',
      '4',
      '--palette',
      'pico8',
      '--palette-file',
      'pal.hex',
    ]);
    expect(outcome.ok).toBe(1);

    const decoded = decodePng(fs.files.get(join('out', 'a_4x4.png')) as Buffer);
    const seen = new Set<string>();
    for (let i = 0; i < decoded.width * decoded.height; i += 1) {
      const o = i * 4;
      if (decoded.data[o + 3] === 0) continue;
      seen.add(`${decoded.data[o]},${decoded.data[o + 1]},${decoded.data[o + 2]}`);
    }
    expect(seen.size).toBeLessThanOrEqual(2);
    for (const key of seen) expect(['255,0,0', '0,0,255']).toContain(key);
  });

  it('调色板文件读不出颜色时报错，而不是拿空板去量化', () => {
    const fs = memoryFs({
      [join('raw', 'a.png')]: solidPng(4, 4, [1, 2, 3, 255]),
      [join('pal.hex')]: '# 只有一行注释\n',
    });
    const { outcome, logs } = run(fs, ['raw', '--palette-file', 'pal.hex']);
    expect(outcome.code).toBe(1);
    expect(logs.join('\n')).toContain('调色板读取失败');
  });

  it('内置表里没有的 id 会回退到第一块并说明一句', () => {
    const fs = memoryFs({ [join('raw', 'a.png')]: solidPng(4, 4, [1, 2, 3, 255]) });
    const { outcome, logs } = run(fs, ['raw', '--out', 'out', '--width', '4', '--palette', 'nope']);
    expect(outcome.ok).toBe(1);
    expect(logs.join('\n')).toContain('改用');
  });

  it('--colors 走 k-means，输出颜色数不超过给定值', () => {
    const fs = memoryFs({
      [join('raw', 'a.png')]: twoColorPng(8, 8, [200, 10, 10, 255], [10, 10, 200, 255]),
    });
    const { outcome } = run(fs, ['raw', '--out', 'out', '--width', '4', '--colors', '4']);
    expect(outcome.ok).toBe(1);

    const decoded = decodePng(fs.files.get(join('out', 'a_4x4.png')) as Buffer);
    const seen = new Set<string>();
    for (let i = 0; i < decoded.width * decoded.height; i += 1) {
      const o = i * 4;
      seen.add(`${decoded.data[o]},${decoded.data[o + 1]},${decoded.data[o + 2]}`);
    }
    expect(seen.size).toBeLessThanOrEqual(4);
  });
});

describe('runCli：--json / --config / 覆盖顺序', () => {
  it('--json 同时写出一份网格 JSON', () => {
    const fs = memoryFs({ [join('raw', 'a.png')]: solidPng(4, 4, [255, 0, 0, 255]) });
    const { outcome } = run(fs, ['raw', '--out', 'out', '--width', '4', '--json']);
    expect(outcome.ok).toBe(1);

    const text = fs.files.get(join('out', 'a_4x4.json'));
    expect(typeof text).toBe('string');
    const json = JSON.parse(text as string) as { w: number; h: number; indices: number[] };
    expect(json.w).toBe(4);
    expect(json.h).toBe(4);
    expect(json.indices).toHaveLength(16);
  });

  it('--config 里的 targetW 生效', () => {
    const fs = memoryFs({
      [join('raw', 'a.png')]: solidPng(8, 8, [1, 2, 3, 255]),
      [join('cfg.json')]: JSON.stringify({ targetW: 8 }),
    });
    const { outcome } = run(fs, ['raw', '--out', 'out', '--config', 'cfg.json']);
    expect(outcome.ok).toBe(1);
    expect(decodePng(fs.files.get(join('out', 'a_8x8.png')) as Buffer).width).toBe(8);
  });

  it('命令行上的 --width 覆盖 config 里的 targetW', () => {
    const fs = memoryFs({
      [join('raw', 'a.png')]: solidPng(8, 8, [1, 2, 3, 255]),
      [join('cfg.json')]: JSON.stringify({ targetW: 8 }),
    });
    const { outcome } = run(fs, ['raw', '--out', 'out', '--config', 'cfg.json', '--width', '4']);
    expect(outcome.ok).toBe(1);
    expect(decodePng(fs.files.get(join('out', 'a_4x4.png')) as Buffer).width).toBe(4);
  });

  it('--config 里的 preprocess 与命令行都生效（深合并）', () => {
    const fs = memoryFs({
      // 白底 + 中间一块红：去背景后只剩红
      [join('raw', 'a.png')]: twoColorPng(8, 8, [255, 255, 255, 255], [255, 0, 0, 255]),
      [join('cfg.json')]: JSON.stringify({ preprocess: { removeBackground: 'edges' } }),
    });
    const { outcome } = run(fs, ['raw', '--out', 'out', '--width', '4', '--config', 'cfg.json']);
    expect(outcome.ok).toBe(1);

    // 名字在转换后才算，所以带的是裁剪后的尺寸
    const decoded = decodePng(fs.files.get(join('out', 'a_2x4.png')) as Buffer);
    expect(decoded.width).toBe(2);
    expect(decoded.height).toBe(4);
    expect(decoded.data[3]).toBe(255);
    // 剩下的应该是红（具体色值取决于默认调色板 mc-dye，只断言「红占主导」）
    expect(decoded.data[0]).toBeGreaterThan(decoded.data[1]);
    expect(decoded.data[0]).toBeGreaterThan(decoded.data[2]);
  });
});
