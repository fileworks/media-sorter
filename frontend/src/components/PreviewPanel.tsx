/**
 * Step 3 — Preview Panel
 *
 * Orchestrator: sidebar (search/filter/tags/categories) + toolbar (summary,
 * expand/collapse, view toggle) + delegates to PreviewList (tree) or
 * PreviewGrid (thumbnail grid).
 */

import {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { ValidationBadge } from "@/components/ui/validation-badge";
import { DuplicateComparison } from "@/components/DuplicateComparison";
import { MediaPreviewModal } from "@/components/MediaPreviewModal";
import { PreviewList } from "@/components/PreviewList";
import { PreviewGrid } from "@/components/PreviewGrid";
import { cn } from "@/lib/utils";
import { getBasename } from "@/lib/pathUtils";
import { partialScanWarning } from "@/lib/operationStates";
import type { PreviewItem, PreviewResult } from "@/types/api";
import { FiMaximize2, FiMinimize2, FiList, FiGrid } from "react-icons/fi";

// ── Types / constants ─────────────────────────────────────────────────────────

type FilterMode = "all" | "sorted" | "warnings" | "problems" | "duplicates";
type SortBy = "name" | "date" | "size" | "status";
type ViewMode = "list" | "grid";

const FILTER_OPTIONS: { key: FilterMode; label: string }[] = [
  { key: "all", label: "All" },
  { key: "sorted", label: "✓ Sorted" },
  { key: "warnings", label: "⚠ Warnings" },
  { key: "problems", label: "✕ Problems" },
  { key: "duplicates", label: "≈ Duplicates" },
];

interface PreviewPanelProps {
  result: PreviewResult | null;
  loading: boolean;
  error?: string | null;
  copyInsteadOfMove?: boolean;
  categorizeEnabled?: boolean;
  sortCriteria?: string[];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function filterItems(
  items: PreviewItem[],
  filter: FilterMode,
  search: string,
  tagFilters: Set<string>,
  categoryFilters: Set<string>,
): PreviewItem[] {
  let filtered = items;
  switch (filter) {
    case "sorted":
      filtered = filtered.filter((i) => i.status === "sort");
      break;
    case "warnings":
      filtered = filtered.filter((i) =>
        ["suspicious_date", "duplicate_unknown"].includes(i.status),
      );
      break;
    case "problems":
      filtered = filtered.filter((i) =>
        ["unknown_date", "future_date", "failed", "junk"].includes(i.status),
      );
      break;
    case "duplicates":
      filtered = filtered.filter((i) => ["duplicate", "already_in_destination"].includes(i.status));
      break;
  }
  if (search.trim()) {
    const q = search.toLowerCase();
    filtered = filtered.filter((i) => getBasename(i.source).toLowerCase().includes(q));
  }
  if (tagFilters.size > 0) {
    filtered = filtered.filter((i) => [...tagFilters].some((t) => (i.tags ?? []).includes(t)));
  }
  if (categoryFilters.size > 0) {
    filtered = filtered.filter((i) => categoryFilters.has(i.category ?? "_uncategorized"));
  }
  return filtered;
}

function sortItems(items: PreviewItem[], sortBy: SortBy, sortDir: "asc" | "desc"): PreviewItem[] {
  const mult = sortDir === "desc" ? -1 : 1;
  return [...items].sort((a, b) => {
    switch (sortBy) {
      case "name":
        return mult * getBasename(a.source).localeCompare(getBasename(b.source));
      case "date":
        return mult * (a.extracted_date ?? "").localeCompare(b.extracted_date ?? "");
      case "size":
        return mult * ((a.file_size ?? 0) - (b.file_size ?? 0));
      case "status":
        return mult * a.status.localeCompare(b.status);
      default:
        return 0;
    }
  });
}

// ── Loading skeleton ──────────────────────────────────────────────────────────

function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-pulse rounded bg-muted", className)} />;
}

function PreviewLoadingSkeleton() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Preview</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div className="flex flex-col lg:flex-row">
          <div className="shrink-0 border-b border-border bg-muted/20 p-3 lg:w-56 lg:border-b-0 lg:border-r">
            <Skeleton className="mb-2 h-4 w-20" />
            <Skeleton className="mb-3 h-7 w-full" />
            <Skeleton className="mb-2 h-4 w-16" />
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="mb-1 h-6 w-full" />
            ))}
          </div>
          <div className="flex-1 space-y-1 p-3">
            <Skeleton className="h-9 w-3/4" />
            <Skeleton className="ml-8 h-8 w-1/2" />
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="ml-14 h-7 w-2/3" />
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SidebarSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </p>
      {children}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function PreviewPanel({
  result,
  loading,
  error,
  copyInsteadOfMove = false,
  categorizeEnabled = false,
  sortCriteria = ["year", "month", "day"],
}: PreviewPanelProps) {
  const [filter, setFilter] = useState<FilterMode>("all");
  const [search, setSearch] = useState("");
  const [tagFilters, setTagFilters] = useState<Set<string>>(new Set());
  const [categoryFilters, setCategoryFilters] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<SortBy>("name");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [compareItem, setCompareItem] = useState<PreviewItem | null>(null);
  const [previewItem, setPreviewItem] = useState<PreviewItem | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("list");
  const [sidebarWidth, setSidebarWidth] = useState(224);
  const sidebarResizing = useRef(false);
  const sidebarResizeStart = useRef({ x: 0, width: 0 });

  const handleSidebarResizeStart = useCallback(
    (e: ReactMouseEvent) => {
      sidebarResizing.current = true;
      sidebarResizeStart.current = { x: e.clientX, width: sidebarWidth };
      e.preventDefault();
    },
    [sidebarWidth],
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!sidebarResizing.current) return;
      const delta = e.clientX - sidebarResizeStart.current.x;
      const newWidth = Math.max(160, Math.min(400, sidebarResizeStart.current.width + delta));
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => {
      sidebarResizing.current = false;
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Initialise/reset expanded state when result changes
  useEffect(() => {
    if (!result) {
      setExpanded(new Set());
      return;
    }
    const s = new Set<string>();
    for (const item of result.items) {
      if ((item.status === "sort" || item.status === "suspicious_date") && item.extracted_date) {
        const year = item.extracted_date.split("-")[0];
        if (year) s.add(`y-${year}`);
      }
      if (item.status === "duplicate" && item.extracted_date) {
        const parts = item.extracted_date.split("-");
        const year = parts[0] || "Unknown";
        const month = parts[1] || "00";
        const day = parts[2] || "00";
        let dateKey = `y-${year}`;
        if (sortCriteria.includes("month")) dateKey = `m-${year}-${month}`;
        if (sortCriteria.includes("month") && sortCriteria.includes("day"))
          dateKey = `d-${year}-${month}-${day}`;
        s.add(`${dateKey}-dup`);
      }
    }
    [
      "duplicates",
      "unknown_date",
      "future_date",
      "failed",
      "junk",
      "already_in_destination",
      "duplicate_unknown",
    ].forEach((k) => s.add(`folder-${k}`));
    if (categorizeEnabled) {
      for (const item of result.items) {
        if ((item.status === "sort" || item.status === "suspicious_date") && item.extracted_date) {
          const parts = item.extracted_date.split("-");
          const year = parts[0] || "Unknown";
          const month = parts[1] || "00";
          const day = parts[2] || "00";
          const catName = item.category ?? "_uncategorized";
          let dateKey = `y-${year}`;
          if (sortCriteria.includes("month")) dateKey = `m-${year}-${month}`;
          if (sortCriteria.includes("month") && sortCriteria.includes("day"))
            dateKey = `d-${year}-${month}-${day}`;
          s.add(`${dateKey}-cat-${catName}`);
        }
      }
    }
    setExpanded(s);
  }, [result, categorizeEnabled, sortCriteria]);

  useEffect(() => {
    setTagFilters(new Set());
    setCategoryFilters(new Set());
  }, [result]);

  const toggleExpanded = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const filterCounts = useMemo(() => {
    const empty: Record<FilterMode, number> = {
      all: 0,
      sorted: 0,
      warnings: 0,
      problems: 0,
      duplicates: 0,
    };
    if (!result) return empty;
    const base = filterItems(result.items, "all", search, tagFilters, categoryFilters);
    const counts = { ...empty, all: base.length };
    for (const item of base) {
      switch (item.status) {
        case "sort":
          counts.sorted++;
          break;
        case "suspicious_date":
        case "duplicate_unknown":
          counts.warnings++;
          break;
        case "duplicate":
        case "already_in_destination":
          counts.duplicates++;
          break;
        default:
          counts.problems++;
          break;
      }
    }
    return counts;
  }, [result, search, tagFilters, categoryFilters]);

  const allTags = useMemo(() => {
    if (!result) return [];
    const tagSet = new Set<string>();
    for (const item of result.items) for (const tag of item.tags ?? []) tagSet.add(tag);
    return [...tagSet].sort();
  }, [result]);

  const allCategories = useMemo(() => {
    if (!result || !categorizeEnabled) return [];
    const catSet = new Set<string>();
    for (const item of result.items) {
      if (item.status === "sort" || item.status === "suspicious_date")
        catSet.add(item.category ?? "_uncategorized");
    }
    return [...catSet].sort((a, b) => {
      if (a === "_uncategorized") return 1;
      if (b === "_uncategorized") return -1;
      return a.localeCompare(b);
    });
  }, [result, categorizeEnabled]);

  const filteredItems = useMemo(() => {
    if (!result) return [];
    return filterItems(result.items, filter, search, tagFilters, categoryFilters);
  }, [result, filter, search, tagFilters, categoryFilters]);

  const sortedItems = useMemo(
    () => sortItems(filteredItems, sortBy, sortDir),
    [filteredItems, sortBy, sortDir],
  );

  const expandAll = useCallback(() => {
    const keys = new Set<string>();
    for (const item of sortedItems) {
      const date = item.extracted_date ?? "";
      const parts = date.split("-");
      const year = parts[0] || "Unknown";
      const month = parts[1] || "00";
      const day = parts[2] || "00";
      if (item.status === "sort" || item.status === "suspicious_date") {
        keys.add(`y-${year}`);
        if (sortCriteria.includes("month")) {
          keys.add(`m-${year}-${month}`);
          if (sortCriteria.includes("day")) keys.add(`d-${year}-${month}-${day}`);
        }
        if (categorizeEnabled) {
          const catName = item.category ?? "_uncategorized";
          let dateKey = `y-${year}`;
          if (sortCriteria.includes("month")) dateKey = `m-${year}-${month}`;
          if (sortCriteria.includes("month") && sortCriteria.includes("day"))
            dateKey = `d-${year}-${month}-${day}`;
          keys.add(`${dateKey}-cat-${catName}`);
        }
      } else if (item.status === "duplicate" && date) {
        keys.add(`y-${year}`);
        if (sortCriteria.includes("month")) keys.add(`m-${year}-${month}`);
        if (sortCriteria.includes("month") && sortCriteria.includes("day"))
          keys.add(`d-${year}-${month}-${day}`);
        let dateKey = `y-${year}`;
        if (sortCriteria.includes("month")) dateKey = `m-${year}-${month}`;
        if (sortCriteria.includes("month") && sortCriteria.includes("day"))
          dateKey = `d-${year}-${month}-${day}`;
        keys.add(`${dateKey}-dup`);
      }
    }
    [
      "duplicates",
      "unknown_date",
      "future_date",
      "failed",
      "junk",
      "already_in_destination",
    ].forEach((k) => keys.add(`folder-${k}`));
    setExpanded(keys);
  }, [sortedItems, sortCriteria, categorizeEnabled]);

  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  const toggleTag = (tag: string) => {
    setTagFilters((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag);
      else next.add(tag);
      return next;
    });
  };
  const toggleCategory = (cat: string) => {
    setCategoryFilters((prev) => {
      const next = new Set(prev);
      if (next.has(cat)) next.delete(cat);
      else next.add(cat);
      return next;
    });
  };

  // ── Render guards ────────────────────────────────────────────────────────────

  if (loading) return <PreviewLoadingSkeleton />;
  if (error)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Preview</CardTitle>
        </CardHeader>
        <CardContent>
          <ValidationBadge severity="error" message={error} />
        </CardContent>
      </Card>
    );
  if (!result)
    return (
      <Card>
        <CardHeader>
          <CardTitle>Preview</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Click "Run Preview →" in the footer to see what will happen before sorting.
          </p>
        </CardContent>
      </Card>
    );

  const { stats, items } = result;
  const warningCount = items.filter((i) => i.status === "suspicious_date").length;

  return (
    <Card className="animate-fade-in overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle>
          Preview
          <span className="ml-2 text-sm font-normal text-muted-foreground">
            ({items.length.toLocaleString()} files)
          </span>
        </CardTitle>
      </CardHeader>

      <CardContent className="p-0">
        {result.partial && (
          <div className="border-b border-border px-4 py-2">
            <ValidationBadge
              severity="warning"
              message={partialScanWarning("Preview", result.issues.length)}
            />
          </div>
        )}
        <div className="flex flex-col lg:flex-row">
          {/* ── Left sidebar ── */}
          <aside
            className="shrink-0 border-b border-border bg-muted/20 lg:border-b-0 min-w-full lg:min-w-0"
            style={{ width: sidebarWidth }}
          >
            <div className="space-y-4 p-3">
              <SidebarSection title="Search">
                <input
                  type="search"
                  placeholder="Filter filenames…"
                  aria-label="Filter files by name"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="h-7 w-full rounded border border-input bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-ring"
                />
              </SidebarSection>

              <SidebarSection title="Status">
                <div className="flex flex-col gap-0.5">
                  {FILTER_OPTIONS.map(({ key, label }) => (
                    <button
                      key={key}
                      className={cn(
                        "flex items-center justify-between gap-1 rounded px-2 py-1 text-left text-xs font-medium transition-colors",
                        filter === key
                          ? "bg-primary text-primary-foreground"
                          : "text-muted-foreground hover:bg-muted/70 hover:text-foreground",
                      )}
                      onClick={() => setFilter(key)}
                      aria-pressed={filter === key}
                    >
                      <span>{label}</span>
                      <span
                        className={cn(
                          "rounded-full px-1.5 py-0 text-[10px] font-normal tabular-nums",
                          filter === key
                            ? "bg-primary-foreground/20 text-primary-foreground"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {(filterCounts[key] ?? 0).toLocaleString()}
                      </span>
                    </button>
                  ))}
                </div>
              </SidebarSection>

              <SidebarSection title="Tags">
                {allTags.length === 0 ? (
                  <p className="text-[11px] italic text-muted-foreground">No tags yet.</p>
                ) : (
                  <div className="flex flex-wrap gap-1">
                    {tagFilters.size > 0 && (
                      <button
                        className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground hover:bg-muted/70"
                        onClick={() => setTagFilters(new Set())}
                        title="Clear tag filter"
                      >
                        ✕ Clear
                      </button>
                    )}
                    {allTags.map((tag) => (
                      <button
                        key={tag}
                        onClick={() => toggleTag(tag)}
                        className={cn(
                          "rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
                          tagFilters.has(tag)
                            ? "bg-primary text-primary-foreground"
                            : "bg-primary/10 text-primary hover:bg-primary/20",
                        )}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                )}
              </SidebarSection>

              {categorizeEnabled && (
                <SidebarSection title="Categories">
                  {allCategories.length === 0 ? (
                    <p className="text-[11px] italic text-muted-foreground">No categories.</p>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {categoryFilters.size > 0 && (
                        <button
                          className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-muted text-muted-foreground hover:bg-muted/70"
                          onClick={() => setCategoryFilters(new Set())}
                          title="Clear category filter"
                        >
                          ✕ Clear
                        </button>
                      )}
                      {allCategories.map((cat) => (
                        <button
                          key={cat}
                          onClick={() => toggleCategory(cat)}
                          className={cn(
                            "rounded-full px-2 py-0.5 text-[11px] font-medium transition-colors",
                            categoryFilters.has(cat)
                              ? cat === "_uncategorized"
                                ? "bg-muted-foreground/20 text-foreground"
                                : "bg-category text-category-foreground"
                              : cat === "_uncategorized"
                                ? "bg-muted text-muted-foreground hover:bg-muted/70"
                                : "bg-category/10 text-category hover:bg-category/20",
                          )}
                        >
                          {cat}
                        </button>
                      ))}
                    </div>
                  )}
                </SidebarSection>
              )}
            </div>
          </aside>

          {/* Resize handle */}
          <div
            aria-hidden
            className="hidden lg:flex w-2 shrink-0 cursor-col-resize select-none items-stretch justify-center group"
            onMouseDown={handleSidebarResizeStart}
            title="Drag to resize sidebar"
          >
            <div className="w-px bg-border group-hover:bg-primary/40 transition-colors" />
          </div>

          {/* ── Right content area ── */}
          <div className="flex min-w-0 flex-1 flex-col">
            {/* Summary bar */}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b bg-muted/30 px-4 py-2 text-xs">
              <span className="font-semibold text-foreground">
                {stats.total.toLocaleString()} total
              </span>
              <span className="text-muted-foreground">·</span>
              <span className="text-success">{stats.will_sort.toLocaleString()} sorted</span>
              {stats.will_quarantine_unknown > 0 && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-warning">
                    {stats.will_quarantine_unknown.toLocaleString()} unknown date
                  </span>
                </>
              )}
              {stats.will_quarantine_future > 0 && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-warning">
                    {stats.will_quarantine_future.toLocaleString()} future date
                  </span>
                </>
              )}
              {stats.will_skip_duplicate > 0 && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-info">
                    {stats.will_skip_duplicate.toLocaleString()} duplicate
                  </span>
                </>
              )}
              {(stats.will_skip_already_in_destination ?? 0) > 0 && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-info">
                    {stats.will_skip_already_in_destination.toLocaleString()} already in destination
                  </span>
                </>
              )}
              {(stats.duplicate_unknown ?? 0) > 0 && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span
                    className="text-warning"
                    title="Video perceptual matching completes during the real sort."
                  >
                    {stats.duplicate_unknown!.toLocaleString()} pending duplicate check
                  </span>
                </>
              )}
              {(stats.will_quarantine_junk ?? 0) > 0 && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-warning">
                    {stats.will_quarantine_junk.toLocaleString()} junk
                  </span>
                </>
              )}
              {categorizeEnabled && stats.uncategorized > 0 && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-muted-foreground">
                    {stats.uncategorized.toLocaleString()} uncategorized
                  </span>
                </>
              )}
              {warningCount > 0 && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-warning">{warningCount.toLocaleString()} warnings</span>
                </>
              )}

              <div className="ml-auto flex shrink-0 items-center gap-1">
                {/* Expand/collapse only apply to list view */}
                {viewMode === "list" && (
                  <>
                    <button
                      type="button"
                      onClick={expandAll}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                      title="Expand all groups"
                    >
                      <FiMaximize2 className="h-3 w-3" />
                      Expand all
                    </button>
                    <button
                      type="button"
                      onClick={collapseAll}
                      className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground"
                      title="Collapse all groups"
                    >
                      <FiMinimize2 className="h-3 w-3" />
                      Collapse all
                    </button>
                    <div className="mx-1 h-3.5 w-px bg-border" />
                  </>
                )}

                {/* View toggle */}
                <div className="flex items-center rounded border border-border bg-background">
                  <button
                    type="button"
                    onClick={() => setViewMode("list")}
                    className={cn(
                      "flex items-center justify-center h-6 w-6 rounded-l text-xs transition-colors",
                      viewMode === "list"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted/70",
                    )}
                    title="List view"
                    aria-label="List view"
                    aria-pressed={viewMode === "list"}
                  >
                    <FiList className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setViewMode("grid")}
                    className={cn(
                      "flex items-center justify-center h-6 w-6 rounded-r text-xs transition-colors",
                      viewMode === "grid"
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted/70",
                    )}
                    title="Grid view"
                    aria-label="Grid view"
                    aria-pressed={viewMode === "grid"}
                  >
                    <FiGrid className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Icon legend (list view only) */}
            {viewMode === "list" && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b px-4 py-1.5 text-[11px] text-muted-foreground">
                <span className="font-medium uppercase tracking-wide">Key</span>
                <span>
                  <span className="text-success">✓</span> sorted
                </span>
                <span>
                  <span className="text-warning">⚠</span> warning
                </span>
                <span>
                  <span className="text-info">≈</span> duplicate
                </span>
                {(stats.will_quarantine_junk ?? 0) > 0 && (
                  <span>
                    <span className="text-warning">⊘</span> junk
                  </span>
                )}
                <span>
                  <span className="text-error">✕</span> problem
                </span>
              </div>
            )}

            {viewMode === "list" ? (
              <PreviewList
                items={sortedItems}
                expanded={expanded}
                sortCriteria={sortCriteria}
                categorizeEnabled={categorizeEnabled}
                onToggle={toggleExpanded}
                onOpen={setPreviewItem}
                onCompare={setCompareItem}
                onContextMenu={() => {}}
                sortBy={sortBy}
                sortDir={sortDir}
                onSortByChange={(s) => setSortBy(s as SortBy)}
                onSortDirToggle={() => setSortDir((d) => (d === "asc" ? "desc" : "asc"))}
              />
            ) : (
              <PreviewGrid
                items={sortedItems}
                categorizeEnabled={categorizeEnabled}
                onOpen={setPreviewItem}
              />
            )}
          </div>
        </div>
      </CardContent>

      {compareItem && (
        <DuplicateComparison
          item={compareItem}
          allItems={result?.items}
          copyInsteadOfMove={copyInsteadOfMove}
          onClose={() => setCompareItem(null)}
        />
      )}

      {previewItem && (
        <MediaPreviewModal
          item={previewItem}
          items={filteredItems}
          onClose={() => setPreviewItem(null)}
        />
      )}
    </Card>
  );
}
