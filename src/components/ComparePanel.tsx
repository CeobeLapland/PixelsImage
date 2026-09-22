import type { JSX } from 'react';

import { Segmented, Toggle } from './controls';
import { Row } from './Section';
import { useApp, type CompareMode } from '@/state/store';

const MODE_OPTIONS: readonly { value: CompareMode; label: string; title: string }[] = [
  {
    value: 'split',
    label: '侧滑分割',
    title: '同一视图下用分割线左右对照，缩放平移共用 —— 逐像素检查差异用这个',
  },
  {
    value: 'sideBySide',
    label: '并排',
    title: '原图与结果各占一半，整体观感对照用这个。此模式下不响应缩放平移',
  },
  { value: 'result', label: '仅结果', title: '只看像素图。绘图主要在这个视图下进行' },
  { value: 'source', label: '仅原图', title: '只看原图，方便回头确认细节' },
];

export function ComparePanel(): JSX.Element {
  const mode = useApp((s) => s.compareMode);
  const setMode = useApp((s) => s.setCompareMode);
  const splitPos = useApp((s) => s.splitPos);
  const setSplitPos = useApp((s) => s.setSplitPos);
  const showGrid = useApp((s) => s.showGrid);
  const setShowGrid = useApp((s) => s.setShowGrid);
  const hasResult = useApp((s) => s.baseGrid !== null);
  const info = useApp((s) => s.info);

  return (
    <div className="section__body">
      <Segmented
        label="对照方式"
        value={mode}
        options={MODE_OPTIONS}
        columns={2}
        disabled={!hasResult}
        onChange={setMode}
      />

      {mode === 'split' && (
        <div className="field">
          <div className="field__head">
            <span className="field__label">分割位置</span>
            <span className="field__hint">{Math.round(splitPos * 100)}%</span>
          </div>
          <input
            className="slider"
            type="range"
            min={0}
            max={100}
            value={Math.round(splitPos * 100)}
            onChange={(e) => setSplitPos(Number(e.target.value) / 100)}
          />
        </div>
      )}

      <Toggle
        label="网格线"
        value={showGrid}
        title="有转换结果时画格网，没有结果时画源像素网格。格边长小于 4px 会自动隐藏，避免糊成一片"
        onChange={setShowGrid}
      />

      {info && (
        <>
          <Row k="转换耗时" v={`${info.ms.toFixed(1)} ms`} />
          {info.fallback && <Row k="执行位置" v="主线程（降级）" muted />}
        </>
      )}

      {mode === 'split' && (
        <p className="note">
          分割线左边是原图、右边是像素图，两者共用同一套缩放与平移，
          所以对得上位置。<b>拖拽画布上的分割线</b>可以左右扫动对比。
        </p>
      )}
      {mode === 'sideBySide' && (
        <p className="note">
          并排模式各自适配到半屏，不响应缩放平移 —— 用来看整体比例和色感。
          需要看细节请切回侧滑分割。
        </p>
      )}
    </div>
  );
}