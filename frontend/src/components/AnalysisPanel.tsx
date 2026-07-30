/**
 * Step 2 — Analysis Panel
 *
 * Shows fast scan statistics: file counts by type, date range, disk space check,
 * estimated duration, and warnings. No thumbnails — optimised for speed.
 */

import { FiSearch } from "react-icons/fi";
import { StateView } from "@/components/StateView";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ValidationBadge } from "@/components/ui/validation-badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { formatBytes, formatDuration } from "@/lib/formatters";
import { formatDate } from "@/lib/dateFormatters";
import { useCountUp } from "@/hooks/useCountUp";
import type { AnalysisResult } from "@/hooks/useAnalysis";
import { useI18n } from "@/i18n/I18nContext";

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
function formatSize(bytes: number, locale: string): string {
  return formatBytes(bytes, { ...SIZE_OPTS, locale });
}

/**
 * Month + year label for the date-range row. Returns "" (falsy) for a missing
 * or invalid date so the surrounding range-label logic can fall back cleanly.
 */
function formatMonthYear(dateStr: string | null, locale: string): string {
  return formatDate(dateStr, { type: "month-year", nullPlaceholder: "", locale });
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
  const { t } = useI18n();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("analysis.results")}</CardTitle>
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

function StatCard({ label, value, locale }: { label: string; value: number; locale: string }) {
  const display = useCountUp(value);
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-3 text-center">
      <p className="text-xl font-bold tabular-nums text-foreground">
        {display.toLocaleString(locale)}
      </p>
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
  const { t, locale } = useI18n();

  // Loading skeleton
  if (loading) return <AnalysisLoadingSkeleton />;

  // Error state
  if (error) {
    return (
      <StateView variant="error" title={t("analysis.results")} detail={error} onRetry={onRetry} />
    );
  }

  // Empty / not yet run
  if (!result) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t("analysis.results")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-3 py-2 text-sm text-muted-foreground">
            <FiSearch className="h-5 w-5 shrink-0 text-muted-foreground/60" />
            <span>{t("analysis.emptyPrompt")}</span>
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

  const earliestFmt = formatMonthYear(date_range.earliest, locale);
  const latestFmt = formatMonthYear(date_range.latest, locale);
  const dateRangeLabel =
    earliestFmt && latestFmt
      ? `${earliestFmt} → ${latestFmt}`
      : earliestFmt
        ? t("analysis.dateFrom", { date: earliestFmt })
        : latestFmt
          ? t("analysis.dateUntil", { date: latestFmt })
          : t("analysis.dateUnknown");

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
        <CardTitle>{t("analysis.results")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Headline */}
        <p className="text-base font-medium text-foreground">
          {t(total_files === 1 ? "analysis.filesFound.one" : "analysis.filesFound", {
            count: total_files.toLocaleString(locale),
          })}
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            {t("analysis.totalSize", { size: formatSize(total_size_bytes, locale) })}
          </span>
        </p>

        {/* No-media empty state — shown right after a scan that finds nothing. */}
        {total_files === 0 && (
          <div className="space-y-3">
            <ValidationBadge severity="warning" message={t("analysis.noMedia")} />
            {onBackToConfig && (
              <Button variant="outline" size="sm" onClick={onBackToConfig}>
                {t("analysis.backToConfig")}
              </Button>
            )}
          </div>
        )}

        {/* By-type grid */}
        {groupedTypes.length > 0 && (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {groupedTypes.map(([type, count]) => (
              <StatCard
                key={type}
                label={type === "Other" ? t("analysis.otherType") : type}
                value={count}
                locale={locale}
              />
            ))}
          </div>
        )}

        {/* Date range */}
        <div className="space-y-1 text-sm text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">{t("analysis.dateRange")}</span>{" "}
            {dateRangeLabel}
          </p>
          {date_range.no_date_estimate > 0 && (
            <p>
              {t("analysis.noDate", {
                count: date_range.no_date_estimate.toLocaleString(locale),
              })}
            </p>
          )}
        </div>

        {/* Disk space */}
        <div className="space-y-2">
          <p className="text-sm">
            <span className="font-medium text-foreground">{t("analysis.diskSpace")}</span>{" "}
            <span className="text-muted-foreground">
              {freeKnown
                ? t("analysis.freeAtDestination", { size: formatSize(freeBytes, locale) })
                : t("analysis.freeUnknown")}
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
                  <span>
                    {t("analysis.copyNeeds", { size: formatSize(requiredBytes, locale) })}
                  </span>
                  <span>·</span>
                  {disk_space.sufficient ? (
                    <span className="text-success">
                      {t("analysis.wouldRemain", {
                        size: formatSize(remainingBytes, locale),
                      })}
                    </span>
                  ) : (
                    <span className="text-error">{t("analysis.notEnough")}</span>
                  )}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">{t("analysis.moveNoSpace")}</p>
              )}
            </>
          )}
          {!freeKnown && isCopy && (
            <p className="text-xs text-muted-foreground">
              {t("analysis.copyUnknown", { size: formatSize(requiredBytes, locale) })}
            </p>
          )}
          {!freeKnown && !isCopy && (
            <p className="text-xs text-muted-foreground">{t("analysis.moveNoSpace")}</p>
          )}
        </div>

        {/* Disk-space error — only when we actually know it's insufficient */}
        {freeKnown && !disk_space.sufficient && (
          <ValidationBadge severity="error" message={t("analysis.noSpaceCopy")} />
        )}

        {/* Estimated time */}
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{t("analysis.estimated")}</span>{" "}
          {formatDuration(estimated_duration_seconds, {
            style: "verbose",
            approximate: true,
            locale,
          })}
          {excluded_files > 0 && (
            <span className="ml-2">
              {t("analysis.excluded", { count: excluded_files.toLocaleString(locale) })}
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
