/**
 * 批处理预设（M5）：把「一整套批量参数」存下来反复用。
 *
 * 与 M7 规划的 `state/presets.ts`（转换预设）的区别：那份只存 ConvertSettings，
 * 这份还要带上导出相关的三样（命名模板、放大倍数、是否填白底）——
 * 它们是「成批出素材」这件事的一部分，缺了就得每批重填。
 *
 * 本模块只管**纯数据**：校验、序列化、去重命名。落 localStorage 的部分在 store 里。
 * 校验必须做足：存进去的是上一个版本写的数据，或被人手改过的 JSON，
 * 形状不对就整条丢掉，绝不让坏数据流进转换流程。
 */

import { DEFAULT_NAME_TEMPLATE } from './naming';
import { makeDefaultSettings, type ConvertSettings } from '../types';

export interface BatchPreset {
  id: string;
  name: string;
  template: string;
  scale: number;
  opaque: boolean;
  settings: ConvertSettings;
  /** 保存时间，用于列表排序（最近存的靠前） */
  savedAt: number;
}

export const BATCH_PRESET_VERSION = 1;

const MAX_SCALE = 64;
const MIN_SCALE = 1;

/** 名字占用时加序号。与调色板那边同一套规则：半角括号在窄面板里更省地方 */
export function uniquePresetName(base: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${base} (${n})`;
    if (!used.has(candidate)) return candidate;
  }
  return `${base} (${Date.now().toString(36)})`;
}

/** 从任意值里取出一个可用作参数的对象；不可用时回退到默认设置 */
function coerceSettings(value: unknown): ConvertSettings {
  const fallback = makeDefaultSettings();
  if (!value || typeof value !== 'object') return fallback;
  const raw = value as Partial<ConvertSettings>;
  // 逐个字段校验太啰嗦，且转换层本身对参数有钳制；这里只保证「类型不崩」
  return {
    ...fallback,
    ...raw,
    preprocess: { ...fallback.preprocess, ...(raw.preprocess ?? {}) },
  };
}

/**
 * 校验一份从存储里读出来的预设数组。
 * 返回空数组表示整份数据不可用 —— 调用方退回「没有预设」即可，不需要报错。
 */
export function coercePresets(raw: unknown): BatchPreset[] {
  if (!Array.isArray(raw)) return [];
  const out: BatchPreset[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const p = entry as Partial<BatchPreset>;
    if (typeof p.id !== 'string' || p.id === '' || seen.has(p.id)) continue;
    if (typeof p.name !== 'string' || p.name.trim() === '') continue;
    seen.add(p.id);

    out.push({
      id: p.id,
      name: p.name,
      template: typeof p.template === 'string' && p.template.trim() !== ''
        ? p.template
        : DEFAULT_NAME_TEMPLATE,
      scale: clampScale(p.scale),
      opaque: p.opaque === true,
      settings: coerceSettings(p.settings),
      savedAt: typeof p.savedAt === 'number' && Number.isFinite(p.savedAt) ? p.savedAt : 0,
    });
  }

  return out;
}

function clampScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1;
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.round(value)));
}

export function serializePresets(presets: readonly BatchPreset[]): string {
  return JSON.stringify({ version: BATCH_PRESET_VERSION, presets });
}

/**
 * 反序列化。带版本号是为了将来结构变了能另起一套迁移；
 * 当前只有 v1，遇到别的版本同样按同一套校验读 —— 校验本身足够严格，
 * 读不出来就丢，没必要因为版本号不认识就把整份预设作废。
 */
export function parsePresets(text: string): BatchPreset[] {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return [];
    const wrapped = parsed as { presets?: unknown };
    return coercePresets(wrapped.presets);
  } catch {
    return [];
  }
}