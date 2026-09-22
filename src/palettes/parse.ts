/**
 * 调色板文件的解析与序列化。
 *
 * 支持三种在像素画工具之间流通最广的纯文本格式：
 * - .hex —— 每行一个十六进制色值的极简清单（Aseprite 等都能导出）
 * - .gpl —— GIMP Palette，带 Name / Columns 元信息
 * - .pal —— JASC-PAL，老牌 Paint Shop Pro 格式，大量复古工具默认输出
 *
 * 设计约束：解析失败一律返回 null，绝不抛异常。
 * 这样 UI 拿到 null 只需提示「无法识别该文件」，调用点不需要 try/catch。
 *
 * 三种格式都不携带 alpha，因此解析结果一律补 255。
 *
 * 结果超过 256 色时直接截断：调色板索引最终要存进 Uint8Array，256 是单字节能表示的
 * 最大索引数，多出来的颜色永远不可能被任何像素引用，留着只会让下游多做无用的距离计算。
 */

import { parseHex } from '@/core/color/space';
import { PALETTE_MAX_COLORS } from '@/core/types';
import type { RGBA } from '@/core/types';

/** 去掉行尾 \r：文件可能来自 Windows，用 split('\n') 会残留 \r 污染 token */
function dropCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/** 十进制整数 token；允许负数是因为越界值走统一钳制，而不是当成格式错误 */
const INT_TOKEN = /^-?\d+$/;

/** 钳到 0-255 的整数；非有限值归 0，避免 NaN 污染后续颜色距离计算 */
function clampByte(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(255, Math.round(v)));
}

/** 由 rgb 构造颜色；三种格式都没有 alpha，一律补 255 */
function rgb(r: number, g: number, b: number): RGBA {
  return [clampByte(r), clampByte(g), clampByte(b), 255];
}

