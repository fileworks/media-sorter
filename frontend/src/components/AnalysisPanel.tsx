/**
 * Step 2 — Analysis Panel
 *
 * Shows fast scan statistics: file counts by type, date range, disk space check,
 * estimated duration, and warnings. No thumbnails — optimised for speed.
 */

import { FiSearch } from "react-icons/fi";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ValidationBadge } from "@/components/ui/validation-badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatBytes, formatDuration } from "@/lib/formatters";
import { formatDate } from "@/lib/dateFormatters";
import { useCountUp } from "@/hooks/useCountUp";
import type { AnalysisResult } from "@/hooks/useAnalysis";

// ── Types ─────────────────────────────────────────────────────────────────────

interface AnalysisPanelProps {
  result: AnalysisResult | null;
  loading: boolean;
  error: string | null;
  onRetry?: () => void;
  /** Jump back to the Configure step (shown in the no-media empty state). */
  onBackToConfig?: () => void;
}

// Copy needs the source bytes plus a small headroom; this mirrors the backend's
// `sufficient` gate (`dest_free >= source * 1.05`) so the panel and the gate
// never disagree.
const COPY_OVERHEAD = 1.05;

// ── Helpers ───────────────────────────────────────────────────────────────────

// AnalysisPanel always shows one decimal for fractional units and "0 B" (never
// "—") for a zero/empty size. A media library can easily exceed 1 TB, so scale
// up to TB rather than capping at the default GB ("5120.0 GB" → "5.0 TB").
const SIZE_OPTS = { decimals: 1, maxUnit: "TB", nullPlaceholder: "0 B" } as const;

/** Format a byte count for the analysis readout (always 1 decimal, "0 B" zero). */
function formatSize(bytes: number): string {
  return formatBytes(bytes, SIZE_OPTS);
}

/**
 * Month + year label for the date-range row. Returns "" (falsy) for a missing
 * or invalid date so the surrounding range-label logic can fall back cleanly.
 */
function formatMonthYear(dateStr: string | null): string {
  return formatDate(dateStr, { type: "month-year", nullPlaceholder: "" });
}

/** Group raw extension→count map into user-friendly type buckets. */
const TYPE_GROUPS: Record<string, string[]> = {
  JPEG: [".jpg", ".jpeg"],
  MP4: [".mp4"],
  MOV: [".mov"],
  RAW: [".raw", ".cr2", ".cr3", ".nef", ".arw", ".orf", ".rw2", ".dng"],
  PNG: [".png"],
  HEIC: [".heic", ".heif"],
};

function groupByType(byType: Record<string, number>): [string, number][] {
  const result: Record<string, number> = {};
  let other = 0;

  for (const [ext, count] of Object.entries(byType)) {
    const normExt = ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
    let matched = false;
    for (const [group, exts] of Object.entries(TYPE_GROUPS)) {
      if (exts.includes(normExt)) {
        result[group] = (result[group] ?? 0) + count;
        matched = true;
        break;
      }
    }
    if (!matched) other += count;
  }

  if (other > 0) result["Other"] = other;

  return Object.entries(result).sort((a, b) => b[1] - a[1]);
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-muted", className)} />;
}

function AnalysisLoadingSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Scan Results</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex items-center gap-3">
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-5 w-20" />
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-16 rounded-lg" />
          ))}
        </div>
        <Skeleton className="h-4 w-48" />
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-6 w-full rounded-full" />
        <Skeleton className="h-4 w-40" />
      </CardContent>
    </Card>
  );
}

// ── Stat Card ─────────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: number }) {
  const display = useCountUp(value);
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-3 text-center">
      <p className="text-xl font-bold tabular-nums text-foreground">{display.toLocaleString()}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

// ── Main Component ────────────────────────────────────────────────────────────

