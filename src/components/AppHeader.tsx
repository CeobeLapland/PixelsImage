import { useRef, type ChangeEvent, type JSX } from 'react';

import { formatBytes } from '@/core/image';
import { PROJECT_EXTENSION } from '@/core/project';
import { useApp } from '@/state/store';
import { BRAND_MARK, PixelIcon } from './PixelIcon';

export function AppHeader(): JSX.Element {
  const source = useApp((s) => s.source);
  const clearWorkspace = useApp((s) => s.clearWorkspace);
  const panelCollapsed = useApp((s) => s.panelCollapsed);
  const togglePanel = useApp((s) => s.togglePanel);

  const saveProject = useApp((s) => s.saveProject);
  const loadProjectFile = useApp((s) => s.loadProjectFile);
  const projectBusy = useApp((s) => s.projectBusy);
  const projectSavedAt = useApp((s) => s.projectSavedAt);
  const setShortcutsOpen = useApp((s) => s.setShortcutsOpen);

  const inputRef = useRef<HTMLInputElement>(null);

  const onProjectFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void loadProjectFile(file);
  };

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
        <input
          ref={inputRef}
          type="file"
          accept={`${PROJECT_EXTENSION},application/json`}
          hidden
          onChange={onProjectFile}
        />
        <button
          type="button"
          className="btn btn--primary"
          disabled={!source || projectBusy}
          title="把源图、参数、调色板与手工修改一起写进 .pixproj"
          onClick={() => void saveProject()}
        >
          {projectBusy ? '处理中…' : projectSavedAt === null ? '存档' : '再存档'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={projectBusy}
          title={`打开一个 ${PROJECT_EXTENSION} 存档`}
          onClick={() => inputRef.current?.click()}
        >
          打开存档
        </button>
        <button
          type="button"
          className="btn"
          onClick={clearWorkspace}
          disabled={!source}
          title="清空图片、结果与批量队列（自定义调色板、预设、方块映射会保留）"
        >
          清空工作区
        </button>
        <button
          type="button"
          className="btn btn--icon"
          title="快捷键（?）"
          aria-label="快捷键"
          onClick={() => setShortcutsOpen(true)}
        >
          ?
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