/**
 * What lands in the folder you selected, which subfolder each file goes to, and
 * why.
 *
 * The pane used to answer "how many files are under this folder" by listing all
 * of them flat. The tree beside it already answered that with a count; what
 * neither answered was *which* files go to `01 — January` and which to
 * `_copies/`, on a screen whose whole purpose is reading the structure a run
 * would build. So the contents are grouped by the next folder down: the list
 * under sticky headers, the grid as folder tiles you can move into.
 *
 * **A duplicate set is decided where it is found.** Expanding one puts every
 * copy side by side with the facts needed to choose between them and a control
 * on each. Sending the reader to a separate queue to answer a question about a
 * set they are looking at is the trip that made them ask for this screen to
 * change.
 *
 * **Selecting and opening are different gestures.** The preview and the name
 * open a file; the rest of the row selects it. In the grid the tile opens and a
 * corner checkbox selects. Neither needs a mode, and both are reachable from the
 * keyboard.
 *
 * Rows are measured rather than estimated: a group header, a set header, a
 * collapsed set and an opened one are four different heights, and an estimate
 * applied to all four drifts further with every one the list scrolls past.
 */

import { useMemo } from "react";
import {
  FiChevronDown,
  FiChevronRight,
  FiCornerDownRight,
  FiFolder,
  FiLayers,
  FiLock,
} from "react-icons/fi";

