import type { JSX } from 'react';

import { NumberField, Segmented, Slider, Toggle } from './controls';
import {
  DITHER_OPTIONS,
  DISTANCE_OPTIONS,
  QUANTIZE_OPTIONS,
  SAMPLING_OPTIONS,
  SIZE_PRESETS,
} from './convertOptions';
import { Row } from './Section';
import { useApp } from '@/state/store';
import { BUILTIN_PALETTES } from '@/palettes/builtin';

export function ConvertPanel(): JSX.Element {
  const settings = useApp((s) => s.settings);
  const patchSettings = useApp((s) => s.patchSettings);
  const source = useApp((s) => s.source);
  const palette = useApp((s) => s.palette);
  const customCount = useApp((s) => Object.keys(s.customPalettes).length);

  const autoHeight =
    source && settings.targetH === 'auto'
      ? Math.max(
          1,
          Math.round(
            (settings.targetW * source.imageData.height) / source.imageData.width,
          ),
        )
      : null;

  const keepRatio = settings.targetH === 'auto';

  return (
    <>
      <div className="section__body">
        <Slider
          label="目标格数（宽）"
          value={settings.targetW}
          min={4}
          max={256}
          onChange={(v) => patchSettings({ targetW: v })}
        />
        <div className="chips">
          {SIZE_PRESETS.map((size) => (
            <button
              key={size}
              type="button"
              className="chip"
              aria-pressed={settings.targetW === size}
              onClick={() => patchSettings({ targetW: size })}
            >
              {size}
            </button>
          ))}
        </div>

        <Toggle
          label="保持原图宽高比"
          value={keepRatio}
          title="关闭后可自由指定高度，得到拉伸或压扁的效果"
          onChange={(on) => {
            if (on) {
              patchSettings({ targetH: 'auto' });
            } else {
              // 从当前推导值切入手动模式，避免跳变
              patchSettings({ targetH: autoHeight ?? settings.targetW });
            }
          }}
        />

        {keepRatio ? (
          <Row k="高度" v={`${autoHeight ?? '—'} 格（按比例）`} />
        ) : (
          <NumberField
            label="高度（格）"
            value={settings.targetH === 'auto' ? 1 : settings.targetH}
            min={1}
            max={256}
            onChange={(v) => patchSettings({ targetH: v })}
          />
        )}

        <Row
          k="输出尺寸"
          v={`${settings.targetW} × ${keepRatio ? (autoHeight ?? '—') : settings.targetH} 格`}
        />
      </div>

      <div className="section__body">
        <Segmented
          label="采样方式"
          value={settings.sampling}
          options={SAMPLING_OPTIONS}
          columns={2}
          onChange={(v) => patchSettings({ sampling: v })}
        />
        <Segmented
          label="颜色距离"
          value={settings.distance}
          options={DISTANCE_OPTIONS}
          columns={3}
          onChange={(v) => patchSettings({ distance: v })}
        />
        <Segmented
          label="抖动算法"
          value={settings.dither}
          options={DITHER_OPTIONS}
          columns={2}
          onChange={(v) => patchSettings({ dither: v })}
        />
        <Slider
          label="抖动强度"
          value={Math.round(settings.ditherStrength * 100)}
          min={0}
          max={100}
          format={(v) => `${v}%`}
          disabled={settings.dither === 'none'}
          onChange={(v) => patchSettings({ ditherStrength: v / 100 })}
        />
      </div>

      <div className="section__body">
        <Segmented
          label="颜色来源"
          value={settings.quantize}
          options={QUANTIZE_OPTIONS}
          columns={2}
          onChange={(v) => patchSettings({ quantize: v })}
        />
        {settings.quantize === 'palette' ? (
          <Row k="当前调色板" v={palette.name} />
        ) : (
          <>
            <Slider
              label="限色数量"
              value={settings.maxColors}
              min={2}
              max={64}
              onChange={(v) => patchSettings({ maxColors: v })}
            />
            <p className="note">
              调色板由这张图现场聚出来，已经显示在「调色板」面板里 ——
              想固定下来复用，点那里的「存为自定义板」。
            </p>
          </>
        )}
      </div>

      <div className="section__body">
        <Toggle
          label="pixelPerfect（每格权重一致）"
          value={settings.pixelPerfect}
          title="源图尺寸不是目标格数的整数倍时，先做整数倍最近邻放大再平均，保证同一元素在不同位置大小一致"
          onChange={(v) => patchSettings({ pixelPerfect: v })}
        />
        <Toggle
          label="裁掉四周透明边"
          value={settings.trimTransparent}
          title="转换后自动裁掉全透明的外圈，输出尺寸会变小"
          onChange={(v) => patchSettings({ trimTransparent: v })}
        />
        <p className="note">
          「调色板」面板里共有 <b>{BUILTIN_PALETTES.length}</b> 块内置板
          {customCount > 0 ? ` 与你保存的 ${customCount} 块自定义板` : ''}
          ，另有从图片提取主色、导入 .hex/.gpl 两条路。
        </p>
      </div>
    </>
  );
}