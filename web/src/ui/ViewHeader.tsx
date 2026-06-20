import type { ReactNode } from 'react';

/** The slim per-view header bar: an eyebrow, a title, and optional right-side content. */
export function ViewHeader({
  eyebrow,
  title,
  right,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  right?: ReactNode;
}) {
  return (
    <header className="view-head">
      <div className="view-titles">
        {eyebrow && <span className="view-eyebrow">{eyebrow}</span>}
        <h1 className="view-title">{title}</h1>
      </div>
      {right && <div className="view-actions">{right}</div>}
    </header>
  );
}
