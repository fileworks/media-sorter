/** Browse planned folders and resolve duplicate sets in place. */

import { useMemo } from "react";
import {
  FiChevronDown,
  FiChevronRight,
  FiCornerDownRight,
  FiFolder,
  FiLayers,
  FiLock,
} from "react-icons/fi";

import { StackVisual } from "@/components/screens/review/StackVisual";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Thumbnail } from "@/components/ui/thumbnail";
import { Tooltip } from "@/components/ui/tooltip";
import { useVirtualWindow } from "@/hooks/useVirtualWindow";
import { useViewportBudget } from "@/hooks/useViewportBudget";
import { useI18n } from "@/i18n/I18nContext";
import { MIN_TARGET_24 } from "@/lib/a11y";
import { formatDate } from "@/lib/dateFormatters";
import { formatBytes } from "@/lib/formatters";
import { companionRoleLabel, companionStatusLabel } from "@/lib/evidenceLabels";
import { formatMetadataSource } from "@/lib/metadataSource";
import { isDecidedState, isProposedState, isUndecidedState } from "@/lib/duplicateDecisions";
import { cn } from "@/lib/utils";
import {
  folderGroups,
  type BrowseEntry,
  type FolderGroup,
  type SetEntry,
} from "@/lib/reviewBrowse";
import { sortEntries, sortRows, type ReviewSort } from "@/lib/reviewSort";
import { relativeDestination, type ReviewRow } from "@/lib/reviewRows";

export type ViewMode = "grid" | "list";

const ROW_HEIGHT = 56;
const LIST_CHROME = 360;
const LIST_MIN_HEIGHT = 260;

/** One line in the list: a subfolder heading, a file, a set, or a set opened. */
type Line =
  | { kind: "group"; key: string; group: FolderGroup; label: string }
  | { kind: "file"; key: string; row: ReviewRow }
  | { kind: "set"; key: string; entry: SetEntry }
  | { kind: "setBody"; key: string; entry: SetEntry };

function flatten(
  groups: readonly FolderGroup[],
  expanded: ReadonlySet<string>,
  label: (group: FolderGroup) => string,
): Line[] {
  const lines: Line[] = [];
  for (const group of groups) {
    lines.push({ kind: "group", key: `group:${group.path}`, group, label: label(group) });
    for (const entry of group.entries) {
      if (entry.kind === "file") {
        lines.push({ kind: "file", key: entry.key, row: entry.row });
        continue;
      }
      lines.push({ kind: "set", key: entry.key, entry });
      if (expanded.has(entry.id)) {
        lines.push({ kind: "setBody", key: `${entry.key}:body`, entry });
      }
    }
  }
  return lines;
}

interface BrowsePaneProps {
  entries: BrowseEntry[];
  view: ViewMode;
  /** The folder being shown, which the tree and the breadcrumb also read. */
  selectedPath: string | null;
  onSelectPath: (path: string | null) => void;
  /** How a synthetic folder ("stays where it is") is named. */
  folderLabel: (path: string, name: string) => string;
  selected: ReadonlySet<string>;
  /** Set-level selection shared with Resolve's bulk actions. */
  selectedSetIds: ReadonlySet<string>;
  expandedSets: ReadonlySet<string>;
  onToggleSet: (setId: string) => void;
  onToggleSetSelection: (setId: string) => void;
  onToggle: (source: string, shiftKey: boolean) => void;
  /** The order chosen in the toolbar, applied inside each folder group. */
  sort: ReviewSort;
  onOpenDetail: (source: string) => void;
  onEnlarge: (source: string) => void;
  onResolveSet: (setId: string) => void;
  /** Deciding a set without leaving the folder it was found in. */
  onKeep: (setId: string, source: string) => void;
  onKeepAll: (setId: string) => void;
  onCompare: (entry: SetEntry) => void;
  /** Library root, stripped from planned destinations so rows show the tail. */
  destinationRoot: string;
  /** Remove a second border when the pane already sits inside Review's shell. */
  embedded?: boolean;
}

