import type { JSX } from 'react';

import { useApp } from '@/state/store';

export function Toasts(): JSX.Element | null {
  const toasts = useApp((s) => s.toasts);
  const dismissToast = useApp((s) => s.dismissToast);

  if (toasts.length === 0) return null;

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className="toast" data-kind={toast.kind}>
          <span className="toast__text">{toast.text}</span>
          <button
            type="button"
            className="toast__close"
            onClick={() => dismissToast(toast.id)}
            aria-label="关闭提示"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}