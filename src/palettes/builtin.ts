/**
 * 内置调色板。
 *
 * M1 只落 Minecraft 16 染料色（本工具的核心目标风格）和灰阶
 * （灰阶是检验抖动算法效果最直观的参照：用 8 级灰阶做 Atkinson，
 * 应该能看出平滑的层次过渡，如果出现条带说明抖动没生效）。
 *
 * 其余内置板（PICO-8 / GameBoy / NES / C64 / MC 羊毛扩展）在 M3 补全。
 */

import { parseHex } from '@/core/color/space';
import type { Palette, RGBA } from '@/core/types';

/** 由 hex 字符串数组构造调色板 */
function definePalette(id: string, name: string, hexes: string[]): Palette {
  const colors = hexes.map((hx) => {
    const parsed = parseHex(hx);
    if (!parsed) throw new Error(`内置调色板 ${id} 中有非法色值：${hx}`);
    return parsed as unknown as RGBA;
  });
  return { id, name, colors, builtin: true, source: 'builtin' };
}

/**
 * Minecraft 16 染料色。
 * 取自游戏内染料/羊毛的基色，是 Minecraft 方块美学的标准色域。
 */
export const MC_DYE_PALETTE = definePalette('mc-dye', 'Minecraft 染料 16 色', [
  '#F9FFFE', // white
  '#9D9D97', // light_gray
  '#474F52', // gray
  '#1D1D21', // black
  '#835432', // brown
  '#B02E26', // red
  '#F9801D', // orange
  '#FED83D', // yellow
  '#80C71F', // lime
  '#5E7C16', // green
  '#169C9C', // cyan
  '#3AB3DA', // light_blue
  '#3C44AA', // blue
  '#8932B8', // purple
  '#C74EBD', // magenta
  '#F38BAA', // pink
]);

/** 8 级灰阶：用于检验抖动效果 */
export const GRAYSCALE_8_PALETTE = definePalette('gray-8', '灰阶 8 级', [
  '#000000',
  '#242424',
  '#494949',
  '#6d6d6d',
  '#929292',
  '#b6b6b6',
  '#dbdbdb',
  '#ffffff',
]);

/** 黑白 1bit：抖动算法最严苛的测试场 */
export const MONO_PALETTE = definePalette('mono', '黑白 2 色', ['#000000', '#ffffff']);

export const BUILTIN_PALETTES: readonly Palette[] = [
  MC_DYE_PALETTE,
  GRAYSCALE_8_PALETTE,
  MONO_PALETTE,
];

export const DEFAULT_PALETTE_ID = MC_DYE_PALETTE.id;

export function getBuiltinPalette(id: string): Palette | undefined {
  return BUILTIN_PALETTES.find((p) => p.id === id);
}

/** 取调色板；找不到则回退到默认板，避免 UI 因悬空 id 崩掉 */
export function resolvePalette(id: string): Palette {
  return getBuiltinPalette(id) ?? MC_DYE_PALETTE;
}