import type { JSX } from 'react';

import { toHex } from '@/core/color/space';
import type { Palette } from '@/core/types';
import { useApp } from '@/state/store';

/** 调色板索引 → hex 文本；越界时返回 null 而不是抛错（状态栏不该崩） */
function hexOfIndex(palette: Palette, index: number): string | null {
  const color = palette.colors[index];
  if (!color) return null;
  return toHex(color[0], color[1], color[2]);
}

export function StatusBar(): JSX.Element {
  const source = useApp((s) => s.source);
  const cursor = useApp((s) => s.cursor);
  const hover = useApp((s) => s.hover);
  const zoom = useApp((s) => s.view.zoom);
  const busy = useApp((s) => s.busy);
  const grid = useApp((s) => s.baseGrid);
  const palette = useApp((s) => s.palette);
  const info = useApp((s) => s.info);
  const converting = useApp((s) => s.converting);
  const tool = useApp((s) => s.tool);
  const brushSize = useApp((s) => s.brushSize);
  const editedCount = useApp((s) => s.editedCount);
  const history = useApp((s) => s.history);

  const original = source ? `${source.originalWidth}×${source.originalHeight}` : '—';
  const working = source ? `${source.imageData.width}×${source.imageData.height}` : '—';
  const cursorText = cursor ? `${cursor.x}, ${cursor.y}` : '—, —';
  const zoomText = zoom >= 1 ? zoom.toFixed(2) : zoom.toFixed(3);

  const hex = hover ? hexOfIndex(palette, hover.index) : null;
  const hexText = hover ? (hover.alpha === 0 ? '透明' : (hex ?? '—')) : '—, —';

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
      <span className="status__item">
        光标 <b>{cursorText}</b>
      </span>

      <span className="status__sep" />
      <span className="status__item status__item--accent">
        格 <b>{hover ? `${hover.x}, ${hover.y}` : '—, —'}</b>
      </span>
      <span className="status__sep" />
      <span className="status__item status__item--accent">
        色号 <b>{hover ? `#${hover.index}` : '—'}</b>
      </span>
      <span className="status__sep" />
      <span className="status__item">
        <b>{hexText}</b>
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

      {grid && (
        <>
          <span className="status__item">
            手改 <b>{editedCount}</b>
          </span>
          <span className="status__sep" />
          <span className="status__item">
            撤销 <b>{history.cursor}</b>
          </span>
          <span className="status__sep" />
          <span className="status__item">
            笔刷 <b>{brushSize}</b>
          </span>
          <span className="status__sep" />
          <span className="status__item">
            工具 <b>{tool}</b>
          </span>
          <span className="status__sep" />
        </>
      )}

      {(busy || converting) && (
        <>
          <span className="status__item status__item--accent">
            <b>{busy ?? '转换中…'}</b>
          </span>
          <span className="status__sep" />
        </>
      )}
      <span className="status__item">M4 · 智能辅助</span>
    </footer>
  );
}