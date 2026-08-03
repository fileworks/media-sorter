/**
 * Screen 4 — the run itself.
 *
 * One big number, because during a twenty-minute operation the only question is
 * "how much longer". Everything else on the screen answers the second question,
 * "is it going well", and answers it with counts rather than adjectives: files
 * verified, duplicates set aside, errors. An error count of zero is worth
 * showing; a reassuring sentence is not.
 *
 * The phase rail is the real pipeline, not an idealised one. Conversion and
 * tagging happen inside the organise pass rather than as passes of their own,
 * so they are named as part of that step instead of being given chips that
 * would never light up on their own.
 */

import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { FiCheck } from "react-icons/fi";

import { ScreenHeader } from "@/components/screens/ScreenHeader";
import { useI18n } from "@/i18n/I18nContext";
import { formatBytes, formatDuration } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { Config, SortingStatus, TaskProgress } from "@/types/api";

type Phase = NonNullable<TaskProgress["phase"]>;

/** The four passes a sort actually makes, in order. */
const PHASE_ORDER: { id: string; phases: Phase[] }[] = [
  { id: "check", phases: ["validating"] },
  { id: "scan", phases: ["scanning_source"] },
  { id: "duplicates", phases: ["indexing_destination", "ranking"] },
  { id: "organize", phases: ["sorting", "analyzing", "previewing"] },
];

function phaseIndex(phase: Phase | null | undefined): number {
  if (!phase) return 0;
  const found = PHASE_ORDER.findIndex((entry) => entry.phases.includes(phase));
  return found === -1 ? 0 : found;
}

interface ExecuteScreenProps {
  status: SortingStatus["status"];
  progress: TaskProgress | null;
  outcomes: Record<string, number>;
  error: string | null;
  config: Config;
  reportPath: string | null;
  onPause?: () => void;
  onCancel: () => void;
  onRetry: () => void;
  /** Rendered under the cards — the live log. */
  children?: React.ReactNode;
}