import { Button } from "@/components/ui/button";
import { Thumbnail } from "@/components/ui/thumbnail";
import { Tooltip } from "@/components/ui/tooltip";
import { useVirtualWindow } from "@/hooks/useVirtualWindow";
import { useViewportBudget } from "@/hooks/useViewportBudget";
import { useI18n } from "@/i18n/I18nContext";
import { formatBytes } from "@/lib/formatters";
import { formatMetadataSource } from "@/lib/metadataSource";
import { isDecidedState, isProposedState, isUndecidedState } from "@/lib/duplicateDecisions";
import { cn } from "@/lib/utils";
import {
  folderGroups,
  type BrowseEntry,
  type FolderGroup,
  type SetEntry,
} from "@/lib/reviewBrowse";
import type { ReviewRow } from "@/lib/reviewRows";

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
  onOpenDetail: (source: string) => void;
  onEnlarge: (source: string) => void;
  onResolveSet: (setId: string) => void;
  /** Deciding a set without leaving the folder it was found in. */
  onKeep: (setId: string, source: string) => void;
  onKeepAll: (setId: string) => void;
  onCompare: (entry: SetEntry) => void;
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
  onOpenDetail,
  onEnlarge,
  onResolveSet,
  onKeep,
  onKeepAll,
  onCompare,
}: BrowsePaneProps) {
  const { t, locale } = useI18n();
  const groups = useMemo(() => folderGroups(entries, selectedPath), [entries, selectedPath]);
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
  });

  if (view === "grid") {
    return (
      <div
        className="overflow-y-auto rounded-xl border border-border"
        style={{ maxHeight }}
        role="group"
        aria-label={t("review.items")}
      >
        {groups.map((group) => (
          <section key={group.path} className="border-b border-border last:border-b-0">
            {group.direct ? (
              <h3 className="px-3 py-2 text-3xs font-semibold uppercase tracking-[0.08em] text-faint">
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

            {/* Only the files landing here are drawn as tiles. A subfolder is a
                tile you move into, so its contents are not also spilled beside
                it — that is the flat list this rendering replaces. */}
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
                      />
                    </li>
                  ) : (
                    <li key={entry.key} className="col-span-full">
                      <SetBlock
                        entry={entry}
                        expanded={expandedSets.has(entry.id)}
                        selected={selected}
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
      className="overflow-y-auto rounded-xl border border-border"
      style={{ maxHeight }}
      role="group"
      aria-label={t("review.items")}
    >
      <div style={{ height: windowing.totalSize, position: "relative" }}>
        {windowing.virtualItems.map((virtual) => {
          const line = lines[virtual.index];
          if (line === undefined) return null;
          return (
            <div
              key={line.key}
              data-virtual-index={virtual.index}
              ref={windowing.measureElement}
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
          className="shrink-0 rounded-md px-2 py-0.5 text-3xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
  const { t } = useI18n();
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
          {t("review.browse.folderCount", { count: group.entries.length.toLocaleString(locale) })}
        </span>
      </span>
      <FiChevronRight className="h-4 w-4 shrink-0 text-faint" aria-hidden />
    </button>
  );
}

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
  const bytes = entry.rows.reduce((sum, row) => sum + row.sizeBytes, 0);

  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted/50 px-3 py-2">
      {!entry.hasBaseline && (
        <input
          type="checkbox"
          checked={selected}
          aria-label={t("review.setSelection.toggle", {
            name: entry.keeper?.name ?? entry.id,
          })}
          onChange={onToggleSelection}
          className="h-4 w-4 shrink-0 rounded border-border text-primary focus-visible:ring-2 focus-visible:ring-ring"
        />
      )}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-lg py-0.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {expanded ? (
          <FiChevronDown className="h-3 w-3 shrink-0 text-faint" aria-hidden />
        ) : (
          <FiChevronRight className="h-3 w-3 shrink-0 text-faint" aria-hidden />
        )}
        <FiLayers className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
        <span className="text-xs font-semibold text-foreground">
          {t("review.stack.copies", { count: entry.rows.length })}
        </span>
        <span className="rounded-full border border-border px-2 py-0.5 text-3xs font-semibold text-muted-foreground">
          {t(`review.stack.kind.${entry.setKind}`)}
        </span>
        <span className="shrink-0 text-3xs text-faint">{formatBytes(bytes, { locale })}</span>
        {entry.hasBaseline && (
          <Tooltip label={t("review.stack.baselineHelp")}>
            <span className="flex shrink-0 items-center gap-1 text-3xs font-semibold text-muted-foreground">
              <FiLock className="h-3 w-3" aria-hidden />
              {t("review.stack.baseline")}
            </span>
          </Tooltip>
        )}
        {entry.keeper && isDecidedState(entry.decisionState) && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">
            {t("review.stack.keeping", { name: entry.keeper.name })}
          </span>
        )}
        {undecided && (
          <span className="min-w-0 truncate text-xs font-medium text-warning">
            {t("review.browse.setUndecided")}
          </span>
        )}
        {isProposedState(entry.decisionState) && entry.proposedKeeper && (
          <span className="min-w-0 truncate text-xs font-medium text-primary">
            {t("review.browse.setProposed", {
              name: entry.proposedKeeper.name,
              rule: t(`config.keeper.${entry.proposalPolicy ?? "manual"}`),
            })}
          </span>
        )}
        {entry.decisionKind === "keep_all" && (
          <span className="min-w-0 truncate text-xs font-medium text-success">
            {t("review.state.notDuplicates")}
          </span>
        )}
      </button>

      {/* Opening the set in the queue is still offered, for working through
          several in sequence — but it is no longer the only way to decide one. */}
      <button
        type="button"
        onClick={onResolve}
        className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-3xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("review.browse.openInResolve")}
      </button>
    </div>
  );
}

/**
 * The set opened in place: every copy, and the decision.
 *
 * The facts on each card are the ones that decide between two copies of the same
 * picture — how many pixels, how many bytes, where it came from, and what date
 * was read off it. A baseline copy states that it is protected instead of
 * offering a control that cannot be used.
 */
function SetCopies({
  entry,
  selected,
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
  onToggleSelect: (source: string, shiftKey: boolean) => void;
  onOpenDetail: (source: string) => void;
  onEnlarge: (source: string) => void;
  onKeep: (setId: string, source: string) => void;
  onKeepAll: (setId: string) => void;
  onCompare: (entry: SetEntry) => void;
  locale: string;
}) {
  const { t } = useI18n();

  return (
    <div className="border-b border-border bg-muted/20 px-3 py-3">
      <ul className="flex flex-wrap gap-2.5">
        {entry.rows.map((row) => {
          const isKeeper = entry.keeper?.source === row.source;
          const locked = row.status === "baseline";
          return (
            <li
              key={row.source}
              className={cn(
                "w-[10.5rem] overflow-hidden rounded-lg border bg-card",
                isKeeper ? "border-success" : "border-border",
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
                <span className="absolute left-1 top-1">
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
                </span>
                {isKeeper && (
                  <span className="absolute right-1 top-1 rounded-full bg-success px-1.5 py-0.5 text-3xs font-semibold text-background">
                    {t("review.resolve.kept")}
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
                        date: row.date,
                        source: formatMetadataSource(row.dateSource, t),
                      })}
                </p>
                {row.setAsideCategory !== null && (
                  <p className="font-semibold text-warning">
                    {t(`review.setAside.${row.setAsideCategory}`)}
                  </p>
                )}
              </div>

              <div className="px-2 pb-2">
                {locked ? (
                  <p className="flex items-center gap-1 text-3xs font-semibold text-muted-foreground">
                    <FiLock className="h-3 w-3" aria-hidden />
                    {t("review.resolve.protected")}
                  </p>
                ) : (
                  <Button
                    size="sm"
                    variant={isKeeper ? "outline" : "default"}
                    className="w-full"
                    disabled={isKeeper}
                    aria-description={isKeeper ? t("review.resolve.alreadyKeeper") : undefined}
                    onClick={() => onKeep(entry.id, row.source)}
                  >
                    {isKeeper ? t("review.resolve.kept") : t("review.detail.makeKeeper")}
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

/**
 * One file in the list.
 *
 * The row's own surface selects; the preview and the name open. Clicking the
 * name used to be the only way to open a file and the checkbox the only way to
 * select one, which put the more common gesture on the smaller target and gave
 * the row's whole width to nothing at all.
 */
function FileLine({
  row,
  selected,
  onToggle,
  onOpenDetail,
  onEnlarge,
  locale,
}: {
  row: ReviewRow;
  selected: boolean;
  onToggle: (shiftKey: boolean) => void;
  onOpenDetail: () => void;
  onEnlarge: () => void;
  locale: string;
}) {
  const { t } = useI18n();
  const locked = row.status === "baseline";

  return (
    /* The pointer affordance is deliberately redundant: the checkbox is the
       accessible selection control and stays keyboard-reachable, so widening the
       target adds a gesture without inventing a second semantic. */
    <div
      onClick={(event) => {
        if (locked) return;
        onToggle(event.shiftKey);
      }}
      className={cn(
        "flex items-center gap-2.5 border-b border-border px-3 py-2 text-xs",
        !locked && "cursor-pointer hover:bg-muted/50",
        selected && "bg-accent",
      )}
      data-selected={selected}
    >
      <input
        type="checkbox"
        checked={selected}
        disabled={locked}
        aria-label={row.name}
        aria-description={locked ? t("review.stack.baselineHelp") : undefined}
        onClick={(event) => event.stopPropagation()}
        // Shift is read off the change event's own click, and the box is left
        // to toggle normally. A second `onClick` handler used to call
        // `preventDefault()` here, which reverted the DOM checkbox after
        // React's value tracker had already recorded the toggle.
        onChange={(event) =>
          onToggle((event.nativeEvent as MouseEvent | undefined)?.shiftKey ?? false)
        }
        className="h-3.5 w-3.5 shrink-0 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
      />

      <span onClick={(event) => event.stopPropagation()} className="shrink-0">
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
        className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-center gap-1.5 truncate font-medium text-foreground">
          {locked && <FiLock className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />}
          {row.name}
        </span>
        {/* Where it came from, then why it lands where it lands. Both without a
            request: a per-row fetch over forty thousand rows is not a list. */}
        <span className="block truncate text-3xs text-faint">
          {t("review.browse.from", { folder: row.folder })} · {t(row.reason.key, row.reason.params)}
        </span>
      </button>

      <span className="hidden shrink-0 text-muted-foreground sm:inline">
        {formatBytes(row.sizeBytes, { locale })}
      </span>

      {row.setAsideCategory !== null && (
        <span className="shrink-0 rounded border border-warning/40 bg-warning/10 px-1.5 py-0.5 text-3xs font-semibold text-warning">
          {t(`review.setAside.${row.setAsideCategory}`)}
        </span>
      )}

      {row.flags.map((flag) => (
        <Tooltip key={flag} label={t(`review.flag.${flag}.help`)}>
          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-3xs font-semibold text-muted-foreground">
            {t(`review.flag.${flag}`)}
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

/** One file in the grid: the tile opens it, the corner checkbox selects it. */
function GridTile({
  row,
  selected,
  onToggle,
  onOpenDetail,
}: {
  row: ReviewRow;
  selected: boolean;
  onToggle: (shiftKey: boolean) => void;
  onOpenDetail: () => void;
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
      <Tooltip label={`${row.name} — ${t(row.reason.key, row.reason.params)}`}>
        <button
          type="button"
          onClick={onOpenDetail}
          className="block w-full text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <Thumbnail path={row.source} maxPx={240} className="aspect-square w-full" />
          <span className="block truncate px-2 py-1 text-3xs font-medium text-foreground">
            {row.name}
          </span>
        </button>
      </Tooltip>

      {/* Revealed on hover and on focus, and permanent once checked — a tile
          whose selection control vanished when the pointer left would make the
          selected state unreadable. */}
      <span
        className={cn(
          "absolute left-1 top-1 rounded bg-card/90 p-1 transition-opacity",
          selected
            ? "opacity-100"
            : "opacity-0 focus-within:opacity-100 group-hover/tile:opacity-100",
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
      </span>

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
