import { FiAlertTriangle, FiCheck } from "react-icons/fi";

import { ScreenHeader } from "@/components/screens/ScreenHeader";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/I18nContext";
import { formatBytes } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { PreviewResult } from "@/types/api";

interface PlanScreenProps {
  result: PreviewResult;
  inputCount: number;
  referenceCount: number;
  onRecalculate: () => void;
}

export function PlanScreen({ result, inputCount, referenceCount, onRecalculate }: PlanScreenProps) {
  const { t, tCount, locale } = useI18n();
  const issueCount = Math.max(result.issues.length, result.stats.issue_count ?? 0);
  const duplicateCount = Math.max(result.impact.unresolved_count, result.stats.will_skip_duplicate);
  const safeBoundary = result.impact.source_mutations === 0;
  /**
   * Four numbers that are not the same number, and say how they differ.
   *
   * "190 files" and "189 acted on" sat side by side with nothing to explain
   * the one that went missing — and the answer is not obvious: a file left
   * where it is does not count, and a photo's RAW sibling or sidecar counts
   * with the photo rather than beside it. Each tile now carries the sentence
   * that separates it from the tile next to it.
   */
  const metrics: [value: string, label: string, help: string][] = [
    [
      result.stats.total.toLocaleString(locale),
      t("plan.metric.files"),
      t("plan.metric.files.help"),
    ],
    [
      result.impact.actionable_groups.toLocaleString(locale),
      t("plan.metric.groups"),
      t("plan.metric.groups.help"),
    ],
    [
      formatBytes(result.impact.required_bytes, { locale }),
      t("plan.metric.required"),
      t("plan.metric.required.help"),
    ],
    [issueCount.toLocaleString(locale), t("plan.metric.issues"), t("plan.metric.issues.help")],
  ];
  const steps = [
    [t("plan.sequence.read.title"), tCount("plan.sequence.read.detail", inputCount)],
    [
      t("plan.sequence.organize.title"),
      tCount("plan.sequence.organize.detail", result.impact.actionable_groups),
    ],
    [
      t("plan.sequence.duplicates.title"),
      tCount("plan.sequence.duplicates.detail", duplicateCount),
    ],
    [
      t("plan.sequence.write.title"),
      tCount("plan.sequence.write.detail", result.impact.copy_count + result.impact.move_count),
    ],
  ];

  return (
    <div className="space-y-4">
      <ScreenHeader
        eyebrow={t("stage.position", { current: 3, total: 4 })}
        title={t("plan.title")}
        subtitle={t("plan.subtitle")}
        actions={
          <Button variant="outline" onClick={onRecalculate}>
            {t("plan.recalculate")}
          </Button>
        }
      />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(18rem,.65fr)]">
        <article className="relative overflow-hidden rounded-window border border-success/40 bg-gradient-to-br from-tint-success/70 via-card to-tint-primary/35 p-4">
          <span
            aria-hidden
            className="pointer-events-none absolute -right-12 -top-16 h-44 w-44 rounded-full border-[28px] border-success/5"
          />
          <span className="inline-flex rounded-panel bg-tint-success px-2 py-1 text-3xs font-bold text-success">
            {t("plan.complete")}
          </span>
          <h2 className="relative mt-3 text-lg font-semibold text-foreground">
            {t("plan.summary.title", { count: result.stats.total.toLocaleString(locale) })}
          </h2>
          <p className="relative mt-1 text-xs text-muted-foreground">
            {tCount("plan.summary.detail", duplicateCount)}
          </p>
          <dl className="relative mt-4 grid grid-cols-2 gap-3 border-t border-success/40 pt-4 sm:grid-cols-4">
            {metrics.map(([value, label, help]) => (
              <div key={label} className="min-w-0">
                <dd className="text-lg font-semibold tabular-nums text-foreground">{value}</dd>
                <dt className="mt-0.5">
                  <Tooltip label={help}>
                    <button
                      type="button"
                      // A hint that is only a hover is a hint a keyboard never
                      // reaches. This is a real stop, and it says the same
                      // sentence to a screen reader.
                      aria-label={`${label} — ${help}`}
                      className="inline-flex min-h-6 items-center rounded-control text-3xs font-semibold uppercase tracking-[0.08em] text-faint underline decoration-dotted underline-offset-[3px] transition-colors hover:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {label}
                    </button>
                  </Tooltip>
                </dt>
              </div>
            ))}
          </dl>
        </article>

        <aside className="rounded-window border border-border bg-card p-4">
          <h2 className="text-3xs font-bold uppercase tracking-[0.09em] text-faint">
            {t("plan.checks")}
          </h2>
          <div className="mt-2 divide-y divide-border">
            {[
              [true, t("plan.check.destination"), t("plan.check.destination.detail")],
              [
                true,
                t("plan.check.sources"),
                t("plan.check.sources.detail", { inputs: inputCount, references: referenceCount }),
              ],
              [
                safeBoundary,
                t("plan.check.boundary"),
                safeBoundary
                  ? t("plan.check.boundary.safe")
                  : tCount("plan.check.boundary.mutations", result.impact.source_mutations),
              ],
            ].map(([safe, title, detail]) => (
              <div key={String(title)} className="flex items-start gap-3 py-3 first:pt-1 last:pb-1">
                <span
                  className={cn(
                    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
                    safe ? "bg-tint-success text-success" : "bg-tint-warning text-warning",
                  )}
                >
                  {safe ? (
                    <FiCheck className="h-3 w-3" aria-hidden />
                  ) : (
                    <FiAlertTriangle className="h-3 w-3" aria-hidden />
                  )}
                </span>
                <div>
                  <p className="text-xs font-semibold text-foreground">{title}</p>
                  <p className="mt-0.5 text-3xs text-faint">{detail}</p>
                </div>
              </div>
            ))}
          </div>
        </aside>
      </div>

      <section className="overflow-hidden rounded-window border border-border bg-card">
        <header className="border-b border-border px-4 py-4">
          <p className="text-3xs font-bold uppercase tracking-[0.09em] text-faint">
            {t("plan.sequence.eyebrow")}
          </p>
          <h2 className="mt-1 text-sm font-semibold text-foreground">{t("plan.sequence.title")}</h2>
        </header>
        <ol className="grid sm:grid-cols-2 lg:grid-cols-4">
          {steps.map(([title, detail], index) => (
            <li
              key={title}
              className="border-t border-border p-4 first:border-t-0 sm:border-l sm:first:border-l-0 lg:border-t-0"
            >
              <span className="font-mono text-3xs font-semibold text-primary">
                {String(index + 1).padStart(2, "0")}
              </span>
              <p className="mt-2 text-xs font-semibold text-foreground">{title}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{detail}</p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
