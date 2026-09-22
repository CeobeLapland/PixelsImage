/**
 * 批量导出的命名规则（M5）。
 *
 * 为什么要有模板，而不是写死「原文件名 + 尺寸」：
 * 批量出素材时命名往往要跟着目标引擎走（`hero_idle_32x32.png`、`tile_03.png`……），
 * 只提供一种固定写法，用户导完还得挨个改名 —— 那批量就白做了。
 *
 * 本模块是纯字符串处理，不碰 DOM，所以能直接单测。
 * 命名出错的代价是「导出 20 张，悄悄覆盖掉 3 张」，属于必须锁死的那一类。
 */

/** 模板里可用的占位符 */
export const NAME_TOKENS = ['name', 'w', 'h', 'scale', 'index'] as const;
export type NameToken = (typeof NAME_TOKENS)[number];

export const DEFAULT_NAME_TEMPLATE = '{name}_{w}x{h}.png';

export interface NameContext {
  /** 源文件名，可带扩展名 */
  name: string;
  /** 网格宽（裁剪后） */
  w: number;
  /** 网格高（裁剪后） */
  h: number;
  /** 放大倍数 */
  scale: number;
  /** 队列中的序号，从 1 开始 */
  index: number;
}

/** 去掉扩展名。以点开头的隐藏文件（`.gitignore`）整体当名字，别切成空串 */
export function baseNameOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  if (dot <= 0) return fileName;
  return fileName.slice(0, dot);
}

/**
 * 各平台文件名的非法字符并集（Windows 最严，按它来），外加控制字符。
 * 之所以不按当前系统判断：导出的 zip 可能被拷到别的系统上解压。
 */
const ILLEGAL_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** 清掉非法字符并压掉多余空白；全非法时给个兜底名 */
export function sanitizeFileName(name: string): string {
  const cleaned = name.replace(ILLEGAL_CHARS, '_').replace(/\s+/g, ' ').trim();
  // 兜底：否则会往 zip 里塞一个空名字的条目
  return cleaned === '' ? 'pixels' : cleaned;
}

/**
 * 按模板生成文件名。
 *
 * 三条约定：
 * - 未知占位符**原样保留**，让用户在文件名里一眼看到自己写错了，
 *   而不是被静默替换成空串；
 * - 结果没有 `.png` 后缀时自动补上 —— 导出目录里一堆无后缀文件没法用；
 * - 最后统一过一遍非法字符清理。
 */
export function applyNameTemplate(template: string, ctx: NameContext): string {
  const values: Record<NameToken, string> = {
    name: sanitizeFileName(baseNameOf(ctx.name)),
    w: String(ctx.w),
    h: String(ctx.h),
    scale: String(ctx.scale),
    index: String(ctx.index),
  };

  let out = template.replace(/\{(\w+)\}/g, (whole, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key as NameToken] : whole,
  );
  out = out.trim();
  if (out === '') out = values.name;
  if (!/\.png$/i.test(out)) out += '.png';
  return sanitizeFileName(out);
}

/** 模板里用到的、不认识的占位符。面板拿它给一句提示 */
export function unknownTokens(template: string): string[] {
  const known = new Set<string>(NAME_TOKENS);
  const out: string[] = [];
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const key = match[1];
    if (!known.has(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

/**
 * 同名去重：第二个及以后插入 `_2`、`_3`……
 *
 * 两个细节都不能省：
 * - 序号插在**扩展名前**，否则 `a.png` 会变成 `a.png_2`；
 * - 比较时**忽略大小写** —— Windows 与 macOS 的默认文件系统不区分大小写，
 *   `A.png` 与 `a.png` 在 zip 里是两个条目，解压时却会互相覆盖。
 */
export function dedupeFileNames(names: readonly string[]): string[] {
  const used = new Set<string>();
  const out: string[] = [];

  for (const raw of names) {
    const name = sanitizeFileName(raw);
    const key = name.toLowerCase();
    if (!used.has(key)) {
      used.add(key);
      out.push(name);
      continue;
    }

    const dot = name.lastIndexOf('.');
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const ext = dot > 0 ? name.slice(dot) : '';

    let placed = false;
    for (let n = 2; n < 10000; n += 1) {
      const candidate = `${stem}_${n}${ext}`;
      const candidateKey = candidate.toLowerCase();
      if (used.has(candidateKey)) continue;
      used.add(candidateKey);
      out.push(candidate);
      placed = true;
      break;
    }
    // 理论上到不了这里（一万个同名），但出口必须存在，否则条目数会对不上
    if (!placed) {
      const fallback = `${stem}_${Date.now().toString(36)}${ext}`;
      used.add(fallback.toLowerCase());
      out.push(fallback);
    }
  }

  return out;
}

/**
 * 一次批量导出里，为每个条目算出最终文件名。
 * 返回值与入参一一对应，顺序保证不变。
 */
export function buildBatchNames(
  template: string,
  items: readonly { name: string; w: number; h: number }[],
  scale: number,
): string[] {
  const raw = items.map((item, i) =>
    applyNameTemplate(template, { name: item.name, w: item.w, h: item.h, scale, index: i + 1 }),
  );
  return dedupeFileNames(raw);
}
