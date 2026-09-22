/**
 * 全局快捷键 —— docs/DESIGN.md §5.4。
 *
 * 只处理「与画布位置无关」的按键。缩放与适配（0 / 1 / + / -）留在
 * Viewport 里，因为它们需要容器尺寸才能算中心点。
 *
 * 两条纪律：
 * - 输入框里打字时不劫持按键（否则在「目标格数」里输入 1 会触发缩放）；
 * - 每个键都在快捷键面板里有对应项，不允许存在「只有代码知道」的隐藏操作。
 */

import { useEffect } from 'react';

import { TOOLS } from '@/core/tools';
import type { ToolId } from '@/core/types';
import { clearSelectionCells, isStroking } from './paint';
import { useApp } from './store';

/** 工具快捷键：B E G I L R O M */
const TOOL_KEYS: Record<string, ToolId> = Object.fromEntries(
  Object.values(TOOLS)
    .filter((tool) => tool.key.length === 1)
    .map((tool) => [tool.key.toLowerCase(), tool.id]),
) as Record<string, ToolId>;

function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;
}

export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) return;
      const store = useApp.getState();
      const key = event.key;

      /* 撤销 / 重做：允许与修饰键组合 */
      if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) store.redo();
        else store.undo();
        return;
      }
      if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'y') {
        event.preventDefault();
        store.redo();
        return;
      }

      // 其余都是无修饰键的单键操作，带 Ctrl/Alt 的组合留给浏览器
      if (event.ctrlKey || event.metaKey || event.altKey) return;

      const tool = TOOL_KEYS[key.toLowerCase()];
      if (tool) {
        event.preventDefault();
        store.setTool(tool);
        return;
      }

      switch (key) {
        case '?':
        case '/':
          // 顺手也认 '/'：中文输入法下打 '?' 常常要先切英文，多给一个入口
          event.preventDefault();
          store.setShortcutsOpen(!store.shortcutsOpen);
          break;
        case '[':
          event.preventDefault();
          store.setBrushSize(store.brushSize - 1);
          break;
        case ']':
          event.preventDefault();
          store.setBrushSize(store.brushSize + 1);
          break;
        case 'x':
        case 'X':
          event.preventDefault();
          store.swapColors();
          break;
        case 'Tab':
          // 折叠右侧面板，换取更大的画布
          event.preventDefault();
          store.togglePanel();
          break;
        case 'Escape':
          if (store.selection) {
            event.preventDefault();
            store.setSelection(null);
          }
          break;
        case 'Delete':
        case 'Backspace':
          if (store.selection && !isStroking()) {
            event.preventDefault();
            clearSelectionCells();
          }
          break;
        default:
          break;
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}