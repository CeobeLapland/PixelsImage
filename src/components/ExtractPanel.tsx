import { useState, type JSX } from 'react';

import { toHex } from '@/core/color/space';
import type { RGBA } from '@/core/types';
import { extractPalette, type ExtractMethod } from '@/palettes/extract';
import { useApp } from '@/state/store';
import { Field, NumberField, Segmented, Toggle } from './controls';
import { Row } from './Section';

const METHOD_OPTIONS: readonly { value: ExtractMethod; label: string; title: string }[] = [
  {
    value: 'medianCut',
    label: '中位切分',
    title: '按最宽通道反复从中位数切开。快、无需迭代，取色更「散得开」，做调色板首选',
  },
  {
    value: 'kmeans',
    label: 'k-means',
    title: '聚类中心更贴近视觉重心，适合「要最能代表这张图的 N 个色」',
  },
];

/**
 * 从图片提取主色。
 *
 * 这是「让颜色完全受我控制」里最实用的一环：把参考图/插画的主色直接变成一块
 * 可用的调色板，再套到别的图上（M3 验收流程的第一步）。
 *
 * 提色默认从**源图**取色而不是转换结果：要的是原图的色彩信息，
 * 拿一张已经被量化过的像素图再提色，只会得到它自己的那几种色。
 */
export function ExtractPanel(): JSX.Element {
  const source = useApp((s) => s.source);
  const addCustomPalette = useApp((s) => s.addCustomPalette);
  const pushToast = useApp((s) => s.pushToast);

  const [count, setCount] = useState(12);
  const [method, setMethod] = useState<ExtractMethod>('medianCut');
  const [excludeTransparent, setExcludeTransparent] = useState(true);
  const [useLuminanceRange, setUseLuminanceRange] = useState(false);
  const [lumRange, setLumRange] = useState<[number, number]>([0.15, 0.95]);
  const [preview, setPreview] = useState<RGBA[] | null>(null);

  const run = () => {
    if (!source) return;
    const colors = extractPalette(source.imageData, {
      count,
      method,
      alphaThreshold: excludeTransparent ? 8 : 0,
      luminanceRange: useLuminanceRange ? lumRange : [0, 1],
    });
    if (colors.length === 0) {
      pushToast('warn', '没提取到颜色：试试关掉明度区间过滤，或放宽透明阈值');
      return;
    }
    setPreview(colors);
  };

  const save = () => {
    if (!preview || preview.length === 0) return;
    addCustomPalette({
      id: 'extracted',
      name: `提色 ${preview.length} 色${source ? ` · ${source.name.replace(/\.[^.]+$/, '')}` : ''}`,
      colors: preview,
      source: 'extracted',
    });
    setPreview(null);
  };

  return (
    <div className="section__body">
      <NumberField label="颜色数" value={count} min={2} max={64} onChange={setCount} />
      <Segmented
        label="提取方法"
        value={method}
        options={METHOD_OPTIONS}
        columns={2}
        onChange={setMethod}
      />
      <Toggle
        label="排除透明像素"
        value={excludeTransparent}
        title="打开后 alpha ≤ 8 的像素不参与统计，避免把抠图留下的半透明边缘也算成颜色"
        onChange={setExcludeTransparent}
      />
      <Toggle
        label="限定明度区间"
        value={useLuminanceRange}
        title="只统计这个亮度范围内的像素。想避开纯黑背景或过曝高光时很有用"
        onChange={setUseLuminanceRange}
      />
      {useLuminanceRange && (
        <Field label="明度区间" hint={`${Math.round(lumRange[0] * 100)}% – ${Math.round(lumRange[1] * 100)}%`}>
          <div className="dualrange">
            <input
              className="slider"
              type="range"
              min={0}
              max={100}
              value={Math.round(lumRange[0] * 100)}
              onChange={(event) =>
                setLumRange([Math.min(Number(event.target.value) / 100, lumRange[1]), lumRange[1]])
              }
            />
            <input
              className="slider"
              type="range"
              min={0}
              max={100}
              value={Math.round(lumRange[1] * 100)}
              onChange={(event) =>
                setLumRange([lumRange[0], Math.max(Number(event.target.value) / 100, lumRange[0])])
              }
            />
          </div>
        </Field>
      )}

      <button
        type="button"
        className="btn btn--primary btn--block"
        disabled={!source}
        onClick={run}
      >
        {preview ? '重新提取' : '从当前图提取主色'}
      </button>

      {!source && <p className="note">先导入一张图片。</p>}

      {preview && (
        <>
          <div className="swatches swatches--preview">
            {preview.map((c, i) => (
              <span
                key={`${i}-${toHex(c[0], c[1], c[2])}`}
                className="swatch swatch--static"
                style={{ background: toHex(c[0], c[1], c[2]) }}
                title={`${toHex(c[0], c[1], c[2]).toUpperCase()}`}
              />
            ))}
          </div>
          <Row k="提取结果" v={`${preview.length} 色`} />
          <button type="button" className="btn btn--block" onClick={save}>
            存为自定义调色板并选用
          </button>
          <p className="note">
            存下来之后可以在「调色板」里选回来，也会记住到下次打开。
            提取结果不会自动改动当前调色板 —— 先看一眼再决定。
          </p>
        </>
      )}
    </div>
  );
}