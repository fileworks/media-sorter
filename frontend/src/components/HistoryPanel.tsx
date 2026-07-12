import { useState, useMemo, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useReportHistory } from "@/hooks/useReportHistory";
import { useToast } from "@/context/toast-context";
import { api } from "@/services/api";
import { Button } from "@/components/ui/button";
import { ReportPanel } from "@/components/ReportPanel";
import { triggerDownload } from "@/lib/download";
import { formatDuration } from "@/lib/formatters";
import { formatDate } from "@/lib/dateFormatters";
import { FiTrash2, FiAlertTriangle, FiSearch, FiX } from "react-icons/fi";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import type { OperationReport } from "@/types/api";

// ── Report Modal ──────────────────────────────────────────────────────────────

function ReportModal({ operationId, onClose }: { operationId: string; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  useFocusTrap(panelRef, true);

  const { data: report, isLoading } = useQuery<OperationReport>({
    queryKey: ["report", operationId],
    queryFn: () => api.getReport(operationId),
    staleTime: 60_000,
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      role="dialog"
      aria-modal="true"
      aria-label={`Sort report ${operationId}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative flex h-[90vh] w-[90vw] max-w-5xl flex-col overflow-hidden rounded-xl bg-background shadow-2xl outline-none"
      >
        <div className="flex items-center justify-between border-b border-border px-6 py-4">
          <h2 className="text-sm font-semibold text-foreground">Sort Report — {operationId}</h2>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            aria-label="Close report"
          >
            <FiX className="h-4 w-4" />
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          {isLoading ? (
            <div className="animate-pulse space-y-4">
              <div className="h-24 rounded-xl bg-muted" />
              <div className="h-48 rounded-xl bg-muted" />
              <div className="h-64 rounded-xl bg-muted" />
            </div>
          ) : report ? (
            <ReportPanel report={report} />
          ) : (
            <p className="py-12 text-center text-sm text-muted-foreground">
              Failed to load report. Try again.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Clear History confirmation ────────────────────────────────────────────────

function ClearHistoryButton() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);

  const handleClear = async () => {
    setClearing(true);
    try {
      await api.clearHistory();
      // Invalidate all report-related queries so the list refreshes immediately
      await queryClient.invalidateQueries({ queryKey: ["reports"] });
      toast("History cleared", "success");
    } catch {
      toast("Could not clear history — try again", "error");
    } finally {
      setClearing(false);
      setConfirming(false);
    }
  };

  if (confirming) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2">
        <FiAlertTriangle className="h-3.5 w-3.5 shrink-0 text-destructive" />
        <span className="text-xs text-destructive">Delete all history?</span>
        <Button
          size="sm"
          variant="destructive"
          disabled={clearing}
          onClick={() => void handleClear()}
          className="h-6 px-2 text-xs"
        >
          {clearing ? "Deleting…" : "Yes, delete"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={clearing}
          onClick={() => setConfirming(false)}
          className="h-6 px-2 text-xs"
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={() => setConfirming(true)}
      className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 gap-1.5"
    >
      <FiTrash2 className="h-3.5 w-3.5" />
      Clear history
    </Button>
  );
}

// ── History Panel ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;

export function HistoryPanel() {
  const { toast } = useToast();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [modalId, setModalId] = useState<string | null>(null);

  const { operations, total, isLoading } = useReportHistory(PAGE_SIZE, page * PAGE_SIZE);

  const filteredOps = useMemo(() => {
    if (!search.trim()) return operations;
    const q = search.trim().toLowerCase();
    return operations.filter(
      (op) => op.source_path.toLowerCase().includes(q) || op.dest_path.toLowerCase().includes(q),
    );
  }, [operations, search]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const handleExport = async (operationId: string) => {
    setExportingId(operationId);
    try {
      const blob = await api.exportReport(operationId, "csv");
      const filename = `mediasort_${operationId}_${new Date().toISOString().slice(0, 10)}.csv`;
      await triggerDownload(blob, filename);
      toast("Report exported", "success");
    } catch {
      toast("Export failed", "error");
    } finally {
      setExportingId(null);
    }
  };

  // ── Loading skeleton ────────────────────────────────────────────────────────
  if (isLoading) {
    return (
      <div className="animate-pulse space-y-3 py-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-16 rounded-xl bg-muted" />
        ))}
      </div>
    );
  }

  // ── Empty state ─────────────────────────────────────────────────────────────
  if (total === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <p className="text-sm font-medium text-foreground">No past sorts yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Your sort history will appear here after your first run.
        </p>
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
            placeholder="Search by path…"
            aria-label="Search sort history by path"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            className="h-8 w-full rounded-md border border-input bg-background pl-8 pr-3 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
        <ClearHistoryButton />
      </div>

      {/* Search empty state */}
      {filteredOps.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 text-center">
          <p className="text-sm text-muted-foreground">No operations match your search.</p>
        </div>
      ) : (
        <>
          {/* Operations list */}
          <div className="divide-y divide-border rounded-xl border border-border bg-card">
            {filteredOps.map((op) => (
              <div
                key={op.id}
                className="flex flex-wrap items-center justify-between gap-4 px-4 py-4"
              >
                <div className="min-w-0 flex-1">
                  <p
                    className="truncate text-sm font-medium text-foreground"
                    title={`${op.source_path} → ${op.dest_path}`}
                  >
                    {op.source_path} → {op.dest_path}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {formatDate(op.execution_date)} · {op.total_files.toLocaleString()} files ·{" "}
                    {op.files_sorted.toLocaleString()} sorted ·{" "}
                    {((op.files_sorted / Math.max(op.total_files, 1)) * 100).toFixed(1)}% ·{" "}
                    {formatDuration(op.duration_seconds)}
                  </p>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={exportingId === op.id}
                    onClick={() => void handleExport(op.id)}
                  >
                    {exportingId === op.id ? "…" : "↓ Export"}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setModalId(op.id)}>
                    View
                  </Button>
                </div>
              </div>
            ))}
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
                ← Prev
              </Button>
              <span className="tabular-nums text-xs text-muted-foreground">
                Page {page + 1} of {totalPages}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={(page + 1) * PAGE_SIZE >= total}
                onClick={() => setPage((p) => p + 1)}
              >
                Next →
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
