import { useMemo, useRef, useState } from "react";
import { MediaPreviewModal } from "@/components/MediaPreviewModal";
import { ExecutePreflight } from "@/components/OperationCenter";
import { StateView } from "@/components/StateView";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nContext";
import { extractErrorMessage } from "@/lib/errorUtils";
import { api, type ReconciliationPlan, type ReconciliationReport } from "@/services/api";
import type { PreviewItem } from "@/types/api";

const PAGE_SIZE = 100;

export function DestinationReconciliationPanel({ items = [] }: { items?: PreviewItem[] }) {
  const { t } = useI18n();
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [filter, setFilter] = useState("all");
  const [pageCursors, setPageCursors] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmedProbable, setConfirmedProbable] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [planResult, setPlanResult] = useState<ReconciliationPlan | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [completed, setCompleted] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [inspected, setInspected] = useState<PreviewItem | null>(null);
  const inspectorOriginRef = useRef<HTMLElement | null>(null);
  const previewBySource = useMemo(() => new Map(items.map((item) => [item.source, item])), [items]);

  const visible = report?.findings ?? [];

  const compare = async () => {
    setRunning(true);
    setError(null);
    setPlanResult(null);
    setCompleted(null);
    try {
      setReport(await api.reconcileDestination());
      setSelected([]);
      setConfirmedProbable([]);
      setPageCursors([null]);
      setPageIndex(0);
    } catch (cause) {
      setError(extractErrorMessage(cause, t("reconcile.failed")));
    } finally {
      setRunning(false);
    }
  };

  const plan = async () => {
    if (!report) return;
    setError(null);
    try {
      setPlanResult(await api.planReconciliation(report, selected, confirmedProbable));
      setAcknowledged(false);
    } catch (cause) {
      setError(extractErrorMessage(cause, t("reconcile.planFailed")));
    }
  };

  const execute = async () => {
    if (!planResult) return;
    setError(null);
    try {
      const result = await api.executeReconciliation(planResult.plan_id);
      setCompleted(result.completed);
      setPlanResult(null);
      setAcknowledged(false);
    } catch (cause) {
      setError(extractErrorMessage(cause, t("reconcile.executeFailed")));
    }
  };

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );

  const loadPage = async (
    cursor: string | null,
    nextFilter: string,
    nextIndex: number,
    cursors: Array<string | null>,
  ) => {
    if (!report) return;
    setRunning(true);
    setError(null);
    try {
      const page = await api.reconciliationFindings(report.report_id, {
        cursor,
        classification:
          nextFilter === "all"
            ? undefined
            : (nextFilter as ReconciliationReport["findings"][number]["classification"]),
        limit: PAGE_SIZE,
      });
      setReport(page);
      setPageCursors(cursors);
      setPageIndex(nextIndex);
    } catch (cause) {
      setError(extractErrorMessage(cause, t("reconcile.failed")));
    } finally {
      setRunning(false);
    }
  };

  return (
    <section className="space-y-4" aria-labelledby="reconciliation-title">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="reconciliation-title" className="text-base font-semibold text-foreground">
            {t("reconcile.title")}
          </h2>
          <p className="text-xs text-muted-foreground">{t("reconcile.directional")}</p>
        </div>
        <Button disabled={running} onClick={() => void compare()}>
          {running ? t("reconcile.running") : t("reconcile.run")}
        </Button>
      </header>

      {error && <StateView variant="error" compact title={t("reconcile.failed")} detail={error} />}
      {!report && !running && !error && (
        <StateView variant="empty" compact title={t("reconcile.notRun")} />
      )}
      {report && (
        <>
          <div className="rounded-lg border border-border bg-card p-3 text-xs text-muted-foreground">
            {t("reconcile.coverage", {
              input: t(`reconcile.coverage.${report.input_coverage}`),
              destination: t(`reconcile.coverage.${report.destination_coverage}`),
            })}
            {report.issues.map((issue) => (
              <p key={issue} className="mt-1 text-warning">
                {issue}
              </p>
            ))}
          </div>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            {t("reconcile.filter")}
            <select
              value={filter}
              onChange={(event) => {
                const nextFilter = event.target.value;
                setFilter(nextFilter);
                void loadPage(null, nextFilter, 0, [null]);
              }}
              className="rounded border border-border bg-background px-2 py-1 text-foreground"
            >
              {["all", "missing", "misplaced", "extra", "matched", "unknown"].map((value) => (
                <option key={value} value={value}>
                  {t(`reconcile.class.${value}`)}
                </option>
              ))}
            </select>
          </label>
          <ul className="space-y-2">
            {visible.map((finding) => {
              const explainedItem = finding.input_path
                ? previewBySource.get(finding.input_path)
                : undefined;
              return (
                <li
                  key={finding.finding_id}
                  className="rounded-lg border border-border bg-card p-3"
                >
                  <div className="flex items-start gap-3">
                    {finding.actionable ? (
                      <input
                        type="checkbox"
                        checked={selected.includes(finding.finding_id)}
                        onChange={() => toggle(finding.finding_id)}
                        aria-label={t("reconcile.selectFinding")}
                      />
                    ) : (
                      <span aria-label={t("reconcile.informational")}>ℹ</span>
                    )}
                    <div className="min-w-0 space-y-1 text-xs">
                      <p className="font-medium text-foreground">
                        {t(`reconcile.class.${finding.classification}`)} ·{" "}
                        {t(`reconcile.identity.${finding.identity}`)}
                      </p>
                      <p className="break-all font-mono text-muted-foreground">
                        {finding.input_path ?? finding.destination_path}
                      </p>
                      {finding.expected_path && (
                        <p className="break-all font-mono text-muted-foreground">
                          → {finding.expected_path}
                        </p>
                      )}
                      <p className="text-muted-foreground">{finding.measured_against}</p>
                      {finding.identity === "probable" && (
                        <>
                          <p className="text-warning">
                            {t("reconcile.probableEvidence", {
                              distance: finding.perceptual_distance ?? "—",
                              metadata: finding.metadata_agreement
                                ? t("common.yes")
                                : t("common.no"),
                            })}
                          </p>
                          <label className="flex items-center gap-2 text-warning">
                            <input
                              type="checkbox"
                              checked={confirmedProbable.includes(finding.finding_id)}
                              onChange={() =>
                                setConfirmedProbable((current) =>
                                  current.includes(finding.finding_id)
                                    ? current.filter((item) => item !== finding.finding_id)
                                    : [...current, finding.finding_id],
                                )
                              }
                            />
                            {t("reconcile.confirmProbable")}
                          </label>
                        </>
                      )}
                      {finding.classification === "extra" && (
                        <p className="text-muted-foreground">{t("reconcile.extraInert")}</p>
                      )}
                      {finding.classification === "misplaced" && explainedItem && (
                        <button
                          type="button"
                          className="rounded border border-border px-2 py-1 text-xs text-foreground hover:border-primary"
                          onClick={(event) => {
                            inspectorOriginRef.current = event.currentTarget;
                            setInspected(explainedItem);
                          }}
                        >
                          {t("reconcile.explainOutcome")}
                        </button>
                      )}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={pageIndex === 0 || running}
                onClick={() => {
                  const previousIndex = pageIndex - 1;
                  void loadPage(
                    pageCursors[previousIndex] ?? null,
                    filter,
                    previousIndex,
                    pageCursors,
                  );
                }}
              >
                {t("common.previous")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!report.next_cursor || running}
                onClick={() => {
                  if (!report.next_cursor) return;
                  const nextIndex = pageIndex + 1;
                  const cursors = [...pageCursors.slice(0, nextIndex), report.next_cursor];
                  void loadPage(report.next_cursor, filter, nextIndex, cursors);
                }}
              >
                {t("common.next")}
              </Button>
            </div>
            <Button disabled={selected.length === 0} onClick={() => void plan()}>
              {t("reconcile.plan", { count: selected.length })}
            </Button>
          </div>
          {planResult && (
            <div className="space-y-3">
              <p role="status" className="rounded bg-success/10 p-2 text-sm text-success">
                {t("reconcile.planReady")}
              </p>
              <ExecutePreflight
                input={{
                  actionableGroups: 1,
                  quarantineCount: 0,
                  quarantineBytes: 0,
                  copyCount: planResult.action_count,
                  moveCount: 0,
                  skipCount: 0,
                  referenceCount: 0,
                  sourceMutations: planResult.source_mutations,
                  acknowledgedSourceMutations: acknowledged,
                  staleGroups: 0,
                  unresolvedGroups: 0,
                  freeBytes: null,
                  requiredBytes: planResult.bytes_affected,
                  quarantineWritable: true,
                  conversionWithoutOriginals: 0,
                  companionsLeftInPlace: 0,
                  embeddedTagCount: 0,
                }}
                onAcknowledge={setAcknowledged}
                onExecute={() => void execute()}
              />
            </div>
          )}
          {completed !== null && (
            <p role="status" className="rounded bg-success/10 p-2 text-sm text-success">
              {t("reconcile.executed", { count: completed })}
            </p>
          )}
        </>
      )}
      {inspected && (
        <MediaPreviewModal
          item={inspected}
          items={items}
          onClose={() => {
            setInspected(null);
            requestAnimationFrame(() => inspectorOriginRef.current?.focus());
          }}
        />
      )}
    </section>
  );
}
