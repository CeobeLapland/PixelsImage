import type { JSX } from 'react';

import { NumberField, Segmented, Slider, Toggle } from './controls';
import { Row } from './Section';
import { BUILTIN_PALETTES } from '@/palettes/builtin';
import { useApp } from '@/state/store';
import type {
  DistanceMode,
  DitherMode,
  SamplingMode,
} from '@/core/types';

/** 目标格数的快捷档位 */
const SIZE_PRESETS = [16, 24, 32, 48, 64, 96, 128];

const SAMPLING_OPTIONS: readonly { value: SamplingMode; label: string; title: string }[] = [
  { value: 'area', label: '面积平均', title: '块内加权平均。照片、插画最稳，颜色过渡自然' },
  { value: 'nearest', label: '最近邻', title: '取块中心像素。源图本身就是像素画时用，保留硬边缘' },
  { value: 'dominant', label: '主色投票', title: '块内直方图投票取主色。色块感强，不产生原图没有的混合色' },
  { value: 'median', label: '中位数', title: '块内各通道取中位数。抗噪点、抗单点高光' },
];

const DISTANCE_OPTIONS: readonly { value: DistanceMode; label: string; title: string }[] = [
  { value: 'weighted', label: '加权 RGB', title: '2Δr²+4Δg²+3Δb²，便宜的感知近似。实时预览默认' },
  { value: 'lab', label: 'CIELAB', title: '转 CIELAB 算 ΔE。最准，暗部与肤色判断明显更好' },
  { value: 'rgb', label: '欧氏 RGB', title: '最快，但对暗部与肤色偏差较大' },
];

const DITHER_OPTIONS: readonly { value: DitherMode; label: string; title: string }[] = [
  { value: 'atkinson', label: 'Atkinson', title: '只扩散 6/8 误差。对比度高、伪影少，像素画首选' },
  { value: 'floyd', label: 'Floyd', title: 'Floyd–Steinberg。细节最好，但有「虫形」伪影' },
  { value: 'sierra', label: 'Sierra', title: '介于 Floyd 与 Atkinson 之间' },
  { value: 'bayer4', label: 'Bayer 4', title: '有序抖动。图案规则，可无缝平铺，适合做贴图' },
  { value: 'bayer2', label: 'Bayer 2', title: '2×2 有序抖动，颗粒最粗' },
  { value: 'bayer8', label: 'Bayer 8', title: '8×8 有序抖动，颗粒最细' },
  { value: 'none', label: '不抖动', title: '直接映射到最近色，硬边、色带明显' },
];

export function ConvertPanel(): JSX.Element {
  const settings = useApp((s) => s.settings);
  const patchSettings = useApp((s) => s.patchSettings);
  const source = useApp((s) => s.source);

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
          当前调色板共 <b>{BUILTIN_PALETTES.length}</b> 个内置可选，
          内含 <b>{BUILTIN_PALETTES[0]?.colors.length ?? 0}</b> 色的 Minecraft 染料板。
          自定义调色板与提色在 M3。
        </p>
      </div>
    </>
  );
}