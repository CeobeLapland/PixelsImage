import { useState, type JSX } from 'react';

import { parseHex, toHex } from '@/core/color/space';
import type { Palette, RGBA } from '@/core/types';
import { BUILTIN_PALETTES } from '@/palettes/builtin';
import { useApp } from '@/state/store';
import { Field, Select, Toggle } from './controls';
import { Row } from './Section';

/**
 * 调色板引擎（M3）的核心面板：选板、取色、改色、全局换色、结构操作。
 *
 * 三种鼠标行为，互不冲突：
 * - 左键点色块 → 设为前景色（画图时最常用）
 * - 右键点色块 → 设为背景色
 * - Shift + 左键 → 把全图中该色换成前景色（全局换色，可撤销）
 */
export function PalettePanel(): JSX.Element {
  const settings = useApp((s) => s.settings);
  const palette = useApp((s) => s.palette);
  const customPalettes = useApp((s) => s.customPalettes);
  const patchSettings = useApp((s) => s.patchSettings);
  const usedColors = useApp((s) => s.info?.usedColors ?? null);
  const foreground = useApp((s) => s.foreground);
  const background = useApp((s) => s.background);
  const setForeground = useApp((s) => s.setForeground);
  const setBackground = useApp((s) => s.setBackground);
  const swapColors = useApp((s) => s.swapColors);
  const replaceColor = useApp((s) => s.replaceColor);
  const editPaletteColor = useApp((s) => s.editPaletteColor);
  const sortPalette = useApp((s) => s.sortPalette);
  const mergePaletteColors = useApp((s) => s.mergePaletteColors);
  const addCustomPalette = useApp((s) => s.addCustomPalette);
  const removeCustomPalette = useApp((s) => s.removeCustomPalette);
  const hasGrid = useApp((s) => s.baseGrid !== null);

  const [editing, setEditing] = useState(false);
  const [editTarget, setEditTarget] = useState(0);
  const [tolerance, setTolerance] = useState(16);

  const isKmeans = settings.quantize === 'kmeans';
  const customs = Object.values(customPalettes).filter((p): p is Palette => Boolean(p));
  const options: { value: string; label: string }[] = [
    ...BUILTIN_PALETTES.map((p) => ({ value: p.id, label: `${p.name}（${p.colors.length}）` })),
    ...customs.map((p) => ({ value: p.id, label: `★ ${p.name}（${p.colors.length}）` })),
  ];

  // 限色模式生成的板是当场算出来的、没有登记过，下拉框里不会有它 ——
  // 补一个「当前」项，否则下拉框会显示成一块和色块对不上的旧板
  const registered = options.some((o) => o.value === palette.id);
  if (!registered) options.unshift({ value: '__current', label: `${palette.name}（当前）` });
  const selectValue = registered
    ? options.some((o) => o.value === settings.paletteId)
      ? settings.paletteId
      : palette.id
    : '__current';

  const isSaved = customPalettes[palette.id] !== undefined;
  const slot = Math.min(editTarget, Math.max(0, palette.colors.length - 1));
  const target = palette.colors[slot];

  const hexOf = (c: RGBA | undefined): string => (c ? toHex(c[0], c[1], c[2]) : '#000000');

  return (
    <div className="section__body">
      <Select
        label="调色板"
        value={selectValue}
        options={options}
        disabled={isKmeans}
        onChange={(v) => {
          if (v !== '__current') patchSettings({ paletteId: v });
        }}
      />

      {isKmeans && (
        <p className="note note--warn">
          当前是 <b>k-means 限色</b>模式，调色板由图片现场聚出来。
          想改用固定调色板，请到「转换」里把颜色来源切回<b>调色板</b>。
          现在的这块板可以点下面的「存为自定义板」固定下来。
        </p>
      )}

      <div className="swatches">
        {palette.colors.map((c, i) => {
          const hex = hexOf(c);
          return (
            <button
              key={`${hex}-${i}`}
              type="button"
              className="swatch"
              style={{ background: hex }}
              title={`#${i} ${hex.toUpperCase()} · 左键设前景色 / 右键设背景色 / Shift+左键把全图此色换成前景色`}
              aria-pressed={i === foreground}
              data-editing={editing && i === slot ? 'true' : undefined}
              onClick={(event) => {
                if (editing) {
                  setEditTarget(i);
                  return;
                }
                if (event.shiftKey) {
                  replaceColor(i, foreground);
                  return;
                }
                setForeground(i);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setBackground(i);
              }}
            >
              {i === background && i !== foreground && <span className="swatch__mark">后</span>}
            </button>
          );
        })}
      </div>

      <div className="colorslot">
        <div className="colorslot__item" title="前景色：铅笔 / 油漆桶 / 形状都用它落笔">
          <i
            className="colorslot__chip"
            style={{ backgroundColor: hexOf(palette.colors[foreground]) }}
          />
          <span className="colorslot__label">
            #{foreground} {hexOf(palette.colors[foreground])}
          </span>
        </div>
        <div className="colorslot__item" title="背景色：右键色块设置；X 键与前景互换">
          <i
            className="colorslot__chip"
            style={{ backgroundColor: hexOf(palette.colors[background]) }}
          />
          <span className="colorslot__label">
            #{background} {hexOf(palette.colors[background])}
          </span>
        </div>
        <button
          type="button"
          className="btn btn--icon"
          title="前景 / 背景互换（X）"
          aria-label="前景背景互换"
          onClick={swapColors}
        >
          ⇄
        </button>
      </div>

      {/* ---- 改色：改的是调色板本身，全图所有指向这个槽位的格子立刻跟着变 ---- */}
      <Toggle
        label="编辑色槽颜色"
        value={editing}
        title="打开后点色块选中它，再用下面的取色器改颜色。改内置板会自动分叉出一份自定义板"
        onChange={(on) => {
          setEditing(on);
          if (on) setEditTarget(foreground);
        }}
      />
      {editing && (
        <Field label={`色槽 #${slot}`} hint={hexOf(target)}>
          <div className="colorpicker">
            <input
              type="color"
              className="colorpicker__input"
              value={hexOf(target)}
              onChange={(event) => {
                const parsed = parseHex(event.target.value);
                if (parsed) editPaletteColor(slot, parsed as unknown as RGBA);
              }}
            />
            <span className="colorpicker__hint">
              改色会立刻作用到全图所有指向这一槽的格子，也包含你手改过的。
            </span>
          </div>
        </Field>
      )}

      {/* ---- 结构操作 ---- */}
      <Field label="排序">
        <div className="chips">
          <button type="button" className="chip" onClick={() => sortPalette('luminance')}>
            按明度
          </button>
          <button type="button" className="chip" onClick={() => sortPalette('hue')}>
            按色相
          </button>
        </div>
      </Field>

      {/* 这里刻意不用控件库的 Slider：它会把 interacting 置位，
          导致拖动合并容差时触发一轮无谓的「快速模式」重算 */}
      <Field label="合并近似色 · 容差" hint={String(tolerance)}>
        <input
          className="slider"
          type="range"
          min={0}
          max={96}
          value={tolerance}
          onChange={(event) => setTolerance(Number(event.target.value))}
        />
      </Field>
      <div className="chips chips--actions">
        <button type="button" className="chip" onClick={() => mergePaletteColors(tolerance)}>
          合并近似色
        </button>
        <button
          type="button"
          className="chip"
          disabled={isSaved}
          title="把当前板存成自定义板，之后可以在下拉框里选回来，也会记住到下次打开"
          onClick={() => addCustomPalette(palette)}
        >
          {isSaved ? '已保存' : '存为自定义板'}
        </button>
      </div>
      {isSaved && (
        <button
          type="button"
          className="btn btn--block"
          onClick={() => removeCustomPalette(palette.id)}
        >
          删除这块自定义板
        </button>
      )}

      <Row k="板内颜色" v={palette.colors.length} />
      {usedColors !== null && <Row k="实际用到" v={`${usedColors} 种`} />}

      <p className="note">
        <b>左键</b>点色块设为前景色、<b>右键</b>设为背景色、
        <b>Shift+左键</b>把全图该色换成前景色
        {hasGrid ? '（换色写进手改层，可 Ctrl+Z 撤销）' : '（需要先生成像素图）'}。
        改色与排序动的是调色板本身，因此不进撤销栈；内置板会被自动分叉成自定义板，
        原始内置板永远保持干净。
      </p>
    </div>
  );
}