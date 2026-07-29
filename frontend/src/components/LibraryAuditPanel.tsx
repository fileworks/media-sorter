import { useMemo, useState } from "react";
import { ExecutePreflight } from "@/components/OperationCenter";
import { StateView } from "@/components/StateView";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nContext";
import { extractErrorMessage } from "@/lib/errorUtils";
import { api, type AuditActionPlan, type AuditReport } from "@/services/api";

interface LibraryAuditPanelProps {
  root: string;
}

export function LibraryAuditPanel({ root }: LibraryAuditPanelProps) {
  const { t } = useI18n();
  const [subtree, setSubtree] = useState("");
  const [sample, setSample] = useState(1);
  const [report, setReport] = useState<AuditReport | null>(null);
  const [previousCount, setPreviousCount] = useState<number | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [plan, setPlan] = useState<AuditActionPlan | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [completed, setCompleted] = useState<number | null>(null);

  const groups = useMemo(() => {
    const grouped = new Map<string, AuditReport["findings"]>();
    for (const finding of report?.findings ?? []) {
      grouped.set(finding.category, [...(grouped.get(finding.category) ?? []), finding]);
    }
    return [...grouped.entries()];
  }, [report]);

  const run = async () => {
    setRunning(true);
    setError(null);
    try {
      const next = await api.runLibraryAudit({
        root,
        subtree,
        sampleProportion: sample,
      });
      const history = await api.auditHistory();
      const previous = history.find((item) => item.audit_id !== next.audit_id);
      setPreviousCount(previous?.findings.length ?? null);
      setReport(next);
      setSelected([]);
      setPlan(null);
      setAcknowledged(false);
      setCompleted(null);
    } catch (cause) {
      setError(extractErrorMessage(cause, t("audit.failed")));
    } finally {
      setRunning(false);
    }
  };

  const buildPlan = async () => {
    if (!report || selected.length === 0) return;
    setError(null);
    try {
      setPlan(await api.planAuditFixes(report.audit_id, selected));
      setAcknowledged(false);
    } catch (cause) {
      setError(extractErrorMessage(cause, t("audit.planFailed")));
    }
  };

  const executePlan = async () => {
    if (!plan) return;
    setError(null);
    try {
      const result = await api.executeAuditFixes(plan.plan_id);
      setCompleted(result.completed);
      setPlan(null);
      setAcknowledged(false);
    } catch (cause) {
      setError(extractErrorMessage(cause, t("audit.executeFailed")));
    }
  };

  const download = async (format: "csv" | "json") => {
    if (!report) return;
    const blob = await api.exportAudit(report.audit_id, format);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${report.audit_id}.${format}`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section
      className="space-y-4 rounded-xl border border-border bg-card p-4"
      aria-labelledby="audit-title"
    >
      <header>
        <h2 id="audit-title" className="text-base font-semibold text-foreground">
          {t("audit.title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("audit.readOnly")}</p>
      </header>

      <div className="grid gap-3 sm:grid-cols-[1fr_10rem_auto]">
        <label className="space-y-1 text-xs text-muted-foreground">
          {t("audit.subtree")}
          <input
            value={subtree}
            onChange={(event) => setSubtree(event.target.value)}
            placeholder={t("audit.wholeLibrary")}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          {t("audit.sample")}
          <select
            value={sample}
            onChange={(event) => setSample(Number(event.target.value))}
            className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
          >
            <option value={1}>{t("audit.sample.full")}</option>
            <option value={0.25}>25%</option>
            <option value={0.1}>10%</option>
            <option value={0.01}>1%</option>
          </select>
        </label>
        <Button className="self-end" disabled={running} onClick={() => void run()}>
          {running ? t("audit.running") : t("audit.run")}
        </Button>
      </div>

      {error && <StateView variant="error" compact title={t("audit.failed")} detail={error} />}

      {report && (
        <div className="space-y-4" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span>{t(`audit.coverage.${report.coverage}`)}</span>
            <span>·</span>
            <span>{t("audit.scanned", { count: report.scanned_files })}</span>
            <span>·</span>
            <span>{t("audit.baselines", { count: report.baseline_established })}</span>
            <span>·</span>
            <span>
              {t("audit.new", {
                count: report.findings.filter((item) => item.newly_appeared).length,
              })}
            </span>
            {previousCount !== null && (
              <span>
                ·{" "}
                {t("audit.trajectory", {
                  previous: previousCount,
                  current: report.findings.length,
                })}
              </span>
            )}
          </div>

          {groups.length === 0 ? (
            <p className="rounded-md bg-success/10 p-3 text-sm text-success">{t("audit.intact")}</p>
          ) : (
            groups.map(([category, findings]) => (
              <section key={category} aria-labelledby={`audit-${category}`}>
                <h3 id={`audit-${category}`} className="text-sm font-medium text-foreground">
                  {t(`audit.category.${category}`, {}, category)} ({findings.length})
                </h3>
                <ul className="mt-1 space-y-1">
                  {findings.map((finding) => (
                    <li
                      key={finding.finding_id}
                      className="rounded-md border border-border bg-muted/20 p-2 text-xs"
                    >
                      <p className="flex items-start gap-2 break-all font-mono text-foreground">
                        {finding.actionable && finding.suggested_path && (
                          <input
                            type="checkbox"
                            checked={selected.includes(finding.finding_id)}
                            aria-label={t("audit.selectFinding", {
                              path: finding.relative_path,
                            })}
                            onChange={() =>
                              setSelected((current) =>
                                current.includes(finding.finding_id)
                                  ? current.filter((item) => item !== finding.finding_id)
                                  : [...current, finding.finding_id],
                              )
                            }
                          />
                        )}
                        <span>{finding.relative_path}</span>
                        {finding.newly_appeared && (
                          <span className="ml-2 rounded bg-warning/10 px-1 text-warning">
                            {t("audit.newBadge")}
                          </span>
                        )}
                      </p>
                      <p className="mt-1 text-muted-foreground">{finding.evidence}</p>
                      {finding.suggested_path && (
                        <p className="mt-1 break-all text-muted-foreground">
                          {t("audit.suggestedPath", { path: finding.suggested_path })}
                        </p>
                      )}
                      <p className="mt-1 text-muted-foreground">
                        {finding.actionable ? t("audit.safeAction") : t("audit.noSafeAction")}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}

          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={selected.length === 0}
              onClick={() => void buildPlan()}
            >
              {t("audit.buildPlan", { count: selected.length })}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void download("json")}>
              {t("audit.exportJson")}
            </Button>
            <Button variant="outline" size="sm" onClick={() => void download("csv")}>
              {t("audit.exportCsv")}
            </Button>
          </div>
          {plan && (
            <ExecutePreflight
              input={{
                actionableGroups: 1,
                quarantineCount: 0,
                quarantineBytes: 0,
                copyCount: 0,
                moveCount: plan.action_count,
                skipCount: 0,
                referenceCount: 0,
                sourceMutations: plan.source_mutations,
                acknowledgedSourceMutations: acknowledged,
                staleGroups: 0,
                unresolvedGroups: 0,
                freeBytes: null,
                requiredBytes: plan.bytes_affected,
                quarantineWritable: true,
                conversionWithoutOriginals: 0,
                companionsLeftInPlace: 0,
                embeddedTagCount: 0,
              }}
              onAcknowledge={setAcknowledged}
              onExecute={() => void executePlan()}
            />
          )}
          {completed !== null && (
            <p role="status" className="rounded bg-success/10 p-2 text-sm text-success">
              {t("audit.executed", { count: completed })}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
