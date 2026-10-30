import { useEffect, useMemo, useRef, useState, type DragEvent, type JSX } from 'react';

import { buildBatchNames, unknownTokens } from '@/core/batch/naming';
import { summarize, type BatchItem } from '@/core/batch/queue';
import { gridToImageData } from '@/core/composite';
import { ACCEPTED_TYPES, formatBytes } from '@/core/image';
import type { Palette } from '@/core/types';
import { BUILTIN_PALETTES } from '@/palettes/builtin';
import { useApp } from '@/state/store';
import { Field, NumberField, Segmented, TextField, Toggle } from './controls';
import { DITHER_OPTIONS, SAMPLING_OPTIONS, SIZE_PRESETS } from './convertOptions';
import { Row } from './Section';

/* --------------------------------------------------------------- 缩略图 */

/** 有结果就画结果（你真正想看的），否则画原图缩略图，都没有就留占位 */
function BatchThumb({ item }: { item: BatchItem }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const grid = item.result?.grid ?? null;
  const palette = item.result?.palette ?? null;
  const thumb = item.thumb ?? null;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (grid && palette) {
      const data = gridToImageData(grid, palette);
      canvas.width = data.width;
      canvas.height = data.height;
      ctx.putImageData(data, 0, 0);
      return;
    }

    if (!thumb) return;
    canvas.width = thumb.width;
    canvas.height = thumb.height;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(thumb, 0, 0);
  }, [grid, palette, thumb]);

  if (!grid && !thumb) {
    return (
      <span className="batch__thumb batch__thumb--empty">
        {item.fileName.slice(-3).toUpperCase()}
      </span>
    );
  }
  return (
    <span className="batch__thumb">
      <canvas ref={canvasRef} />
    </span>
  );
}

/* ------------------------------------------------------------------ 状态 */

const STATUS_LABEL: Record<BatchItem['status'], string> = {
  pending: '待处理',
  converting: '转换中',
  done: '完成',
  error: '失败',
};

/**
 * 裸滑块。
 *
 * 刻意不用控件库的 `Slider`：那个会在拖动期间置位 store 的 `interacting`，
 * 那是给「拖动时要看到实时预览」的转换参数用的 —— 而批量参数改了并不需要
 * 重算编辑器里那张图，用它只会平白触发一轮快速模式重算（同 DESIGN 决策 32）。
 */
function BareSlider({
  label,
  value,
  min,
  max,
  format,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  format?: (v: number) => string;
  disabled?: boolean;
  onChange: (v: number) => void;
}): JSX.Element {
  return (
    <Field label={label} hint={format ? format(value) : String(value)}>
      <input
        className="slider"
        type="range"
        min={min}
        max={max}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </Field>
  );
}

/* ------------------------------------------------------------------ 面板 */

