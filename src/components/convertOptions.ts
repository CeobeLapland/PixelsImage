/**
 * 转换参数的选项表。
 *
 * 单独成文件是因为「转换」面板与「批量」面板要渲染同一批选项 ——
 * 两处各写一份的话，加一种抖动算法时很容易只改一处，
 * 于是批量面板里少一个选项、还看不出是漏了。
 */

import type { SegmentOption } from './controls';
import type { DistanceMode, DitherMode, QuantizeMode, SamplingMode } from '@/core/types';

/** 目标格数的快捷档位 */
export const SIZE_PRESETS = [16, 24, 32, 48, 64, 96, 128];

export const SAMPLING_OPTIONS: readonly SegmentOption<SamplingMode>[] = [
  { value: 'area', label: '面积平均', title: '块内加权平均。照片、插画最稳，颜色过渡自然' },
  { value: 'nearest', label: '最近邻', title: '取块中心像素。源图本身就是像素画时用，保留硬边缘' },
  { value: 'dominant', label: '主色投票', title: '块内直方图投票取主色。色块感强，不产生原图没有的混合色' },
  { value: 'median', label: '中位数', title: '块内各通道取中位数。抗噪点、抗单点高光' },
];

export const QUANTIZE_OPTIONS: readonly SegmentOption<QuantizeMode>[] = [
  {
    value: 'palette',
    label: '固定调色板',
    title: '把颜色映射到「调色板」面板里选中的那块板。可控、可复现，也是手改的基础',
  },
  {
    value: 'kmeans',
    label: 'k-means 限色',
    title: '从图片现场聚出 N 个代表色当调色板。适合「不知道用什么板，先看看这张图本来长什么样」',
  },
];

export const DISTANCE_OPTIONS: readonly SegmentOption<DistanceMode>[] = [
  { value: 'weighted', label: '加权 RGB', title: '2Δr²+4Δg²+3Δb²，便宜的感知近似。实时预览默认' },
  { value: 'lab', label: 'CIELAB', title: '转 CIELAB 算 ΔE。最准，暗部与肤色判断明显更好' },
  { value: 'rgb', label: '欧氏 RGB', title: '最快，但对暗部与肤色偏差较大' },
];

export const DITHER_OPTIONS: readonly SegmentOption<DitherMode>[] = [
  { value: 'atkinson', label: 'Atkinson', title: '只扩散 6/8 误差。对比度高、伪影少，像素画首选' },
  { value: 'floyd', label: 'Floyd', title: 'Floyd–Steinberg。细节最好，但有「虫形」伪影' },
  { value: 'sierra', label: 'Sierra', title: '介于 Floyd 与 Atkinson 之间' },
  { value: 'bayer4', label: 'Bayer 4', title: '有序抖动。图案规则，可无缝平铺，适合做贴图' },
  { value: 'bayer2', label: 'Bayer 2', title: '2×2 有序抖动，颗粒最粗' },
  { value: 'bayer8', label: 'Bayer 8', title: '8×8 有序抖动，颗粒最细' },
  { value: 'none', label: '不抖动', title: '直接映射到最近色，硬边、色带明显' },
];