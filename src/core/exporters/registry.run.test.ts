/**
 * 导出器的端到端执行（M6）。
 *
 * 单个算法都有各自的测试，这里测的是**串起来之后**的产物：
 * 文件名对不对、该出几个文件、错误路径会不会静默产出空包。
 * 用替身 OffscreenCanvas 绕开 PNG 编码 —— 编码本身是浏览器的事，
 * 我们要锁的是「交给它的东西」和「拿回来的文件名」。
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { makePalette, BLUE, RED, WHITE } from '@/core/__testing__/fixtures';
import { createGrid, type PixelGrid } from '@/core/types';
import { suggestBlockMap } from './blocks';
import { getExporter, mergeOptionValues, defaultOptionValues, type ExportContext } from './registry';

const PALETTE = makePalette('mc', [RED, WHITE, BLUE]);

function makeGrid(w: number, h: number, alphas?: number[]): PixelGrid {
  const grid = createGrid(w, h);
  for (let i = 0; i < grid.indices.length; i += 1) {
    grid.indices[i] = i % 3;
    grid.alpha[i] = alphas ? (alphas[i] ?? 255) : 255;
  }
  return grid;
}

/**
 * 替身 canvas：既要满足 `imageDataToPngBlob`（putImageData + convertToBlob），
 * 也要满足蓝图渲染（fillRect / fillText / measureText / strokeRect / getImageData）。
 * 全都不做真实绘制 —— 这一层测的是产物与文件名，不是像素。
 */
class FakeCtx {
  fillStyle = '#000000';
  strokeStyle = '#000000';
  lineWidth = 1;
  font = '';
  textAlign = 'left';
  textBaseline = 'alphabetic';

  putImageData(): void {}
  fillRect(): void {}
  strokeRect(): void {}
  fillText(): void {}
  measureText(text: string): { width: number } {
    return { width: text.length * 6 };
  }
  getImageData(_x: number, _y: number, w: number, h: number): ImageData {
    return new ImageData(w, h);
  }
}

class FakeOffscreenCanvas {
  width: number;
  height: number;
  private ctx = new FakeCtx();
  constructor(w: number, h: number) {
    this.width = w;
    this.height = h;
  }
  getContext(): FakeCtx {
    return this.ctx;
  }
  async convertToBlob(options: { type: string }): Promise<Blob> {
    return new Blob([new Uint8Array([1, 2, 3])], { type: options.type });
  }
}

beforeAll(() => {
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
});

afterEach(() => {
  vi.stubGlobal('OffscreenCanvas', FakeOffscreenCanvas);
});

function makeContext(over: Partial<ExportContext> = {}): ExportContext {
  return {
    grid: makeGrid(4, 3),
    palette: PALETTE,
    sourceName: 'hero.png',
    batchTiles: [],
    blockMap: {},
    suggestedBlocks: suggestBlockMap(PALETTE.colors),
    ...over,
  };
}

/** 跑一个导出器，选项用默认值加上覆盖项 */
async function run(
  id: string,
  ctx: ExportContext,
  over: Record<string, number | boolean | string> = {},
) {
  const exporter = getExporter(id);
  if (!exporter) throw new Error(`找不到导出器 ${id}`);
  const values = { ...defaultOptionValues(exporter), ...over };
  return exporter.run(ctx, values);
}

async function textOf(blob: Blob): Promise<string> {
  return await blob.text();
}

describe('PNG 导出器', () => {
  it('产出一个文件，名字带网格尺寸', async () => {
    const result = await run('png', makeContext());
    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe('hero_4x3.png');
    expect(result.files[0].blob.type).toBe('image/png');
  });

  it('放大倍数写进文件名', async () => {
    const result = await run('png', makeContext(), { scale: 4 });
    expect(result.files[0].name).toBe('hero_4x3@4x.png');
  });

  it('没有网格时报错而不是产出空文件', async () => {
    await expect(run('png', makeContext({ grid: null }))).rejects.toThrow('还没有转换结果');
  });
});

