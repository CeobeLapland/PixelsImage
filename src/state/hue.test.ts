/**
 * 色相偏移的 store 层测试。
 *
 * 这里只锁「接线」：网格索引不能动、色板要换掉、内置板要被复制而不是改坏。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makePalette, BLUE, RED, WHITE } from '@/core/__testing__/fixtures';
import { readCell } from '@/core/edit';
import { createGrid, type PixelGrid } from '@/core/types';
import { MC_DYE_PALETTE, resolvePalette } from '@/palettes/builtin';
import { useApp } from './store';

const PALETTE = makePalette('test', [RED, WHITE, BLUE]);
const GRAY = [128, 128, 128, 255] as const;

function makeGrid(w: number, h: number, indices: number[]): PixelGrid {
  const grid = createGrid(w, h);
  grid.alpha.fill(255);
  grid.indices.set(indices);
  return grid;
}

function apply(grid: PixelGrid, palette = PALETTE): void {
  useApp.getState().applyResult(grid, palette, {
    targetW: grid.w,
    targetH: grid.h,
    usedColors: 3,
    trimmed: false,
    ms: 1,
    fallback: false,
  });
}

function effectiveIndices(): number[] {
  const s = useApp.getState();
  const out: number[] = [];
  for (let y = 0; y < (s.baseGrid?.h ?? 0); y += 1) {
    for (let x = 0; x < (s.baseGrid?.w ?? 0); x += 1) {
      out.push(readCell(s.baseGrid, s.editLayer, x, y).index);
    }
  }
  return out;
}

beforeEach(() => {
  vi.useFakeTimers();
  useApp.setState({
    customPalettes: {},
    palette: PALETTE,
    settings: { ...useApp.getState().settings, paletteId: 'test', quantize: 'palette' },
  });
  useApp.getState().clearResult();
});

describe('shiftPaletteHue', () => {
  it('网格色号不动，色板颜色变', () => {
    apply(makeGrid(3, 1, [0, 1, 2]));
    const before = effectiveIndices();
    const version = useApp.getState().editVersion;

    useApp.getState().shiftPaletteHue(120);

    expect(effectiveIndices()).toEqual(before);
    const palette = useApp.getState().palette;
    // 红被转走；白不该被染色
    expect(palette.colors[0]).not.toEqual(RED);
    expect(palette.colors[1]).toEqual(WHITE);
    expect(useApp.getState().editVersion).toBe(version + 1);
    // 调色板操作不进格子撤销栈
    expect(useApp.getState().history.entries).toHaveLength(0);
  });

  it('反向偏移能把颜色大致转回去（低饱和色；高饱和色会被色域钳制）', () => {
    const muted = [180, 120, 110, 255] as const;
    const mutedPalette = makePalette('muted', [muted, WHITE]);
    apply(makeGrid(2, 1, [0, 1]), mutedPalette);
    useApp.setState({ palette: mutedPalette });

    useApp.getState().shiftPaletteHue(120);
    useApp.getState().shiftPaletteHue(-120);

    const color = useApp.getState().palette.colors[0];
    if (!color) throw new Error('缺少颜色');
    expect(Math.abs(color[0] - muted[0])).toBeLessThanOrEqual(4);
    expect(Math.abs(color[1] - muted[1])).toBeLessThanOrEqual(4);
    expect(Math.abs(color[2] - muted[2])).toBeLessThanOrEqual(4);
  });

  it('灰阶不会被染色', () => {
    const grayPalette = makePalette('gray', [GRAY, RED]);
    apply(makeGrid(2, 1, [0, 1]), grayPalette);
    useApp.setState({ palette: grayPalette });
    useApp.getState().shiftPaletteHue(90);

    expect(useApp.getState().palette.colors[0]).toEqual(GRAY);
  });

  it('0° 只提示，不改色板', () => {
    apply(makeGrid(1, 1, [0]));
    useApp.getState().shiftPaletteHue(0);
    expect(useApp.getState().palette.colors).toEqual(PALETTE.colors);
    expect(useApp.getState().toasts.at(-1)?.text).toContain('0°');
  });

  it('内置板会被复制成自定义板，不会改坏内置板', () => {
    useApp.setState({
      palette: resolvePalette(MC_DYE_PALETTE.id),
      settings: { ...useApp.getState().settings, paletteId: MC_DYE_PALETTE.id },
    });
    const before = MC_DYE_PALETTE.colors.map((c) => [...c]);

    useApp.getState().shiftPaletteHue(45);

    const state = useApp.getState();
    expect(state.palette.id).not.toBe(MC_DYE_PALETTE.id);
    expect(state.customPalettes[state.palette.id]).toBeDefined();
    expect(MC_DYE_PALETTE.colors).toEqual(before);
  });
});