export function BatchPanel(): JSX.Element {
  const items = useApp((s) => s.batchItems);
  const batchSettings = useApp((s) => s.batchSettings);
  const template = useApp((s) => s.batchTemplate);
  const scale = useApp((s) => s.batchScale);
  const opaque = useApp((s) => s.batchOpaque);
  const running = useApp((s) => s.batchRunning);
  const fingerprint = useApp((s) => s.batchRunFingerprint);
  const activeId = useApp((s) => s.batchActiveId);
  const presets = useApp((s) => s.batchPresets);
  const customPalettes = useApp((s) => s.customPalettes);
  const editedCount = useApp((s) => s.editedCount);

  const addBatchFiles = useApp((s) => s.addBatchFiles);
  const removeBatchItem = useApp((s) => s.removeBatchItem);
  const clearBatch = useApp((s) => s.clearBatch);
  const patchBatchItem = useApp((s) => s.patchBatchItem);
  const clearBatchOverride = useApp((s) => s.clearBatchOverride);
  const patchBatchSettings = useApp((s) => s.patchBatchSettings);
  const setBatchTemplate = useApp((s) => s.setBatchTemplate);
  const setBatchScale = useApp((s) => s.setBatchScale);
  const setBatchOpaque = useApp((s) => s.setBatchOpaque);
  const syncBatchSettings = useApp((s) => s.syncBatchSettings);
  const setCompareOpen = useApp((s) => s.setCompareOpen);
  const runBatch = useApp((s) => s.runBatch);
  const stopBatch = useApp((s) => s.stopBatch);
  const resetBatchResults = useApp((s) => s.resetBatchResults);
  const editBatchItem = useApp((s) => s.editBatchItem);
  const commitEditorToBatch = useApp((s) => s.commitEditorToBatch);
  const exportBatchZip = useApp((s) => s.exportBatchZip);
  const saveBatchPreset = useApp((s) => s.saveBatchPreset);
  const applyBatchPreset = useApp((s) => s.applyBatchPreset);
  const removeBatchPreset = useApp((s) => s.removeBatchPreset);

  const inputRef = useRef<HTMLInputElement>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [presetName, setPresetName] = useState('');
  const [hot, setHot] = useState(false);

  const stats = useMemo(() => summarize(items), [items]);
  const doneItems = useMemo(
    () => items.filter((i) => i.status === 'done' && i.result),
    [items],
  );
  const stale = fingerprint !== null && fingerprint !== JSON.stringify(batchSettings);

  const paletteOptions = useMemo(
    () => [
      ...BUILTIN_PALETTES.map((p) => ({ value: p.id, label: p.name, title: `${p.colors.length} 色` })),
      ...Object.values(customPalettes)
        .filter((p): p is Palette => Boolean(p))
        .map((p) => ({ value: p.id, label: p.name, title: `自定义 · ${p.colors.length} 色` })),
    ],
    [customPalettes],
  );

  /** 预览最终会写进 zip 的文件名，冲突已经在这里去掉了 */
  const previewNames = useMemo(() => {
    if (doneItems.length === 0) return [];
    return buildBatchNames(
      template,
      doneItems.map((i) => ({
        name: i.fileName,
        w: i.result?.grid.w ?? 0,
        h: i.result?.grid.h ?? 0,
      })),
      scale,
    );
  }, [doneItems, template, scale]);

  const badTokens = unknownTokens(template);

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setHot(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length > 0) addBatchFiles(files);
  };

  const keepRatio = batchSettings.targetH === 'auto';

  return (
    <div className="section__body">
      {/* ------------------------------ 队列 ------------------------------ */}
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED_TYPES}
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length > 0) addBatchFiles(files);
          event.target.value = '';
        }}
      />

      <div
        className="batch__drop"
        data-hot={hot ? 'true' : undefined}
        onDragOver={(event) => {
          event.preventDefault();
          setHot(true);
        }}
        onDragLeave={() => setHot(false)}
        onDrop={onDrop}
      >
        <button type="button" className="btn btn--block" onClick={() => inputRef.current?.click()}>
          添加图片（可多选）
        </button>
        <p className="note note--tight">
          也可以把一批文件直接拖到这里。队列项共用下方这套参数，个别项可以单独改尺寸。
          <br />
          拖进 <b>GIF / WebP 动图</b>会自动拆成逐帧入队（需要 Chrome / Edge）——队列顺序就是动画帧顺序，
          导出里选「GIF 动画」或「Aseprite 动画」就能按这个顺序出片。
        </p>
      </div>

      {items.length > 0 && (
        <>
          <ul className="batch__list">
            {items.map((item) => {
              const open = expandedId === item.id;
              const overrideW = item.override?.targetW;
              return (
                <li
                  key={item.id}
                  className="batch__item"
                  data-status={item.status}
                  data-active={activeId === item.id ? 'true' : undefined}
                >
                  <button
                    type="button"
                    className="batch__row"
                    aria-expanded={open}
                    onClick={() => setExpandedId(open ? null : item.id)}
                  >
                    <BatchThumb item={item} />
                    <span className="batch__meta">
                      <span className="batch__name" title={item.fileName}>
                        {item.fileName}
                      </span>
                      <span className="batch__sub">
                        {item.result
                          ? `${item.result.grid.w}×${item.result.grid.h} · ${item.result.usedColors} 色`
                          : formatBytes(item.size)}
                        {overrideW !== undefined && ' · 独立尺寸'}
                      </span>
                    </span>
                    <span className="batch__status">{STATUS_LABEL[item.status]}</span>
                  </button>

                  {item.error && <p className="note note--warn note--tight">{item.error}</p>}

                  {open && (
                    <div className="batch__detail">
                      <Toggle
                        label="独立目标格数"
                        value={overrideW !== undefined}
                        title="这一项单独用别的目标宽度，其余项仍用批量参数"
                        onChange={(on) => {
                          if (on) {
                            patchBatchItem(item.id, { targetW: batchSettings.targetW, targetH: 'auto' });
                          } else {
                            clearBatchOverride(item.id);
                          }
                        }}
                      />
                      {overrideW !== undefined && (
                        <NumberField
                          label="目标格数（宽）"
                          value={overrideW}
                          min={4}
                          max={256}
                          onChange={(v) => patchBatchItem(item.id, { targetW: v })}
                        />
                      )}

                      {activeId === item.id && (
                        <>
                          <button
                            type="button"
                            className="btn btn--primary btn--block"
                            title="把编辑器里当前这张图（含手工修改）写回队列，导出 zip 时用这一份"
                            onClick={() => commitEditorToBatch(item.id)}
                          >
                            {editedCount > 0
                              ? `写回队列（含 ${editedCount} 格手改）`
                              : '把当前结果写回队列'}
                          </button>
                          <p className="note note--tight">
                            这一项正在编辑器里。<b>手改住在编辑层里</b>，
                            不点上面的按钮写回，导出 zip 拿到的仍是未经手改的转换结果。
                          </p>
                        </>
                      )}

                      <div className="chips--actions">
                        <button
                          type="button"
                          className="chip"
                          title="把这张图的源图与参数送进主编辑器，逐格手改后再回来"
                          onClick={() => void editBatchItem(item.id)}
                        >
                          在编辑器中打开
                        </button>
                        <button
                          type="button"
                          className="chip"
                          onClick={() => {
                            setExpandedId(null);
                            removeBatchItem(item.id);
                          }}
                        >
                          移出队列
                        </button>
                      </div>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>

          <div className="chips--actions">
            <button
              type="button"
              className="chip"
              disabled={doneItems.length === 0}
              title="把已完成的图摊开成一张一张并排看，方便挑哪张出得好"
              onClick={() => setCompareOpen(true)}
            >
              并排对比（{doneItems.length}）
            </button>
            <button
              type="button"
              className="chip"
              disabled={running || stats.done + stats.error === 0}
              title="已完成的项退回待处理，用于改完参数重跑"
              onClick={resetBatchResults}
            >
              重置结果
            </button>
            <button
              type="button"
              className="chip"
              disabled={running}
              onClick={clearBatch}
            >
              清空队列
            </button>
          </div>

          <Row
            k="队列"
            v={`共 ${stats.total} · 完成 ${stats.done} · 失败 ${stats.error}${
              stats.pending > 0 ? ` · 待处理 ${stats.pending}` : ''
            }`}
          />
          {running && <Row k="进度" v={`${stats.done + stats.error} / ${stats.total}`} />}
          {stale && (
            <p className="note note--warn">
              批量参数在上次转换之后改过，队列里的结果仍是旧参数跑出来的。
              想统一重跑请点「重置结果」再开始。
            </p>
          )}

          {running ? (
            <button type="button" className="btn btn--block" onClick={stopBatch}>
              停止转换
            </button>
          ) : (
            <button
              type="button"
              className="btn btn--primary btn--block"
              disabled={stats.pending === 0}
              onClick={() => void runBatch()}
            >
              {stats.pending === 0 ? '全部已处理' : `开始转换（${stats.pending} 张待处理）`}
            </button>
          )}
        </>
      )}

      {/* ------------------------------ 参数 ------------------------------ */}
      <div className="batch__group">
        <h3 className="batch__groupTitle">
          批量参数
          <button
            type="button"
            className="linkbtn"
            title="把「转换」面板里当前这套参数抄过来（含距离度量、预处理等本面板没展开的项）"
            onClick={syncBatchSettings}
          >
            从当前参数同步
          </button>
        </h3>

        <BareSlider
          label="目标格数（宽）"
          value={batchSettings.targetW}
          min={4}
          max={256}
          onChange={(v) => patchBatchSettings({ targetW: v })}
        />
        <div className="chips">
          {SIZE_PRESETS.map((size) => (
            <button
              key={size}
              type="button"
              className="chip"
              aria-pressed={batchSettings.targetW === size}
              onClick={() => patchBatchSettings({ targetW: size })}
            >
              {size}
            </button>
          ))}
        </div>
        <Toggle
          label="保持原图宽高比"
          value={keepRatio}
          title="关闭后所有图都用固定的高度格数，宽高比不同的图会被拉伸"
          onChange={(on) =>
            patchBatchSettings(on ? { targetH: 'auto' } : { targetH: batchSettings.targetW })
          }
        />

        {batchSettings.quantize === 'palette' ? (
          <div className="field">
            <div className="field__head">
              <span className="field__label">调色板</span>
            </div>
            <select
              className="select"
              value={batchSettings.paletteId}
              onChange={(event) => patchBatchSettings({ paletteId: event.target.value })}
            >
              {paletteOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <Row k="调色板" v="k-means 现场生成" />
        )}

        <Segmented
          label="采样方式"
          value={batchSettings.sampling}
          options={SAMPLING_OPTIONS}
          columns={2}
          onChange={(v) => patchBatchSettings({ sampling: v })}
        />
        <Segmented
          label="抖动算法"
          value={batchSettings.dither}
          options={DITHER_OPTIONS}
          columns={2}
          onChange={(v) => patchBatchSettings({ dither: v })}
        />
        <BareSlider
          label="抖动强度"
          value={Math.round(batchSettings.ditherStrength * 100)}
          min={0}
          max={100}
          format={(v) => `${v}%`}
          disabled={batchSettings.dither === 'none'}
          onChange={(v) => patchBatchSettings({ ditherStrength: v / 100 })}
        />
        <Toggle
          label="裁掉四周透明边"
          value={batchSettings.trimTransparent}
          title="每张图各自裁掉自己的透明外圈，输出尺寸会不一样"
          onChange={(v) => patchBatchSettings({ trimTransparent: v })}
        />
        <p className="note note--tight">
          颜色距离、预处理（亮度/去背等）、限色模式这些没在本面板展开的项，
          沿用<b>同步过来的那一份</b>。要改就在「转换」面板调好，再点一次同步。
        </p>
      </div>

      {/* ------------------------------ 导出 ------------------------------ */}
      <div className="batch__group">
        <h3 className="batch__groupTitle">命名与打包</h3>
        <TextField
          label="命名模板"
          value={template}
          placeholder="{name}_{w}x{h}.png"
          onCommit={setBatchTemplate}
        />
        <div className="chips">
          {['{name}', '{w}', '{h}', '{scale}', '{index}'].map((token) => (
            <button
              key={token}
              type="button"
              className="chip"
              title={`插入 ${token}`}
              onClick={() => setBatchTemplate(`${template}${token}`)}
            >
              {token}
            </button>
          ))}
        </div>
        {badTokens.length > 0 && (
          <p className="note note--warn">
            模板里的 {badTokens.map((t) => `{${t}}`).join('、')} 不是已知占位符，会原样写进文件名。
            可用的是：{'{name}'}（源文件名）、{'{w}'}/{'{h}'}（网格尺寸）、{'{scale}'}、{'{index}'}。
          </p>
        )}
        {previewNames.length > 0 && (
          <p className="note note--tight">
            例如：<b>{previewNames[0]}</b>
            {previewNames.length > 1 ? ` ……（共 ${previewNames.length} 个文件）` : ''}
          </p>
        )}

        <NumberField label="放大倍数" value={scale} min={1} max={64} onChange={setBatchScale} />
        <div className="chips">
          {[1, 2, 4, 8].map((k) => (
            <button
              key={k}
              type="button"
              className="chip"
              aria-pressed={scale === k}
              onClick={() => setBatchScale(k)}
            >
              {k}×
            </button>
          ))}
        </div>
        <Toggle
          label="透明区填白底"
          value={opaque}
          title="GIF 或某些编辑器不认 alpha 时可打开"
          onChange={setBatchOpaque}
        />

        <button
          type="button"
          className="btn btn--primary btn--block"
          disabled={doneItems.length === 0}
          title="打包已完成的 PNG + 调色板 .hex + report.txt"
          onClick={() => void exportBatchZip()}
        >
          {doneItems.length === 0
            ? '还没有可导出的图'
            : `导出 zip（${doneItems.length} 张）`}
        </button>
        <p className="note note--tight">
          包里是每张图的 PNG、用到的调色板 <b>.hex</b>，以及一份 <b>report.txt</b>
          （逐张尺寸/用色/耗时）。PNG 本身已是压缩数据，所以 zip 只做存储不做二次压缩。
        </p>
      </div>

      {/* ------------------------------ 预设 ------------------------------ */}
      <div className="batch__group">
        <h3 className="batch__groupTitle">批处理预设</h3>
        <div className="batch__presetRow">
          <input
            className="textfield__input"
            type="text"
            placeholder="给这套参数起个名字"
            value={presetName}
            onChange={(event) => setPresetName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              saveBatchPreset(presetName);
              setPresetName('');
            }}
          />
          <button
            type="button"
            className="btn"
            disabled={presetName.trim() === ''}
            onClick={() => {
              saveBatchPreset(presetName);
              setPresetName('');
            }}
          >
            保存
          </button>
        </div>
        {presets.length === 0 ? (
          <p className="note note--tight">
            预设会把「参数 + 命名模板 + 放大倍数 + 白底」一起存下来，下次一键套用。
          </p>
        ) : (
          <ul className="batch__presets">
            {presets.map((preset) => (
              <li key={preset.id}>
                <button
                  type="button"
                  className="batch__presetApply"
                  title="套用这套参数"
                  onClick={() => applyBatchPreset(preset.id)}
                >
                  {preset.name}
                </button>
                <button
                  type="button"
                  className="batch__presetDel"
                  title="删除该预设"
                  onClick={() => removeBatchPreset(preset.id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {presets.length > 0 && (
          <p className="note note--tight">
            套用预设只改批量参数与导出设置，<b>不会动队列</b>；套用后记得重置结果再重跑。
          </p>
        )}
      </div>
    </div>
  );
}