describe('网格 JSON 导出器', () => {
  it('内容是合法 JSON，且 indices 与网格一一对应', async () => {
    const result = await run('gridJson', makeContext());
    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe('hero.json');

    const json = JSON.parse(await textOf(result.files[0].blob)) as {
      w: number;
      h: number;
      indices: number[];
      palette: { colors: string[] };
    };
    expect(json.w).toBe(4);
    expect(json.h).toBe(3);
    expect(json.indices).toHaveLength(12);
    expect(json.palette.colors).toEqual(['#ff0000', '#ffffff', '#0000ff']);
  });

  it('说明文字会指出 alpha 是否被省略', async () => {
    const opaque = await run('gridJson', makeContext());
    expect(opaque.note).toContain('省略 alpha');

    const transparent = await run('gridJson', makeContext({ grid: makeGrid(2, 2, [255, 0, 255, 255]) }));
    expect(transparent.note).toContain('含 alpha');
  });
});

describe('建造蓝图 PNG 导出器', () => {
  it('单页时产出图纸 + 色号对照表', async () => {
    const result = await run('blueprintPng', makeContext());
    expect(result.files.map((f) => f.name)).toEqual([
      'hero_blueprint.png',
      'hero_blueprint_legend.txt',
    ]);
    expect(result.files[0].blob.type).toBe('image/png');
  });

  it('分页时逐页命名，不会互相覆盖', async () => {
    const result = await run('blueprintPng', makeContext({ grid: makeGrid(8, 8) }), {
      pageCols: 4,
      pageRows: 4,
    });
    const names = result.files.map((f) => f.name);
    expect(names).toContain('hero_blueprint_p1.png');
    expect(names).toContain('hero_blueprint_p2.png');
    expect(names).toContain('hero_blueprint_p3.png');
    expect(names).toContain('hero_blueprint_p4.png');
    // 4 页 + 一份对照表
    expect(result.files).toHaveLength(5);
  });

  it('说明文字带上页数与用色数', async () => {
    const result = await run('blueprintPng', makeContext({ grid: makeGrid(8, 8) }), {
      pageCols: 4,
      pageRows: 4,
    });
    expect(result.note).toContain('4 页');
    expect(result.note).toContain('3 种颜色');
  });

  it('对照表里能查到色号与方块名', async () => {
    const result = await run('blueprintPng', makeContext(), { trim: false });
    const legend = result.files.find((f) => f.name.endsWith('_legend.txt'));
    expect(legend).toBeDefined();
    expect(await textOf(legend?.blob as Blob)).toContain('#0');
  });

  it('裁剪开关影响图纸尺寸（体现为页内容变化而不是报错）', async () => {
    // 只有中间一格不透明，裁完应为 1×1
    const grid = createGrid(4, 4);
    grid.indices.fill(0);
    grid.alpha.fill(0);
    grid.alpha[1 * 4 + 1] = 255;

    const result = await run('blueprintPng', makeContext({ grid }), { trim: true, cell: 8 });
    expect(result.note).toContain('1×1 格');
  });
});

describe('建造清单 CSV 导出器', () => {
  it('产出 CSV + 对照表两份', async () => {
    const result = await run('blueprintCsv', makeContext());
    expect(result.files.map((f) => f.name)).toEqual([
      'hero_blueprint.csv',
      'hero_blueprint_legend.txt',
    ]);
  });

  it('CSV 表头与行数正确', async () => {
    const result = await run('blueprintCsv', makeContext());
    const lines = (await textOf(result.files[0].blob)).trimEnd().split('\n');
    expect(lines[0]).toBe('x,y,z,block');
    expect(lines).toHaveLength(1 + 12);
    expect(result.note).toBe('12 个方块');
  });

  it('跳过透明格时行数减少，说明文字跟着变', async () => {
    const grid = makeGrid(2, 2, [255, 0, 0, 255]);
    const result = await run('blueprintCsv', makeContext({ grid }));
    const lines = (await textOf(result.files[0].blob)).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(result.note).toBe('2 个方块');
  });

  it('关掉表头后不写第一行', async () => {
    const result = await run('blueprintCsv', makeContext(), { header: false });
    const lines = (await textOf(result.files[0].blob)).trimEnd().split('\n');
    expect(lines[0]).not.toBe('x,y,z,block');
    expect(result.note).toBe('12 个方块');
  });

  it('yAxis 选项确实生效', async () => {
    const up = await run('blueprintCsv', makeContext(), { yAxis: 'up' });
    const upLines = (await textOf(up.files[0].blob)).trimEnd().split('\n');
    expect(upLines[1].split(',')[1]).toBe('2'); // 3 行 → 第一行 y=2

    const down = await run('blueprintCsv', makeContext(), { yAxis: 'down' });
    const downLines = (await textOf(down.files[0].blob)).trimEnd().split('\n');
    expect(downLines[1].split(',')[1]).toBe('0');
  });
});

