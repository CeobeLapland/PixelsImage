import { describe, expect, it } from 'vitest';

import { makePalette, BLUE, RED, WHITE } from '@/core/__testing__/fixtures';
import { createEditLayer, createGrid, makeDefaultSettings, type PixelGrid } from '@/core/types';
import {
  buildProject,
  buildProjectName,
  describeProject,
  deserializeEditLayer,
  deserializeGrid,
  deserializePalette,
  parseProject,
  serializeEditLayer,
  serializeGrid,
  serializeProject,
  type ProjectInput,
} from './project';

function makeGrid(w: number, h: number): PixelGrid {
  const grid = createGrid(w, h);
  for (let i = 0; i < grid.indices.length; i += 1) {
    grid.indices[i] = i % 3;
    grid.alpha[i] = i % 5 === 0 ? 0 : 255;
  }
  return grid;
}

/** 一份最小的可用源图 data URL */
const SOURCE = 'data:image/png;base64,iVBORw0KGgo=';

function makeInput(over: Partial<ProjectInput> = {}): ProjectInput {
  return {
    name: 'hero.png',
    source: SOURCE,
    originalWidth: 800,
    originalHeight: 600,
    settings: makeDefaultSettings(),
    palette: makePalette('p', [RED, WHITE, BLUE]),
    baseGrid: makeGrid(4, 3),
    editLayer: null,
    savedAt: 1700000000000,
    ...over,
  };
}

describe('编辑层的稀疏序列化', () => {
  it('空编辑层不写这一段', () => {
    expect(serializeEditLayer(null)).toBeNull();
    expect(serializeEditLayer(createEditLayer(4, 4))).toBeNull();
  });

  it('只记被改过的格子，行优先升序', () => {
    const layer = createEditLayer(4, 4);
    layer.cells[0] = { index: 1, alpha: 255 };
    layer.cells[5] = { index: 2, alpha: 128 };

    const data = serializeEditLayer(layer);
    expect(data?.rows).toEqual([0, 5]);
    expect(data?.index).toEqual([1, 2]);
    expect(data?.alpha).toEqual([255, 128]);
    expect(data?.w).toBe(4);
  });

  it('往返之后手改一格不差', () => {
    const layer = createEditLayer(6, 5);
    layer.cells[3] = { index: 2, alpha: 0 };
    layer.cells[17] = { index: 1, alpha: 200 };
    const back = deserializeEditLayer(serializeEditLayer(layer));
    expect(back?.w).toBe(6);
    expect(back?.h).toBe(5);
    expect(back?.cells[3]).toEqual({ index: 2, alpha: 0 });
    expect(back?.cells[17]).toEqual({ index: 1, alpha: 200 });
    expect(back?.cells[4]).toBeNull();
  });
});

describe('编辑层损坏数据的处理', () => {
  it('三个数组长度不一致 → 整段作废，而不是读进一半', () => {
    // 读进一半比整段作废更危险：画面少几格手改而用户不知道少了什么
    expect(
      deserializeEditLayer({ w: 4, h: 4, rows: [0, 1], index: [1], alpha: [255, 255] }),
    ).toBeNull();
  });

  it('下标越界 → 作废', () => {
    expect(deserializeEditLayer({ w: 2, h: 2, rows: [4], index: [1], alpha: [255] })).toBeNull();
    expect(deserializeEditLayer({ w: 2, h: 2, rows: [-1], index: [1], alpha: [255] })).toBeNull();
  });

  it('尺寸非法 → 作废', () => {
    expect(deserializeEditLayer({ w: 0, h: 4, rows: [], index: [], alpha: [] })).toBeNull();
    expect(deserializeEditLayer({ w: 1.5, h: 4, rows: [], index: [], alpha: [] })).toBeNull();
  });

  it('非对象 → 作废', () => {
    expect(deserializeEditLayer(null)).toBeNull();
    expect(deserializeEditLayer('x')).toBeNull();
  });

  it('色值超出 0-255 时钳住，不产生非法索引', () => {
    const back = deserializeEditLayer({ w: 2, h: 2, rows: [0], index: [300], alpha: [-5] });
    expect(back?.cells[0]).toEqual({ index: 255, alpha: 0 });
  });
});

describe('网格的序列化', () => {
  it('往返一致（含半透明与全透明格）', () => {
    const grid = makeGrid(4, 3);
    const back = deserializeGrid(JSON.parse(JSON.stringify(serializeGrid(grid))) as unknown);
    expect(back?.w).toBe(4);
    expect(back?.h).toBe(3);
    expect(Array.from(back?.indices ?? [])).toEqual(Array.from(grid.indices));
    expect(Array.from(back?.alpha ?? [])).toEqual(Array.from(grid.alpha));
  });

  it('长度与 w×h 不符 → 作废', () => {
    expect(deserializeGrid({ w: 4, h: 4, indices: [1, 2], alpha: [255, 255] })).toBeNull();
  });

  it('尺寸非法 → 作废', () => {
    expect(deserializeGrid({ w: 0, h: 4, indices: [], alpha: [] })).toBeNull();
  });
});

