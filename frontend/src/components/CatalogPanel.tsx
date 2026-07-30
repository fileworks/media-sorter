/**
 * The index, in plain sight: where it is, what it costs, and how stale it is.
 *
 * A cache the user cannot see is a cache they cannot trust. Everything here is
 * reversible — rebuilding a root or resetting the whole index costs time, never
 * media — but a full reset still asks first, because it throws away every hash
 * this machine has ever computed.
 */

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { StateView } from "@/components/StateView";
import { useI18n } from "@/i18n/I18nContext";
import { formatBytesShort } from "@/lib/optimizationProjection";
import { api } from "@/services/api";
import type { CatalogFreshness } from "@/services/api";

const FRESHNESS_TONE: Record<CatalogFreshness["state"], string> = {
  fresh: "text-success",
  stale: "text-warning",
  unknown: "text-muted-foreground",
  rebuilding: "text-info",
};

const FRESHNESS_KEY: Record<CatalogFreshness["state"], string> = {
  fresh: "catalog.freshness.fresh",
  stale: "catalog.freshness.stale",
  unknown: "catalog.freshness.unknown",
  rebuilding: "catalog.freshness.rebuilding",
};

export function CatalogPanel() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [confirmingReset, setConfirmingReset] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ["catalog", "diagnostics"],
    queryFn: () => api.catalogDiagnostics(),
  });

  const rebuild = useMutation({
    mutationFn: (options: { rootId?: string; confirmFullReset?: boolean }) =>
      api.rebuildCatalog(options),
    onSuccess: () => {
      setConfirmingReset(false);
      void queryClient.invalidateQueries({ queryKey: ["catalog", "diagnostics"] });
    },
  });

  if (isLoading) {
    return <StateView variant="loading" title={t("catalog.loading")} />;
  }
  if (error || !data) {
    return <StateView variant="error" title={t("catalog.error")} />;
  }

  return (
    <section className="space-y-4" aria-labelledby="catalog-panel-title">
      <header>
        <h2 id="catalog-panel-title" className="text-base font-semibold text-foreground">
          {t("catalog.title")}
        </h2>
        <p className="text-xs text-muted-foreground">
          {data.mode === "portable" ? t("catalog.mode.portable") : t("catalog.mode.application")}
        </p>
      </header>

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { label: t("catalog.size"), value: formatBytesShort(data.size_bytes) },
          { label: t("catalog.files"), value: data.files.toLocaleString() },
          { label: t("catalog.hashed"), value: data.hashed_files.toLocaleString() },
          { label: t("catalog.missing"), value: data.missing_files.toLocaleString() },
        ].map((fact) => (
          <div key={fact.label} className="rounded-lg border border-border p-3">
            <dt className="text-xs text-muted-foreground">{fact.label}</dt>
            <dd className="text-sm tabular-nums text-foreground">{fact.value}</dd>
          </div>
        ))}
      </dl>

      {data.over_soft_limit && (
        <p className="text-xs text-warning">
          {t("catalog.overLimit", { size: formatBytesShort(data.soft_limit_bytes) })}
        </p>
      )}

      <p className="break-all text-[11px] text-muted-foreground">{data.path}</p>

      {data.freshness.length > 0 && (
        <ul className="space-y-2">
          {data.freshness.map((root) => (
            <li
              key={root.root_id}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border p-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm text-foreground">{root.root_id}</p>
                <p className={`text-xs ${FRESHNESS_TONE[root.state]}`}>
                  {t(FRESHNESS_KEY[root.state])}
                  {root.issue_count > 0 &&
                    ` · ${t("catalog.inaccessible", { count: root.issue_count })}`}
                </p>
              </div>
              <button
                type="button"
                disabled={rebuild.isPending}
                aria-label={`${t("catalog.rebuildRoot")}: ${root.root_id}`}
                onClick={() => rebuild.mutate({ rootId: root.root_id })}
                className="rounded-lg border border-border px-3 py-1 text-xs hover:border-primary disabled:opacity-40"
              >
                {t("catalog.rebuildRoot")}
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="rounded-lg border border-border p-3">
        <p id="catalog-reset-title" className="text-sm text-foreground">
          {t("catalog.resetTitle")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">{t("catalog.resetHelp")}</p>
        {confirmingReset ? (
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              disabled={rebuild.isPending}
              aria-describedby="catalog-reset-title"
              onClick={() => rebuild.mutate({ confirmFullReset: true })}
              className="rounded-lg border border-error px-3 py-1 text-xs text-error disabled:opacity-40"
            >
              {t("catalog.resetConfirm")}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingReset(false)}
              className="rounded-lg border border-border px-3 py-1 text-xs"
            >
              {t("common.cancel")}
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-describedby="catalog-reset-title"
            onClick={() => setConfirmingReset(true)}
            className="mt-2 rounded-lg border border-border px-3 py-1 text-xs hover:border-error"
          >
            {t("catalog.reset")}
          </button>
        )}
      </div>
    </section>
  );
}