export function ExecuteScreen({
  status,
  progress,
  outcomes,
  error,
  config,
  reportPath,
  onCancel,
  onRetry,
  children,
}: ExecuteScreenProps) {
  const { t, locale } = useI18n();

  const percentage = Math.round(progress?.percentage ?? 0);
  const current = phaseIndex(progress?.phase);
  const done = status === "completed";
  const failed = status === "failed";
  const cancelled = status === "cancelled";
  const settled = done || failed || cancelled;

  const n = (value: number | undefined) => (value ?? 0).toLocaleString(locale);
  const errorCount = (outcomes.failed ?? 0) + (outcomes.corrupted ?? 0);

  const throughput = useMemo(() => {
    if (!progress?.bytes_done || !progress.bytes_total_known) return null;
    return t("execute.ofBytes", {
      done: formatBytes(progress.bytes_done, { locale }),
      total: formatBytes(progress.bytes_total ?? 0, { locale }),
    });
  }, [locale, progress, t]);

  const eta = progress?.estimated_time_remaining_seconds ?? null;

  return (
    <div className="space-y-5">
      <div>
        <ScreenHeader
          title={t(settled ? "execute.titleDone" : "execute.title")}
          subtitle={
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <FiCheck className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden />
              {t(config.copy_instead_of_move ? "execute.confirmedCopy" : "execute.confirmedMove", {
                files: n(progress?.total),
              })}
            </span>
          }
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
        <section className="rounded-2xl border border-border bg-card p-6">
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
            <span
              className={cn(
                "text-4xl font-bold tracking-tight",
                failed ? "text-error" : "text-primary",
              )}
              aria-live="polite"
            >
              {settled ? (done ? "100%" : `${percentage}%`) : `${percentage}%`}
            </span>
            <span className="text-sm font-semibold text-foreground">
              {t(
                failed
                  ? "execute.phase.failed"
                  : cancelled
                    ? "execute.phase.cancelled"
                    : done
                      ? "execute.phase.done"
                      : `execute.phase.${PHASE_ORDER[current].id}`,
              )}
            </span>
            <span className="flex-1" />
            {!settled && eta !== null && (
              <span className="text-xs text-muted-foreground">
                {t("execute.timeLeft", {
                  duration: formatDuration(eta, { style: "long", locale }),
                })}
              </span>
            )}
          </div>

          <div
            className="mt-3 h-2.5 overflow-hidden rounded-full bg-muted"
            role="progressbar"
            aria-valuenow={percentage}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t("execute.title")}
          >
            <div
              className={cn(
                "h-full rounded-full transition-[width] duration-500",
                failed ? "bg-error" : "bg-gradient-to-r from-primary to-brand",
              )}
              style={{ width: `${percentage}%` }}
            />
          </div>

          <p className="mt-2.5 text-xs text-muted-foreground">
            {t("execute.counts", {
              done: n(progress?.current),
              total: n(progress?.total),
              errors: n(errorCount),
            })}
            {throughput && ` · ${throughput}`}
          </p>

          <ol className="mt-5 flex flex-wrap items-center gap-2">
            {PHASE_ORDER.map((entry, index) => {
              const complete = done || index < current;
              const active = !settled && index === current;
              return (
                <li key={entry.id} className="flex items-center gap-2">
                  {index > 0 && <span className="h-px w-4 bg-border" aria-hidden />}
                  <span
                    className={cn(
                      "inline-flex items-center gap-1.5 text-xs",
                      active && "font-semibold text-primary",
                      complete && !active && "text-muted-foreground",
                      !complete && !active && "text-faint",
                    )}
                    aria-current={active ? "step" : undefined}
                  >
                    <span
                      className={cn(
                        "flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                        complete && "bg-tint-success text-success",
                        active && "bg-primary",
                        !complete && !active && "border border-border",
                      )}
                      aria-hidden
                    >
                      {complete && <FiCheck className="h-2.5 w-2.5" />}
                      {active && (
                        <span className="h-1.5 w-1.5 rounded-full bg-primary-foreground" />
                      )}
                    </span>
                    {t(`execute.step.${entry.id}`)}
                  </span>
                </li>
              );
            })}
          </ol>

          {(config.convert_images || config.convert_videos || config.ai_tagging_enabled) && (
            <p className="mt-2 text-xs text-faint">{t("execute.organizeIncludes")}</p>
          )}

          {error && (
            <p
              className="mt-4 rounded-lg border border-error/40 bg-tint-error px-3.5 py-2.5 text-xs text-error"
              role="alert"
            >
              {error}
            </p>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-2.5">
            {!settled && (
              <Button
                variant="outline"
                size="sm"
                onClick={onCancel}
                className="text-error hover:bg-tint-error"
              >
                {t("execute.cancelRun")}
              </Button>
            )}
            {(failed || cancelled) && (
              <button
                type="button"
                onClick={onRetry}
                className="rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("execute.retry")}
              </button>
            )}
            <span className="text-xs text-muted-foreground">
              <FiCheck className="mr-1 inline h-3 w-3 align-[-1px] text-success" aria-hidden />
              {t(config.copy_instead_of_move ? "execute.safeCopy" : "execute.safeMove")}
            </span>
          </div>
        </section>

        <section className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5">
          <h2 className="text-3xs font-semibold uppercase tracking-[0.08em] text-faint">
            {t("execute.soFar")}
          </h2>
          <dl className="space-y-2.5 text-xs">
            {(
              [
                ["execute.stat.verified", n(outcomes.sorted)],
                ["execute.stat.duplicates", n(outcomes.duplicate)],
                ["execute.stat.junk", n(outcomes.junk)],
                ["execute.stat.collisions", n(outcomes.name_collision)],
                ["execute.stat.skipped", n(outcomes.already_in_destination)],
              ] as const
            ).map(([key, value]) => (
              <div key={key} className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">{t(key)}</dt>
                <dd className="font-semibold text-foreground">{value}</dd>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-muted-foreground">{t("execute.stat.errors")}</dt>
              <dd className={cn("font-semibold", errorCount === 0 ? "text-success" : "text-error")}>
                {n(errorCount)}
              </dd>
            </div>
          </dl>

          <div className="flex-1" />

          <p className="border-t border-border pt-3 text-xs leading-relaxed text-faint">
            {t("execute.reportNote")}
            {reportPath && (
              <>
                <br />
                <span className="font-mono text-muted-foreground">{reportPath}</span>
              </>
            )}
          </p>
        </section>
      </div>

      {children}
    </div>
  );
}
