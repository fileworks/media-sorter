/** Planned destination hierarchy for the current run. */

import { useEffect, useMemo, useState } from "react";
import { FiChevronDown, FiChevronRight, FiSearch } from "react-icons/fi";

import { Tooltip } from "@/components/ui/tooltip";
import { useVirtualWindow } from "@/hooks/useVirtualWindow";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";
import { STAYS_PATH, isStaysPath, staysDivisionFor } from "@/lib/reviewBrowse";
import type { TreeNode } from "@/lib/reviewPlan";

interface DestinationTreeProps {
  root: TreeNode;
  /** Actual destination root, shown as context above the planned hierarchy. */
  destinationRoot?: string;
  /** The folder the contents pane is showing, or null for the whole plan. */
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
  /** Duplicate sets this run does not act on, stated rather than hidden. */
  outOfScopeSets: number;
  /** Return to the screen that can bring omitted folders into this run. */
  onOpenSources?: () => void;
  /** Excluded run sources need their explanation immediately, not behind a disclosure. */
  revealOutOfScope?: boolean;
  /** Controlled when Review coordinates the global Escape stack. */
  query?: string;
  onQueryChange?: (query: string) => void;
  /** Remove card chrome when the tree is the left rail of Review's shared shell. */
  embedded?: boolean;
}

/** Every node whose subtree matches, plus the ancestors needed to reach it. */
function filterTree(node: TreeNode, needle: string): TreeNode | null {
  if (!needle) return node;
  const matches = node.name.toLowerCase().includes(needle);
  const children = node.children
    .map((child) => filterTree(child, needle))
    .filter((child): child is TreeNode => child !== null);
  if (!matches && children.length === 0) return null;
  return { ...node, children };
}

/** The label a synthetic node carries, which is never its raw path segment. */
function useNodeLabel() {
  const { t } = useI18n();
  return (node: TreeNode): string => {
    if (node.path === STAYS_PATH) return t("review.browse.stays");
    const division = staysDivisionFor(node.path);
    return division === null ? node.name : t(`review.browse.stays.${division}`);
  };
}

function Row({
  node,
  depth,
  expanded,
  onToggle,
  selectedPath,
  onSelect,
  locale,
  label,
  t,
  tCount,
}: {
  node: TreeNode;
  depth: number;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
  locale: string;
  label: (node: TreeNode) => string;
  t: ReturnType<typeof useI18n>["t"];
  tCount: ReturnType<typeof useI18n>["tCount"];
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.path);
  const selected = selectedPath === node.path;
  const name = label(node);
  const stays = isStaysPath(node.path);
  const division = staysDivisionFor(node.path);

  return (
    <>
      <div
        className={cn(
          // Square left edge: an accent border on a rounded box curves away at
          // both corners and draws a parenthesis beside the row rather than a
          // rule down it.
          "flex items-center gap-1 rounded-r-panel border-l-2 pr-1 text-xs",
          selected ? "bg-tint-primary" : "hover:bg-muted",
          selected ? "border-primary" : stays ? "border-faint bg-muted/35" : "border-transparent",
        )}
        style={{ paddingLeft: `${depth * 0.9}rem` }}
      >
        {/* Expansion and content selection remain separate controls. */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.path)}
            aria-expanded={isOpen}
            aria-label={t("review.browse.expand", { folder: name })}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-control text-faint transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {isOpen ? (
              <FiChevronDown className="h-3 w-3" aria-hidden />
            ) : (
              <FiChevronRight className="h-3 w-3" aria-hidden />
            )}
          </button>
        ) : (
          <span className="w-6 shrink-0" aria-hidden />
        )}

        <button
          type="button"
          aria-pressed={selected}
          aria-label={t("review.browse.showContents", { folder: name })}
          onClick={() => onSelect(selected ? null : node.path)}
          className="flex min-h-6 min-w-0 flex-1 items-center gap-2 rounded-panel py-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span
            className={cn(
              "truncate",
              selected && "font-semibold text-primary",
              !selected && (stays || node.isReview ? "text-muted-foreground" : "text-foreground"),
            )}
          >
            {name}
          </span>
        </button>

        {/* Mark folders containing unresolved duplicate sets. */}
        {node.undecidedSets > 0 && (
          <Tooltip label={tCount("review.tree.undecidedHere", node.undecidedSets)}>
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
              role="img"
              aria-label={tCount("review.tree.undecidedHere", node.undecidedSets)}
            />
          </Tooltip>
        )}

        <span
          className={cn(
            "shrink-0 font-mono text-3xs tabular-nums",
            selected ? "text-primary" : "text-faint",
          )}
        >
          {node.count.toLocaleString(locale)}
        </span>
      </div>

      {/* State each stay-in-place rule once per division. */}
      {division !== null && isOpen && (
        <p
          className="py-1 pr-2 text-3xs leading-relaxed text-faint"
          style={{ paddingLeft: `${(depth + 1) * 0.9 + 0.9}rem` }}
        >
          {t(`review.browse.stays.${division}.rule`)}
        </p>
      )}
    </>
  );
}

