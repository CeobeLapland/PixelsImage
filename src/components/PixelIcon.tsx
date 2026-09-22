/**
 * 像素图标：用字符矩阵定义图标，渲染成 SVG。
 *
 * 之所以不用图标库：这是个像素工具，图标本身就该是像素画出来的。
 * 顺便省掉一个依赖。
 *
 * 字符含义：'.' / ' ' = 空，'X' = 实心，'o' = 半透明（次级）
 */

import type { JSX } from 'react';

export type IconRows = readonly string[];

interface PixelIconProps {
  rows: IconRows;
  size?: number;
  className?: string;
}

export function PixelIcon({ rows, size = 18, className }: PixelIconProps): JSX.Element {
  const height = rows.length;
  const width = rows[0]?.length ?? 0;
  const cells: JSX.Element[] = [];

  for (let y = 0; y < height; y += 1) {
    const row = rows[y] ?? '';
    for (let x = 0; x < width; x += 1) {
      const ch = row[x];
      if (ch !== 'X' && ch !== 'o') continue;
      cells.push(
        <rect
          key={`${x}:${y}`}
          x={x}
          y={y}
          width={1}
          height={1}
          fill="currentColor"
          opacity={ch === 'o' ? 0.4 : 1}
        />,
      );
    }
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
      style={{ display: 'block' }}
      className={className}
    >
      {cells}
    </svg>
  );
}

/* ----------------------------------------------------------- 编辑器工具图标 */

export const ICON_PENCIL: IconRows = [
  '............',
  '............',
  '.........XXX',
  '........XXX.',
  '.......XXX..',
  '......XXX...',
  '.....XXX....',
  '....XXX.....',
  '...XXX......',
  '..XX........',
  '.X..........',
  '............',
];

export const ICON_ERASER: IconRows = [
  '............',
  '............',
  '......XXX...',
  '.....XXXXX..',
  '....XXXXXXX.',
  '...XXXXXXX..',
  '..XXXXXXX...',
  '.XXXXXXX....',
  'XXXXXXX.....',
  '.XXXXX......',
  '..XXX.......',
  '............',
];

export const ICON_BUCKET: IconRows = [
  '............',
  '...XX.......',
  '..XXXX......',
  '.XXXXXX.....',
  'XXXXXXXX....',
  'XXXXXXXXX...',
  '.XXXXXXX....',
  '..XXXXX..XX.',
  '...XXX..XX..',
  '....X.......',
  '............',
  '............',
];

export const ICON_EYEDROPPER: IconRows = [
  '....XXXX....',
  '...XXXXXX...',
  '...XXXXXX...',
  '...XXXXXX...',
  '....XXXX....',
  '.....XX.....',
  '.....XX.....',
  '.....XX.....',
  '.....XX.....',
  '.....X......',
  '............',
  '............',
];

export const ICON_LINE: IconRows = [
  '............',
  '.........XX.',
  '.........XX.',
  '........XX..',
  '.......XX...',
  '......XX....',
  '.....XX.....',
  '....XX......',
  '...XX.......',
  '..XX........',
  '.XX.........',
  '............',
];

export const ICON_RECT: IconRows = [
  '............',
  '.XXXXXXXXXX.',
  '.X........X.',
  '.X........X.',
  '.X........X.',
  '.X........X.',
  '.X........X.',
  '.X........X.',
  '.X........X.',
  '.X........X.',
  '.XXXXXXXXXX.',
  '............',
];

export const ICON_ELLIPSE: IconRows = [
  '............',
  '....XXXX....',
  '..XX....XX..',
  '.X........X.',
  '.X........X.',
  'X..........X',
  'X..........X',
  '.X........X.',
  '.X........X.',
  '..XX....XX..',
  '....XXXX....',
  '............',
];

export const ICON_SELECT: IconRows = [
  '............',
  'XX.XX.XX.XX.',
  'X..........X',
  'X..........X',
  'X..........X',
  'X..........X',
  'X..........X',
  'X..........X',
  'X..........X',
  'X..........X',
  '.XX.XX.XX.XX',
  '............',
];

/** 工具 id → 图标 */
export const TOOL_ICONS = {
  pencil: ICON_PENCIL,
  eraser: ICON_ERASER,
  bucket: ICON_BUCKET,
  eyedropper: ICON_EYEDROPPER,
  line: ICON_LINE,
  rect: ICON_RECT,
  ellipse: ICON_ELLIPSE,
  select: ICON_SELECT,
} as const;

/** 顶栏品牌标记：5×5 的像素菱形 */
export const BRAND_MARK: IconRows = [
  '..o..',
  '.XoX.',
  'oXXXo',
  '.XoX.',
  '..o..',
];

/** 空状态：图片落入像素网格 */
export const DROP_MARK: IconRows = [
  '.........',
  '....X....',
  '....X....',
  '....X....',
  '..XXXXX..',
  '...XXX...',
  '....X....',
  '.........',
  '.X.X.X.X.',
];