/** 恰好 3 位或 6 位十六进制（不含 #）。长度必须是这两个值之一 */
const HEX_VALUE = /^(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/**
 * .hex：逐行取第一个空白分隔的 token 作为色值，其余当注释。
 *
 * 关键点：不能「以 # 开头就丢」——`#F9FFFE` 既是合法颜色又以 # 开头。
 * 正确做法是先剥掉可选的 #，再看剩下的是否恰好是 3/6 位十六进制：
 * 是就当颜色，不是就整行跳过。这样 `# comment`、`; xxx`、`// xxx`
 * 都会被自然识别成注释，不需要维护一份「注释前缀」清单。
 */
export function parseHexPalette(text: string): RGBA[] | null {
  const out: RGBA[] = [];

  for (const rawLine of text.split('\n')) {
    const line = dropCr(rawLine).trim();
    if (line === '') continue;

    const token = line.split(/\s+/)[0];
    const bare = token.startsWith('#') ? token.slice(1) : token;
    if (!HEX_VALUE.test(bare)) continue;

    const parsed = parseHex(token);
    if (!parsed) continue;

    out.push(parsed);
    if (out.length >= PALETTE_MAX_COLORS) break;
  }

  // 一个颜色都没解析出来说明整份文本不是 .hex（纯垃圾/纯注释）
  return out.length > 0 ? out : null;
}

/**
 * GIMP Palette。
 *
 * 头部允许前导空行和大小写差异，但不做更宽的模糊匹配：
 * 若连魔数都不对，后续任何一行都可能是巧合，硬解析出来的调色板不可信。
 */
export function parseGpl(text: string): RGBA[] | null {
  const lines = text.split('\n');

  let i = 0;
  while (i < lines.length && dropCr(lines[i]).trim() === '') i += 1;
  if (i >= lines.length) return null;
  if (dropCr(lines[i]).trim().toLowerCase() !== 'gimp palette') return null;
  i += 1;

  const out: RGBA[] = [];

  for (; i < lines.length; i += 1) {
    const line = dropCr(lines[i]).trim();
    if (line === '' || line.startsWith('#')) continue;
    // Name / Columns 是元信息，解析不返回名字，所以直接跳过
    if (/^name:/i.test(line) || /^columns:/i.test(line)) continue;

    const tokens = line.split(/\s+/);
    if (tokens.length < 3 || !INT_TOKEN.test(tokens[0]) || !INT_TOKEN.test(tokens[1]) || !INT_TOKEN.test(tokens[2])) {
      // 既不是注释/元信息，也不是合法的 R G B 数据行 —— 视为不认识的格式
      return null;
    }

    out.push(rgb(parseInt(tokens[0], 10), parseInt(tokens[1], 10), parseInt(tokens[2], 10)));
    if (out.length >= PALETTE_MAX_COLORS) break;
  }

  return out.length > 0 ? out : null;
}

/**
 * JASC-PAL。
 *
 * 第三行声明的数量不被信任：实际文件里数量与数据行数不符的情况很常见
 * （手改过、被别的工具截断过），按声明数量循环会读多/读少，
 * 因此以「实际能解析到的 R G B 行数」为准，只要至少 1 个颜色就接受。
 */
export function parseJascPal(text: string): RGBA[] | null {
  const lines = text.split('\n').map(dropCr);
  if (lines.length < 3) return null;
  if (lines[0].trim().toUpperCase() !== 'JASC-PAL') return null;
  if (lines[1].trim() !== '0100') return null;
  // 声明数量仍需是合法整数，否则连格式都不成立
  if (!INT_TOKEN.test(lines[2].trim())) return null;

  const out: RGBA[] = [];

  for (let i = 3; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;

    const tokens = line.split(/\s+/);
    if (tokens.length < 3 || !INT_TOKEN.test(tokens[0]) || !INT_TOKEN.test(tokens[1]) || !INT_TOKEN.test(tokens[2])) {
      return null;
    }

    out.push(rgb(parseInt(tokens[0], 10), parseInt(tokens[1], 10), parseInt(tokens[2], 10)));
    if (out.length >= PALETTE_MAX_COLORS) break;
  }

  return out.length > 0 ? out : null;
}

/** 取小写扩展名；没有点返回空串 */
function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

/**
 * 按文件名后缀选择解析器；后缀未知时依次尝试 gpl → jasc → hex。
 *
 * 顺序不是随便定的：gpl / jasc 都有魔数校验，误判概率极低，
 * 而 hex 最宽松（任何含十六进制 token 的文本都可能通过），
 * 所以把 hex 放最后兜底，避免它抢先把别的格式「解析成功」成残缺结果。
 */
export function parsePaletteText(text: string, filename?: string): RGBA[] | null {
  switch (filename ? extensionOf(filename) : '') {
    case 'hex':
    case 'txt':
      return parseHexPalette(text);
    case 'gpl':
      return parseGpl(text);
    case 'pal':
      return parseJascPal(text);
    default:
      return parseGpl(text) ?? parseJascPal(text) ?? parseHexPalette(text);
  }
}

/** RGBA → 大写 RRGGBB（不带 #），序列化三处共用 */
function hexTriplet(c: RGBA): string {
  const v = (clampByte(c[0]) << 16) | (clampByte(c[1]) << 8) | clampByte(c[2]);
  return v.toString(16).toUpperCase().padStart(6, '0');
}

/**
 * .hex 序列化：可选的 name 写成首行注释（解析时会自然跳过），
 * 颜色行不带 # 前缀，保证与本模块的解析器往返一致。
 */
export function serializeHexPalette(colors: readonly RGBA[], name?: string): string {
  const lines: string[] = [];
  if (name) lines.push(`# ${name}`);
  for (const c of colors) lines.push(hexTriplet(c));
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

/**
 * GIMP Palette 序列化。
 * 颜色名写成 #RRGGBB 便于在 GIMP 里直观查看；列宽固定 3 让数字对齐更好读。
 */
export function serializeGplPalette(colors: readonly RGBA[], name: string): string {
  const lines = ['GIMP Palette', `Name: ${name}`, 'Columns: 8', '#'];
  for (const c of colors) {
    const r = String(clampByte(c[0])).padStart(3);
    const g = String(clampByte(c[1])).padStart(3);
    const b = String(clampByte(c[2])).padStart(3);
    lines.push(`${r} ${g} ${b}\t#${hexTriplet(c)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** JASC-PAL 序列化：第三行写真实颜色数，与该格式的约定保持一致 */
export function serializeJascPalette(colors: readonly RGBA[]): string {
  const lines = ['JASC-PAL', '0100', String(colors.length)];
  for (const c of colors) {
    lines.push(`${clampByte(c[0])} ${clampByte(c[1])} ${clampByte(c[2])}`);
  }
  return `${lines.join('\n')}\n`;
}