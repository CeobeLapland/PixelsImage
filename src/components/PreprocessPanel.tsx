import type { JSX } from 'react';

import { isPreprocessIdentity } from '@/core/preprocess';
import { useApp } from '@/state/store';
import { Segmented, Slider, Toggle } from './controls';
import { Row } from './Section';

/** 去背景的模式。默认「只去与边缘连通」是刻意的，见下面注释 */
const BG_MODE_OPTIONS = [
  {
    value: 'none',
    label: '关闭',
    title: '不做按颜色去背景',
  },
  {
    value: 'edges',
    label: '只去边缘',
    title:
      '只擦掉与画面边缘连通的部分。主体内部同色的区域（高光、白衣服、水印字）不会被误杀 —— 默认用它',
  },
  {
    value: 'all',
    label: '全部近色',
    title: '所有接近底色的像素都擦掉，包括主体内部的。主体里确实没有同色区域时才用',
  },
] as const;

/** 底色快捷项。绿幕实拍很少是纯 #00ff00，所以这只是起点，取色器可以改 */
const BG_PRESETS = [
  { value: '#ffffff', label: '白', title: '最常见：素材图、扫描件、AI 生成图' },
  { value: '#00ff00', label: '绿', title: '绿幕。按你片子的实际绿色选，纯绿在实拍里很少见' },
  { value: '#000000', label: '黑', title: '黑底素材（夜景、产品图）' },
] as const;

/**
 * 预处理面板：在降采样**之前**作用于源图。
 *
 * 这一组参数长期「有实现、没界面」，直到 M4 才补上。M7 之后这里有两套去背手段，
 * 用途完全不同，面板上必须讲清楚：
 * - **按颜色去背景**：给白底/绿幕这类「背景是实色」的图用（照片、AI 生成图多半是这种）
 * - **透明阈值**：给**已经有透明通道**的图用（抠好的 PNG），它看的是 alpha，对实色底无效
 */
export function PreprocessPanel(): JSX.Element {
  const preprocess = useApp((s) => s.settings.preprocess);
  const patchPreprocess = useApp((s) => s.patchPreprocess);
  const resetSettings = useApp((s) => s.resetSettings);
  const pushToast = useApp((s) => s.pushToast);

  const active = !isPreprocessIdentity(preprocess);
  const removing = preprocess.removeBackground !== 'none';

  return (
    <div className="section__body">
      {/* ---------------- 按颜色去背景（M7 新增） ---------------- */}
      <Segmented
        label="去除背景色"
        value={preprocess.removeBackground}
        options={BG_MODE_OPTIONS}
        columns={3}
        onChange={(v) => patchPreprocess({ removeBackground: v })}
      />
      {removing && (
        <>
          <div className="field">
            <div className="field__head">
              <span className="field__label">背景色</span>
              <span className="field__hint">{preprocess.bgColor}</span>
            </div>
            <div className="bgpick">
              <input
                className="bgpick__swatch"
                type="color"
                value={preprocess.bgColor}
                title="要判定为背景的颜色。白底、绿幕、蓝幕都选在这里"
                onChange={(event) => patchPreprocess({ bgColor: event.target.value })}
              />
              <div className="chips">
                {BG_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    type="button"
                    className="chip"
                    aria-pressed={preprocess.bgColor.toLowerCase() === preset.value}
                    title={preset.title}
                    onClick={() => patchPreprocess({ bgColor: preset.value })}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <Slider
            label="容差"
            value={preprocess.bgTolerance}
            min={0}
            max={96}
            format={(v) => `${v}（每通道差 ≤ ${v} 算背景）`}
            onChange={(v) => patchPreprocess({ bgTolerance: v })}
          />
          <Toggle
            label="边缘软化"
            value={preprocess.bgSoftEdge}
            title="紧贴背景的一圈过渡色按「离底色多远」给半透明。关掉的话边缘会留下一圈硬边，降到像素尺寸后更明显"
            onChange={(v) => patchPreprocess({ bgSoftEdge: v })}
          />
          <p className="note note--tight">
            <b>只去边缘</b>是从画面四条边开始泛洪：只有和边缘连通的近底色区域才会被擦掉。
            所以主体内部的同色区域（眼睛高光、白字、白衣服）是安全的；
            但主体与边缘之间若有一段同色通路连着，那部分也会被去掉。
            容差调得越大越激进，<b>别超过主体里最接近底色的那个颜色</b>。
          </p>
          {preprocess.bgSoftEdge && !preprocess.decontaminate && (
            <p className="note note--warn note--tight">
              软化的边缘像素只拿到了透明度，颜色里还混着背景色。
              把下面的<b>边缘色晕清理</b>一起打开，它们才会被染成主体色。
            </p>
          )}
        </>
      )}

      {/* ---------------- 颜色调整 ---------------- */}
      <Slider
        label="亮度"
        value={preprocess.brightness}
        min={-100}
        max={100}
        onChange={(v) => patchPreprocess({ brightness: v })}
      />
      <Slider
        label="对比度"
        value={preprocess.contrast}
        min={-100}
        max={100}
        onChange={(v) => patchPreprocess({ contrast: v })}
      />
      <Slider
        label="饱和度"
        value={preprocess.saturation}
        min={-100}
        max={100}
        onChange={(v) => patchPreprocess({ saturation: v })}
      />
      <Slider
        label="锐化"
        value={preprocess.sharpen}
        min={0}
        max={100}
        onChange={(v) => patchPreprocess({ sharpen: v })}
      />

      {/* ---------------- 透明通道去背（老路子） ---------------- */}
      <Slider
        label="透明阈值（按 alpha 去背）"
        value={preprocess.alphaThreshold}
        min={0}
        max={255}
        format={(v) => (v >= 255 ? '不处理' : `α < ${v} 判为背景`)}
        onChange={(v) => patchPreprocess({ alphaThreshold: v })}
      />
      <Toggle
        label="边缘色晕清理"
        value={preprocess.decontaminate}
        title="把半透明边缘的 RGB 换成相邻主体色，消除抠图残留的背景色（绿幕边、白底灰边）"
        onChange={(v) => patchPreprocess({ decontaminate: v })}
      />

      {preprocess.alphaThreshold < 255 && !preprocess.decontaminate && (
        <p className="note note--warn note--tight">
          只设了透明阈值、没开色晕清理时，边缘常会留下一圈背景色的脏边
          （半透明像素的 RGB 里还混着背景色）。建议把上面的开关一起打开。
        </p>
      )}
      <p className="note note--tight">
        <b>透明阈值</b>看的是 alpha，只对<b>本来就有透明通道</b>的图有效（抠好的 PNG）。
        白底照片每格 alpha 都是 255，调它是没反应的 —— 那种情况用上面的<b>去除背景色</b>。
      </p>

      <Row k="处理生效" v={active ? '是' : '全部中性值'} muted />

      <button
        type="button"
        className="btn btn--block"
        disabled={!active}
        title="把所有转换与预处理参数恢复为默认值（不影响手工修改）"
        onClick={() => {
          resetSettings();
          pushToast('info', '转换与预处理参数已恢复默认');
        }}
      >
        参数恢复默认
      </button>

      <p className="note">
        预处理在<b>降采样之前</b>执行，顺序是：去背景色 → 调色 → 锐化 → alpha 阈值 → 色晕清理。
        去背景排在最前，是因为它按<b>原图颜色</b>判定，与你眼里的白底一致
        （先调亮度的话，白底变灰就判不出来了）。
      </p>
    </div>
  );
}