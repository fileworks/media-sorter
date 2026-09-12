import { useState, useMemo } from "react";
import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { useReportHistory } from "@/hooks/useReportHistory";
import { useToast } from "@/context/toast-context";
import { api } from "@/services/api";
import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalHeader } from "@/components/ui/modal";
import { ReportPanel } from "@/components/ReportPanel";
import { StateView } from "@/components/StateView";
import { triggerDownload } from "@/lib/download";
import { formatDuration } from "@/lib/formatters";
import { formatDate } from "@/lib/dateFormatters";
import { FiTrash2, FiAlertTriangle, FiSearch } from "react-icons/fi";
import { useI18n } from "@/i18n/I18nContext";
import { presentOutcome, type StatusTone } from "@/lib/statusPresentation";
import type { OperationOutcome, OperationReport } from "@/types/api";

// ── Report Modal ──────────────────────────────────────────────────────────────

function ReportModal({ operationId, onClose }: { operationId: string; onClose: () => void }) {
  const { t } = useI18n();

  const {
    data: report,
    isLoading,
    isError,
    refetch,
  } = useQuery<OperationReport>({
    queryKey: ["report", operationId],
    queryFn: () => api.getReport(operationId),
    staleTime: 60_000,
  });

  return (
    <Modal
      open
      onClose={onClose}
      title={t("history.reportTitle", { id: operationId })}
      size="xl"
      className="h-[calc(100dvh-2rem)]"
    >
      <ModalHeader />
      <ModalBody>
        {isLoading ? (
          <div className="animate-pulse space-y-4" aria-busy>
            <div className="h-24 rounded-window bg-muted" />
            <div className="h-48 rounded-window bg-muted" />
            <div className="h-64 rounded-window bg-muted" />
          </div>
        ) : isError ? (
          <StateView
            variant="error"
            title={t("history.loadFailed")}
            onRetry={() => void refetch()}
          />
        ) : report ? (
          <ReportPanel report={report} />
        ) : (
          <p className="py-12 text-center text-sm text-muted-foreground">
            {t("history.loadFailed")}
          </p>
        )}
      </ModalBody>
    </Modal>
  );
}

// ── Clear History confirmation ────────────────────────────────────────────────

function ClearHistoryButton() {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);

  // The last two direct API calls in the app. As mutations they get a pending
  // state, an error surface and cache invalidation like everything else.
  const clearHistory = useMutation({
    mutationFn: () => api.clearHistory(),
    onSuccess: async () => {
      // Invalidate all report-related queries so the list refreshes immediately
      await queryClient.invalidateQueries({ queryKey: ["reports"] });
      toast(t("history.cleared"), "success");
    },
    onError: () => toast(t("history.clearFailed"), "error"),
    onSettled: () => setConfirming(false),
  });
  const clearing = clearHistory.isPending;

  const handleClear = () => clearHistory.mutate();

  if (confirming) {
    return (
      <div className="flex items-center gap-2 rounded-panel border border-destructive/40 bg-destructive/10 px-3 py-2">
        <FiAlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        <span className="text-xs text-destructive">{t("history.deleteAll")}</span>
        <Button
          size="sm"
          variant="destructive"
          disabled={clearing}
          onClick={() => void handleClear()}
          className="h-6 px-2 text-xs"
        >
          {clearing ? t("history.deleting") : t("history.confirmDelete")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={clearing}
          onClick={() => setConfirming(false)}
          className="h-6 px-2 text-xs"
        >
          {t("common.cancel")}
        </Button>
      </div>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setConfirming(true)}
      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 gap-2"
    >
      <FiTrash2 className="h-3.5 w-3.5" />
      {t("history.clear")}
    </Button>
  );
}

// ── History Panel ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;

/**
 * Chip colours per tone. A chip is not a `StateView` — it is one cell in a
 * table of past runs — so it keeps its denser treatment, but it no longer holds
 * a second opinion about *which* tone each outcome deserves. That decision
 * belongs to `presentOutcome`, which the report and the outcome banner already
 * read, and restating it here is how the same run ends up amber in one place
 * and blue in another.
 */
const TONE_CLASSES: Record<StatusTone | "neutral", string> = {
  success: "border-success/40 bg-success/10 text-success",
  warning: "border-warning/40 bg-warning/10 text-warning",
  info: "border-info/40 bg-info/10 text-info",
  error: "border-error/40 bg-error/10 text-error",
  neutral: "border-border bg-muted text-muted-foreground",
};

function outcomeChipClass(outcome: OperationOutcome): string {
  if (outcome === "unknown") return TONE_CLASSES.neutral;
  return TONE_CLASSES[presentOutcome(outcome, 0).tone];
}

