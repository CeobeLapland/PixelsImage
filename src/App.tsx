import { useEffect, type JSX } from 'react';

import { useApp } from '@/state/store';
import { AppHeader } from './components/AppHeader';
import { SidePanel } from './components/SidePanel';
import { Stage } from './components/Stage';
import { StatusBar } from './components/StatusBar';
import { Toasts } from './components/Toasts';
import { ToolRail } from './components/ToolRail';

export default function App(): JSX.Element {
  /* 面板折叠：Tab 换取更大的画布 */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
      ) {
        return;
      }
      if (event.key === 'Tab') {
        event.preventDefault();
        useApp.getState().togglePanel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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