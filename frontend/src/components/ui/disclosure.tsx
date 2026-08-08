import type { ReactNode } from "react";
import { FiChevronRight } from "react-icons/fi";

/** A row's deeper settings, closed until somebody wants them. */
export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  return (
    <details className="group border-b border-border">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-5 py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring">
        <FiChevronRight
          className="h-3.5 w-3.5 transition-transform group-open:rotate-90"
          aria-hidden
        />
        {summary}
      </summary>
      <div className="space-y-3.5 border-t border-border bg-muted/40 px-5 py-4">{children}</div>
    </details>
  );
}
