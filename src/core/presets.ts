/**
 * 转换预设（M7）。
 *
 * 与批处理预设（core/batch/presets.ts）的区别：那份还带命名模板、放大倍数这些
 * **导出**相关的设置；这份只管「一套转换参数」，服务于日常调参 ——
 * 调出一套满意的参数存下来，下次换张图直接套。
 *
 * 纯数据：校验、序列化、命名去重。落 localStorage 的部分在 store 里。
 */

import { makeDefaultSettings, type ConvertSettings } from './types';

export interface ConvertPreset {
  id: string;
  name: string;
  settings: ConvertSettings;
  savedAt: number;
}

export const CONVERT_PRESET_VERSION = 1;

/** 重名时加序号。与调色板、批处理预设同一套规则 */
export function uniquePresetName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} (${n})`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base} (${Date.now().toString(36)})`;
}

/**
 * 校验参数对象。
 *
 * 只保证「形状不崩、类型对得上」，不逐字段钳制取值 ——
 * 转换流水线本身对越界参数有钳制（targetW 会被取整并限制在合理区间），
 * 在这里再抄一遍限制条件，将来改了那边这里就会悄悄不同步。
 */
export function coerceSettings(value: unknown): ConvertSettings {
  const fallback = makeDefaultSettings();
  if (!value || typeof value !== 'object') return fallback;
  const raw = value as Partial<ConvertSettings>;
  return {
    ...fallback,
    ...raw,
    preprocess: { ...fallback.preprocess, ...(raw.preprocess ?? {}) },
  };
}

/** 校验一份从存储读出来的预设数组；形状不对的整条丢掉 */
export function coerceConvertPresets(raw: unknown): ConvertPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: ConvertPreset[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const p = entry as Partial<ConvertPreset>;
    if (typeof p.id !== 'string' || p.id === '' || seen.has(p.id)) continue;
    if (typeof p.name !== 'string' || p.name.trim() === '') continue;
    seen.add(p.id);

    out.push({
      id: p.id,
      name: p.name,
      settings: coerceSettings(p.settings),
      savedAt: typeof p.savedAt === 'number' && Number.isFinite(p.savedAt) ? p.savedAt : 0,
    });
  }

  return out;
}

export function serializeConvertPresets(presets: readonly ConvertPreset[]): string {
  return JSON.stringify({ version: CONVERT_PRESET_VERSION, presets });
}

export function parseConvertPresets(text: string): ConvertPreset[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return [];
    return coerceConvertPresets((parsed as { presets?: unknown }).presets);
  } catch {
    return [];
  }
}