function visibleNodes(root: TreeNode, expanded: ReadonlySet<string>) {
  const rows: Array<{ node: TreeNode; depth: number }> = [];
  const visit = (node: TreeNode, depth: number) => {
    rows.push({ node, depth });
    if (expanded.has(node.path)) node.children.forEach((child) => visit(child, depth + 1));
  };
  visit(root, 0);
  return rows;
}

/** Paths worth opening on first paint: the root and its immediate children. */
function initialExpansion(root: TreeNode): Set<string> {
  return new Set(["", ...root.children.map((child) => child.path)]);
}

export function DestinationTree({
  root,
  destinationRoot,
  selectedPath,
  onSelect,
  outOfScopeSets,
  onOpenSources,
  revealOutOfScope = false,
  query: controlledQuery,
  onQueryChange,
  embedded = false,
}: DestinationTreeProps) {
  const { t, tCount, locale } = useI18n();
  const [localQuery, setLocalQuery] = useState("");
  const query = controlledQuery ?? localQuery;
  const setQuery = onQueryChange ?? setLocalQuery;
  const [expanded, setExpanded] = useState<Set<string>>(() => initialExpansion(root));
  const [alsoOpen, setAlsoOpen] = useState(revealOutOfScope);
  const label = useNodeLabel();

  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => filterTree(root, needle), [root, needle]);

  // Expand newly discovered top-level branches.
  useEffect(() => {
    setExpanded((current) => {
      const next = new Set(current);
      let changed = false;
      for (const child of root.children) {
        if (!next.has(child.path) && !current.has(`seen:${child.path}`)) {
          next.add(child.path);
          next.add(`seen:${child.path}`);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [root]);

  useEffect(() => {
    if (revealOutOfScope && outOfScopeSets > 0) setAlsoOpen(true);
  }, [outOfScopeSets, revealOutOfScope]);

  // Expand filtered paths so every match is visible.
  const effectiveExpanded = useMemo(() => {
    if (!needle || !filtered) return expanded;
    const all = new Set<string>();
    const walk = (node: TreeNode) => {
      all.add(node.path);
      node.children.forEach(walk);
    };
    walk(filtered);
    return all;
  }, [expanded, filtered, needle]);
  const visible = useMemo(
    () => (filtered ? visibleNodes(filtered, effectiveExpanded) : []),
    [effectiveExpanded, filtered],
  );
  const treeWindow = useVirtualWindow({
    count: visible.length,
    estimateSize: 32,
    maxHeight: 416,
    overscan: 8,
    anchorKey: visible[0]?.node.path ?? null,
    measurementKey: visible,
  });

  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <section
      aria-label={t("review.tree.title")}
      className={cn("bg-card", embedded ? "" : "rounded-window border border-border p-4")}
    >
      <div
        className={cn(
          "sticky top-0 z-20 flex items-start gap-2 bg-card",
          embedded && "border-b border-border p-3",
        )}
      >
        <div className="min-w-0 flex-1">
          <h2 className="text-3xs font-semibold uppercase tracking-[0.08em] text-faint">
            {t("review.tree.title")}
          </h2>
          {destinationRoot && (
            <p
              className="mt-1 truncate font-mono text-3xs text-muted-foreground"
              title={destinationRoot}
            >
              {destinationRoot}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={() => setExpanded(new Set([""]))}
          className="inline-flex min-h-6 shrink-0 items-center px-1 text-3xs text-faint underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("review.tree.collapseAll")}
        </button>
      </div>

      <div className={cn(embedded && "p-2")}>
        <label className="mb-2 flex items-center gap-2 rounded-panel border border-border bg-background px-3 py-1">
          <FiSearch className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
          <span className="sr-only">{t("review.tree.filter")}</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape" || query === "") return;
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }}
            placeholder={t("review.tree.filter")}
            className="h-6 min-w-0 flex-1 bg-transparent text-xs placeholder:text-faint focus-visible:outline-none"
          />
        </label>

        {filtered && filtered.count > 0 ? (
          <div
            ref={treeWindow.scrollRef}
            onScroll={treeWindow.onScroll}
            className="max-h-[min(26rem,45dvh)] overflow-y-auto overscroll-contain"
            style={{ height: treeWindow.containerHeight }}
          >
            <ul className="relative" style={{ height: treeWindow.totalSize }}>
              {treeWindow.virtualItems.map((virtual) => {
                const line = visible[virtual.index];
                if (line === undefined) return null;
                return (
                  <li
                    key={line.node.path}
                    ref={treeWindow.measureElement}
                    data-virtual-index={virtual.index}
                    // Clears the sticky tree heading when a row is scrolled
                    // into view by the outer scroller.
                    className="absolute inset-x-0 scroll-mt-8"
                    style={{ transform: `translateY(${virtual.start}px)` }}
                  >
                    <Row
                      node={line.node}
                      depth={line.depth}
                      expanded={effectiveExpanded}
                      onToggle={toggle}
                      selectedPath={selectedPath}
                      onSelect={onSelect}
                      locale={locale}
                      label={label}
                      t={t}
                      tCount={tCount}
                    />
                  </li>
                );
              })}
            </ul>
          </div>
        ) : (
          <p className="px-1 py-3 text-xs text-faint">
            {needle ? t("review.tree.noMatches", { query }) : t("review.tree.empty")}
          </p>
        )}

        {/* Keep excluded duplicate sets visible but collapsed. */}
        {outOfScopeSets > 0 && (
          <div className="mt-3 border-t border-border pt-3">
            <button
              type="button"
              aria-expanded={alsoOpen}
              onClick={() => setAlsoOpen((open) => !open)}
              className="flex w-full items-center gap-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {alsoOpen ? (
                <FiChevronDown className="h-3 w-3 shrink-0" aria-hidden />
              ) : (
                <FiChevronRight className="h-3 w-3 shrink-0" aria-hidden />
              )}
              {tCount("review.browse.alsoInLibrary", outOfScopeSets)}
            </button>
            {alsoOpen && (
              <div className="mt-2 space-y-2 pl-4">
                <p className="text-xs leading-relaxed text-faint">
                  {t("review.browse.alsoInLibrary.rule")}
                </p>
                {onOpenSources && (
                  <button
                    type="button"
                    onClick={onOpenSources}
                    className="rounded-panel border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {t("review.browse.openSources")}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <p className="mt-3 border-t border-border pt-3 text-3xs leading-relaxed text-faint">
          {t("review.tree.note")}
        </p>
      </div>
    </section>
  );
}
