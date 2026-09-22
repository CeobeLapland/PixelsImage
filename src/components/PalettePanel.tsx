import { useState, type JSX } from 'react';

import { Select } from './controls';
import { Row } from './Section';
import { BUILTIN_PALETTES } from '@/palettes/builtin';
import { useApp } from '@/state/store';

const PALETTE_OPTIONS = BUILTIN_PALETTES.map((p) => ({
  value: p.id,
  label: `${p.name}（${p.colors.length}）`,
}));

/** 调色板选择 + 色板预览。完整的调色板引擎（提色/导入/换色）在 M3。 */
export function PalettePanel(): JSX.Element {
  const paletteId = useApp((s) => s.settings.paletteId);
  const palette = useApp((s) => s.palette);
  const patchSettings = useApp((s) => s.patchSettings);
  const usedColors = useApp((s) => s.info?.usedColors ?? null);
  const [copied, setCopied] = useState<number | null>(null);

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
          const hex = `#${[c[0], c[1], c[2]]
            .map((v) => v.toString(16).padStart(2, '0'))
            .join('')}`;
          return (
            <button
              key={`${hex}-${i}`}
              type="button"
              className="swatch"
              style={{ background: hex }}
              title={`${i} · ${hex.toUpperCase()}（点击复制）`}
              onClick={() => {
                void navigator.clipboard?.writeText(hex.toUpperCase());
                setCopied(i);
                setTimeout(() => setCopied((v) => (v === i ? null : v)), 1200);
              }}
            >
              {copied === i && <span className="swatch__copied">已复制</span>}
            </button>
          );
        })}
      </div>

      <Row k="板内颜色" v={palette.colors.length} />
      {usedColors !== null && <Row k="实际用到" v={`${usedColors} 种`} />}
      <p className="note">点击色块复制 hex；前景色与绘图取色在 M2 接入。</p>
    </div>
  );
}