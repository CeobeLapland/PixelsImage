/**
 * 反向解析的 store 层测试：验证「解析 + 对齐参数 + 清空旧工作」这条链路。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BLUE, RED, WHITE } from '@/core/__testing__/fixtures';
import type { SourceImage } from '@/core/types';
import { useApp } from './store';

/** 把 cells 按 k 倍放大成一张 RGBA 图 */
function imageDataOf(cells: readonly (readonly number[])[], k: number): ImageData {
  const gw = cells.length;
  const w = gw * k;
  const h = k;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let gy = 0; gy < cells.length; gy += 1) {
    const cell = cells[gy] as readonly number[];
    for (let dy = 0; dy < k; dy += 1) {
      for (let dx = 0; dx < k; dx += 1) {
        const o = (dy * w + gy * k + dx) * 4;
        data[o] = cell[0] as number;
        data[o + 1] = cell[1] as number;
        data[o + 2] = cell[2] as number;
        data[o + 3] = cell[3] as number;
      }
    }
  }
  return new ImageData(data, w, h);
}

function setSource(imageData: ImageData): void {
  const source: SourceImage = {
    id: 'src-test',
    name: 'pixel.png',
    type: 'image/png',
    bytes: 100,
    originalWidth: imageData.width,
    originalHeight: imageData.height,
    imageData,
    previewBitmap: {} as ImageBitmap,
    previewScale: 1,
    truncated: false,
  };
  useApp.setState({ source, sourceStatus: 'ready', sourceError: null });
}

beforeEach(() => {
  vi.useFakeTimers();
  useApp.setState({ customPalettes: {} });
  useApp.getState().clearResult();
});

describe('reverseParseSource', () => {
  it('按像素建网格、生成调色板，并把参数对齐到结果', () => {
    setSource(imageDataOf([RED, BLUE, WHITE], 4));

    const result = useApp.getState().reverseParseSource();
    expect(result?.scale).toBe(4);
    expect(result?.grid.w).toBe(3);
    expect(result?.grid.h).toBe(1);

    const state = useApp.getState();
    expect(state.baseGrid?.w).toBe(3);
    expect(state.baseGrid?.h).toBe(1);
    expect(state.palette.colors.map((c) => [c[0], c[1], c[2]])).toEqual([
      [255, 0, 0],
      [0, 0, 255],
      [255, 255, 255],
    ]);
    // 参数被对齐到解析结果：尺寸、面积平均、不裁剪、不抖动
    expect(state.settings.targetW).toBe(3);
    expect(state.settings.targetH).toBe(1);
    expect(state.settings.sampling).toBe('area');
    expect(state.settings.dither).toBe('none');
    expect(state.settings.trimTransparent).toBe(false);
    // 调色板已登记为自定义板，后续按 id 能解析到它
    expect(state.customPalettes[state.settings.paletteId]).toBeDefined();
    // 旧手改与撤销栈被清空
    expect(state.history.entries).toHaveLength(0);
    expect(state.editedCount).toBe(0);
    expect(state.editLayer?.w).toBe(3);
  });

  it('没有源图时提示并返回 null', () => {
    useApp.setState({ source: null, sourceStatus: 'idle' });
    expect(useApp.getState().reverseParseSource()).toBeNull();
    expect(useApp.getState().toasts.at(-1)?.text).toContain('先载入');
  });
});
