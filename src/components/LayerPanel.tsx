/**
 * 编辑面板（M2）：工具参数、撤销历史、双层模型的状态与操作。
 *
 * 名字沿用 ROADMAP 里的 LayerPanel —— 它的核心职责就是让「底层 / 编辑层」
 * 这个双层模型在界面上可见、可干预，而不是把手工修改藏成一个看不见的状态。
 */

import type { JSX } from 'react';

import { TOOLS } from '@/core/tools';
import type { SymmetryMode } from '@/core/types';
import { useApp } from '@/state/store';
import { Field, Segmented, Slider, Toggle } from './controls';
import { Row } from './Section';

const BRUSH_OPTIONS = [
  { value: '1', label: '1' },
  { value: '2', label: '2' },
  { value: '3', label: '3' },
  { value: '4', label: '4' },
] as const;

const SYMMETRY_OPTIONS: readonly { value: SymmetryMode; label: string; title: string }[] = [
  { value: 'none', label: '关', title: '不镜像' },
  { value: 'x', label: '左右', title: '沿竖直中轴左右镜像（画角色正面最常用）' },
  { value: 'y', label: '上下', title: '沿水平中轴上下镜像' },
  { value: 'xy', label: '四向', title: '上下左右同时镜像，落笔即四向同步' },
];

export function LayerPanel(): JSX.Element {
  const tool = useApp((s) => s.tool);
  const brushSize = useApp((s) => s.brushSize);
  const setBrushSize = useApp((s) => s.setBrushSize);
  const symmetry = useApp((s) => s.symmetry);
  const setSymmetry = useApp((s) => s.setSymmetry);
  const shapeFill = useApp((s) => s.shapeFill);
  const setShapeFill = useApp((s) => s.setShapeFill);

  const editedCount = useApp((s) => s.editedCount);
  const history = useApp((s) => s.history);
  const undo = useApp((s) => s.undo);
  const redo = useApp((s) => s.redo);
  const clearEditLayer = useApp((s) => s.clearEditLayer);
  const hasGrid = useApp((s) => s.baseGrid !== null);

  const overlaySource = useApp((s) => s.overlaySource);
  const overlayOpacity = useApp((s) => s.overlayOpacity);
  const setOverlaySource = useApp((s) => s.setOverlaySource);
  const setOverlayOpacity = useApp((s) => s.setOverlayOpacity);
  const compareMode = useApp((s) => s.compareMode);
  const setCompareMode = useApp((s) => s.setCompareMode);

  const info = TOOLS[tool];
  const isShape = info.kind === 'shape';
  const canUndo = history.cursor > 0;
  const canRedo = history.cursor < history.entries.length;

  return (
    <div className="section__body">
      <Row k="当前工具" v={`${info.label}（${info.key}）`} />
      <p className="note">{info.hint}</p>

      <Segmented
        label="笔刷尺寸"
        value={String(brushSize)}
        options={BRUSH_OPTIONS}
        disabled={tool === 'bucket' || tool === 'eyedropper' || tool === 'select'}
        onChange={(v) => setBrushSize(Number(v))}
      />
      <Segmented
        label="对称镜像"
        value={symmetry}
        options={SYMMETRY_OPTIONS}
        columns={4}
        onChange={setSymmetry}
      />
      {isShape && (
        <Toggle
          label="填充形状"
          value={shapeFill}
          title="关闭时只画轮廓，打开时画实心"
          onChange={setShapeFill}
        />
      )}

      <div className="chips chips--actions">
        <button
          type="button"
          className="chip"
          disabled={!canUndo}
          title="Ctrl+Z"
          onClick={undo}
        >
          ↶ 撤销
        </button>
        <button
          type="button"
          className="chip"
          disabled={!canRedo}
          title="Ctrl+Shift+Z"
          onClick={redo}
        >
          ↷ 重做
        </button>
      </div>

      <Row k="手改格数" v={`${editedCount} 格`} />
      <Row k="可撤销步数" v={`${history.cursor} / ${history.entries.length}`} muted />

      <Field label="编辑层">
        <button
          type="button"
          className="btn btn--block"
          disabled={editedCount === 0}
          title="只清掉手工修改，转换出来的底层不动；这一步本身可以撤销"
          onClick={clearEditLayer}
        >
          清空手工修改{editedCount > 0 ? `（${editedCount} 格）` : ''}
        </button>
      </Field>

      <Toggle
        label="叠加原图对照"
        value={overlaySource}
        disabled={!hasGrid}
        title="把原图半透明压在手改结果上，描线时好对位置。仅在「仅结果」视图生效"
        onChange={setOverlaySource}
      />
      {overlaySource && (
        <Slider
          label="叠加不透明度"
          value={Math.round(overlayOpacity * 100)}
          min={5}
          max={95}
          format={(v) => `${v}%`}
          onChange={(v) => setOverlayOpacity(v / 100)}
        />
      )}

      {hasGrid && compareMode !== 'result' && (
        <p className="note note--warn">
          当前是
          {compareMode === 'split' ? '「侧滑分割」' : compareMode === 'sideBySide' ? '「并排」' : '「仅原图」'}
          视图。分割视图可在右半侧落笔，并排与仅原图不响应绘制。
          <button type="button" className="linkbtn" onClick={() => setCompareMode('result')}>
            切到仅结果
          </button>
        </p>
      )}

      {!hasGrid && (
        <p className="note">还没有像素图：先在「转换」里生成结果，工具才落得下笔。</p>
      )}

      <p className="note">
        手工修改存在独立的编辑层里，<b>调整转换参数不会覆盖它</b>；
        只有网格尺寸变化时才按比例重采样（这一步可以撤销）。
      </p>
    </div>
  );
}