export function AnalysisPanel({
  result,
  loading,
  error,
  onRetry,
  onBackToConfig,
}: AnalysisPanelProps) {
  // Loading skeleton
  if (loading) return <AnalysisLoadingSkeleton />;

  // Error state
  if (error) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Scan Results</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <ValidationBadge severity="error" message={error} />
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>
              Retry
            </Button>
          )}
        </CardContent>
      </Card>
    );
  }

  // Empty / not yet run
  if (!result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Scan Results</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 py-2 text-sm text-muted-foreground">
            <FiSearch className="h-5 w-5 shrink-0 text-muted-foreground/60" />
            <span>
              Click <strong className="text-foreground">Analyze →</strong> below to scan your source
              folder for photos and videos.
            </span>
          </div>
        </CardContent>
      </Card>
    );
  }

  // ── Derived values ───────────────────────────────────────────────────────────

  const {
    total_files,
    total_size_bytes,
    by_type,
    date_range,
    disk_space,
    excluded_files,
    estimated_duration_seconds,
    warnings,
  } = result;

  const groupedTypes = groupByType(by_type);

  const earliestFmt = formatMonthYear(date_range.earliest);
  const latestFmt = formatMonthYear(date_range.latest);
  const dateRangeLabel =
    earliestFmt && latestFmt
      ? `${earliestFmt} → ${latestFmt}`
      : earliestFmt
        ? `From ${earliestFmt}`
        : latestFmt
          ? `Until ${latestFmt}`
          : "Unknown date range";

  // Copy consumes `source * overhead` at the destination; move relocates files
  // and consumes no net destination space, so it needs none. "Remaining" is the
  // free space left once the operation is done — the figure users actually want.
  const isCopy = disk_space.mode === "copy";
  const freeBytes = disk_space.destination_free_bytes;
  // When the backend couldn't read the destination's free space (e.g. a
  // permission error), destination_free_bytes is not meaningful — show an honest
  // "unknown" state rather than a misleading "0 B free" + green bar.
  const freeKnown = disk_space.free_space_known !== false;
  const requiredBytes = isCopy ? Math.round(disk_space.source_size_bytes * COPY_OVERHEAD) : 0;
  const remainingBytes = Math.max(0, freeBytes - requiredBytes);
  const diskUsedPercent = freeBytes > 0 ? Math.min(100, (requiredBytes / freeBytes) * 100) : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Scan Results</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Headline */}
        <p className="text-base font-medium text-foreground">
          {total_files.toLocaleString()} files found
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            · {formatSize(total_size_bytes)} total
          </span>
        </p>

        {/* No-media empty state — shown right after a scan that finds nothing. */}
        {total_files === 0 && (
          <div className="space-y-3">
            <ValidationBadge
              severity="warning"
              message="No photos or videos were found in the source folder. Check the path or your Scan & filters settings."
            />
            {onBackToConfig && (
              <Button variant="outline" size="sm" onClick={onBackToConfig}>
                ← Back to Config
              </Button>
            )}
          </div>
        )}

        {/* By-type grid */}
        {groupedTypes.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {groupedTypes.map(([type, count]) => (
              <StatCard key={type} label={type} value={count} />
            ))}
          </div>
        )}

        {/* Date range */}
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">Date range:</span> {dateRangeLabel}
          </p>
          {date_range.no_date_estimate > 0 && (
            <p>~{date_range.no_date_estimate.toLocaleString()} files have no extractable date</p>
          )}
        </div>

        {/* Disk space */}
        <div className="space-y-2">
          <p className="text-sm">
            <span className="font-medium text-foreground">Disk space:</span>{" "}
            <span className="text-muted-foreground">
              {freeKnown
                ? `${formatSize(freeBytes)} free at destination`
                : "Free space at destination unknown (check permissions)"}
            </span>
          </p>
          {freeKnown && (
            <>
              <div className="relative h-3 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    "h-full rounded-full transition-all",
                    disk_space.sufficient ? "bg-success" : "bg-error",
                  )}
                  style={{
                    width: `${diskUsedPercent}%`,
                    minWidth: diskUsedPercent > 0 ? "6px" : "0",
                  }}
                />
              </div>
              {isCopy ? (
                <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                  <span>Copy needs {formatSize(requiredBytes)}</span>
                  <span>·</span>
                  {disk_space.sufficient ? (
                    <span className="text-success">
                      {formatSize(remainingBytes)} would remain free ✓
                    </span>
                  ) : (
                    <span className="text-error">not enough space ✕</span>
                  )}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Move relocates files in place — no extra destination space needed.
                </p>
              )}
            </>
          )}
          {!freeKnown && isCopy && (
            <p className="text-xs text-muted-foreground">
              Copy needs {formatSize(requiredBytes)}, but the destination&apos;s free space
              couldn&apos;t be checked.
            </p>
          )}
          {!freeKnown && !isCopy && (
            <p className="text-xs text-muted-foreground">
              Move relocates files in place — no extra destination space needed.
            </p>
          )}
        </div>

        {/* Disk-space error — only when we actually know it's insufficient */}
        {freeKnown && !disk_space.sufficient && (
          <ValidationBadge
            severity="error"
            message="Not enough disk space for copy. Switch to Move or free up destination space."
          />
        )}

        {/* Estimated time */}
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Estimated sort time:</span>{" "}
          {formatDuration(estimated_duration_seconds, { style: "verbose", approximate: true })}
          {excluded_files > 0 && (
            <span className="ml-2">
              ({excluded_files.toLocaleString()} files excluded by exclusion patterns)
            </span>
          )}
        </p>

        {/* Warnings */}
        {warnings.length > 0 && (
          <div className="space-y-2">
            {warnings.map((w, i) => (
              <ValidationBadge key={i} severity="warning" message={w} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
