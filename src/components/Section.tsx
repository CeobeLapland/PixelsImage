/** 面板折叠分组与键值行。被多个面板共用，所以单独成文件。 */

import { useState, type JSX, type ReactNode } from 'react';

export function Section({
  title,
  badge,
  defaultOpen = true,
  children,
}: {
  title: string;
  badge?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="section">
      <button
        type="button"
        className="section__head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <h2>{title}</h2>
        {badge}
      </button>
      <div className="section__body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

export function Row({
  k,
  v,
  muted,
}: {
  k: string;
  v: ReactNode;
  muted?: boolean;
}): JSX.Element {
  return (
    <div className="kv">
      <span className="kv__k">{k}</span>
      <span className="kv__v" data-muted={muted ? 'true' : undefined}>
        {v}
      </span>
    </div>
  );
}