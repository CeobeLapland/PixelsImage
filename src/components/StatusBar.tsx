import type { JSX } from 'react';

import { useApp } from '@/state/store';

export function StatusBar(): JSX.Element {
  const source = useApp((s) => s.source);
  const cursor = useApp((s) => s.cursor);
  const zoom = useApp((s) => s.view.zoom);
  const busy = useApp((s) => s.busy);

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

      <span className="status__spacer" />

      {busy && (
        <>
          <span className="status__item status__item--accent">
            <b>{busy}</b>
          </span>
          <span className="status__sep" />
        </>
      )}
      <span className="status__item">M0 · 工程骨架</span>
    </footer>
  );
}