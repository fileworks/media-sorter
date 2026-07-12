/**
 * Live progress card shown while a preview run is in flight (Step 3).
 *
 * The backend reports a coarse `phase` so the bar shows meaningful feedback
 * during the setup work that happens before the per-file loop — instead of
 * sitting frozen at 0%. Styling mirrors
 * SortingProgress for visual consistency between Preview and Sort.
 */

import { ProgressBar } from "@/components/ui/progress";
import { formatCount, formatDuration } from "@/lib/formatters";
import type { TaskProgress } from "@/types/api";

// Human label per backend phase. "scanning" has no incremental count (a
// directory walk isn't easily made incremental), so it renders indeterminate.
const PHASE_LABELS: Record<string, string> = {
  scanning: "Scanning folder…",
  ranking: "Analyzing image quality…",
  previewing: "Reading dates…",
};

interface PreviewProgressCardProps {
  progress: TaskProgress | null;
  /** Wall-clock seconds since the run started — the fallback before a count exists. */
  elapsed: number;
}

export function PreviewProgressCard({ progress, elapsed }: PreviewProgressCardProps) {
  const phase = progress?.phase ?? null;
  // Determinate only once a real count is flowing (the per-file / ranking
  // phases). During "scanning" total is still 0, so the bar is indeterminate.
  const determinate = !!progress && progress.total > 0 && phase !== "scanning";
  const label = (phase && PHASE_LABELS[phase]) || "Generating preview…";
  const eta = progress?.estimated_time_remaining_seconds ?? null;

  return (
    <div className="space-y-2 rounded-xl border border-border bg-card px-4 py-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-foreground">{label}</p>
        {determinate && progress ? (
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatCount(progress.current)} / {formatCount(progress.total)} files ·{" "}
            {Math.round(progress.percentage)}%
          </span>
        ) : (
          elapsed > 0 && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatDuration(elapsed, { style: "short" })}
            </span>
          )
        )}
      </div>

      <ProgressBar
        value={determinate && progress ? progress.percentage : undefined}
        className="h-1.5"
      />

      {determinate && eta != null && eta > 1 && (
        <p className="text-xs text-muted-foreground">
          About {formatDuration(eta, { style: "verbose", rounding: "ceil" })} remaining
        </p>
      )}
    </div>
  );
}
