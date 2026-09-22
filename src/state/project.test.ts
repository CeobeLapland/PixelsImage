/**
 * 存档与预设的状态行为（M7）。
 *
 * 这里锁的是**读档之后手改还在不在** —— 那是 ROADMAP 的验收标准，
 * 也是最容易悄悄坏掉的一处：换图时会 clearResult（作废旧结果），
 * 编辑层如果写在这个动作之前就会被一起清掉，而且画面上「只是少了手改」，
 * 不报错、不提示。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makePalette, BLUE, RED, WHITE } from '@/core/__testing__/fixtures';
import { createEditLayer, createGrid, makeDefaultSettings, type PixelGrid } from '@/core/types';
import { buildProject, serializeProject } from '@/core/project';
import { useApp, type ConvertInfo } from './store';

const PALETTE = makePalette('test', [RED, WHITE, BLUE]);

/*
 * 读档要真的走一遍「data URL → 解码成 ImageData」这条链，而 node 里没有
 * createImageBitmap 和 canvas。补最小替身：这一条正是验收标准所在
 * （手改必须活着回来），跳过它就等于没测。
 */
class FakeCtx {
  imageSmoothingEnabled = true;
  imageSmoothingQuality = 'high';
  drawImage(): void {}
  clearRect(): void {}
  getImageData(_x: number, _y: number, w: number, h: number): ImageData {
    return new ImageData(w, h);
  }
}

