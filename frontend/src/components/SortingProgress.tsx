/**
 * SortingProgress — Step 4 sort-state card.
 *
 * Shows a rich progress view while sorting runs (bar, ETA, rolling speed),
 * a summary card when complete, and an error card when failed/cancelled.
 */

import { useEffect, useRef, useState } from "react";
import { FiClock, FiZap, FiCheckCircle, FiAlertTriangle, FiX } from "react-icons/fi";
import { StateView } from "@/components/StateView";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ProgressBar } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { formatCount, formatDuration } from "@/lib/formatters";
import type { SortingStatus } from "@/types/api";
import type { SortTaskResult } from "@/types/api";
import { useI18n } from "@/i18n/I18nContext";

// Sort timings read as approximate, spelled-out, and rounded up (e.g.
// "~2 min 31 sec") to match the live-progress tone.
const DURATION_OPTS = { style: "long", approximate: true, rounding: "ceil" } as const;

// ── Types ─────────────────────────────────────────────────────────────────────

type SortingUIStatus = "idle" | "pending" | "running" | "completed" | "failed" | "cancelled";

export interface SortingProgressProps {
  progress: SortingStatus | null;
  status: SortingUIStatus;
  error: string | null;
  onCancel: () => void;
  onViewReport?: () => void;
  onRetry?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function SortingProgress({
  progress,
  status,
  error,
  onCancel,
  onViewReport,
  onRetry,
}: SortingProgressProps) {
  const { t, locale } = useI18n();
  const taskProgress = progress?.progress;
  const pct = taskProgress?.percentage ?? 0;
  const isRunning = status === "running" || status === "pending";

  // ── Rolling speed & ETA ────────────────────────────────────────────────────
  const speedSamples = useRef<{ t: number; n: number }[]>([]);
  const [speed, setSpeed] = useState<number | null>(null); // files / sec
  const [localEta, setLocalEta] = useState<number | null>(null); // seconds

  useEffect(() => {
    if (!isRunning || !taskProgress) {
      speedSamples.current = [];
      setSpeed(null);
      setLocalEta(null);
      return;
    }
    const now = Date.now();
    speedSamples.current = [...speedSamples.current.slice(-9), { t: now, n: taskProgress.current }];
    if (speedSamples.current.length >= 2) {
      const oldest = speedSamples.current[0];
      const newest = speedSamples.current[speedSamples.current.length - 1];
      const dt = (newest.t - oldest.t) / 1000;
      const dn = newest.n - oldest.n;
      const spd = dt > 0 && dn > 0 ? dn / dt : null;
      setSpeed(spd);
      if (spd && taskProgress.total > taskProgress.current) {
        setLocalEta((taskProgress.total - taskProgress.current) / spd);
      } else {
        setLocalEta(null);
      }
    }
  }, [taskProgress, isRunning]);

  // ── Duration tracking ──────────────────────────────────────────────────────
  const startTimeRef = useRef<number | null>(null);
  const [durationSecs, setDurationSecs] = useState<number | null>(null);

  useEffect(() => {
    if (isRunning && !startTimeRef.current) {
      startTimeRef.current = Date.now();
    }
    if (!isRunning && startTimeRef.current) {
      setDurationSecs(Math.round((Date.now() - startTimeRef.current) / 1000));
      startTimeRef.current = null;
    }
  }, [isRunning]);

  // ── Result data (available once completed/failed) ──────────────────────────
  // "Quarantined" excludes duplicates — they have their own line below — so this
  // matches ReportPanel's quarantine count (future + unknown + corrupted) instead
  // of double-counting duplicates here and again in the duplicates line.
  const result = progress?.result as SortTaskResult | undefined;
  const quarantined =
    (result?.future_dates ?? 0) +
    (result?.unknown_dates ?? 0) +
    (result?.corrupted ?? 0) +
    (result?.junk ?? 0);

  // ── Render: running / pending ──────────────────────────────────────────────
  if (isRunning) {
    const etaSeconds = localEta ?? taskProgress?.estimated_time_remaining_seconds ?? null;

    return (
      <Card>
        <CardHeader>
          <CardTitle>{t(status === "pending" ? "sort.starting" : "sort.inProgress")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Progress bar */}
          <div className="space-y-1.5">
            <ProgressBar value={status === "pending" ? undefined : pct} />
            {taskProgress && taskProgress.total > 0 && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {t("progress.files", {
                    current: formatCount(taskProgress.current, locale),
                    total: formatCount(taskProgress.total, locale),
                    percentage: Math.round(pct),
                  })}
                </span>
                <span className="font-semibold">{Math.round(pct)}%</span>
              </div>
            )}
          </div>

          {/* ETA + speed */}
          {(etaSeconds !== null || speed !== null) && (
            <div className="flex flex-wrap gap-6 text-sm text-muted-foreground">
              {etaSeconds !== null && (
                <span className="flex items-center gap-1.5">
                  <FiClock className="h-3.5 w-3.5 shrink-0" />
                  {t("progress.remaining", {
                    duration: formatDuration(etaSeconds, { ...DURATION_OPTS, locale }),
                  })}
                </span>
              )}
              {speed !== null && (
                <span className="flex items-center gap-1.5">
                  <FiZap className="h-3.5 w-3.5 shrink-0" />
                  {t("sort.speed", {
                    speed: new Intl.NumberFormat(locale, {
                      minimumFractionDigits: 1,
                      maximumFractionDigits: 1,
                    }).format(speed),
                  })}
                </span>
              )}
            </div>
          )}

          {/* Cancel button */}
          <div className="flex justify-end">
            <Button variant="destructive" size="sm" onClick={onCancel}>
              {t("sort.cancel")}
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ── Render: completed ──────────────────────────────────────────────────────
  if (status === "completed") {
    return (
      <Card className="animate-fade-in">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-success">
            <FiCheckCircle className="inline-block h-5 w-5 animate-badge-pop" />
            {t("sort.complete")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2 text-sm">
            {result ? (
              <>
                <p className="flex items-center gap-1.5">
                  <FiCheckCircle className="shrink-0 h-3.5 w-3.5 text-success" />
                  {t("sort.sorted", { count: formatCount(result.sorted, locale) })}
                </p>

                {quarantined > 0 && (
                  <p className="flex items-center gap-1.5">
                    <FiAlertTriangle className="shrink-0 h-3.5 w-3.5 text-warning" />
                    {t("sort.quarantined", { count: formatCount(quarantined, locale) })}
                    {(result.unknown_dates > 0 || result.future_dates > 0) && (
                      <span className="text-muted-foreground">
                        {" "}
                        (
                        {result.unknown_dates > 0 &&
                          `${formatCount(result.unknown_dates)} unknown date`}
                        {result.unknown_dates > 0 && result.future_dates > 0 && ", "}
                        {result.future_dates > 0 &&
                          `${formatCount(result.future_dates)} future date`}
                        )
                      </span>
                    )}
                  </p>
                )}

                {result.duplicates > 0 && (
                  <p className="flex items-center gap-1.5 text-muted-foreground">
                    <span className="shrink-0 font-mono text-xs">≈</span>
                    <span className="text-foreground">
                      {t("sort.duplicates", {
                        count: formatCount(result.duplicates, locale),
                      })}
                    </span>
                  </p>
                )}

                <p className="flex items-center gap-1.5">
                  <FiX className="shrink-0 h-3.5 w-3.5 text-error" />
                  {t("sort.failureCount", { count: formatCount(result.failed, locale) })}
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">{t("sort.loadingSummary")}</p>
            )}

            {durationSecs !== null && (
              <p className="flex items-center gap-1.5 text-muted-foreground">
                <FiClock className="shrink-0 h-3.5 w-3.5" />
                {t("sort.completedIn", {
                  duration: formatDuration(durationSecs, { ...DURATION_OPTS, locale }),
                })}
              </p>
            )}
          </div>

          {onViewReport && (
            <div className="flex justify-end">
              <Button size="sm" onClick={onViewReport}>
                {t("sort.viewReport")}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    );
  }

  // ── Render: failed ─────────────────────────────────────────────────────────
  if (status === "failed") {
    return (
      <StateView
        variant="error"
        title={t("sort.failed")}
        detail={error ?? progress?.error ?? t("sort.unexpected")}
        onRetry={onRetry}
        action={
          onViewReport ? (
            <Button size="sm" onClick={onViewReport}>
              {t("sort.viewPartialReport")}
            </Button>
          ) : undefined
        }
      >
        <div className="mt-3 space-y-2">
          {taskProgress && taskProgress.total > 0 && (
            <p className="text-sm text-muted-foreground">
              {t("sort.processedBeforeFailure", {
                current: formatCount(taskProgress.current, locale),
                total: formatCount(taskProgress.total, locale),
              })}
            </p>
          )}

          <p className="text-xs text-muted-foreground">{t("sort.checkLog")}</p>
        </div>
      </StateView>
    );
  }

  // ── Render: cancelled ─────────────────────────────────────────────────────
  if (status === "cancelled") {
    return (
      <Card className="animate-fade-in">
        <CardHeader>
          <CardTitle className="text-muted-foreground">{t("sort.cancelled")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            {t("sort.cancelled")}{" "}
            {taskProgress && taskProgress.total > 0 && (
              <>
                {t("sort.cancelledCount", {
                  current: formatCount(taskProgress.current, locale),
                  total: formatCount(taskProgress.total, locale),
                })}
              </>
            )}
          </p>
        </CardContent>
      </Card>
    );
  }

  // ── Render: idle ───────────────────────────────────────────────────────────
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-muted-foreground">{t("sort.ready")}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">{t("sort.readyHelp")}</p>
      </CardContent>
    </Card>
  );
}
