/**
 * Virtual-scrolled tree view for the Preview panel — the existing list layout,
 * extracted from PreviewPanel so PreviewPanel can delegate to it or to
 * PreviewGrid based on the active view toggle.
 */

import {
  useState,
  useCallback,
  useMemo,
  useRef,
  useEffect,
  memo,
  type FC,
  type MouseEvent as ReactMouseEvent,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { MediaHoverCard, type HoverMeta } from "@/components/ui/media-hover-card";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/formatters";
import { getBasename } from "@/lib/pathUtils";
import { copyPath as copyPathToClipboard } from "@/lib/reveal";
import type { PreviewItem } from "@/types/api";
import { type FlatRow, buildFlatRows, MONTH_NAMES } from "@/lib/previewRows";
import { FiArrowUp, FiArrowDown } from "react-icons/fi";

// ── Constants ──────────────────────────────────────────────────────────────────

const ITEM_HEIGHT = 36;
const OVERSCAN = 20;
const MAX_CONTAINER_HEIGHT = 520;
const EMPTY_HEIGHT = 96;

export type ColWidths = { name: number; source: number; date: number };
const DEFAULT_COL_WIDTHS: ColWidths = { name: 224, source: 80, date: 96 };
const COL_LIMITS: Record<keyof ColWidths, [number, number]> = {
  name: [100, 400],
  source: [48, 160],
  date: [72, 160],
};
const COL_LABELS: Record<keyof ColWidths, string> = {
  name: "Name",
  source: "Source",
  date: "Date",
};

// ── Types ──────────────────────────────────────────────────────────────────────

interface ContextMenuState {
  x: number;
  y: number;
  item: PreviewItem;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getDestDisplay(dest: string | null): string {
  if (!dest) return "—";
  const parts = dest.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 4) return parts.join("/");
  return parts.slice(-4).join("/");
}

function getStatusIcon(status: string): string {
  switch (status) {
    case "sort":
      return "✓";
    case "suspicious_date":
      return "⚠";
    case "duplicate":
    case "already_in_destination":
      return "≈";
    case "junk":
      return "⊘";
    case "duplicate_unknown":
      return "?";
    default:
      return "✕";
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case "sort":
      return "text-success";
    case "suspicious_date":
    case "junk":
    case "duplicate_unknown":
      return "text-warning";
    case "duplicate":
    case "already_in_destination":
      return "text-info";
    default:
      return "text-error";
  }
}

function getStatusTooltip(status: string): string {
  switch (status) {
    case "sort":
      return "Will be sorted";
    case "suspicious_date":
      return "Warning: suspicious date";
    case "duplicate":
      return "Duplicate file";
    case "unknown_date":
      return "Problem: unknown date";
    case "future_date":
      return "Problem: future date";
    case "failed":
      return "Problem: processing failed";
    case "junk":
      return "Junk/thumbnail — quarantined to _junk/";
    case "already_in_destination":
      return "Already in destination — quarantined to _already_in_destination/";
    case "duplicate_unknown":
      return "Video perceptual match is checked during the full sort";
    default:
      return status;
  }
}

function getRowKey(row: FlatRow, index: number): string {
  switch (row.kind) {
    case "year":
      return `y-${row.year}`;
    case "month":
      return `m-${row.year}-${row.month}`;
    case "day":
      return `d-${row.year}-${row.month}-${row.day}`;
    case "file":
      return `f-${row.item.source}`;
    case "cat-header":
      return `ch-${row.catKey}`;
    case "cat-file":
      return `cf-${row.catKey}-${row.item.source}`;
    case "date-dup-header":
      return `ddh-${row.bucketKey}`;
    case "date-dup-file":
      return `ddf-${row.bucketKey}-${row.item.source}`;
    case "folder-header":
      return `fh-${row.folderKey}`;
    case "folder-file":
      return `ff-${row.folderKey}-${row.item.source}`;
    default:
      return `row-${index}`;
  }
}

// ── Row sub-components ────────────────────────────────────────────────────────

const YearRow: FC<{
  row: Extract<FlatRow, { kind: "year" }>;
  isExpanded: boolean;
  onToggle: () => void;
}> = ({ row, isExpanded, onToggle }) => (
  <button
    className="flex w-full items-center gap-2 px-3 py-0 text-left font-semibold hover:bg-muted/50"
    style={{ height: ITEM_HEIGHT }}
    onClick={onToggle}
    aria-expanded={isExpanded}
  >
    <span className="text-[10px] text-muted-foreground">{isExpanded ? "▼" : "▶"}</span>
    <span className="text-sm">{row.year}</span>
    <span className="text-xs text-muted-foreground">({row.count.toLocaleString()} files)</span>
  </button>
);

const MonthRow: FC<{
  row: Extract<FlatRow, { kind: "month" }>;
  isExpanded: boolean;
  onToggle: () => void;
}> = ({ row, isExpanded, onToggle }) => (
  <button
    className="flex w-full items-center gap-2 px-3 py-0 pl-8 text-left hover:bg-muted/50"
    style={{ height: ITEM_HEIGHT }}
    onClick={onToggle}
    aria-expanded={isExpanded}
  >
    <span className="text-[10px] text-muted-foreground">{isExpanded ? "▼" : "▶"}</span>
    <span className="text-sm text-muted-foreground">{row.monthName}</span>
    <span className="text-xs text-muted-foreground">({row.count.toLocaleString()} files)</span>
  </button>
);

const DayRow: FC<{
  row: Extract<FlatRow, { kind: "day" }>;
  isExpanded: boolean;
  onToggle: () => void;
}> = ({ row, isExpanded, onToggle }) => {
  const monthName = MONTH_NAMES[parseInt(row.month, 10) - 1] ?? row.month;
  return (
    <button
      className="flex w-full items-center gap-2 px-3 py-0 pl-14 text-left hover:bg-muted/50"
      style={{ height: ITEM_HEIGHT }}
      onClick={onToggle}
      aria-expanded={isExpanded}
    >
      <span className="text-[10px] text-muted-foreground">{isExpanded ? "▼" : "▶"}</span>
      <span className="text-xs text-muted-foreground">
        {parseInt(row.day, 10)} {monthName}
      </span>
      <span className="text-xs text-muted-foreground">({row.count.toLocaleString()} files)</span>
    </button>
  );
};

const FILE_DEPTH_PADDING: Record<number, string> = {
  1: "pl-8",
  2: "pl-14",
  3: "pl-20",
  4: "pl-28",
};
const DEPTH_SPACER_PX: Record<number, number> = { 1: 12, 2: 36, 3: 60, 4: 92 };

const CatHeaderRow: FC<{
  row: Extract<FlatRow, { kind: "cat-header" }>;
  isExpanded: boolean;
  onToggle: () => void;
}> = ({ row, isExpanded, onToggle }) => (
  <button
    className={cn(
      "flex w-full items-center gap-2 px-3 py-0 text-left hover:bg-muted/50",
      FILE_DEPTH_PADDING[row.depth] ?? "pl-20",
    )}
    style={{ height: ITEM_HEIGHT }}
    onClick={onToggle}
    aria-expanded={isExpanded}
  >
    <span className="text-[10px] text-muted-foreground">{isExpanded ? "▼" : "▶"}</span>
    <code
      className={cn(
        "text-xs font-medium",
        row.isUncategorized ? "text-muted-foreground" : "text-category",
      )}
    >
      {row.name}/
    </code>
    <span className="text-xs text-muted-foreground">({row.count.toLocaleString()} files)</span>
  </button>
);

const DateDupHeaderRow: FC<{
  row: Extract<FlatRow, { kind: "date-dup-header" }>;
  isExpanded: boolean;
  onToggle: () => void;
}> = ({ row, isExpanded, onToggle }) => (
  <button
    className={cn(
      "flex w-full items-center gap-2 px-3 py-0 text-left hover:bg-muted/50",
      FILE_DEPTH_PADDING[row.depth] ?? "pl-20",
    )}
    style={{ height: ITEM_HEIGHT }}
    onClick={onToggle}
    aria-expanded={isExpanded}
  >
    <span className="text-[10px] text-muted-foreground">{isExpanded ? "▼" : "▶"}</span>
    <code className="text-xs font-medium text-info">_duplicates/</code>
    <span className="text-xs text-muted-foreground">({row.count.toLocaleString()} files)</span>
  </button>
);

const FileRow: FC<{
  item: PreviewItem;
  depth?: number;
  indent?: boolean;
  categorizeEnabled?: boolean;
  colWidths?: ColWidths;
  onCompare?: (item: PreviewItem) => void;
  onOpen?: (item: PreviewItem) => void;
  onContextMenu?: (item: PreviewItem, e: ReactMouseEvent) => void;
}> = memo(
  ({
    item,
    depth = 3,
    indent = false,
    categorizeEnabled = false,
    colWidths,
    onCompare,
    onOpen,
    onContextMenu,
  }) => {
    const cw = colWidths ?? DEFAULT_COL_WIDTHS;
    const icon = getStatusIcon(item.status);
    const iconColor = getStatusColor(item.status);
    const statusTooltip = getStatusTooltip(item.status);
    const basename = getBasename(item.source);
    const destDisplay = getDestDisplay(item.destination);

    const hoverMeta: HoverMeta[] = [
      { label: "Date", value: item.extracted_date ?? "—" },
      { label: "Source", value: item.metadata_source || "—" },
      { label: "Size", value: formatBytes(item.file_size) },
    ];

    const isDuplicate =
      (item.status === "duplicate" || item.status === "already_in_destination") &&
      !!item.duplicate_of &&
      !!onCompare;
    const handleClick = isDuplicate
      ? () => onCompare!(item)
      : onOpen
        ? () => onOpen(item)
        : undefined;
    const spacerW = DEPTH_SPACER_PX[indent ? 1 : depth] ?? 92;
    const nameW = Math.max(40, cw.name - spacerW);

    return (
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-0 text-xs hover:bg-muted/30",
          handleClick &&
            "cursor-pointer outline-none focus-visible:bg-muted/40 focus-visible:ring-1 focus-visible:ring-ring",
        )}
        style={{ height: ITEM_HEIGHT }}
        onContextMenu={
          onContextMenu
            ? (e) => {
                e.preventDefault();
                onContextMenu(item, e);
              }
            : undefined
        }
        {...(handleClick
          ? {
              role: "button" as const,
              tabIndex: 0,
              "aria-label": isDuplicate
                ? `Compare duplicate ${basename}`
                : `Open preview of ${basename}`,
              onClick: handleClick,
              onKeyDown: (e: KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleClick();
                }
              },
            }
          : {})}
      >
        <span className="shrink-0" style={{ width: spacerW }} aria-hidden />
        <span className={cn("w-4 shrink-0 text-center font-bold", iconColor)} title={statusTooltip}>
          {icon}
        </span>
        <div className="min-w-0 shrink-0 overflow-hidden" style={{ width: nameW }}>
          <MediaHoverCard
            path={item.source}
            title={basename}
            meta={hoverMeta}
            className="min-w-0 w-full"
          >
            <span className="block truncate text-foreground">{basename}</span>
          </MediaHoverCard>
        </div>
        <span
          className="hidden shrink-0 truncate text-muted-foreground sm:block"
          style={{ width: cw.source }}
        >
          {item.metadata_source || "—"}
        </span>
        <span className="hidden shrink-0 text-muted-foreground sm:block" style={{ width: cw.date }}>
          {item.extracted_date ?? "—"}
        </span>
        <span className="hidden text-muted-foreground sm:block">→</span>
        <span
          className="min-w-0 flex-1 truncate text-muted-foreground"
          title={item.destination ?? ""}
        >
          {destDisplay}
        </span>
        {categorizeEnabled &&
          !isDuplicate &&
          item.status === "sort" &&
          (item.category ? (
            <span
              className="shrink-0 rounded-full bg-category/10 px-1.5 py-0.5 text-[10px] font-medium text-category"
              title={`Category: ${item.category}`}
            >
              {item.category}
            </span>
          ) : (
            <span
              className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
              title="No confident category → _uncategorized/"
            >
              _uncategorized
            </span>
          ))}
        {(item.status === "duplicate" || item.status === "already_in_destination") &&
          item.duplicate_type && (
            <span
              className="ml-2 shrink-0 rounded-full bg-info/15 px-1.5 py-0.5 text-[10px] font-medium text-info"
              title={item.duplicate_of ? `Duplicate of ${item.duplicate_of}` : undefined}
            >
              {item.duplicate_type === "exact" ? "exact" : `~${item.duplicate_similarity ?? 0}%`}
            </span>
          )}
        {item.status !== "duplicate" && (item.tags ?? []).length > 0 && (
          <div
            className="flex shrink-0 gap-1"
            onClick={(e) => e.stopPropagation()}
            role="presentation"
          >
            {(item.tags ?? []).map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>
    );
  },
);

const FolderHeaderRow: FC<{
  row: Extract<FlatRow, { kind: "folder-header" }>;
  isExpanded: boolean;
  onToggle: () => void;
}> = ({ row, isExpanded, onToggle }) => (
  <button
    className="flex w-full items-center gap-2 border-t border-border px-3 py-0 text-left hover:bg-muted/50"
    style={{ height: ITEM_HEIGHT }}
    onClick={onToggle}
    aria-expanded={isExpanded}
  >
    <span className="text-[10px] text-muted-foreground">{isExpanded ? "▼" : "▶"}</span>
    <code className="text-sm font-medium text-foreground">{row.label}</code>
    <span className="text-xs text-muted-foreground">({row.count.toLocaleString()} files)</span>
  </button>
);

const ContextMenu: FC<{
  state: ContextMenuState;
  onPreview: (item: PreviewItem) => void;
  onCompare: (item: PreviewItem) => void;
  onClose: () => void;
}> = ({ state, onPreview, onCompare, onClose }) => {
  const { item } = state;
  const isDuplicate = item.status === "duplicate" && !!item.duplicate_of;
  const x = Math.min(state.x, window.innerWidth - 200);
  const y = Math.min(state.y, window.innerHeight - 110);
  const copyPath = useCallback(() => {
    void copyPathToClipboard(item.source);
    onClose();
  }, [item.source, onClose]);
  const menuItemCls =
    "flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-foreground hover:bg-muted transition-colors";

  return createPortal(
    <div
      className="fixed z-50 min-w-[172px] overflow-hidden rounded-md border border-border bg-background py-1 shadow-lg"
      style={{ top: y, left: x }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {isDuplicate ? (
        <button
          className={menuItemCls}
          onClick={() => {
            onCompare(item);
            onClose();
          }}
        >
          <span className="text-info text-sm leading-none">≈</span>Compare Duplicate
        </button>
      ) : (
        <button
          className={menuItemCls}
          onClick={() => {
            onPreview(item);
            onClose();
          }}
        >
          <span className="text-muted-foreground text-sm leading-none">⌕</span>Open Preview
        </button>
      )}
      <div className="my-0.5 border-t border-border" />
      <button className={menuItemCls} onClick={copyPath}>
        <span className="text-muted-foreground text-sm leading-none">⎘</span>Copy Source Path
      </button>
    </div>,
    document.body,
  );
};

const RowRenderer: FC<{
  row: FlatRow;
  expanded: Set<string>;
  categorizeEnabled: boolean;
  colWidths: ColWidths;
  onToggle: (key: string) => void;
  onCompare: (item: PreviewItem) => void;
  onOpen: (item: PreviewItem) => void;
  onContextMenu: (item: PreviewItem, e: ReactMouseEvent) => void;
}> = memo(
  ({ row, expanded, categorizeEnabled, colWidths, onToggle, onCompare, onOpen, onContextMenu }) => {
    switch (row.kind) {
      case "year":
        return (
          <YearRow
            row={row}
            isExpanded={expanded.has(`y-${row.year}`)}
            onToggle={() => onToggle(`y-${row.year}`)}
          />
        );
      case "month":
        return (
          <MonthRow
            row={row}
            isExpanded={expanded.has(`m-${row.year}-${row.month}`)}
            onToggle={() => onToggle(`m-${row.year}-${row.month}`)}
          />
        );
      case "day":
        return (
          <DayRow
            row={row}
            isExpanded={expanded.has(`d-${row.year}-${row.month}-${row.day}`)}
            onToggle={() => onToggle(`d-${row.year}-${row.month}-${row.day}`)}
          />
        );
      case "file":
        return (
          <FileRow
            item={row.item}
            depth={row.depth}
            categorizeEnabled={categorizeEnabled}
            colWidths={colWidths}
            onCompare={onCompare}
            onOpen={onOpen}
            onContextMenu={onContextMenu}
          />
        );
      case "cat-header":
        return (
          <CatHeaderRow
            row={row}
            isExpanded={expanded.has(row.catKey)}
            onToggle={() => onToggle(row.catKey)}
          />
        );
      case "cat-file":
        return (
          <FileRow
            item={row.item}
            depth={row.depth}
            categorizeEnabled={categorizeEnabled}
            colWidths={colWidths}
            onCompare={onCompare}
            onOpen={onOpen}
            onContextMenu={onContextMenu}
          />
        );
      case "date-dup-header":
        return (
          <DateDupHeaderRow
            row={row}
            isExpanded={expanded.has(row.bucketKey)}
            onToggle={() => onToggle(row.bucketKey)}
          />
        );
      case "date-dup-file":
        return (
          <FileRow
            item={row.item}
            depth={row.depth}
            categorizeEnabled={categorizeEnabled}
            colWidths={colWidths}
            onCompare={onCompare}
            onOpen={onOpen}
            onContextMenu={onContextMenu}
          />
        );
      case "folder-header":
        return (
          <FolderHeaderRow
            row={row}
            isExpanded={expanded.has(`folder-${row.folderKey}`)}
            onToggle={() => onToggle(`folder-${row.folderKey}`)}
          />
        );
      case "folder-file":
        return (
          <FileRow
            item={row.item}
            indent
            categorizeEnabled={categorizeEnabled}
            colWidths={colWidths}
            onCompare={onCompare}
            onOpen={onOpen}
            onContextMenu={onContextMenu}
          />
        );
      default:
        return null;
    }
  },
);

function TreeColumnHeader({
  colWidths,
  onResizeStart,
}: {
  colWidths: ColWidths;
  onResizeStart: (col: keyof ColWidths, e: ReactMouseEvent) => void;
}) {
  return (
    <div
      className="flex select-none items-center gap-2 border-b border-border bg-muted/30 px-3"
      style={{ height: 26 }}
    >
      <span className="shrink-0" style={{ width: 0 }} aria-hidden />
      <span className="w-4 shrink-0" />
      {(["name", "source", "date"] as const).map((col) => (
        <div
          key={col}
          className={cn(
            "group relative flex shrink-0 items-center",
            col !== "name" && "hidden sm:flex",
          )}
          style={{ width: colWidths[col] }}
        >
          <span className="truncate pr-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
            {COL_LABELS[col]}
          </span>
          <div
            className="absolute right-0 top-0 z-10 flex h-full w-3 cursor-col-resize items-center justify-center"
            onMouseDown={(e) => onResizeStart(col, e)}
          >
            <div className="h-3/4 w-px bg-border transition-colors group-hover:bg-primary/50" />
          </div>
        </div>
      ))}
      <span className="hidden shrink-0 text-transparent sm:block">→</span>
      <span className="hidden min-w-0 flex-1 truncate text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:block">
        Destination
      </span>
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface PreviewListProps {
  items: PreviewItem[];
  expanded: Set<string>;
  sortCriteria?: string[];
  categorizeEnabled?: boolean;
  onToggle: (key: string) => void;
  onOpen: (item: PreviewItem) => void;
  onCompare: (item: PreviewItem) => void;
  onContextMenu: (item: PreviewItem, e: ReactMouseEvent) => void;
  // Sort controls (rendered inside the list's toolbar)
  sortBy: string;
  sortDir: "asc" | "desc";
  onSortByChange: (s: string) => void;
  onSortDirToggle: () => void;
}

const SORT_OPTIONS: { key: string; label: string }[] = [
  { key: "name", label: "Name" },
  { key: "date", label: "Date" },
  { key: "size", label: "Size" },
  { key: "status", label: "Status" },
];

export function PreviewList({
  items,
  expanded,
  sortCriteria = ["year", "month", "day"],
  categorizeEnabled = false,
  onToggle,
  onOpen,
  onCompare,
  onContextMenu,
  sortBy,
  sortDir,
  onSortByChange,
  onSortDirToggle,
}: PreviewListProps) {
  const [scrollTop, setScrollTop] = useState(0);
  const [colWidths, setColWidths] = useState<ColWidths>(DEFAULT_COL_WIDTHS);
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);
  const colResizing = useRef<{ col: keyof ColWidths; startX: number; startW: number } | null>(null);

  const handleColResizeStart = useCallback(
    (col: keyof ColWidths, e: ReactMouseEvent) => {
      colResizing.current = { col, startX: e.clientX, startW: colWidths[col] };
      e.preventDefault();
    },
    [colWidths],
  );

  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!colResizing.current) return;
      const { col, startX, startW } = colResizing.current;
      const delta = e.clientX - startX;
      const [min, max] = COL_LIMITS[col];
      setColWidths((prev) => ({ ...prev, [col]: Math.max(min, Math.min(max, startW + delta)) }));
    };
    const onMouseUp = () => {
      colResizing.current = null;
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    const timeout = setTimeout(() => {
      window.addEventListener("click", close);
      window.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      clearTimeout(timeout);
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  const handleContextMenu = useCallback(
    (item: PreviewItem, e: ReactMouseEvent) => {
      setCtxMenu({ x: e.clientX, y: e.clientY, item });
      onContextMenu(item, e);
    },
    [onContextMenu],
  );

  const flatRows = useMemo(
    () => buildFlatRows(items, expanded, sortCriteria, categorizeEnabled),
    [items, expanded, sortCriteria, categorizeEnabled],
  );

  // Precompute the breadcrumb for every row in a single pass so scrolling is an
  // O(1) array lookup. Previously this recomputed the running breadcrumb from
  // row 0 on every scroll event — O(n) per frame, janky deep in a large list.
  const breadcrumbs = useMemo(() => {
    const out = new Array<string>(flatRows.length);
    let year = "",
      monthName = "",
      dayLabel = "",
      sectionLabel = "";
    for (let i = 0; i < flatRows.length; i++) {
      const row = flatRows[i];
      if (row.kind === "year") {
        year = row.year;
        monthName = "";
        dayLabel = "";
        sectionLabel = "";
      } else if (row.kind === "month") {
        monthName = row.monthName;
        dayLabel = "";
        sectionLabel = "";
      } else if (row.kind === "day") {
        dayLabel = `${parseInt(row.day, 10)} ${MONTH_NAMES[parseInt(row.month, 10) - 1] ?? row.month}`;
        sectionLabel = "";
      } else if (row.kind === "cat-header") {
        sectionLabel = row.name;
      } else if (row.kind === "cat-file") {
        sectionLabel = row.catName;
      } else if (row.kind === "date-dup-header" || row.kind === "date-dup-file") {
        sectionLabel = "_duplicates";
      } else if (row.kind === "folder-header") {
        year = "";
        monthName = "";
        dayLabel = "";
        sectionLabel = row.label;
      }
      const parts = [year, monthName, dayLabel].filter(Boolean);
      if (sectionLabel) parts.push(sectionLabel);
      out[i] = parts.join(" › ");
    }
    return out;
  }, [flatRows]);

  const scrollContextLabel =
    breadcrumbs.length === 0
      ? ""
      : breadcrumbs[
          Math.min(breadcrumbs.length - 1, Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT)))
        ];

  const totalListHeight = flatRows.length * ITEM_HEIGHT;
  const hasRows = flatRows.length > 0;
  const containerHeight = hasRows ? Math.min(totalListHeight, MAX_CONTAINER_HEIGHT) : EMPTY_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ITEM_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(
    flatRows.length,
    Math.ceil((scrollTop + containerHeight) / ITEM_HEIGHT) + OVERSCAN,
  );

  return (
    <>
      {/* Sort toolbar */}
      <div className="flex items-center gap-2 border-b bg-muted/20 px-3 py-1.5">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Sort
        </span>
        <select
          value={sortBy}
          onChange={(e) => onSortByChange(e.target.value)}
          className="h-6 flex-none rounded border border-input bg-background px-1.5 text-xs outline-none focus:ring-1 focus:ring-ring"
        >
          {SORT_OPTIONS.map(({ key, label }) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
        <button
          onClick={onSortDirToggle}
          className="flex h-6 w-6 items-center justify-center rounded border border-input bg-background text-xs text-foreground transition-colors hover:bg-muted/70"
          title={
            sortDir === "asc"
              ? "Ascending — click for descending"
              : "Descending — click for ascending"
          }
        >
          {sortDir === "asc" ? (
            <FiArrowUp className="h-3 w-3" />
          ) : (
            <FiArrowDown className="h-3 w-3" />
          )}
        </button>
      </div>

      {/* Sticky breadcrumb */}
      <div className="min-h-[26px] border-b bg-muted/40 px-4 py-1 text-[11px] font-medium text-muted-foreground">
        {scrollContextLabel}
      </div>

      {/* Column header */}
      <TreeColumnHeader colWidths={colWidths} onResizeStart={handleColResizeStart} />

      {/* Virtual tree */}
      <div
        style={{
          height: containerHeight,
          overflowY: totalListHeight > MAX_CONTAINER_HEIGHT ? "auto" : "hidden",
        }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        {flatRows.length === 0 ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            No items match the current filter.
          </div>
        ) : (
          <div style={{ height: totalListHeight, position: "relative" }}>
            {flatRows.slice(startIndex, endIndex).map((row, i) => (
              <div
                key={getRowKey(row, startIndex + i)}
                style={{
                  position: "absolute",
                  top: (startIndex + i) * ITEM_HEIGHT,
                  left: 0,
                  right: 0,
                  height: ITEM_HEIGHT,
                }}
              >
                <RowRenderer
                  row={row}
                  expanded={expanded}
                  categorizeEnabled={categorizeEnabled}
                  colWidths={colWidths}
                  onToggle={onToggle}
                  onCompare={onCompare}
                  onOpen={onOpen}
                  onContextMenu={handleContextMenu}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {ctxMenu && (
        <ContextMenu
          state={ctxMenu}
          onPreview={onOpen}
          onCompare={onCompare}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </>
  );
}
