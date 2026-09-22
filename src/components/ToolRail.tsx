import type { JSX } from 'react';

import { TOOLS } from '@/core/tools';
import type { ToolId } from '@/core/types';
import { useApp } from '@/state/store';
import { PixelIcon, TOOL_ICONS } from './PixelIcon';

/** 顺序即工具栏中的排列，按使用频率分组 */
const TOOL_GROUPS: ToolId[][] = [
  ['pencil', 'eraser', 'bucket', 'eyedropper'],
  ['line', 'rect', 'ellipse', 'select'],
];

export function ToolRail(): JSX.Element {
  const tool = useApp((s) => s.tool);
  const setTool = useApp((s) => s.setTool);
  const history = useApp((s) => s.history);
  const undo = useApp((s) => s.undo);
  const redo = useApp((s) => s.redo);

  const canUndo = history.cursor > 0;
  const canRedo = history.cursor < history.entries.length;

  return (
    <nav className="rail" aria-label="绘图工具">
      {TOOL_GROUPS.map((group, groupIndex) => (
        <div key={groupIndex} style={{ display: 'contents' }}>
          {groupIndex > 0 && <div className="rail__divider" />}
          {group.map((id) => {
            const info = TOOLS[id];
            return (
              <button
                key={id}
                type="button"
                className="rail__btn"
                aria-pressed={tool === id}
                title={`${info.label}（${info.key}）· ${info.hint}`}
                aria-label={info.label}
                onClick={() => setTool(id)}
              >
                <PixelIcon rows={TOOL_ICONS[id]} size={18} />
              </button>
            );
          })}
        </div>
      ))}

      <div className="rail__spacer" />
      <div className="rail__divider" />

      <button
        type="button"
        className="rail__btn"
        disabled={!canUndo}
        title="撤销（Ctrl+Z）"
        aria-label="撤销"
        onClick={undo}
      >
        <span className="rail__glyph">↶</span>
      </button>
      <button
        type="button"
        className="rail__btn"
        disabled={!canRedo}
        title="重做（Ctrl+Shift+Z）"
        aria-label="重做"
        onClick={redo}
      >
        <span className="rail__glyph">↷</span>
      </button>
    </nav>
  );
}