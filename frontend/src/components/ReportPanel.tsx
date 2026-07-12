import { useState, useMemo } from "react";
import { FiLoader, FiSearch } from "react-icons/fi";
import { api } from "@/services/api";
import { useToast } from "@/context/toast-context";
import { Button } from "@/components/ui/button";
import { ValidationBadge } from "@/components/ui/validation-badge";
import { triggerDownload } from "@/lib/download";
import { cn } from "@/lib/utils";
import { formatDuration } from "@/lib/formatters";
import { useCountUp } from "@/hooks/useCountUp";
import type { OperationReport, FileOperationRecord } from "@/types/api";

// ── Props ─────────────────────────────────────────────────────────────────────

export interface ReportPanelProps {
  report: OperationReport;
}

// ── Formatters ────────────────────────────────────────────────────────────────

function pct(value: number, total: number): string {
  if (total === 0) return "0.0%";
  return `${((value / total) * 100).toFixed(1)}%`;
}

// ── Section A — Summary Cards ─────────────────────────────────────────────────

function SummaryCard({
  label,
  value,
  subtext,
  color,
}: {
  label: string;
  value: number;
  subtext: string;
  color: string;
}) {
  const display = useCountUp(value);
  return (
    <div className="rounded-xl border border-border bg-muted/30 p-4 text-center">
      <p className="mb-1 text-xs text-muted-foreground">{label}</p>
      <p className={cn("text-2xl font-bold tabular-nums", color)}>{display.toLocaleString()}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{subtext}</p>
    </div>
  );
}

// ── Section B — Statistics Dashboard ─────────────────────────────────────────

