/**
 * 内置调色板。
 *
 * 每块板都对应一种明确的创作语境，不是随便凑数：
 * - MC 染料 / 混凝土：这个工具的核心目标风格
 * - PICO-8：虚拟主机色域，受限但辨识度极高
 * - GameBoy 四阶灰绿：单色掌机的经典渐变
 * - NES / C64：8 位时代的真实硬件色域
 * - DawnBringer 16：像素画社区最通用的通用板
 * - 灰阶 / 黑白：检验抖动算法与明度分层的参照系
 */

import { parseHex } from '@/core/color/space';
import { PALETTE_MAX_COLORS, type Palette, type RGBA } from '@/core/types';

/** 由 hex 字符串数组构造调色板 */
function definePalette(id: string, name: string, hexes: string[]): Palette {
  if (hexes.length > PALETTE_MAX_COLORS) {
    throw new Error(`内置调色板 ${id} 超过 ${PALETTE_MAX_COLORS} 色上限`);
  }
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

/**
 * Minecraft 16 色混凝土。
 *
 * 槽位顺序与染料板一一对应，方便两板之间直接对照。取的是材质基色的近似值：
 * 游戏里方块颜色受光照与生物群系影响，并不存在唯一正确的 hex。
 */
export const MC_CONCRETE_PALETTE = definePalette('mc-concrete', 'Minecraft 混凝土 16 色', [
  '#CFD5D6', // white
  '#7D7D73', // light_gray
  '#373A3C', // gray
  '#080A0F', // black
  '#603B1C', // brown
  '#8E2121', // red
  '#E06101', // orange
  '#F1AF15', // yellow
  '#5EA818', // lime
  '#495B24', // green
  '#157788', // cyan
  '#2489C7', // light_blue
  '#2C2E8F', // blue
  '#64209C', // purple
  '#A9309F', // magenta
  '#ED8DAC', // pink
]);

/** PICO-8 的 16 色（官方色值） */
export const PICO8_PALETTE = definePalette('pico8', 'PICO-8 16 色', [
  '#000000', // 0 black
  '#1D2B53', // 1 dark-blue
  '#7E2553', // 2 dark-purple
  '#008751', // 3 dark-green
  '#AB5236', // 4 brown
  '#5F574F', // 5 dark-grey
  '#C2C3C7', // 6 light-grey
  '#FFF1E8', // 7 white
  '#FF004D', // 8 red
  '#FFA300', // 9 orange
  '#FFEC27', // 10 yellow
  '#00E436', // 11 green
  '#29ADFF', // 12 blue
  '#83769C', // 13 lavender
  '#FF77A8', // 14 pink
  '#FFCCAA', // 15 light-peach
]);

/** GameBoy DMG 的四阶灰绿：单色掌机只有这四种「颜色」 */
export const GAMEBOY_PALETTE = definePalette('gameboy', 'GameBoy 4 色', [
  '#0F380F',
  '#306230',
  '#8BAC0F',
  '#9BBC0F',
]);

/**
 * C64 16 色（Pepto 校准值）。
 * 原始硬件的色值有多个流传版本、差异很大，Pepto 这套是社区公认最接近真实显示效果的一份。
 */
export const C64_PALETTE = definePalette('c64', 'Commodore 64 16 色', [
  '#000000', // black
  '#FFFFFF', // white
  '#880000', // red
  '#AAFFEE', // cyan
  '#CC44CC', // purple
  '#00CC55', // green
  '#0000AA', // blue
  '#EEEE77', // yellow
  '#DD8855', // orange
  '#664400', // brown
  '#FF7777', // light red
  '#333333', // dark grey
  '#777777', // grey
  '#AAFF66', // light green
  '#0088FF', // light blue
  '#BBBBBB', // light grey
]);

/**
 * NES 子集 24 色。
 *
 * 从 NES 2C02 的 50 多个可用色里挑出 24 个互不重复、且覆盖明暗两端的常用色。
 * 完整色表里包含大量肉眼几乎无法区分的近邻色，做像素画时反而干扰判断。
 */
export const NES_PALETTE = definePalette('nes', 'NES 子集 24 色', [
  '#000000',
  '#7C7C7C',
  '#BCBCBC',
  '#F8F8F8',
  '#0000FC',
  '#0058F8',
  '#3CBCFC',
  '#008888',
  '#00B800',
  '#58D854',
  '#B8F818',
  '#F8D878',
  '#FCA044',
  '#F83800',
  '#E40058',
  '#D800CC',
  '#F878F8',
  '#6844FC',
  '#4428BC',
  '#005800',
  '#503000',
  '#881400',
  '#A80020',
  '#940084',
]);

/** DawnBringer 16：像素画社区最通用的通用板，几乎任何题材都能用 */
export const DB16_PALETTE = definePalette('db16', 'DawnBringer 16', [
  '#140C1C',
  '#442434',
  '#30346D',
  '#4E4A4E',
  '#854C30',
  '#346524',
  '#D04648',
  '#757161',
  '#597DCE',
  '#D27D2C',
  '#8595A1',
  '#6DAA2C',
  '#D2AA99',
  '#6DC2CA',
  '#DAD45E',
  '#DEEED6',
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
  MC_CONCRETE_PALETTE,
  PICO8_PALETTE,
  GAMEBOY_PALETTE,
  NES_PALETTE,
  C64_PALETTE,
  DB16_PALETTE,
  GRAYSCALE_8_PALETTE,
  MONO_PALETTE,
];

export const DEFAULT_PALETTE_ID = MC_DYE_PALETTE.id;

export function getBuiltinPalette(id: string): Palette | undefined {
  return BUILTIN_PALETTES.find((p) => p.id === id);
}

/**
 * 取调色板：先查自定义板、再查内置板，都没有则回退到默认板。
 * 悬空 id 绝不能抛错 —— 删掉一个正在使用的自定义板不该炸掉整个界面。
 */
export function resolvePalette(
  id: string,
  customs: Record<string, Palette | undefined> = {},
): Palette {
  return customs[id] ?? getBuiltinPalette(id) ?? MC_DYE_PALETTE;
}