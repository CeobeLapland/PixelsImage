/**
 * 局部转换面板（M9）。
 *
 * 一件事：把「选区」里的颜色换成另一块调色板的颜色，其余格子不动。
 *
 * 为什么不是「重跑转换流水线」：网格里每格只有调色板索引，没有独立 RGB。
 * 真正的局部重算需要把源图坐标映射回来（还要处理裁透明边的偏移），
 * 而做素材时九成需求是「这块区域换套颜色」—— 直接换板更准也更快。
 */

import { useState, type JSX } from 'react';

import type { DistanceMode, DitherMode, Palette } from '@/core/types';
import { BUILTIN_PALETTES, resolvePalette } from '@/palettes/builtin';
import { useApp } from '@/state/store';
import { DISTANCE_OPTIONS, DITHER_OPTIONS } from './convertOptions';
import { Select, Slider } from './controls';
import { Row } from './Section';

export function LocalPanel(): JSX.Element {
  const selection = useApp((s) => s.selection);
  const palette = useApp((s) => s.palette);
  const customPalettes = useApp((s) => s.customPalettes);
  const settings = useApp((s) => s.settings);
  const requantizeSelection = useApp((s) => s.requantizeSelection);

  const [paletteId, setPaletteId] = useState<string>('__current');
  const [distance, setDistance] = useState<DistanceMode>(settings.distance);
  const [dither, setDither] = useState<DitherMode>('none');
  const [strength, setStrength] = useState(100);

  const customs = Object.values(customPalettes).filter((p): p is Palette => Boolean(p));
  const options: { value: string; label: string }[] = [
    { value: '__current', label: `当前板 · ${palette.name}（${palette.colors.length}）` },
    ...BUILTIN_PALETTES.map((p) => ({ value: p.id, label: `${p.name}（${p.colors.length}）` })),
    ...customs.map((p) => ({ value: p.id, label: `★ ${p.name}（${p.colors.length}）` })),
  ];

  const target: Palette =
    paletteId === '__current' ? palette : resolvePalette(paletteId, customPalettes);

  return (
    <div className="section__body">
      <p className="note">
        用画布上的「选区」工具（<b>M</b>）框一块区域，再挑一块目标调色板。
        只有选区内的格子会换板，其余保持原样。
      </p>

      <Select label="目标调色板" value={paletteId} options={options} onChange={setPaletteId} />
      <Select label="颜色距离" value={distance} options={DISTANCE_OPTIONS} onChange={setDistance} />
      <Select label="抖动" value={dither} options={DITHER_OPTIONS} onChange={setDither} />
      {dither !== 'none' && (
        <Slider
          label="抖动强度"
          value={strength}
          min={0}
          max={100}
          format={(v) => `${v}%`}
          onChange={setStrength}
        />
      )}

      {selection ? (
        <Row k="选区" v={`${selection.w} × ${selection.h} · (${selection.x}, ${selection.y})`} />
      ) : (
        <p className="note note--warn">还没有选区：先在画布上框一块，再回来点按钮。</p>
      )}

      <button
        type="button"
        className="btn btn--primary btn--block"
        disabled={!selection}
        onClick={() =>
          requantizeSelection({
            palette: target,
            distance,
            dither,
            ditherStrength: strength / 100,
          })
        }
      >
        把选区换成这块板
      </button>

      <p className="note note--tight">
        目标板里用到的颜色会<b>追加</b>到当前板末尾（同色复用），所以其他格子的色号不会变。
        改动写进手改层，<b>Ctrl+Z</b> 可撤销；追加的颜色会留在板上。
        目标板选「当前板」时，等于只对选区重新抖动一次。
      </p>
    </div>
  );
}