class FakeCanvas {
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
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('OffscreenCanvas', FakeCanvas);
  vi.stubGlobal(
    'createImageBitmap',
    async () => ({ width: 2, height: 2, close: () => undefined }),
  );
  useApp.getState().clearResult();
  useApp.setState({
    convertPresets: [],
    projectSavedAt: null,
    projectBusy: false,
    shortcutsOpen: false,
    settings: makeDefaultSettings(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeGrid(w: number, h: number, seed = 0): PixelGrid {
  const grid = createGrid(w, h);
  for (let i = 0; i < grid.indices.length; i += 1) {
    grid.indices[i] = (i + seed) % 3;
    grid.alpha[i] = 255;
  }
  return grid;
}

function info(w: number, h: number): ConvertInfo {
  return { targetW: w, targetH: h, usedColors: 3, trimmed: false, ms: 1, fallback: false };
}

describe('转换预设', () => {
  it('保存的是当前这一套参数（深拷贝 preprocess）', () => {
    useApp.getState().patchSettings({ targetW: 96, sampling: 'median' });
    useApp.getState().patchPreprocess({ brightness: 15 });
    useApp.getState().saveConvertPreset('厚涂');

    const preset = useApp.getState().convertPresets[0];
    expect(preset.name).toBe('厚涂');
    expect(preset.settings.targetW).toBe(96);
    expect(preset.settings.sampling).toBe('median');
    expect(preset.settings.preprocess.brightness).toBe(15);

    // 之后再改参数不该动到已存的预设
    useApp.getState().patchPreprocess({ brightness: -40 });
    expect(useApp.getState().convertPresets[0].settings.preprocess.brightness).toBe(15);
  });

  it('重名自动加序号', () => {
    useApp.getState().saveConvertPreset('厚涂');
    useApp.getState().saveConvertPreset('厚涂');
    expect(useApp.getState().convertPresets.map((p) => p.name)).toEqual(['厚涂 (2)', '厚涂']);
  });

  it('空名字不保存', () => {
    useApp.getState().saveConvertPreset('   ');
    expect(useApp.getState().convertPresets).toHaveLength(0);
  });

  it('套用预设会覆盖当前参数，但不动调色板之外的编辑状态', () => {
    useApp.getState().patchSettings({ targetW: 32 });
    useApp.getState().saveConvertPreset('小图');

    useApp.getState().patchSettings({ targetW: 200 });
    const id = useApp.getState().convertPresets[0].id;
    useApp.getState().applyConvertPreset(id);

    expect(useApp.getState().settings.targetW).toBe(32);
  });

  it('套用不存在的预设什么也不做', () => {
    useApp.getState().patchSettings({ targetW: 48 });
    useApp.getState().applyConvertPreset('nope');
    expect(useApp.getState().settings.targetW).toBe(48);
  });

  it('删除预设', () => {
    useApp.getState().saveConvertPreset('a');
    const id = useApp.getState().convertPresets[0].id;
    useApp.getState().removeConvertPreset(id);
    expect(useApp.getState().convertPresets).toHaveLength(0);
  });
});

describe('读档：手改必须还在', () => {
  /** 造一份带手改的存档文本 */
  function projectText(): string {
    const layer = createEditLayer(4, 3);
    layer.cells[1] = { index: 2, alpha: 255 };
    layer.cells[7] = { index: 1, alpha: 128 };
    return serializeProject(
      buildProject({
        name: 'hero.png',
        // 只要形如 data:image/* 就会走解码；用 1×1 的透明 PNG
        source:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
        originalWidth: 800,
        originalHeight: 600,
        settings: { ...makeDefaultSettings(), targetW: 4, targetH: 3 },
        palette: PALETTE,
        baseGrid: makeGrid(4, 3),
        editLayer: layer,
        savedAt: 1700000000000,
      }),
    );
  }

  it('读档后 baseGrid / 编辑层 / 参数都还原', async () => {
    const file = new File([projectText()], 'hero.pixproj');
    await useApp.getState().loadProjectFile(file);

    const state = useApp.getState();
    expect(state.baseGrid?.w).toBe(4);
    expect(state.baseGrid?.h).toBe(3);
    expect(state.editLayer?.w).toBe(4);
    expect(state.editedCount).toBe(2);
    expect(state.settings.targetW).toBe(4);
    expect(state.palette.colors).toHaveLength(3);
    expect(state.projectSavedAt).toBe(1700000000000);
  });

  it('手改的格子在原位上，且写入基准层（之后改尺寸才会按比例重采样）', async () => {
    await useApp.getState().loadProjectFile(new File([projectText()], 'hero.pixproj'));

    const state = useApp.getState();
    expect(state.editLayer?.cells[1]).toEqual({ index: 2, alpha: 255 });
    expect(state.editLayer?.cells[7]).toEqual({ index: 1, alpha: 128 });
    expect(state.editOrigin?.w).toBe(4);
    expect(state.editOrigin?.layer.cells[1]).toEqual({ index: 2, alpha: 255 });
  });

  it('坏存档只提示，不破坏当前状态', async () => {
    const before = useApp.getState().settings.targetW;
    await useApp.getState().loadProjectFile(new File(['{ 不是 json'], 'bad.pixproj'));
    expect(useApp.getState().settings.targetW).toBe(before);
    expect(useApp.getState().projectBusy).toBe(false);
  });

  it('源图不是 data URL 时明确拒绝', async () => {
    const project = buildProject({
      name: 'x.png',
      source: 'hero.png',
      originalWidth: 1,
      originalHeight: 1,
      settings: makeDefaultSettings(),
      palette: PALETTE,
      baseGrid: null,
      editLayer: null,
      savedAt: 0,
    });
    await useApp.getState().loadProjectFile(
      new File([serializeProject(project)], 'x.pixproj'),
    );
    expect(useApp.getState().baseGrid).toBeNull();
  });
});

describe('清空工作区', () => {
  it('抹掉图与队列，但保留预设这类用户数据', () => {
    useApp.getState().applyResult(makeGrid(4, 4), PALETTE, info(4, 4));
    useApp.getState().saveConvertPreset('留下的');
    useApp.setState({
      batchItems: [
        {
          id: 'b1',
          file: new File([new Uint8Array(2)], 'a.png'),
          fileName: 'a.png',
          size: 2,
          status: 'pending',
        },
      ],
      projectSavedAt: 123,
    });

    useApp.getState().clearWorkspace();

    const state = useApp.getState();
    expect(state.baseGrid).toBeNull();
    expect(state.editLayer).toBeNull();
    expect(state.batchItems).toHaveLength(0);
    expect(state.projectSavedAt).toBeNull();
    // 预设与调色板是用户攒下来的，清工作区不该动它们
    expect(state.convertPresets.map((p) => p.name)).toEqual(['留下的']);
  });
});

describe('快捷键面板开关', () => {
  it('能开能关', () => {
    useApp.getState().setShortcutsOpen(true);
    expect(useApp.getState().shortcutsOpen).toBe(true);
    useApp.getState().setShortcutsOpen(false);
    expect(useApp.getState().shortcutsOpen).toBe(false);
  });
});