describe('调色板的序列化', () => {
  it('往返一致，且一律记为自定义板', () => {
    const palette = makePalette('p', [RED, WHITE, BLUE]);
    const back = deserializePalette(JSON.parse(JSON.stringify(palette)));
    expect(back?.colors).toHaveLength(3);
    expect(back?.colors[0]).toEqual([255, 0, 0, 255]);
    // 存档里的板是「这份文档的板」，不该再被当成可共享的内置板
    expect(back?.builtin).toBe(false);
  });

  it('缺 alpha 时补 255（老存档可能只有 RGB）', () => {
    const back = deserializePalette({ id: 'p', name: 'p', colors: [[1, 2, 3]] });
    expect(back?.colors[0]).toEqual([1, 2, 3, 255]);
  });

  it('色值不是数组 → 整块作废', () => {
    expect(deserializePalette({ id: 'p', name: 'p', colors: ['#fff'] })).toBeNull();
    expect(deserializePalette({ id: 'p', name: 'p', colors: [] })).toBeNull();
  });
});

describe('整份存档的往返', () => {
  it('参数 / 调色板 / 网格 / 手改都能还原', () => {
    const layer = createEditLayer(4, 3);
    layer.cells[1] = { index: 2, alpha: 255 };
    const input = makeInput({ editLayer: layer, settings: { ...makeDefaultSettings(), targetW: 48 } });

    const text = serializeProject(buildProject(input));
    const parsed = parseProject(text);

    expect(parsed.settings.targetW).toBe(48);
    expect(parsed.palette.colors).toHaveLength(3);
    expect(parsed.baseGrid?.w).toBe(4);
    expect(parsed.editLayer?.cells[1]).toEqual({ index: 2, alpha: 255 });
  });

  it('没有转换结果时 baseGrid 为 null，不炸', () => {
    const parsed = parseProject(serializeProject(buildProject(makeInput({ baseGrid: null }))));
    expect(parsed.baseGrid).toBeNull();
    expect(parsed.editLayer).toBeNull();
  });

  it('没手改时编辑层为 null', () => {
    const parsed = parseProject(serializeProject(buildProject(makeInput())));
    expect(parsed.editLayer).toBeNull();
  });

  it('版本号与保存时间被保留', () => {
    const parsed = parseProject(serializeProject(buildProject(makeInput())));
    expect(parsed.project.version).toBeGreaterThanOrEqual(2);
    expect(parsed.project.savedAt).toBe(1700000000000);
  });
});

describe('损坏存档的错误提示', () => {
  it('不是 JSON', () => {
    expect(() => parseProject('not json at all')).toThrow('合法');
  });

  it('缺源图', () => {
    const { source: _drop, ...rest } = buildProject(makeInput());
    expect(() => parseProject(JSON.stringify(rest))).toThrow('源图');
  });

  it('源图不是 data URL', () => {
    expect(() =>
      parseProject(serializeProject({ ...buildProject(makeInput()), source: 'hero.png' })),
    ).toThrow('源图');
  });

  it('调色板损坏时明确报错，而不是读出一块空板', () => {
    const project = buildProject(makeInput());
    expect(() =>
      parseProject(serializeProject({ ...project, palette: { id: 'p', colors: [] } as never })),
    ).toThrow('调色板');
  });

  it('编辑层损坏不阻断读档 —— 网格还能看，丢的只是手改', () => {
    const project = buildProject(makeInput());
    const broken = { ...project, edit: { w: 2, h: 2, rows: [99], index: [1], alpha: [1] } };
    const parsed = parseProject(JSON.stringify(broken));
    expect(parsed.editLayer).toBeNull();
    expect(parsed.baseGrid?.w).toBe(4);
  });

  it('缺 settings 时回退到默认参数', () => {
    const { settings: _drop, ...rest } = buildProject(makeInput());
    const parsed = parseProject(JSON.stringify(rest));
    expect(parsed.settings.preprocess.alphaThreshold).toBe(255);
  });
});

describe('文件名与摘要', () => {
  it('存档名由源图名推导', () => {
    expect(buildProjectName('hero.png')).toBe('hero.pixproj');
    expect(buildProjectName('a b.jpg')).toBe('a b.pixproj');
    expect(buildProjectName('')).toBe('pixels.pixproj');
  });

  it('摘要把关键状态写清楚', () => {
    const layer = createEditLayer(4, 3);
    layer.cells[0] = { index: 1, alpha: 255 };
    const text = describeProject(buildProject(makeInput({ editLayer: layer })));
    expect(text).toContain('hero.png');
    expect(text).toContain('4×3 格');
    expect(text).toContain('1 格手改');
  });

  it('未转换的存档摘要说「未转换」', () => {
    expect(describeProject(buildProject(makeInput({ baseGrid: null })))).toContain('未转换');
  });
});