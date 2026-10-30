/**
 * 并排对比（M7）：把批量队列里已完成的图一次摊开看。
 *
 * 为什么做成「叠层视图」而不是侧栏里的一行行：
 * 这个功能的用途是**挑图** —— 同一套参数下，20 张参考图哪张出得好。
 * 侧栏一行只有 34px 的缩略图，看不出细节；摊成大图并排才谈得上「对比」。
 *
 * 数据全部来自批量队列，不另开转换路径：队列里已经是「用同一套参数跑出来的结果」，
 * 再算一遍纯属浪费，还会与队列里的结果不一致。
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';

import type { BatchItem } from '@/core/batch/queue';
import { gridToImageData } from '@/core/composite';
import { useApp } from '@/state/store';

/** 单格的画布：结果图 + 可选的原图缩略图对照 */
function CompareCell({
  item,
  showSource,
}: {
  item: BatchItem;
  showSource: boolean;
}): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const result = item.result;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !result) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const data = gridToImageData(result.grid, result.palette);
    canvas.width = data.width;
    canvas.height = data.height;
    ctx.putImageData(data, 0, 0);
  }, [result]);

  return (
    <figure className="cmp__cell">
      {showSource && (
        <div className="cmp__pair">
          <span className="cmp__tag">原图</span>
          <span className="cmp__thumb">
            {item.thumb ? <SourceThumb item={item} /> : <i className="cmp__none">无缩略图</i>}
          </span>
        </div>
      )}
      <div className="cmp__pair">
        {showSource && <span className="cmp__tag">像素</span>}
        <span className="cmp__thumb cmp__thumb--result">
          <canvas ref={canvasRef} />
        </span>
      </div>
      <figcaption className="cmp__meta">
        <span className="cmp__name" title={item.fileName}>
          {item.fileName}
        </span>
        {result && (
          <span className="cmp__sub">
            {result.grid.w}×{result.grid.h} · {result.usedColors} 色
          </span>
        )}
      </figcaption>
    </figure>
  );
}

/** 原图缩略图要单独一个 canvas：ImageBitmap 不能直接塞进 <img> */
function SourceThumb({ item }: { item: BatchItem }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    const bitmap = item.thumb;
    if (!canvas || !bitmap) return;
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0);
  }, [item.thumb]);
  return <canvas ref={canvasRef} />;
}

export function CompareView(): JSX.Element | null {
  const open = useApp((s) => s.compareOpen);
  const setOpen = useApp((s) => s.setCompareOpen);
  const items = useApp((s) => s.batchItems);
  const [showSource, setShowSource] = useState(false);

  const done = useMemo(
    () => items.filter((i) => i.status === 'done' && i.result),
    [items],
  );

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setOpen]);

  if (!open) return null;

  return (
    <div className="cmp" role="dialog" aria-label="并排对比" onClick={() => setOpen(false)}>
      <div className="cmp__panel" onClick={(event) => event.stopPropagation()}>
        <header className="cmp__head">
          <h2>并排对比</h2>
          <span className="cmp__count">{done.length} 张已完成</span>
          <button
            type="button"
            className="chip"
            aria-pressed={showSource}
            title="每张图左边加一列原图缩略图，方便看「转得像不像」"
            onClick={() => setShowSource(!showSource)}
          >
            对照原图
          </button>
          <button
            type="button"
            className="shortcuts__close"
            title="关闭（Esc）"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </header>

        {done.length === 0 ? (
          <p className="note">批量队列里还没有已完成的图。先去「批量处理」跑一轮。</p>
        ) : (
          <div className="cmp__grid">
            {done.map((item) => (
              <CompareCell
                key={item.id}
                item={item}
                showSource={showSource}
              />
            ))}
          </div>
        )}

        <p className="note note--tight">
          每张都按自己那份参数渲染（队列项可能带「独立目标格数」的覆盖）。
          棋盘格底板表示透明区，图本身仍保留 alpha。
        </p>
      </div>
    </div>
  );
}
