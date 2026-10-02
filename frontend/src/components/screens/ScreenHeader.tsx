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
  eyebrow,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  /** Compact workflow or outcome context above the title. */
  eyebrow?: ReactNode;
}) {
  return (
    // Trimmed alongside the title bar and the stepper. Six stage headings, one
    // per screen, were each opening with 22px type and 20px of air under them
    // — a fair amount of a laptop's height spent restating a step the rail
    // above had already named. The hierarchy is unchanged; the gaps are not.
    <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {eyebrow && (
          <p className="mb-0.5 text-3xs font-bold uppercase tracking-[0.09em] text-faint">
            {eyebrow}
          </p>
        )}
        <h1
          id="current-stage-heading"
          className="text-[1.25rem] font-semibold leading-tight tracking-[-0.018em] text-foreground"
        >
          {title}
        </h1>
        {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