describe('精灵图集导出器', () => {
  it('队列为空时明确报错，而不是产出一张空图', async () => {
    await expect(run('spritesheet', makeContext())).rejects.toThrow('批量队列');
  });

  it('有图时产出图集 PNG + 坐标 JSON', async () => {
    const tiles = [
      { grid: makeGrid(4, 4), palette: PALETTE, name: 'a' },
      { grid: makeGrid(4, 4), palette: PALETTE, name: 'b' },
    ];
    const result = await run('spritesheet', makeContext({ batchTiles: tiles }), { padding: 0 });

    expect(result.files.map((f) => f.name)).toEqual(['hero_sheet.png', 'hero_sheet.json']);
    const manifest = JSON.parse(await textOf(result.files[1].blob)) as {
      sheet: { columns: number; rows: number };
      frames: { name: string }[];
    };
    expect(manifest.frames.map((f) => f.name)).toEqual(['a', 'b']);
    expect(manifest.sheet.columns).toBe(2);
    expect(result.note).toContain('2 格');
  });
});

describe('Aseprite 导出器', () => {
  it('产出一个 .ase 文件', async () => {
    const result = await run('ase', makeContext());
    expect(result.files).toHaveLength(1);
    expect(result.files[0].name).toBe('hero.ase');
  });

  it('内容不是空的，且声明了 Aseprite 魔数', async () => {
    const result = await run('ase', makeContext());
    const bytes = new Uint8Array(await result.files[0].blob.arrayBuffer());
    expect(bytes.length).toBeGreaterThan(128);
    // 文件头偏移 4 处是 WORD 0xA5E0
    const view = new DataView(bytes.buffer);
    expect(view.getUint16(4, true)).toBe(0xa5e0);
    expect(view.getUint16(8, true)).toBe(4); // 宽
    expect(view.getUint16(10, true)).toBe(3); // 高
  });

  it('没有网格时报错', async () => {
    await expect(run('ase', makeContext({ grid: null }))).rejects.toThrow('还没有转换结果');
  });
});

describe('选项表与执行的一致性', () => {
  it('每个导出器的默认选项都能直接跑通（图集除外，它需要队列）', async () => {
    const ctx = makeContext({
      batchTiles: [{ grid: makeGrid(4, 4), palette: PALETTE, name: 'a' }],
    });
    for (const id of ['png', 'gridJson', 'spritesheet', 'blueprintPng', 'blueprintCsv', 'ase']) {
      const result = await run(id, ctx);
      expect(result.files.length).toBeGreaterThan(0);
      for (const file of result.files) {
        expect(file.name.length).toBeGreaterThan(0);
        expect(file.blob.size).toBeGreaterThan(0);
      }
    }
  });

  it('mergeOptionValues 的结果能直接喂给 run（键名对得上）', async () => {
    const exporter = getExporter('blueprintPng');
    if (!exporter) throw new Error('缺少 blueprintPng');
    const values = mergeOptionValues(exporter, { cell: 'bad' as never, oneBased: true });
    const result = await exporter.run(makeContext(), values);
    expect(result.files.length).toBeGreaterThan(0);
  });
});