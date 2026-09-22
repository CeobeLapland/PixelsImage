/**
 * 调色板颜色 → Minecraft 方块 的映射（M6）。
 *
 * 为什么**按 hex 键**而不是按调色板槽位序号：
 * 槽位顺序会因为排序、合并近似色而改变（palettes/ops.ts 里那套重映射），
 * 也可能因为换了一块板而整体位移。按颜色键的话，这些操作都不会让映射错位 ——
 * 「这个颜色用哪种方块」本来就是一句与槽位无关的话。
 *
 * 为什么默认值是**算出来的**而不是硬编码一张表：
 * Minecraft 没有精确等于某个 hex 的方块，颜色匹配天然是「最接近」而不是「相等」。
 * 给每个方块标一个代表色，再按加权 RGB 距离找最近的，任意调色板都能得到一份
 * 说得过去的初值；用户只在个别颜色上改。硬编码只能覆盖内置板，换个自定义板就废了。
 */

import { createNearestFinder } from '@/core/color/distance';
import { parseHex, toHex } from '@/core/color/space';
import type { RGBA } from '@/core/types';

export interface McBlock {
  /** Minecraft 方块 id，也是写进 CSV 的值 */
  id: string;
  /** 面板里显示的中文名 */
  name: string;
  /** 代表色。取材质基色的近似值 —— 游戏内受光照影响，不存在唯一正确的 hex */
  hex: string;
}

/**
 * 可选方块清单。
 *
 * 覆盖三档：羊毛 / 混凝土（与内置的两块 MC 板一一对应，选这两块板时默认映射
 * 会精确命中），以及一批「纯色好取用」的常见方块，给非 MC 调色板兜底。
 */
export const MC_BLOCKS: readonly McBlock[] = [
  // ---- 羊毛 16 色（色值与「Minecraft 染料 16 色」一致）----
  { id: 'white_wool', name: '白色羊毛', hex: '#F9FFFE' },
  { id: 'light_gray_wool', name: '淡灰色羊毛', hex: '#9D9D97' },
  { id: 'gray_wool', name: '灰色羊毛', hex: '#474F52' },
  { id: 'black_wool', name: '黑色羊毛', hex: '#1D1D21' },
  { id: 'brown_wool', name: '棕色羊毛', hex: '#835432' },
  { id: 'red_wool', name: '红色羊毛', hex: '#B02E26' },
  { id: 'orange_wool', name: '橙色羊毛', hex: '#F9801D' },
  { id: 'yellow_wool', name: '黄色羊毛', hex: '#FED83D' },
  { id: 'lime_wool', name: '黄绿色羊毛', hex: '#80C71F' },
  { id: 'green_wool', name: '绿色羊毛', hex: '#5E7C16' },
  { id: 'cyan_wool', name: '青色羊毛', hex: '#169C9C' },
  { id: 'light_blue_wool', name: '淡蓝色羊毛', hex: '#3AB3DA' },
  { id: 'blue_wool', name: '蓝色羊毛', hex: '#3C44AA' },
  { id: 'purple_wool', name: '紫色羊毛', hex: '#8932B8' },
  { id: 'magenta_wool', name: '品红色羊毛', hex: '#C74EBD' },
  { id: 'pink_wool', name: '粉红色羊毛', hex: '#F38BAA' },

  // ---- 混凝土 16 色（色值与「Minecraft 混凝土 16 色」一致）----
  { id: 'white_concrete', name: '白色混凝土', hex: '#CFD5D6' },
  { id: 'light_gray_concrete', name: '淡灰色混凝土', hex: '#7D7D73' },
  { id: 'gray_concrete', name: '灰色混凝土', hex: '#373A3C' },
  { id: 'black_concrete', name: '黑色混凝土', hex: '#080A0F' },
  { id: 'brown_concrete', name: '棕色混凝土', hex: '#603B1C' },
  { id: 'red_concrete', name: '红色混凝土', hex: '#8E2121' },
  { id: 'orange_concrete', name: '橙色混凝土', hex: '#E06101' },
  { id: 'yellow_concrete', name: '黄色混凝土', hex: '#F1AF15' },
  { id: 'lime_concrete', name: '黄绿色混凝土', hex: '#5EA818' },
  { id: 'green_concrete', name: '绿色混凝土', hex: '#495B24' },
  { id: 'cyan_concrete', name: '青色混凝土', hex: '#157788' },
  { id: 'light_blue_concrete', name: '淡蓝色混凝土', hex: '#2489C7' },
  { id: 'blue_concrete', name: '蓝色混凝土', hex: '#2C2E8F' },
  { id: 'purple_concrete', name: '紫色混凝土', hex: '#64209C' },
  { id: 'magenta_concrete', name: '品红色混凝土', hex: '#A9309F' },
  { id: 'pink_concrete', name: '粉红色混凝土', hex: '#ED8DAC' },

  // ---- 常见纯色方块：给非 MC 调色板兜底 ----
  { id: 'quartz_block', name: '石英块', hex: '#ECE9E2' },
  { id: 'snow_block', name: '雪块', hex: '#F9FEFE' },
  { id: 'iron_block', name: '铁块', hex: '#D8D8D8' },
  { id: 'stone', name: '石头', hex: '#7F7F7F' },
  { id: 'cobblestone', name: '圆石', hex: '#7A7A7A' },
  { id: 'deepslate', name: '深板岩', hex: '#4F4F52' },
  { id: 'obsidian', name: '黑曜石', hex: '#14121D' },
  { id: 'oak_planks', name: '橡木木板', hex: '#B08B52' },
  { id: 'spruce_planks', name: '云杉木板', hex: '#6B4E2E' },
  { id: 'dirt', name: '泥土', hex: '#866043' },
  { id: 'grass_block', name: '草方块', hex: '#5D8C43' },
  { id: 'sand', name: '沙子', hex: '#DBD3A0' },
  { id: 'sandstone', name: '砂岩', hex: '#D6CFA0' },
  { id: 'end_stone', name: '末地石', hex: '#DBDE9F' },
  { id: 'gold_block', name: '金块', hex: '#F9EC4E' },
  { id: 'glowstone', name: '荧石', hex: '#F9D67C' },
  { id: 'terracotta', name: '陶瓦', hex: '#985E43' },
  { id: 'bricks', name: '砖块', hex: '#97564A' },
  { id: 'netherrack', name: '下界岩', hex: '#6B2A2A' },
  { id: 'nether_bricks', name: '下界砖块', hex: '#2D161B' },
  { id: 'purpur_block', name: '紫珀块', hex: '#A97DA9' },
  { id: 'prismarine', name: '海晶石', hex: '#63A897' },
  { id: 'ice', name: '冰', hex: '#7FB4F5' },
  { id: 'bone_block', name: '骨块', hex: '#E4DFC7' },
];

