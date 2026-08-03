/**
 * The one heading each screen opens with, and the sentence under it.
 *
 * Every screen asks a question in the heading and answers "what happens next"
 * in the subtitle. Keeping that pair in one component is what stops the four
 * screens drifting into four different typographic ideas.
 */

import type { ReactNode } from "react";

export function ScreenHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 id="current-stage-heading" className="text-lg font-bold tracking-tight text-foreground">
          {title}
        </h1>
        {subtitle && <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
