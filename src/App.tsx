import { type JSX } from 'react';

import { useShortcuts } from '@/state/useShortcuts';
import { usePipelineRunner } from '@/state/usePipeline';
import { AppHeader } from './components/AppHeader';
import { SidePanel } from './components/SidePanel';
import { Stage } from './components/Stage';
import { StatusBar } from './components/StatusBar';
import { Toasts } from './components/Toasts';
import { ToolRail } from './components/ToolRail';

export default function App(): JSX.Element {
  // 转换流水线的驱动：源图 / 参数变化 → Worker → 结果写入 store
  usePipelineRunner();
  // 全局快捷键：工具切换、笔刷、撤销重做、折叠面板（DESIGN §5.4）
  useShortcuts();

  return (
    <div className="app">
      <AppHeader />
      <div className="app__body">
        <ToolRail />
        <main className="app__stage">
          <Stage />
        </main>
        <SidePanel />
      </div>
      <StatusBar />
      <Toasts />
    </div>
  );
}