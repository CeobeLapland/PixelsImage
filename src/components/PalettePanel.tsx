import type { JSX } from 'react';

import { Select } from './controls';
import { Row } from './Section';
import { BUILTIN_PALETTES } from '@/palettes/builtin';
import { useApp } from '@/state/store';

const PALETTE_OPTIONS = BUILTIN_PALETTES.map((p) => ({
  value: p.id,
  label: `${p.name}（${p.colors.length}）`,
}));

function hexOf(color: readonly number[] | undefined): string {
  if (!color) return 'transparent';
  return `#${[color[0] ?? 0, color[1] ?? 0, color[2] ?? 0]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * 调色板选择 + 色块网格。
 *
 * M2 只做最必需的一条链路：**左键设为前景色、右键设为背景色** ——
 * 不能选颜色就没法画。提色、导入导出、全局换色、色板编辑都在 M3。
 */
export function PalettePanel(): JSX.Element {
  const paletteId = useApp((s) => s.settings.paletteId);
  const palette = useApp((s) => s.palette);
  const patchSettings = useApp((s) => s.patchSettings);
  const usedColors = useApp((s) => s.info?.usedColors ?? null);
  const foreground = useApp((s) => s.foreground);
  const background = useApp((s) => s.background);
  const setForeground = useApp((s) => s.setForeground);
  const setBackground = useApp((s) => s.setBackground);
  const swapColors = useApp((s) => s.swapColors);

  return (
    <div className="section__body">
      <Select
        label="调色板"
        value={paletteId}
        options={PALETTE_OPTIONS}
        onChange={(v) => patchSettings({ paletteId: v })}
      />

      <div className="swatches">
        {palette.colors.map((c, i) => {
          const hex = hexOf(c);
          return (
            <button
              key={`${hex}-${i}`}
              type="button"
              className="swatch"
              style={{ background: hex }}
              title={`#${i} ${hex.toUpperCase()} · 左键设前景色，右键设背景色`}
              aria-pressed={i === foreground}
              onClick={() => setForeground(i)}
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

      <Row k="板内颜色" v={palette.colors.length} />
      {usedColors !== null && <Row k="实际用到" v={`${usedColors} 种`} />}
      <p className="note">
        <b>左键点色块</b>设为前景色、<b>右键</b>设为背景色；所有绘图工具都用前景色落笔，
        <b>Alt + 点击画布</b>可以直接吸取某一格的颜色。
      </p>
    </div>
  );
}