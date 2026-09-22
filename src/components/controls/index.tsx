/**
 * 面板控件库。
 *
 * 这些控件的共同约定：
 * - 所有会触发重算的控件（滑块、开关、分段选择）在交互开始时把 store 的
 *   `interacting` 置 true，结束时置 false —— 转换器据此判断是否降级到快速模式。
 *   这样「拖动时跟手、松手后变准」这件事只需要在控件层声明一次。
 */

import { useEffect, useRef, useState, type JSX, type ReactNode } from 'react';

import { useApp } from '@/state/store';

/* --------------------------------------------------------------- 通用行 */

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="field">
      <div className="field__head">
        <span className="field__label">{label}</span>
        {hint && <span className="field__hint">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

/* --------------------------------------------------------------- 滑块 */

interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  /** 数值的显示方式，默认原样 */
  format?: (v: number) => string;
  disabled?: boolean;
  onChange: (v: number) => void;
  /** 拖动结束（用于触发一次完整精度重算） */
  onCommit?: () => void;
}

export function Slider({
  label,
  value,
  min,
  max,
  step = 1,
  format,
  disabled,
  onChange,
  onCommit,
}: SliderProps): JSX.Element {
  const dragging = useRef(false);

  const beginInteraction = () => {
    if (dragging.current) return;
    dragging.current = true;
    useApp.getState().setInteracting(true);
  };

  const endInteraction = () => {
    if (!dragging.current) return;
    dragging.current = false;
    useApp.getState().setInteracting(false);
    onCommit?.();
  };

  return (
    <Field label={label} hint={format ? format(value) : String(value)}>
      <input
        className="slider"
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onPointerDown={beginInteraction}
        onPointerUp={endInteraction}
        onPointerCancel={endInteraction}
        onKeyDown={beginInteraction}
        onKeyUp={endInteraction}
        onBlur={endInteraction}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </Field>
  );
}

/* --------------------------------------------------------------- 分段选择 */

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  title?: string;
}

export function Segmented<T extends string>({
  label,
  value,
  options,
  disabled,
  columns,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly SegmentOption<T>[];
  disabled?: boolean;
  /** 指定列数则渲染成网格，否则自动换行 */
  columns?: number;
  onChange: (v: T) => void;
}): JSX.Element {
  return (
    <Field label={label}>
      <div
        className="seg"
        role="radiogroup"
        aria-label={label}
        style={columns ? { gridTemplateColumns: `repeat(${columns}, 1fr)` } : undefined}
        data-grid={columns ? 'true' : undefined}
      >
        {options.map((opt) => (
          <button
            key={opt.value}
            type="button"
            role="radio"
            className="seg__item"
            aria-checked={value === opt.value}
            disabled={disabled}
            title={opt.title ?? opt.label}
            onClick={() => {
              if (value === opt.value) return;
              onChange(opt.value);
            }}
          >
            {opt.label}
          </button>
        ))}
      </div>
    </Field>
  );
}

/* --------------------------------------------------------------- 下拉选择 */

export function Select<T extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: T;
  options: readonly SegmentOption<T>[];
  disabled?: boolean;
  onChange: (v: T) => void;
}): JSX.Element {
  return (
    <Field label={label}>
      <select
        className="select"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value as T)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </Field>
  );
}

/* --------------------------------------------------------------- 文本输入 */

interface TextFieldProps {
  label: string;
  value: string;
  placeholder?: string;
  disabled?: boolean;
  /** 失焦或回车时提交；空串不提交 —— 否则一不留神就把名字清空了 */
  onCommit: (v: string) => void;
}

export function TextField({
  label,
  value,
  placeholder,
  disabled,
  onCommit,
}: TextFieldProps): JSX.Element {
  const [draft, setDraft] = useState(value);

  // 外部值变化（例如切到了另一块调色板）时同步草稿
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const next = draft.trim();
    if (next === '' || next === value) {
      setDraft(value);
      return;
    }
    onCommit(next);
  };

  return (
    <Field label={label}>
      <input
        className="textfield__input"
        type="text"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            // Esc 放弃修改：先还原草稿再失焦，避免 blur 又提交一次
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
      />
    </Field>
  );
}

/* --------------------------------------------------------------- 数字输入 */

export function NumberField({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled?: boolean;
  onChange: (v: number) => void;
}): JSX.Element {
  const commit = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    onChange(Math.max(min, Math.min(max, Math.round(parsed))));
  };

  return (
    <Field label={label}>
      <input
        className="numberfield__input"
        type="number"
        value={value}
        min={min}
        max={max}
        disabled={disabled}
        onChange={(event) => commit(event.target.value)}
      />
    </Field>
  );
}

/* --------------------------------------------------------------- 开关 */

export function Toggle({
  label,
  value,
  disabled,
  title,
  onChange,
}: {
  label: string;
  value: boolean;
  disabled?: boolean;
  title?: string;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="toggle"
      aria-pressed={value}
      disabled={disabled}
      title={title}
      onClick={() => onChange(!value)}
    >
      <span className="toggle__track" />
      <span>{label}</span>
    </button>
  );
}