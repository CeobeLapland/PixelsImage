import type { JSX } from 'react';

import { useApp } from '@/state/store';

export function StatusBar(): JSX.Element {
  const source = useApp((s) => s.source);
  const cursor = useApp((s) => s.cursor);
  const zoom = useApp((s) => s.view.zoom);
  const busy = useApp((s) => s.busy);
  const grid = useApp((s) => s.baseGrid);
  const info = useApp((s) => s.info);
  const converting = useApp((s) => s.converting);

  const original = source ? `${source.originalWidth}×${source.originalHeight}` : '—';
  const working = source ? `${source.imageData.width}×${source.imageData.height}` : '—';
  const cursorText = cursor ? `${cursor.x}, ${cursor.y}` : '—, —';
  const zoomText = zoom >= 1 ? zoom.toFixed(2) : zoom.toFixed(3);

  return (
    <footer className="status">
      <span className="status__item">
        原图 <b>{original}</b>
      </span>
      <span className="status__sep" />
      <span className="status__item">
        源像素 <b>{working}</b>
      </span>
      <span className="status__sep" />
      <span className="status__item status__item--accent">
        光标 <b>{cursorText}</b>
      </span>
      <span className="status__sep" />
      <span className="status__item">
        缩放 <b>{zoomText}×</b>
      </span>

      <span className="status__sep" />
      <span className="status__item">
        网格 <b>{grid ? `${grid.w}×${grid.h}` : '—'}</b>
      </span>
      {info && (
        <>
          <span className="status__sep" />
          <span className="status__item">
            用色 <b>{info.usedColors}</b>
          </span>
          <span className="status__sep" />
          <span className="status__item">
            耗时 <b>{info.ms.toFixed(1)} ms</b>
          </span>
        </>
      )}

      <span className="status__spacer" />

      {(busy || converting) && (
        <>
          <span className="status__item status__item--accent">
            <b>{busy ?? '转换中…'}</b>
          </span>
          <span className="status__sep" />
        </>
      )}
      <span className="status__item">M1 · 转换引擎</span>
    </footer>
  );
}