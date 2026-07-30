/**
 * The quarantine manager: everything held, why, and how to get it back.
 *
 * Restoring is the ordinary action and is previewed before it moves anything.
 * Permanent removal lives here too — visibly separate, behind a frozen impact
 * preview and its own acknowledgement, because it is the one thing in this
 * application that cannot be undone.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { formatBytesShort } from "@/lib/optimizationProjection";
import { redactRoot } from "@/lib/operationHistory";
import { api } from "@/services/api";
import type { CleanupImpact, QuarantineRecord } from "@/services/api";
import { useI18n } from "@/i18n/I18nContext";

const REASON_LABEL: Record<string, string> = {
  duplicate: "quarantine.reason.duplicate",
  optimization_original: "quarantine.reason.optimizationOriginal",
  replaced: "quarantine.reason.replaced",
  junk: "quarantine.reason.junk",
  unknown_date: "quarantine.reason.unknownDate",
  corrupt: "quarantine.reason.corrupt",
  user_request: "quarantine.reason.userRequest",
};

export function QuarantineManager() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [impact, setImpact] = useState<CleanupImpact | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const { data: records = [] } = useQuery({
    queryKey: ["quarantine", "records"],
    queryFn: () => api.listQuarantine(),
  });
  const { data: summary } = useQuery({
    queryKey: ["quarantine", "summary"],
    queryFn: () => api.quarantineSummary(),
  });

  const cleanup = useMutation({
    mutationFn: (frozen: CleanupImpact) => api.cleanupQuarantine(frozen.record_ids, true),
    onSuccess: () => {
      setImpact(null);
      setAcknowledged(false);
      setSelected(new Set());
      void queryClient.invalidateQueries({ queryKey: ["quarantine"] });
    },
  });

  const toggle = (recordId: string) => {
    setImpact(null);
    setAcknowledged(false);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(recordId)) next.delete(recordId);
      else next.add(recordId);
      return next;
    });
  };

  const retained = records.filter((record: QuarantineRecord) => record.retention === "retained");

  return (
    <section className="space-y-4">
      <header>
        <h2 className="text-base font-semibold text-foreground">{t("quarantine.title")}</h2>
        <p className="text-xs text-muted-foreground">
          {summary
            ? t("quarantine.summary", {
                count: summary.retained_count,
                bytes: formatBytesShort(summary.retained_bytes),
              })
            : t("quarantine.neverAutomatic")}
        </p>
      </header>

      {retained.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("quarantine.empty")}</p>
      ) : (
        <ul className="space-y-2">
          {retained.map((record: QuarantineRecord) => (
            <li
              key={record.record_id}
              className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-3"
            >
              <label className="flex min-w-0 items-start gap-2">
                <input
                  type="checkbox"
                  checked={selected.has(record.record_id)}
                  onChange={() => toggle(record.record_id)}
                  aria-label={t("quarantine.select", { path: record.original_path })}
                />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-foreground">
                    {redactRoot(record.original_path)}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {t(REASON_LABEL[record.reason] ?? "quarantine.reason.other", {
                      reason: record.reason,
                    })}{" "}
                    · {formatBytesShort(record.size_bytes)} ·{" "}
                    {t("quarantine.ageDays", { count: Math.round(record.age_days) })}
                  </span>
                  {record.keeper_path && (
                    <span className="block text-2xs text-muted-foreground">
                      {t("quarantine.keptInstead", {
                        path: redactRoot(record.keeper_path),
                      })}
                    </span>
                  )}
                </span>
              </label>
              <button
                type="button"
                onClick={() =>
                  api.previewRestore(record.record_id).then((preview) => {
                    if (preview.restorable) {
                      void queryClient.invalidateQueries({ queryKey: ["quarantine"] });
                    }
                  })
                }
                className="rounded-lg border border-border px-3 py-1 text-xs hover:border-primary"
              >
                {t("quarantine.previewRestore")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-lg border border-border p-3">
        <h3 className="text-sm text-foreground">{t("quarantine.removeSelected")}</h3>
        <p className="mt-1 text-xs text-muted-foreground">{t("quarantine.removeDescription")}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <button
            type="button"
            disabled={selected.size === 0}
            onClick={() => api.previewCleanup([...selected]).then(setImpact)}
            className="rounded-lg border border-border px-3 py-1 text-xs hover:border-error disabled:opacity-40"
          >
            {t("quarantine.previewDelete")}
          </button>
        </div>

        {impact && (
          <div className="mt-3 rounded-lg border border-error/40 bg-error/5 p-3 text-xs">
            <p className="text-foreground">{impact.acknowledgement_text}</p>
            {impact.excluded_reasons.length > 0 && (
              <ul className="mt-1 text-muted-foreground">
                {impact.excluded_reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            )}
            <label className="mt-2 flex items-center gap-2">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              {t("quarantine.acknowledge")}
            </label>
            <button
              type="button"
              disabled={!acknowledged || impact.item_count === 0 || cleanup.isPending}
              onClick={() => cleanup.mutate(impact)}
              className="mt-2 rounded-lg border border-error px-3 py-1 text-error disabled:opacity-40"
            >
              {t("quarantine.deletePermanently", { count: impact.item_count })}
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
