/**
 * SortingProgress — Step 4 sort-state card.
 *
 * Shows a rich progress view while sorting runs (bar, ETA, rolling speed),
 * a summary card when complete, and an error card when failed/cancelled.
 */

import { useEffect, useRef, useState } from "react";
import { FiClock, FiZap, FiCheckCircle, FiAlertTriangle, FiX } from "react-icons/fi";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ProgressBar } from "@/components/ui/progress";
import { Button } from "@/components/ui/button";
import { formatCount, formatDuration } from "@/lib/formatters";
import type { SortingStatus } from "@/types/api";
import type { SortTaskResult } from "@/types/api";

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
          <CardTitle>{status === "pending" ? "Starting…" : "Sorting in progress"}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Progress bar */}
          <div className="space-y-1.5">
            <ProgressBar value={status === "pending" ? undefined : pct} />
            {taskProgress && taskProgress.total > 0 && (
              <div className="flex items-center justify-between text-sm">
                <span className="text-muted-foreground">
                  {formatCount(taskProgress.current)} / {formatCount(taskProgress.total)} files
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
                  Estimated remaining: {formatDuration(etaSeconds, DURATION_OPTS)}
                </span>
              )}
              {speed !== null && (
                <span className="flex items-center gap-1.5">
                  <FiZap className="h-3.5 w-3.5 shrink-0" />
                  {speed.toFixed(1)} files/sec
                </span>
              )}
            </div>
          )}

          {/* Cancel button */}
          <div className="flex justify-end">
            <Button variant="destructive" size="sm" onClick={onCancel}>
              Cancel Sort
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
            Sort complete
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2 text-sm">
            {result ? (
              <>
                <p className="flex items-center gap-1.5">
                  <FiCheckCircle className="shrink-0 h-3.5 w-3.5 text-success" />
                  <strong>{formatCount(result.sorted)}</strong> files sorted successfully
                </p>

                {quarantined > 0 && (
                  <p className="flex items-center gap-1.5">
                    <FiAlertTriangle className="shrink-0 h-3.5 w-3.5 text-warning" />
                    <strong>{formatCount(quarantined)}</strong> quarantined
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
                    <strong className="text-foreground">
                      {formatCount(result.duplicates)}
                    </strong>{" "}
                    duplicates moved to _duplicates/
                  </p>
                )}

                <p className="flex items-center gap-1.5">
                  <FiX className="shrink-0 h-3.5 w-3.5 text-error" />
                  <strong>{formatCount(result.failed)}</strong> failed
                </p>
              </>
            ) : (
              <p className="text-muted-foreground">Sort finished. Loading summary…</p>
            )}

            {durationSecs !== null && (
              <p className="flex items-center gap-1.5 text-muted-foreground">
                <FiClock className="shrink-0 h-3.5 w-3.5" />
                Completed in {formatDuration(durationSecs, DURATION_OPTS)}
              </p>
            )}
          </div>

          {onViewReport && (
            <div className="flex justify-end">
              <Button size="sm" onClick={onViewReport}>
                View Report →
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
      <Card className="animate-fade-in">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-error">
            <FiX className="inline-block h-5 w-5 animate-badge-pop" />
            Sort failed
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md bg-error/10 px-3 py-2 text-sm text-error">
            {error ?? progress?.error ?? "An unexpected error stopped the sort."}
          </div>

          {taskProgress && taskProgress.total > 0 && (
            <p className="text-sm text-muted-foreground">
              Files processed before failure:{" "}
              <strong>
                {formatCount(taskProgress.current)} / {formatCount(taskProgress.total)}
              </strong>
            </p>
          )}

          <p className="text-xs text-muted-foreground">Check the log below for details.</p>

          <div className="flex justify-end gap-2">
            {onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                Try Again
              </Button>
            )}
            {onViewReport && (
              <Button size="sm" onClick={onViewReport}>
                View Partial Report
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  // ── Render: cancelled ─────────────────────────────────────────────────────
  if (status === "cancelled") {
    return (
      <Card className="animate-fade-in">
        <CardHeader>
          <CardTitle className="text-muted-foreground">Sort cancelled</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            The sort was cancelled.
            {taskProgress && taskProgress.total > 0 && (
              <>
                {" "}
                {formatCount(taskProgress.current)} of {formatCount(taskProgress.total)} files were
                processed.
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
        <CardTitle className="text-muted-foreground">Ready to sort</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-sm text-muted-foreground">
          Click Sort Now below to start organizing your files.
        </p>
      </CardContent>
    </Card>
  );
}