export function BrowsePane({
  entries,
  view,
  selectedPath,
  onSelectPath,
  folderLabel,
  selected,
  selectedSetIds,
  expandedSets,
  onToggleSet,
  onToggleSetSelection,
  onToggle,
  sort,
  onOpenDetail,
  onEnlarge,
  onResolveSet,
  onKeep,
  onKeepAll,
  onCompare,
  destinationRoot,
  embedded = false,
}: BrowsePaneProps) {
  const { t, locale } = useI18n();
  // Sort within destination groups without reordering the hierarchy.
  const groups = useMemo(
    () =>
      folderGroups(entries, selectedPath).map((group) => ({
        ...group,
        entries: sortEntries(group.entries, sort, locale),
      })),
    [entries, locale, selectedPath, sort],
  );
  const label = useMemo(
    () => (group: FolderGroup) =>
      group.direct ? t("review.browse.landsHere") : folderLabel(group.path, group.name),
    [folderLabel, t],
  );
  const lines = useMemo(() => flatten(groups, expandedSets, label), [expandedSets, groups, label]);
  const maxHeight = useViewportBudget({ reserved: LIST_CHROME, min: LIST_MIN_HEIGHT });

  const windowing = useVirtualWindow({
    count: lines.length,
    estimateSize: ROW_HEIGHT,
    maxHeight,
    overscan: 10,
    anchorKey: lines[0]?.key ?? null,
    measurementKey: lines,
  });

  if (view === "grid") {
    return (
      <div
        className={cn("overflow-y-auto", !embedded && "rounded-xl border border-border")}
        style={{ maxHeight }}
        role="group"
        aria-label={t("review.items")}
      >
        {groups.map((group) => (
          <section
            key={group.path}
            // Clears the sticky group heading above it.
            className="scroll-mt-8 border-b border-border last:border-b-0"
            style={{ contentVisibility: "auto", containIntrinsicSize: "320px" }}
          >
            {group.direct ? (
              <h3 className="sticky top-0 z-10 flex items-center gap-1.5 border-b border-success/20 bg-tint-success/60 px-3 py-2 text-3xs font-semibold uppercase tracking-[0.08em] text-success">
                <FiCornerDownRight className="h-3 w-3" aria-hidden />
                {t("review.browse.landsHere")}
              </h3>
            ) : (
              <FolderTile
                group={group}
                label={label(group)}
                onOpen={() => onSelectPath(group.path)}
                locale={locale}
              />
            )}

            {/* Draw only direct children of the current destination. */}
            {group.direct && (
              <ul className="grid grid-cols-2 gap-2 p-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {group.entries.map((entry) =>
                  entry.kind === "file" ? (
                    <li key={entry.key}>
                      <GridTile
                        row={entry.row}
                        selected={selected.has(entry.row.source)}
                        onToggle={(shiftKey) => onToggle(entry.row.source, shiftKey)}
                        onOpenDetail={() => onOpenDetail(entry.row.source)}
                        onEnlarge={() => onEnlarge(entry.row.source)}
                      />
                    </li>
                  ) : (
                    <li key={entry.key} className="col-span-full">
                      <SetBlock
                        entry={entry}
                        expanded={expandedSets.has(entry.id)}
                        selected={selected}
                        sort={sort}
                        setSelected={selectedSetIds.has(entry.id)}
                        onToggleExpand={() => onToggleSet(entry.id)}
                        onToggleSetSelection={() => onToggleSetSelection(entry.id)}
                        onToggleSelect={onToggle}
                        onOpenDetail={onOpenDetail}
                        onEnlarge={onEnlarge}
                        onResolve={() => onResolveSet(entry.id)}
                        onKeep={onKeep}
                        onKeepAll={onKeepAll}
                        onCompare={onCompare}
                        locale={locale}
                      />
                    </li>
                  ),
                )}
              </ul>
            )}
          </section>
        ))}
      </div>
    );
  }

  return (
    <div
      ref={windowing.scrollRef}
      onScroll={windowing.onScroll}
      className={cn("overflow-y-auto", !embedded && "rounded-xl border border-border")}
      style={{ maxHeight }}
      role="group"
      aria-label={t("review.items")}
    >
      {/* Header and rows share the same responsive grid. */}
      <div
        aria-hidden
        className="asset-grid sticky top-0 z-20 border-b border-border bg-card px-3 py-1 text-3xs font-bold uppercase tracking-wider text-faint"
      >
        <span />
        <span />
        <span>{t("review.browse.columnName")}</span>
        <span className="text-right">{t("review.browse.columnDate")}</span>
        <span className="text-right">{t("review.browse.columnStatus")}</span>
        <span>{t("review.browse.columnDestination")}</span>
      </div>
      <div style={{ height: windowing.totalSize, position: "relative" }}>
        {windowing.virtualItems.map((virtual) => {
          const line = lines[virtual.index];
          if (line === undefined) return null;
          return (
            <div
              key={line.key}
              data-virtual-index={virtual.index}
              ref={windowing.measureElement}
              // Clears the sticky column header when a row is scrolled into
              // view, so a focused row is not hidden underneath it.
              className="scroll-mt-8"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${virtual.start}px)`,
              }}
            >
              {line.kind === "group" ? (
                <GroupHeader
                  group={line.group}
                  label={line.label}
                  onOpen={line.group.direct ? null : () => onSelectPath(line.group.path)}
                  locale={locale}
                />
              ) : line.kind === "set" ? (
                <SetHeader
                  entry={line.entry}
                  expanded={expandedSets.has(line.entry.id)}
                  selected={selectedSetIds.has(line.entry.id)}
                  onToggle={() => onToggleSet(line.entry.id)}
                  onToggleSelection={() => onToggleSetSelection(line.entry.id)}
                  onResolve={() => onResolveSet(line.entry.id)}
                  locale={locale}
                />
              ) : line.kind === "setBody" ? (
                <SetCopies
                  entry={line.entry}
                  selected={selected}
                  sort={sort}
                  onToggleSelect={onToggle}
                  onOpenDetail={onOpenDetail}
                  onEnlarge={onEnlarge}
                  onKeep={onKeep}
                  onKeepAll={onKeepAll}
                  onCompare={onCompare}
                  locale={locale}
                />
              ) : (
                <FileLine
                  row={line.row}
                  selected={selected.has(line.row.source)}
                  onToggle={(shiftKey) => onToggle(line.row.source, shiftKey)}
                  onOpenDetail={() => onOpenDetail(line.row.source)}
                  onEnlarge={() => onEnlarge(line.row.source)}
                  destinationRoot={destinationRoot}
                  locale={locale}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** The subfolder heading in the list: what it is called, and how many land there. */
function GroupHeader({
  group,
  label,
  onOpen,
  locale,
}: {
  group: FolderGroup;
  label: string;
  onOpen: (() => void) | null;
  locale: string;
}) {
  const { t } = useI18n();
  const count = group.entries.length.toLocaleString(locale);

  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-card/95 px-3 py-1.5 backdrop-blur-sm">
      {group.direct ? (
        <FiCornerDownRight className="h-3 w-3 shrink-0 text-faint" aria-hidden />
      ) : (
        <FiFolder className="h-3 w-3 shrink-0 text-faint" aria-hidden />
      )}
      <span className="min-w-0 truncate text-3xs font-semibold uppercase tracking-[0.08em] text-foreground">
        {label}
      </span>
      <span className="shrink-0 text-3xs tabular-nums text-faint">{count}</span>
      <span className="flex-1" />
      {onOpen !== null && (
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex min-h-6 shrink-0 items-center rounded-md px-2 py-0.5 text-3xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("review.browse.openFolder")}
        </button>
      )}
    </div>
  );
}

/** A subfolder in the grid: a face, a count, and a way into it. */
function FolderTile({
  group,
  label,
  onOpen,
  locale,
}: {
  group: FolderGroup;
  label: string;
  onOpen: () => void;
  locale: string;
}) {
  const { tCount } = useI18n();
  const faces = useMemo(() => {
    const paths: string[] = [];
    for (const entry of group.entries) {
      const row = entry.kind === "file" ? entry.row : (entry.keeper ?? entry.rows[0]);
      if (row) paths.push(row.source);
      if (paths.length === 4) break;
    }
    return paths;
  }, [group.entries]);

  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="grid h-12 w-12 shrink-0 grid-cols-2 grid-rows-2 gap-px overflow-hidden rounded-lg bg-border">
        {faces.map((source) => (
          <Thumbnail key={source} path={source} maxPx={80} className="h-full w-full" />
        ))}
        {faces.length === 0 && (
          <span className="col-span-2 row-span-2 flex items-center justify-center bg-muted">
            <FiFolder className="h-4 w-4 text-faint" aria-hidden />
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-semibold text-foreground">{label}</span>
        <span className="block text-3xs text-faint">
          {tCount("review.browse.folderCount", group.entries.length, {
            count: group.entries.length.toLocaleString(locale),
          })}
        </span>
      </span>
      <FiChevronRight className="h-4 w-4 shrink-0 text-faint" aria-hidden />
    </button>
  );
}

/** One duplicate set in its planned destination. */
function SetHeader({
  entry,
  expanded,
  selected,
  onToggle,
  onToggleSelection,
  onResolve,
  locale,
}: {
  entry: SetEntry;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
  onToggleSelection: () => void;
  onResolve: () => void;
  locale: string;
}) {
  const { t } = useI18n();
  const undecided = isUndecidedState(entry.decisionState) && !entry.hasBaseline;
  const proposed = isProposedState(entry.decisionState) && entry.proposedKeeper !== null;
  const settled = entry.hasBaseline || isDecidedState(entry.decisionState);
  const bytes = entry.rows.every((row) => row.sizeBytes !== null)
    ? entry.rows.reduce((sum, row) => sum + (row.sizeBytes ?? 0), 0)
    : null;
  const name = entry.keeper?.name ?? entry.rows[0]?.name ?? entry.id;

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 border-b px-3 py-2 transition-colors",
        settled
          ? "border-success/45 bg-tint-success/55"
          : proposed
            ? "border-primary/45 bg-tint-primary/45"
            : "border-primary/55 bg-tint-primary",
      )}
    >
      {!entry.hasBaseline && (
        <label className="grid h-6 w-6 shrink-0 place-items-center">
          <input
            type="checkbox"
            checked={selected}
            aria-label={t("review.setSelection.toggle", {
              name: entry.keeper?.name ?? entry.id,
            })}
            onChange={onToggleSelection}
            className="h-4 w-4 rounded border-border text-primary focus-visible:ring-2 focus-visible:ring-ring"
          />
        </label>
      )}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex min-h-6 min-w-0 flex-1 items-center gap-2.5 rounded-panel py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {expanded ? (
          <FiChevronDown className="h-3 w-3 shrink-0 text-faint" aria-hidden />
        ) : (
          <FiChevronRight className="h-3 w-3 shrink-0 text-faint" aria-hidden />
        )}
        <StackVisual paths={entry.rows.map((row) => row.source)} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1.5">
            <FiLayers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span className="truncate text-xs font-semibold text-foreground">{name}</span>
            <span className="shrink-0 text-xs text-muted-foreground">
              · {t("review.stack.copies", { count: entry.rows.length })}
            </span>
          </span>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-3xs text-muted-foreground">
            <span>
              {entry.setKind === "exact"
                ? t("review.stack.match.exact")
                : entry.setKind === "similar" && entry.similarity !== null
                  ? t("review.stack.match.similar", { percent: entry.similarity })
                  : t(`review.stack.kind.${entry.setKind}`)}
            </span>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{formatBytes(bytes, { locale })}</span>
            {entry.hasBaseline && (
              <Tooltip label={t("review.stack.baselineHelp")}>
                <span className="flex shrink-0 items-center gap-1 font-semibold">
                  <FiLock className="h-3 w-3" aria-hidden />
                  {t("review.stack.baseline")}
                </span>
              </Tooltip>
            )}
            {entry.keeper && isDecidedState(entry.decisionState) && (
              <span className="min-w-0 truncate">
                · {t("review.stack.keeping", { name: entry.keeper.name })}
              </span>
            )}
            {undecided && (
              <span className="min-w-0 truncate font-semibold text-foreground">
                · {t("review.browse.setUndecided")}
              </span>
            )}
            {/* The keep rule named itself on every row — the same words fifteen
                times, where only the file differs. It is stated once, with its
                full reasoning, on the screen that owns it. */}
            {proposed && entry.proposedKeeper && (
              <span className="min-w-0 truncate">
                ·{" "}
                {t("review.browse.setProposed", {
                  name: entry.proposedKeeper.name,
                })}
              </span>
            )}
            {entry.decisionKind === "keep_all" && (
              <span className="min-w-0 truncate font-semibold text-success">
                · {t("review.state.notDuplicates")}
              </span>
            )}
          </span>
        </span>
      </button>

      {/* Lift the status badge above the tinted row. */}
      <Badge
        tone={settled ? "success" : "primary"}
        className={cn("border bg-card", settled ? "border-success/30" : "border-primary/30")}
      >
        {t(settled ? "review.stack.state.decided" : "review.stack.state.open")}
      </Badge>

      {/* Offer sequential resolution without blocking inline decisions. */}
      <button
        type="button"
        onClick={onResolve}
        className={cn(
          "inline-flex min-h-6 shrink-0 items-center rounded-[5px] px-1.5 py-0.5 text-3xs font-bold transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          settled ? "text-success hover:bg-tint-success" : "text-primary hover:bg-tint-primary",
        )}
      >
        {t(settled ? "review.browse.openResult" : "review.browse.openInResolve")}
      </button>
    </div>
  );
}

/** Expanded duplicate set with copy facts and decision controls. */
function SetCopies({
  entry,
  selected,
  sort,
  onToggleSelect,
  onOpenDetail,
  onEnlarge,
  onKeep,
  onKeepAll,
  onCompare,
  locale,
}: {
  entry: SetEntry;
  selected: ReadonlySet<string>;
  sort: ReviewSort;
  onToggleSelect: (source: string, shiftKey: boolean) => void;
  onOpenDetail: (source: string) => void;
  onEnlarge: (source: string) => void;
  onKeep: (setId: string, source: string) => void;
  onKeepAll: (setId: string) => void;
  onCompare: (entry: SetEntry) => void;
  locale: string;
}) {
  const { t } = useI18n();
  const copies = sortRows(entry.rows, sort, locale);

  return (
    <div className="border-b border-border bg-muted/20 px-3 py-3">
      <ul className="flex flex-wrap gap-2.5">
        {copies.map((row) => {
          const locked = row.status === "baseline";
          const distinct = entry.decisionKind === "keep_all";
          const confirmedKeeper =
            (entry.hasBaseline || entry.decisionKind === "keeper") &&
            entry.keeper?.source === row.source;
          const kept = distinct || confirmedKeeper;
          const suggested = !kept && !locked && entry.proposedKeeper?.source === row.source;
          return (
            <li
              key={row.source}
              className={cn(
                "w-[10.5rem] overflow-hidden rounded-lg border bg-card",
                kept || locked
                  ? "border-success"
                  : suggested
                    ? "border-dashed border-primary"
                    : "border-border",
              )}
            >
              <div className="relative">
                <Thumbnail
                  path={row.source}
                  maxPx={320}
                  className="aspect-[4/3] w-full"
                  onOpen={() => onEnlarge(row.source)}
                  openLabel={t("review.viewer.open", { name: row.name })}
                />
                <label
                  className={cn(
                    MIN_TARGET_24,
                    "absolute left-1 top-1 h-6 w-6 items-center justify-center",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(row.source)}
                    disabled={locked}
                    aria-label={row.name}
                    aria-description={locked ? t("review.stack.baselineHelp") : undefined}
                    onChange={(event) =>
                      onToggleSelect(
                        row.source,
                        (event.nativeEvent as MouseEvent | undefined)?.shiftKey ?? false,
                      )
                    }
                    className="h-3.5 w-3.5 rounded border-border bg-card/90 text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
                  />
                </label>
                {(kept || locked || suggested) && (
                  <span
                    className={cn(
                      "absolute right-1 top-1 rounded-full px-1.5 py-0.5 text-3xs font-semibold",
                      suggested
                        ? "border border-primary/40 bg-card text-primary"
                        : "bg-success text-background",
                    )}
                  >
                    {t(
                      locked
                        ? "review.resolve.protected"
                        : suggested
                          ? "review.resolve.suggested"
                          : "review.resolve.kept",
                    )}
                  </span>
                )}
              </div>

              <div className="space-y-0.5 px-2 py-1.5 text-3xs">
                <button
                  type="button"
                  onClick={() => onOpenDetail(row.source)}
                  className="block w-full truncate text-left text-xs font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {row.name}
                </button>
                <p className="truncate text-faint" title={row.folder}>
                  {row.folder}
                </p>
                <p className="text-faint">{formatBytes(row.sizeBytes, { locale })}</p>
                <p className="truncate text-faint">
                  {row.date === null
                    ? t("review.resolve.noDate")
                    : t("review.resolve.dated", {
                        date: formatDate(row.date, { locale }),
                        source: formatMetadataSource(row.dateSource, t),
                      })}
                </p>
                {row.setAsideCategory !== null && (
                  <p className="font-semibold text-warning">
                    {t(`review.setAside.${row.setAsideCategory}`)}
                  </p>
                )}
                {mediaUnitSummary(row, t) && (
                  <p className="line-clamp-3 text-faint">{mediaUnitSummary(row, t)}</p>
                )}
              </div>

              <div className="px-2 pb-2">
                {locked || entry.hasBaseline ? (
                  <p className="flex items-center gap-1 text-3xs font-semibold text-muted-foreground">
                    <FiLock className="h-3 w-3" aria-hidden />
                    {t(locked ? "review.resolve.protected" : "review.resolve.baselineWins")}
                  </p>
                ) : (
                  <Button
                    size="sm"
                    variant={kept ? "outline" : "default"}
                    className="w-full"
                    disabled={kept}
                    aria-description={kept ? t("review.resolve.alreadyKeeper") : undefined}
                    onClick={() => onKeep(entry.id, row.source)}
                  >
                    {kept ? t("review.resolve.kept") : t("review.detail.makeKeeper")}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {!entry.hasBaseline && (
          <Button size="sm" variant="outline" onClick={() => onKeepAll(entry.id)}>
            {t("review.resolve.keepAll")}
          </Button>
        )}
        <Button size="sm" variant="ghost" onClick={() => onCompare(entry)}>
          {t("review.compare.title")}
        </Button>
        {entry.hasBaseline && (
          <p className="text-3xs text-muted-foreground">{t("review.resolve.baselineWins")}</p>
        )}
      </div>
    </div>
  );
}

/** The grid's version: the set header and, when opened, the same decision block. */
function SetBlock({
  entry,
  expanded,
  selected,
  sort,
  setSelected,
  onToggleExpand,
  onToggleSetSelection,
  onToggleSelect,
  onOpenDetail,
  onEnlarge,
  onResolve,
  onKeep,
  onKeepAll,
  onCompare,
  locale,
}: {
  entry: SetEntry;
  expanded: boolean;
  selected: ReadonlySet<string>;
  sort: ReviewSort;
  setSelected: boolean;
  onToggleExpand: () => void;
  onToggleSetSelection: () => void;
  onToggleSelect: (source: string, shiftKey: boolean) => void;
  onOpenDetail: (source: string) => void;
  onEnlarge: (source: string) => void;
  onResolve: () => void;
  onKeep: (setId: string, source: string) => void;
  onKeepAll: (setId: string) => void;
  onCompare: (entry: SetEntry) => void;
  locale: string;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <SetHeader
        entry={entry}
        expanded={expanded}
        selected={setSelected}
        onToggle={onToggleExpand}
        onToggleSelection={onToggleSetSelection}
        onResolve={onResolve}
        locale={locale}
      />
      {expanded && (
        <SetCopies
          entry={entry}
          selected={selected}
          sort={sort}
          onToggleSelect={onToggleSelect}
          onOpenDetail={onOpenDetail}
          onEnlarge={onEnlarge}
          onKeep={onKeep}
          onKeepAll={onKeepAll}
          onCompare={onCompare}
          locale={locale}
        />
      )}
    </div>
  );
}

/** File row with separate selection, preview, and detail actions. */
function FileLine({
  row,
  selected,
  onToggle,
  onOpenDetail,
  onEnlarge,
  destinationRoot,
  locale,
}: {
  row: ReviewRow;
  selected: boolean;
  onToggle: (shiftKey: boolean) => void;
  onOpenDetail: () => void;
  onEnlarge: () => void;
  destinationRoot: string;
  locale: string;
}) {
  const { t } = useI18n();
  const locked = row.status === "baseline";

  return (
    /* The checkbox remains the accessible selection control. */
    <div
      onClick={(event) => {
        if (locked) return;
        onToggle(event.shiftKey);
      }}
      className={cn(
        "asset-grid h-[3.25rem] border-b border-border px-3 text-xs",
        !locked && "cursor-pointer hover:bg-muted/50",
        selected && "bg-accent",
      )}
      data-selected={selected}
    >
      <label
        className={cn(MIN_TARGET_24, "h-6 w-6 items-center justify-center")}
        onClick={(event) => event.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={selected}
          disabled={locked}
          aria-label={row.name}
          aria-description={locked ? t("review.stack.baselineHelp") : undefined}
          // Preserve shift-range selection from the checkbox event.
          onChange={(event) =>
            onToggle((event.nativeEvent as MouseEvent | undefined)?.shiftKey ?? false)
          }
          className="h-3.5 w-3.5 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        />
      </label>

      <span onClick={(event) => event.stopPropagation()}>
        <Thumbnail
          path={row.source}
          maxPx={80}
          className="h-9 w-9 rounded"
          onOpen={onEnlarge}
          openLabel={t("review.viewer.open", { name: row.name })}
        />
      </span>

      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onOpenDetail();
        }}
        title={t(row.reason.key, row.reason.params)}
        className="min-w-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-1.5 truncate font-medium text-foreground">
          {locked && <FiLock className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />}
          {row.name}
        </span>
        {/* Keep the row summary compact; full provenance is in details. */}
        <span className="block truncate text-3xs text-faint">
          {formatBytes(row.sizeBytes, { locale })}
          {row.date !== null && ` · ${formatMetadataSource(row.dateSource, t)}`}
        </span>
      </button>

      <span className="truncate text-right text-3xs tabular-nums text-muted-foreground">
        {row.date === null ? t("review.resolve.noDate") : formatDate(row.date, { locale })}
      </span>

      <span className="flex justify-end gap-1">
        {row.setAsideCategory !== null ? (
          <span className="truncate rounded border border-warning/40 bg-tint-warning px-1.5 py-0.5 text-3xs font-semibold text-warning">
            {t(`review.setAside.${row.setAsideCategory}`)}
          </span>
        ) : row.flags.length > 0 ? (
          <Tooltip
            label={
              row.flags[0] === "unit_member"
                ? (mediaUnitSummary(row, t) ?? t("review.flag.unit_member.help"))
                : t(`review.flag.${row.flags[0]}.help`)
            }
          >
            <span className="truncate rounded border border-border px-1.5 py-0.5 text-3xs font-semibold text-muted-foreground">
              {t(`review.flag.${row.flags[0]}`)}
            </span>
          </Tooltip>
        ) : (
          <span className="rounded bg-tint-success px-1.5 py-0.5 text-3xs font-semibold text-success">
            {t("review.browse.statusReady")}
          </span>
        )}
      </span>

      <span className="truncate font-mono text-3xs text-faint" title={row.destination ?? undefined}>
        {row.destination === null
          ? ""
          : (destinationFolder(relativeDestination(row.destination, destinationRoot)) ?? "")}
      </span>
    </div>
  );
}

/** The folder part of a root-relative destination — the cell shows where, not what. */
function destinationFolder(relative: string): string {
  const separator = relative.lastIndexOf("/");
  return separator === -1 ? "" : `${relative.slice(0, separator)}/`;
}

function mediaUnitSummary(
  row: ReviewRow,
  t: (key: string, params?: Record<string, string | number>) => string,
): string | null {
  if (!row.unitId) return null;
  const membership = t(
    row.unitPrimary === null
      ? "review.browse.unit.unknown"
      : row.unitPrimary
        ? "review.browse.unit.primary"
        : "review.browse.unit.member",
    { id: row.unitId },
  );
  const companions = (row.companions ?? []).map((companion) =>
    t("review.browse.unit.companion", {
      role: companionRoleLabel(companion.role, t),
      status: companionStatusLabel(companion.status, t),
      destination: companion.destination ?? t("review.destination.none"),
      warning: companion.warning ?? t("review.browse.unit.noWarning"),
    }),
  );
  const warnings = row.unitWarnings ?? [];
  return [membership, ...companions, ...warnings].join(" · ");
}

/** One file in the grid: the tile opens it, the corner checkbox selects it. */
function GridTile({
  row,
  selected,
  onToggle,
  onOpenDetail,
  onEnlarge,
}: {
  row: ReviewRow;
  selected: boolean;
  onToggle: (shiftKey: boolean) => void;
  onOpenDetail: () => void;
  onEnlarge: () => void;
}) {
  const { t } = useI18n();
  const locked = row.status === "baseline";

  return (
    <div
      className={cn(
        "group/tile relative overflow-hidden rounded-lg border transition-colors",
        selected ? "border-primary" : "border-border hover:border-faint",
      )}
    >
      <Thumbnail
        path={row.source}
        maxPx={240}
        className="aspect-square w-full"
        onOpen={onEnlarge}
        openLabel={t("review.viewer.open", { name: row.name })}
      />
      <Tooltip
        label={[row.name, t(row.reason.key, row.reason.params), mediaUnitSummary(row, t)]
          .filter(Boolean)
          .join(" — ")}
      >
        <button
          type="button"
          onClick={onOpenDetail}
          className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <span className="block truncate px-2 py-1 text-3xs font-medium text-foreground">
            {row.name}
          </span>
        </button>
      </Tooltip>

      {/* Keep the selection control visible after selection. */}
      <label
        className={cn(
          MIN_TARGET_24,
          "absolute left-1 top-1 h-6 w-6 items-center justify-center rounded bg-card/90 transition-opacity",
          selected
            ? "opacity-100"
            : "review-grid-select opacity-0 focus-within:opacity-100 group-hover/tile:opacity-100",
        )}
      >
        <input
          type="checkbox"
          checked={selected}
          disabled={locked}
          aria-label={t("review.browse.select", { name: row.name })}
          aria-description={locked ? t("review.stack.baselineHelp") : undefined}
          onChange={(event) =>
            onToggle((event.nativeEvent as MouseEvent | undefined)?.shiftKey ?? false)
          }
          className="block h-3.5 w-3.5 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
        />
      </label>

      {locked && (
        <span className="absolute right-1 top-1 rounded bg-card/90 p-1">
          <FiLock className="h-3 w-3 text-muted-foreground" aria-hidden />
        </span>
      )}
      {row.setAsideCategory !== null && (
        <span className="absolute bottom-7 right-1 rounded bg-card/90 px-1.5 py-0.5 text-3xs font-semibold text-warning">
          {t(`review.setAside.${row.setAsideCategory}`)}
        </span>
      )}
    </div>
  );
}
