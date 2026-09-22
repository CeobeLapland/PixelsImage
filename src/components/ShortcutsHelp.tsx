/**
 * 快捷键帮助面板（M7）。
 *
 * 存在的理由很实际：这个工具的按键不少（工具、笔刷、视图、撤销、选区），
 * 而「只有代码知道」的隐藏操作等于不存在。所以 useShortcuts 里定了一条纪律 ——
 * 每个键在这里都有对应项，加按键时顺手补一行。
 *
 * 用 `?` 唤起，`Esc` 或点背景关闭。
 */

import { useEffect, type JSX } from 'react';

import { TOOLS } from '@/core/tools';
import { useApp } from '@/state/store';

interface ShortcutRow {
  keys: string;
  what: string;
}

interface ShortcutGroup {
  title: string;
  rows: ShortcutRow[];
}

/** 工具键从注册表里取，避免「加了新工具但帮助面板没写」 */
const toolKeys = Object.values(TOOLS)
  .filter((tool) => tool.key.length === 1)
  .map((tool) => tool.key.toUpperCase())
  .join(' ');

const GROUPS: ShortcutGroup[] = [
  {
    title: '工具',
    rows: [
      { keys: toolKeys, what: '依次切换：铅笔 / 橡皮 / 油漆桶 / 吸管 / 直线 / 矩形 / 椭圆 / 选区' },
      { keys: '[ ]', what: '笔刷尺寸 1–4' },
      { keys: 'Alt + 点击', what: '临时取色（不切换当前工具）' },
      { keys: 'X', what: '前景色与背景色互换' },
    ],
  },
  {
    title: '视图',
    rows: [
      { keys: '滚轮', what: '以光标为锚点缩放' },
      { keys: '拖拽 / 中键拖拽 / 空格 + 拖拽', what: '平移画布' },
      { keys: '0', what: '适配窗口' },
      { keys: '1', what: '回到 1:1（原尺寸）' },
      { keys: '+ -', what: '放大 / 缩小一档' },
      { keys: 'Tab', what: '折叠 / 展开右侧面板' },
    ],
  },
  {
    title: '编辑',
    rows: [
      { keys: 'Ctrl + Z', what: '撤销' },
      { keys: 'Ctrl + Shift + Z / Ctrl + Y', what: '重做' },
      { keys: 'Esc', what: '取消选区' },
      { keys: 'Delete / Backspace', what: '清空选区内容' },
    ],
  },
  {
    title: '导入导出',
    rows: [
      { keys: 'Ctrl + V', what: '粘贴剪贴板里的图片' },
      { keys: '拖到画布', what: '导入图片（替换当前图）' },
      { keys: '拖到批量队列', what: '一次加入多张图' },
      { keys: '?', what: '打开 / 关闭这个面板' },
    ],
  },
];

export function ShortcutsHelp(): JSX.Element | null {
  const open = useApp((s) => s.shortcutsOpen);
  const setOpen = useApp((s) => s.setShortcutsOpen);

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
    <div
      className="shortcuts"
      role="dialog"
      aria-label="快捷键"
      onClick={() => setOpen(false)}
    >
      <div className="shortcuts__panel" onClick={(event) => event.stopPropagation()}>
        <header className="shortcuts__head">
          <h2>快捷键</h2>
          <button
            type="button"
            className="shortcuts__close"
            title="关闭（Esc）"
            onClick={() => setOpen(false)}
          >
            ×
          </button>
        </header>

        <div className="shortcuts__body">
          {GROUPS.map((group) => (
            <section key={group.title} className="shortcuts__group">
              <h3>{group.title}</h3>
              <dl>
                {group.rows.map((row) => (
                  <div className="shortcuts__row" key={row.keys}>
                    <dt>
                      {row.keys.split(' ').map((k) => (
                        <kbd key={k}>{k}</kbd>
                      ))}
                    </dt>
                    <dd>{row.what}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>

        <p className="note">
          在输入框里打字时不会触发这些按键。缩放与适配（<b>0</b> / <b>1</b> / <b>+</b> / <b>-</b>）
          需要知道画布尺寸，所以由画布自己处理，效果与这里写的一致。
        </p>
      </div>
    </div>
  );
}