const BLOCK_BY_ID = new Map(MC_BLOCKS.map((b) => [b.id, b]));

export function findBlock(id: string | undefined): McBlock | undefined {
  return id === undefined ? undefined : BLOCK_BY_ID.get(id);
}

/** 调色板颜色 → 方块 id。键是大写 6 位 hex，不带 # */
export type BlockMap = Record<string, string>;

/** RGBA → `RRGGBB` 大写；映射表的键统一用这个形式 */
export function colorKey(color: RGBA): string {
  return toHex(color[0], color[1], color[2]).replace('#', '').toUpperCase();
}

/** 把方块清单编成一张调色板，供最近色查找复用 core 里那套距离度量 */
function blockColorPalette(): RGBA[] {
  return MC_BLOCKS.map((b) => {
    const parsed = parseHex(b.hex);
    // 表里的 hex 都是自己写的常量，解析不出来属于数据错误，直接炸掉比静默跳过好
    if (!parsed) throw new Error(`方块表里的色值非法：${b.id} → ${b.hex}`);
    return parsed as unknown as RGBA;
  });
}

/**
 * 为一批颜色生成默认映射：每个颜色取「最接近的方块」。
 *
 * 用加权 RGB 而不是 CIELAB：这里是给人挑初值的，差一两档无所谓，
 * 而每次打开面板都要跑一遍，加权 RGB 足够且不用建 LAB 表。
 */
export function suggestBlockMap(colors: readonly RGBA[]): BlockMap {
  const finder = createNearestFinder(blockColorPalette(), 'weighted', null);
  const out: BlockMap = {};
  for (const color of colors) {
    const key = colorKey(color);
    if (out[key] !== undefined) continue;
    const block = MC_BLOCKS[finder(color[0], color[1], color[2])];
    if (block) out[key] = block.id;
  }
  return out;
}

/**
 * 取某个颜色该用哪种方块。
 * 优先用用户自己改过的映射，没改过就现算一个最接近的 ——
 * 「没配过就空着」会让 CSV 里出现空 block 列，照着搭的时候才发现少了几格。
 */
export function resolveBlock(
  color: RGBA,
  userMap: BlockMap,
  suggested: BlockMap,
): McBlock | undefined {
  const key = colorKey(color);
  return findBlock(userMap[key]) ?? findBlock(suggested[key]);
}

/** 校验从 localStorage 读出来的映射表：键不是 6 位 hex、值不是已知方块 id 的一律丢掉 */
export function sanitizeBlockMap(raw: unknown): BlockMap {
  if (!raw || typeof raw !== 'object') return {};
  const out: BlockMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^[0-9A-F]{6}$/.test(key)) continue;
    if (typeof value !== 'string' || !BLOCK_BY_ID.has(value)) continue;
    out[key] = value;
  }
  return out;
}
