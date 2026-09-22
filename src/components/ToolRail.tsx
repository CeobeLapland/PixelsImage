import type { JSX } from 'react';

import type { ToolId } from '@/core/types';
import { TOOL_ICONS, PixelIcon } from './PixelIcon';

interface ToolDef {
  id: ToolId;
  label: string;
  key: string;
}

/** 顺序即工具栏中的排列，按使用频率分组 */
const TOOL_GROUPS: ToolDef[][] = [
  [
    { id: 'pencil', label: '铅笔', key: 'B' },
    { id: 'eraser', label: '橡皮', key: 'E' },
    { id: 'bucket', label: '油漆桶', key: 'G' },
    { id: 'eyedropper', label: '吸管', key: 'I' },
  ],
  [
    { id: 'line', label: '直线', key: 'L' },
    { id: 'rect', label: '矩形', key: 'R' },
    { id: 'ellipse', label: '椭圆', key: 'O' },
    { id: 'select', label: '选区移动', key: 'M' },
  ],
];

/**
 * M0 阶段：工具栏骨架已就位，绘图工具在 M2 接入，当前一律禁用。
 * 禁用态由 `disabled` + tooltip 说明，不假装能用。
 */
export function ToolRail(): JSX.Element {
  return (
    <nav className="rail" aria-label="绘图工具">
      {TOOL_GROUPS.map((group, groupIndex) => (
        <div key={groupIndex} style={{ display: 'contents' }}>
          {groupIndex > 0 && <div className="rail__divider" />}
          {group.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className="rail__btn"
              disabled
              title={`${tool.label}（${tool.key}）· M2 阶段接入`}
              aria-label={tool.label}
            >
              <PixelIcon rows={TOOL_ICONS[tool.id]} size={18} />
            </button>
          ))}
        </div>
      ))}
      <div className="rail__spacer" />
    </nav>
  );
}