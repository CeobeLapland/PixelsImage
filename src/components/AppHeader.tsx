import type { JSX } from 'react';

import { formatBytes } from '@/core/image';
import { useApp } from '@/state/store';
import { BRAND_MARK, PixelIcon } from './PixelIcon';

export function AppHeader(): JSX.Element {
  const source = useApp((s) => s.source);
  const clearSource = useApp((s) => s.clearSource);
  const panelCollapsed = useApp((s) => s.panelCollapsed);
  const togglePanel = useApp((s) => s.togglePanel);

  return (
    <header className="header">
      <div className="header__brand">
        <PixelIcon rows={BRAND_MARK} size={16} className="header__mark" />
        <div>
          <div className="header__title">PixelsImage</div>
          <div className="header__sub">像素工坊 · 本地运行</div>
        </div>
      </div>

      <div className="header__doc">
        {source ? (
          <>
            <span className="header__filename" title={source.name}>
              {source.name}
            </span>
            <span className="badge">
              {source.originalWidth}×{source.originalHeight}
            </span>
            <span className="badge">{formatBytes(source.bytes)}</span>
            {source.truncated && <span className="badge badge--warn">已降采样</span>}
          </>
        ) : (
          <span className="header__filename">未载入图片</span>
        )}
      </div>

      <div className="header__actions">
        <button
          type="button"
          className="btn"
          onClick={clearSource}
          disabled={!source}
          title="移除当前图片"
        >
          清除
        </button>
        <button
          type="button"
          className="btn"
          onClick={togglePanel}
          aria-pressed={!panelCollapsed}
          title="折叠 / 展开右侧面板（Tab）"
        >
          {panelCollapsed ? '显示面板' : '折叠面板'}
        </button>
      </div>
    </header>
  );
}