/** CSS-only vertical bar chart for files-per-year. */
function BarChart({ data }: { data: Record<string, number> | undefined }) {
  const BAR_MAX_PX = 72;
  const entries = Object.entries(data ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const max = Math.max(...entries.map(([, v]) => v), 1);

  return (
    <div
      className="flex items-end gap-1 overflow-x-auto pb-1"
      style={{ minHeight: `${BAR_MAX_PX + 40}px` }}
    >
      {entries.map(([label, value]) => (
        <div key={label} className="flex min-w-[28px] flex-1 flex-col items-center gap-1">
          <span className="text-[10px] font-mono leading-none text-muted-foreground">{value}</span>
          <div
            className="w-full rounded-t bg-info/60 transition-colors hover:bg-info/80"
            style={{ height: `${Math.max((value / max) * BAR_MAX_PX, 4)}px` }}
          />
          <span className="text-[10px] leading-none text-muted-foreground">{label}</span>
        </div>
      ))}
    </div>
  );
}

/** Horizontal stacked percentage bar for file types.
 * Categorical chart palette — deliberately raw values: the semantic tokens
 * cover statuses, not an n-way series. */
const TYPE_COLORS = [
  "bg-blue-500",
  "bg-green-500",
  "bg-amber-500",
  "bg-purple-500",
  "bg-rose-500",
  "bg-slate-400",
];

function TypeBar({ data }: { data: Record<string, number> | undefined }) {
  const safeData = data ?? {};
  const total = Math.max(
    Object.values(safeData).reduce((a, b) => a + b, 0),
    1,
  );
  const entries = Object.entries(safeData).sort(([, a], [, b]) => b - a);
  return (
    <div className="space-y-3">
      <div className="flex h-4 w-full overflow-hidden rounded-full">
        {entries.map(([type, count], i) => (
          <div
            key={type}
            className={TYPE_COLORS[i % TYPE_COLORS.length]}
            style={{ width: `${(count / total) * 100}%` }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {entries.map(([type, count], i) => (
          <div key={type} className="flex items-center gap-1.5 text-xs">
            <span className={cn("h-2.5 w-2.5 rounded-sm", TYPE_COLORS[i % TYPE_COLORS.length])} />
            <span className="capitalize">{type.replace(/^\./, "")}</span>
            <span className="text-muted-foreground">({count})</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Top camera models list with percentage bars. */
function CameraTable({ data }: { data: Record<string, number> }) {
  const total = Math.max(
    Object.values(data).reduce((a, b) => a + b, 0),
    1,
  );
  const entries = Object.entries(data)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8);

  if (entries.length === 0) {
    return <p className="text-xs italic text-muted-foreground">No camera data available</p>;
  }

  return (
    <div className="space-y-2">
      {entries.map(([model, count]) => (
        <div key={model} className="space-y-0.5">
          <div className="flex items-center justify-between text-xs">
            <span className="truncate text-foreground" title={model}>
              {model || "Unknown"}
            </span>
            <span className="ml-2 shrink-0 tabular-nums text-muted-foreground">
              {count} ({((count / total) * 100).toFixed(0)}%)
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-muted-foreground/40"
              style={{ width: `${(count / total) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

type ReportStatistics = NonNullable<OperationReport["statistics"]>;

function StatsDashboard({
  statistics,
  open,
  onToggle,
}: {
  statistics: ReportStatistics;
  open: boolean;
  onToggle: () => void;
}) {
  const hasYears = Object.keys(statistics.files_per_year ?? {}).length > 0;
  const hasTypes = Object.keys(statistics.files_per_type ?? {}).length > 0;
  const hasCameras = Object.keys(statistics.camera_models ?? {}).length > 0;

  return (
    <div className="rounded-xl border border-border bg-card">
      <button
        onClick={onToggle}
        className="flex w-full items-center justify-between rounded-xl px-4 py-3 text-sm font-medium text-foreground transition-colors hover:bg-accent/50"
      >
        <span>Statistics Dashboard</span>
        <span className="text-muted-foreground">{open ? "▲" : "▼"}</span>
      </button>
      {open && (
        <div className="space-y-5 border-t border-border px-4 pb-5 pt-4">
          {hasYears && (
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Files per year
              </p>
              <BarChart data={statistics.files_per_year} />
            </div>
          )}
          <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
            {hasTypes && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  File types
                </p>
                <TypeBar data={statistics.files_per_type} />
              </div>
            )}
            {hasCameras && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                  Top camera models
                </p>
                <CameraTable data={statistics.camera_models} />
              </div>
            )}
          </div>
          {!hasYears && !hasTypes && !hasCameras && (
            <p className="text-xs italic text-muted-foreground">No statistics data.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Section C — File Table ────────────────────────────────────────────────────

type FilterTab = "all" | "sorted" | "quarantined" | "duplicates" | "failed";
type SortCol = keyof Pick<
  FileOperationRecord,
  "source_path" | "dest_path" | "extracted_date" | "metadata_source" | "status"
>;

const FILTER_TABS: {
  id: FilterTab;
  label: string;
  statuses: string[] | null;
}[] = [
  { id: "all", label: "All", statuses: null },
  { id: "sorted", label: "✓ Sorted", statuses: ["success"] },
  {
    id: "quarantined",
    label: "⚠ Quarantined",
    statuses: ["unknown_date", "future_date", "corrupted", "junk"],
  },
  {
    id: "duplicates",
    label: "≈ Duplicates",
    statuses: ["duplicate", "already_in_destination"],
  },
  { id: "failed", label: "✕ Failed", statuses: ["failed"] },
];

const STATUS_STYLES: Record<string, { label: string; className: string }> = {
  success: {
    label: "✓ sorted",
    className: "text-success bg-success/10",
  },
  unknown_date: {
    label: "? unknown date",
    className: "text-warning bg-warning/10",
  },
  future_date: {
    label: "future date",
    className: "text-warning bg-warning/10",
  },
  duplicate: {
    label: "≈ duplicate",
    className: "text-info bg-info/10",
  },
  failed: {
    label: "✕ failed",
    className: "text-error bg-error/10",
  },
  corrupted: {
    label: "⚠ corrupted",
    className: "text-warning bg-warning/10",
  },
  junk: {
    label: "⊘ junk",
    className: "text-warning bg-warning/10",
  },
  already_in_destination: {
    label: "≈ in destination",
    className: "text-info bg-info/10",
  },
};

function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLES[status] ?? {
    label: status,
    className: "text-muted-foreground bg-muted",
  };
  return (
    <span
      className={cn("whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium", s.className)}
    >
      {s.label}
    </span>
  );
}

const FILE_PAGE_SIZE = 50;

const SORT_COLUMNS: { col: SortCol; label: string }[] = [
  { col: "source_path", label: "Source" },
  { col: "dest_path", label: "Destination" },
  { col: "extracted_date", label: "Date" },
  { col: "metadata_source", label: "Date source" },
  { col: "status", label: "Status" },
];

function FileTableSection({
  files,
  suspiciousCount,
}: {
  files: FileOperationRecord[];
  suspiciousCount: number;
}) {
  const [tab, setTab] = useState<FilterTab>("all");
  const [search, setSearch] = useState("");
  const [sortCol, setSortCol] = useState<SortCol>("source_path");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [page, setPage] = useState(0);

  const handleSortClick = (col: SortCol) => {
    if (col === sortCol) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortCol(col);
      setSortDir("asc");
    }
    setPage(0);
  };

  // Pre-compute tab counts once
  const tabCounts = useMemo(() => {
    const counts: Record<FilterTab, number> = {
      all: files.length,
      sorted: 0,
      quarantined: 0,
      duplicates: 0,
      failed: 0,
    };
    for (const f of files) {
      if (f.status === "success") counts.sorted++;
      else if (["unknown_date", "future_date", "corrupted", "junk"].includes(f.status))
        counts.quarantined++;
      else if (["duplicate", "already_in_destination"].includes(f.status)) counts.duplicates++;
      else if (f.status === "failed") counts.failed++;
    }
    return counts;
  }, [files]);

  const activeStatuses = FILTER_TABS.find((t) => t.id === tab)?.statuses ?? null;

  const filtered = useMemo(() => {
    let result = files;
    if (activeStatuses) {
      result = result.filter((f) => activeStatuses.includes(f.status));
    }
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      result = result.filter((f) => f.source_path.toLowerCase().includes(q));
    }
    return result;
  }, [files, activeStatuses, search]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      const aVal = String(a[sortCol] ?? "");
      const bVal = String(b[sortCol] ?? "");
      const cmp = aVal.localeCompare(bVal);
      return sortDir === "asc" ? cmp : -cmp;
    });
  }, [filtered, sortCol, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / FILE_PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageFiles = sorted.slice(safePage * FILE_PAGE_SIZE, (safePage + 1) * FILE_PAGE_SIZE);

  const SortIcon = ({ col }: { col: SortCol }) => (
    <span className="ml-1 text-muted-foreground/60">
      {sortCol === col ? (sortDir === "asc" ? "↑" : "↓") : "↕"}
    </span>
  );

  return (
    <div className="rounded-xl border border-border bg-card">
      {/* Filters + Search */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <div className="flex flex-wrap gap-1">
          {FILTER_TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setTab(t.id);
                setPage(0);
              }}
              className={cn(
                "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                tab === t.id
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
              )}
            >
              {t.label} <span className="tabular-nums">({tabCounts[t.id]})</span>
            </button>
          ))}
        </div>
        <div className="relative">
          <FiSearch className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            type="search"
            placeholder="Search by path…"
            aria-label="Search report files by path"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            className="h-7 w-48 rounded-md border border-input bg-background pl-6 pr-2.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>
      </div>

      {/* EXIF sanity warning banner */}
      {suspiciousCount > 0 && (
        <div className="px-4 pt-3">
          <ValidationBadge
            severity="warning"
            message={`${suspiciousCount} file${suspiciousCount !== 1 ? "s" : ""} had suspicious EXIF dates (e.g., camera clock reset to 2000). The filename or filesystem date was used instead where available.`}
          />
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="sticky top-0 z-10 bg-muted/80 backdrop-blur-sm">
            <tr>
              {SORT_COLUMNS.map(({ col, label }) => (
                <th
                  key={col}
                  className="px-3 py-2 text-left font-medium"
                  aria-sort={
                    sortCol === col ? (sortDir === "asc" ? "ascending" : "descending") : "none"
                  }
                >
                  <button
                    type="button"
                    onClick={() => handleSortClick(col)}
                    className="select-none rounded text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    {label}
                    <SortIcon col={col} />
                  </button>
                </th>
              ))}
              <th className="px-3 py-2 text-left font-medium text-muted-foreground">Tags</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {pageFiles.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  No files match the current filter.
                </td>
              </tr>
            ) : (
              pageFiles.map((f) => (
                <tr key={f.id} className="transition-colors hover:bg-accent/30">
                  <td
                    className="max-w-[180px] truncate px-3 py-2 text-foreground"
                    title={f.source_path}
                  >
                    {f.source_path.split(/[/\\]/).pop() ?? f.source_path}
                  </td>
                  <td
                    className="max-w-[180px] truncate px-3 py-2 text-muted-foreground"
                    title={f.dest_path ?? "—"}
                  >
                    {f.dest_path ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-muted-foreground">
                    {f.extracted_date ?? "—"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 capitalize text-muted-foreground">
                    {f.metadata_source?.replace(/_/g, " ") ?? "—"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-1.5">
                      <StatusBadge status={f.status} />
                      {["duplicate", "already_in_destination"].includes(f.status) &&
                        f.duplicate_type && (
                          <span
                            className="rounded-full bg-info/15 px-1.5 py-0.5 text-[10px] font-medium text-info"
                            title={f.duplicate_of ? `Duplicate of ${f.duplicate_of}` : undefined}
                          >
                            {f.duplicate_type === "exact"
                              ? "exact"
                              : `~${f.duplicate_similarity ?? 0}%`}
                          </span>
                        )}
                    </div>
                  </td>
                  <td
                    className="max-w-[120px] truncate px-3 py-2 text-muted-foreground"
                    title={f.tags.join(", ") || undefined}
                  >
                    {f.tags.join(", ") || "—"}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-border px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {sorted.length.toLocaleString()} file
            {sorted.length !== 1 ? "s" : ""} · showing{" "}
            {(safePage * FILE_PAGE_SIZE + 1).toLocaleString()}–
            {Math.min((safePage + 1) * FILE_PAGE_SIZE, sorted.length).toLocaleString()}
          </p>
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={safePage === 0}
              onClick={() => setPage((p) => p - 1)}
            >
              ← Prev
            </Button>
            <span className="tabular-nums text-xs text-muted-foreground">
              Page {safePage + 1} of {totalPages}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={safePage >= totalPages - 1}
              onClick={() => setPage((p) => p + 1)}
            >
              Next →
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Export ───────────────────────────────────────────────────────────────

export function ReportPanel({ report }: ReportPanelProps) {
  const { toast } = useToast();
  const [exporting, setExporting] = useState<"csv" | "json" | null>(null);
  const [statsOpen, setStatsOpen] = useState(true);

  const handleExport = async (format: "csv" | "json") => {
    if (exporting) return;
    setExporting(format);
    try {
      const blob = await api.exportReport(report.operation_id, format);
      const filename = `mediasort_${report.operation_id}_${new Date()
        .toISOString()
        .slice(0, 10)}.${format}`;
      await triggerDownload(blob, filename);
      toast("Report exported successfully", "success");
    } catch {
      toast("Export failed — try again", "error");
    } finally {
      setExporting(null);
    }
  };

  const { summary } = report;
  const total = Math.max(summary.total, 1);
  // Fold the P0-engine outcomes into the existing cards so every file is
  // accounted for and the cards agree with the filter tabs below (junk →
  // Quarantined, already-in-destination → Duplicates).
  const junkCount = summary.junk ?? 0;
  const alreadyInDestCount = summary.already_in_destination ?? 0;
  const quarantineCount =
    summary.future_dates + summary.unknown_dates + summary.corrupted + junkCount;
  const duplicateCount = summary.duplicates + alreadyInDestCount;
  const suspiciousCount = report.files.filter((f) => f.suspicious === true).length;

  return (
    <div className="space-y-4">
      {/* ── Section A: Summary Cards ── */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryCard
            label="Sorted"
            value={summary.sorted}
            subtext={pct(summary.sorted, total)}
            color="text-success"
          />
          <SummaryCard
            label="Quarantined"
            value={quarantineCount}
            subtext={pct(quarantineCount, total)}
            color="text-warning"
          />
          <SummaryCard
            label="Duplicates"
            value={duplicateCount}
            subtext={pct(duplicateCount, total)}
            color="text-info"
          />
          <SummaryCard
            label="Failed"
            value={summary.failed}
            subtext={pct(summary.failed, total)}
            color="text-error"
          />
        </div>

        {/* Meta row */}
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>Duration: {formatDuration(report.duration_seconds, { style: "long" })}</span>
          <span>·</span>
          <span className="max-w-[220px] truncate" title={report.source_path}>
            Source: {report.source_path}
          </span>
          <span>·</span>
          <span className="max-w-[220px] truncate" title={report.dest_path}>
            Dest: {report.dest_path}
          </span>
        </div>

        {/* Export buttons */}
        <div className="mt-3 flex gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={!!exporting}
            onClick={() => void handleExport("csv")}
          >
            {exporting === "csv" ? (
              <span className="flex items-center gap-1.5">
                <FiLoader className="h-3.5 w-3.5 animate-spin" />
                Exporting…
              </span>
            ) : (
              "↓ Export CSV"
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={!!exporting}
            onClick={() => void handleExport("json")}
          >
            {exporting === "json" ? (
              <span className="flex items-center gap-1.5">
                <FiLoader className="h-3.5 w-3.5 animate-spin" />
                Exporting…
              </span>
            ) : (
              "↓ Export JSON"
            )}
          </Button>
        </div>
      </div>

      {/* ── Section B: Statistics Dashboard (only when statistics block exists) ── */}
      {report.statistics && (
        <StatsDashboard
          statistics={report.statistics}
          open={statsOpen}
          onToggle={() => setStatsOpen((v) => !v)}
        />
      )}

      {/* ── Section C: File Table ── */}
      <FileTableSection files={report.files} suspiciousCount={suspiciousCount} />
    </div>
  );
}
