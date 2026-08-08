/**
 * Live progress card shown while a preview run is in flight (Step 3).
 *
 * The backend reports a coarse `phase` so the bar shows meaningful feedback
 * during the setup work that happens before the per-file loop — instead of
 * sitting frozen at 0%. Styling mirrors
 * SortingProgress for visual consistency between Preview and Sort.
 */

import { ProgressBar } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { ScreenHeader } from "@/components/screens/ScreenHeader";
import { formatCount, formatDuration } from "@/lib/formatters";
import type { TaskProgress } from "@/types/api";
import { useI18n } from "@/i18n/I18nContext";

// Human labels for the typed backend phases.
const PHASE_KEYS: Record<string, string> = {
  validating: "progress.validating",
  scanning_source: "progress.scanningSource",
  indexing_destination: "progress.indexingDestination",
  ranking: "progress.ranking",
  analyzing: "progress.analyzingFiles",
  previewing: "progress.previewing",
};

interface PreviewProgressCardProps {
  operation: "analysis" | "preview";
  progress: TaskProgress | null;
  /** Wall-clock seconds since the run started — the fallback before a count exists. */
  elapsed: number;
  onCancel: () => void;
}

export function PreviewProgressCard({
  operation,
  progress,
  elapsed,
  onCancel,
}: PreviewProgressCardProps) {
  const { t, locale } = useI18n();
  const phase = progress?.phase ?? null;
  // Determinate only once a phase has a real item count.
  const determinate = !!progress && progress.total > 0;
  const label =
    phase && PHASE_KEYS[phase]
      ? t(PHASE_KEYS[phase])
      : t(operation === "analysis" ? "progress.scanning" : "progress.preview");
  const eta = progress?.estimated_time_remaining_seconds ?? null;

  return (
    <div>
      <ScreenHeader
        title={t("stage.review.computing")}
        subtitle={t("stage.review.computingHelp")}
      />
      <div className="space-y-3 rounded-xl border border-border bg-card px-4 py-3" aria-busy>
        <div className="flex items-baseline justify-between gap-2" aria-live="polite">
          <p className="text-sm font-medium text-foreground">{label}</p>
          {determinate && progress ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {t("progress.files", {
                current: formatCount(progress.current, locale),
                total: formatCount(progress.total, locale),
                percentage: Math.round(progress.percentage),
              })}
            </span>
          ) : (
            elapsed > 0 && (
              <span className="text-xs tabular-nums text-muted-foreground">
                {formatDuration(elapsed, { style: "short", locale })}
              </span>
            )
          )}
        </div>

        <ProgressBar
          value={determinate && progress ? progress.percentage : undefined}
          label={label}
          className="h-1.5"
        />

        <div className="flex flex-wrap items-center justify-between gap-2">
          {determinate && eta != null && eta > 1 ? (
            <p className="text-xs text-muted-foreground">
              {t("progress.remaining", {
                duration: formatDuration(eta, { style: "verbose", rounding: "ceil", locale }),
              })}
            </p>
          ) : (
            <span />
          )}
          <Button size="sm" variant="outline" onClick={onCancel}>
            {t("common.stop")}
          </Button>
        </div>
      </div>
    </div>
  );
}
