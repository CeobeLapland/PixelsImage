import type { JSX } from 'react';

import { isPreprocessIdentity } from '@/core/preprocess';
import { useApp } from '@/state/store';
import { Slider, Toggle } from './controls';
import { Row } from './Section';

/**
 * 预处理面板：在降采样**之前**作用于源图。
 *
 * 这一组参数长期「有实现、没界面」，直到 M4 才补上 —— 而它恰好是去背的唯一途径：
 * α 阈值负责判「哪些像素算背景」，色晕清理负责把边缘那圈残留的背景色擦干净。
 * 两者一起用才是完整的一键去背（只用阈值会留下灰边）。
 */
export function PreprocessPanel(): JSX.Element {
  const preprocess = useApp((s) => s.settings.preprocess);
  const patchPreprocess = useApp((s) => s.patchPreprocess);
  const resetSettings = useApp((s) => s.resetSettings);
  const pushToast = useApp((s) => s.pushToast);

  const active = !isPreprocessIdentity(preprocess);

  return (
    <div className="section__body">
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

      <Slider
        label="透明阈值（去背）"
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
        <p className="note note--warn">
          只设了透明阈值、没开色晕清理时，边缘常会留下一圈背景色的脏边
          （半透明像素的 RGB 里还混着背景色）。建议把上面的开关一起打开。
        </p>
      )}

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
        预处理在<b>降采样之前</b>执行：锐化必须先做，否则边缘已经糊掉了；
        去背要放在最后，否则调色时会把背景色也算进去。
        所有调整都会立刻重算，不需要重新导入图片。
      </p>
    </div>
  );
}