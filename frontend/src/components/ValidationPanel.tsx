/**
 * The validation report: what is wrong, how sure the check is, and what it
 * never looked at.
 *
 * A disabled check is shown as disabled, not as passed. A run that could not
 * read part of the library says so at the top, permanently — no combination of
 * green rows promotes a partial report into a clean bill of health.
 */

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { StateView } from "@/components/StateView";
import { useI18n } from "@/i18n/I18nContext";
import { api } from "@/services/api";
import type { ValidationFinding } from "@/services/api";

const CATEGORY_KEY: Record<string, string> = {
  misplaced: "validation.category.misplaced",
  inconsistent_name: "validation.category.inconsistentName",
  exact_duplicate: "validation.category.exactDuplicate",
  similar_media: "validation.category.similarMedia",
  unreadable: "validation.category.unreadable",
  missing_sidecar: "validation.category.missingSidecar",
  catalog_stale: "validation.category.catalogStale",
};

const STATE_TONE: Record<ValidationFinding["state"], string> = {
  failed: "text-warning",
  passed: "text-success",
  disabled: "text-muted-foreground",
  not_evaluated: "text-muted-foreground",
  unknown: "text-muted-foreground",
};

const STATE_KEY: Record<ValidationFinding["state"], string> = {
  failed: "validation.state.failed",
  passed: "validation.state.passed",
  disabled: "validation.state.disabled",
  not_evaluated: "validation.state.notEvaluated",
  unknown: "validation.state.unknown",
};

export function ValidationPanel({ rootId }: { rootId: string }) {
  const { t } = useI18n();
  const [showPassed, setShowPassed] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["validation", rootId],
    queryFn: () => api.runValidation(rootId),
    enabled: Boolean(rootId),
  });

  const visible = useMemo(() => {
    const findings = data?.findings ?? [];
    return showPassed ? findings : findings.filter((finding) => finding.state === "failed");
  }, [data, showPassed]);

  if (!rootId) {
    return <StateView variant="blocked" title={t("validation.noRoot")} />;
  }
  if (isLoading) return <StateView variant="loading" title={t("validation.loading")} />;
  if (error || !data) {
    return <StateView variant="error" title={t("validation.error")} />;
  }

  return (
    <section className="space-y-3" aria-labelledby="validation-panel-title">
      <header className="space-y-1">
        <h2 id="validation-panel-title" className="text-base font-semibold text-foreground">
          {t("validation.title")}
        </h2>
        {data.unreachable_scopes.length > 0 ? (
          <p className="rounded-lg border border-warning/40 bg-warning/5 p-2 text-xs text-warning">
            {t("validation.partial", { count: data.unreachable_scopes.length })}
          </p>
        ) : (
          <p className="text-xs text-muted-foreground">{t("validation.complete")}</p>
        )}
      </header>

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={showPassed}
          aria-controls="validation-findings"
          onChange={(event) => setShowPassed(event.target.checked)}
        />
        {t("validation.showAll")}
      </label>

      {visible.length === 0 ? (
        <StateView variant="empty" compact title={t("validation.empty")} />
      ) : (
        <div id="validation-findings" className="overflow-x-auto" aria-live="polite">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">{t("validation.tableCaption")}</caption>
            <thead>
              <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="pb-2 pr-3 font-medium">
                  {t("validation.column.check")}
                </th>
                <th scope="col" className="pb-2 pr-3 font-medium">
                  {t("validation.column.file")}
                </th>
                <th scope="col" className="pb-2 pr-3 font-medium">
                  {t("validation.column.evidence")}
                </th>
                <th scope="col" className="pb-2 font-medium">
                  {t("validation.column.confidence")}
                </th>
              </tr>
            </thead>
            <tbody>
              {visible.map((finding) => (
                <tr key={finding.finding_id} className="border-t border-border align-top">
                  <td className="py-2 pr-3">
                    <div className="text-foreground">
                      {t(CATEGORY_KEY[finding.category] ?? finding.category)}
                    </div>
                    <div className={`text-xs ${STATE_TONE[finding.state]}`}>
                      {t(STATE_KEY[finding.state])}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">
                    <div className="truncate" title={finding.current_path ?? undefined}>
                      {finding.current_path ?? "—"}
                    </div>
                    {finding.expected_path && (
                      <div className="truncate text-2xs" title={finding.expected_path}>
                        {t("validation.expected", { path: finding.expected_path })}
                      </div>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-xs text-muted-foreground">{finding.evidence}</td>
                  <td className="py-2 text-xs text-muted-foreground">{finding.confidence}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data.disabled_categories.length > 0 && (
        <p className="text-2xs text-muted-foreground">
          {t("validation.disabled", { categories: data.disabled_categories.join(", ") })}
        </p>
      )}
    </section>
  );
}