export function HistoryPanel() {
  const { t, locale, formatNumber } = useI18n();
  const { toast } = useToast();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [modalId, setModalId] = useState<string | null>(null);

  const { operations, total, isLoading, error, refetch } = useReportHistory(
    PAGE_SIZE,
    page * PAGE_SIZE,
  );

  const filteredOps = useMemo(() => {
    if (!search.trim()) return operations;
    const q = search.trim().toLowerCase();
    return operations.filter((op) => {
      const sources = op.source_roots
        .flatMap((root) => [root.path, root.display_name ?? ""])
        .join(" ")
        .toLowerCase();
      return (
        op.source_path.toLowerCase().includes(q) ||
        op.dest_path.toLowerCase().includes(q) ||
        sources.includes(q)
      );
    });
  }, [operations, search]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  // Exporting reads; it changes nothing, so it is not confirmed.
  const exportReport = useMutation({
    mutationFn: async (operationId: string) => {
      const blob = await api.exportReport(operationId, "csv");
      const filename = `mediasort_${operationId}_${new Date().toISOString().slice(0, 10)}.csv`;
      await triggerDownload(blob, filename);
    },
    onSuccess: () => toast(t("history.exported"), "success"),
    onError: () => toast(t("history.exportFailed"), "error"),
  });

  const handleExport = (operationId: string) => exportReport.mutate(operationId);

  // ── Loading skeleton ────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="animate-pulse space-y-3 py-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-16 rounded-window bg-muted" />
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <StateView variant="error" title={t("history.listFailed")} onRetry={() => void refetch()} />
    );
  }

  // ── Empty state ─────────────────────────────────────────────────────────────
  if (total === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <p className="text-sm font-medium text-foreground">{t("history.empty")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("history.emptyHelp")}</p>
      </div>
    );
  }

  // ── Main panel ──────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Header row: search + clear */}
      <div className="flex items-center justify-between gap-3">
        <div className="relative flex-1 max-w-xs">
          <FiSearch className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder={t("history.searchPlaceholder")}
            aria-label={t("history.searchLabel")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            className="h-8 w-full rounded-panel border border-input bg-background pl-8 pr-3 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <ClearHistoryButton />
      </div>

      {/* Search empty state */}
      {filteredOps.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <p className="text-sm text-muted-foreground">{t("history.noMatches")}</p>
        </div>
      ) : (
        <>
          {/* Operations list */}
          <div className="divide-y divide-border rounded-window border border-border bg-card">
            {filteredOps.map((op) => {
              const roots = op.source_roots.length
                ? op.source_roots
                : [{ root_id: "legacy", path: op.source_path, display_name: null }];
              const sourceLabel = roots.map((root) => root.display_name ?? root.path).join(", ");
              const changed =
                op.files_sorted +
                op.duplicates_found +
                op.future_dates +
                op.unknown_dates +
                op.corrupted_files +
                op.junk_files;
              const skipped = op.files_skipped + op.already_in_destination;
              const attention = op.files_failed + op.incomplete_units + op.unmatched_companions;
              return (
                <div
                  key={op.id}
                  className="flex flex-wrap items-center justify-between gap-4 px-4 py-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-2">
                      <p
                        className="min-w-0 truncate text-sm font-medium text-foreground"
                        title={`${sourceLabel} → ${op.dest_path}`}
                      >
                        {sourceLabel} → {op.dest_path}
                      </p>
                      <span
                        className={`shrink-0 rounded-full border px-2 py-0.5 text-3xs font-semibold ${outcomeChipClass(op.outcome)}`}
                      >
                        {t(`report.outcome.${op.outcome}`)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t("history.operationWhen", {
                        date: formatDate(op.finished_at ?? op.execution_date, { locale }),
                        duration: formatDuration(op.duration_seconds, { locale }),
                        mode: t(`report.runMode.${op.run_mode}`),
                      })}
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {t("history.operationCounts", {
                        changed: formatNumber(changed),
                        skipped: formatNumber(skipped),
                        attention: formatNumber(attention),
                        remaining: formatNumber(op.remaining_files),
                      })}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={exportReport.isPending && exportReport.variables === op.id}
                      onClick={() => void handleExport(op.id)}
                    >
                      {exportReport.isPending && exportReport.variables === op.id
                        ? "…"
                        : t("history.export")}
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setModalId(op.id)}>
                      {t("history.view")}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-3">
              <Button
                variant="ghost"
                size="sm"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                {t("history.previous")}
              </Button>
              <span className="tabular-nums text-xs text-muted-foreground">
                {t("history.page", { page: page + 1, pages: totalPages })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={(page + 1) * PAGE_SIZE >= total}
                onClick={() => setPage((p) => p + 1)}
              >
                {t("history.next")}
              </Button>
            </div>
          )}
        </>
      )}

      {/* Full-report modal */}
      {modalId && <ReportModal operationId={modalId} onClose={() => setModalId(null)} />}
    </div>
  );
}
