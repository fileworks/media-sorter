/**
 * The folder structure this run would build — the object of the screen, not a
 * filter on it.
 *
 * Two jobs, two controls, and they used to be swapped: the chevron expanded and
 * the *label* filtered, which is backwards from every file browser anyone has
 * used. The row now expands, as a row does; a separate, separately-labelled
 * affordance makes the folder the subject of the contents pane. Both are
 * keyboard-reachable and announced differently, so assistive technology can tell
 * the two apart as well.
 *
 * Counts sit on every folder because "2,206 files would land in 08 — August" is
 * the sentence that catches a mis-set date criterion, and it catches it before
 * anything has moved.
 */

import { useEffect, useMemo, useState } from "react";
import { FiChevronDown, FiChevronRight, FiCornerDownRight, FiSearch } from "react-icons/fi";

import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";
import { STAYS_PATH, isStaysPath, staysDivisionFor } from "@/lib/reviewBrowse";
import type { TreeNode } from "@/lib/reviewPlan";

interface DestinationTreeProps {
  root: TreeNode;
  /** The folder the contents pane is showing, or null for the whole plan. */
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
  /** Duplicate sets this run does not act on, stated rather than hidden. */
  outOfScopeSets: number;
  /** Controlled when Review coordinates the global Escape stack. */
  query?: string;
  onQueryChange?: (query: string) => void;
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
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.path);
  const selected = selectedPath === node.path;
  const name = label(node);
  const stays = isStaysPath(node.path);
  const division = staysDivisionFor(node.path);

  return (
    <li>
      <div
        className={cn(
          "flex items-center gap-1 rounded-lg pr-1 text-xs",
          selected ? "bg-tint-primary" : "hover:bg-muted",
        )}
        style={{ paddingLeft: `${depth * 0.9}rem` }}
      >
        {/* The row itself: activating it opens or closes the folder. A leaf has
            nothing to open, so it is a plain span and not a dead button. */}
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.path)}
            aria-expanded={isOpen}
            aria-label={t("review.browse.expand", { folder: name })}
            className="flex min-w-0 flex-1 items-center gap-1.5 rounded-lg py-1 pl-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {isOpen ? (
              <FiChevronDown className="h-3 w-3 shrink-0 text-faint" aria-hidden />
            ) : (
              <FiChevronRight className="h-3 w-3 shrink-0 text-faint" aria-hidden />
            )}
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
        ) : (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-1.5">
            <span className="w-3 shrink-0" aria-hidden />
            <span
              className={cn(
                "truncate",
                selected && "font-semibold text-primary",
                !selected && (stays || node.isReview ? "text-muted-foreground" : "text-foreground"),
              )}
            >
              {name}
            </span>
          </span>
        )}

        <span className={cn("shrink-0 tabular-nums", selected ? "text-primary" : "text-faint")}>
          {node.count.toLocaleString(locale)}
        </span>

        {/* The second job, and the second control. Named "Show the contents of
            X" rather than "X", so a screen reader user hears which of the two
            buttons on this row does what. */}
        <Tooltip label={t("review.browse.showContents", { folder: name })}>
          <button
            type="button"
            aria-pressed={selected}
            aria-label={t("review.browse.showContents", { folder: name })}
            onClick={() => onSelect(selected ? null : node.path)}
            className={cn(
              "shrink-0 rounded-md p-1 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              selected ? "text-primary" : "text-faint hover:bg-muted hover:text-foreground",
            )}
          >
            <FiCornerDownRight className="h-3 w-3" aria-hidden />
          </button>
        </Tooltip>
      </div>

      {/* Each division of "stays where it is" states its rule once, here,
          rather than repeating it on every row beneath it. */}
      {division !== null && isOpen && (
        <p
          className="py-1 pr-2 text-3xs leading-relaxed text-faint"
          style={{ paddingLeft: `${(depth + 1) * 0.9 + 0.9}rem` }}
        >
          {t(`review.browse.stays.${division}.rule`)}
        </p>
      )}

      {hasChildren && isOpen && (
        <ul>
          {node.children.map((child) => (
            <Row
              key={child.path}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              selectedPath={selectedPath}
              onSelect={onSelect}
              locale={locale}
              label={label}
              t={t}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Paths worth opening on first paint: the root and its immediate children. */
function initialExpansion(root: TreeNode): Set<string> {
  return new Set(["", ...root.children.map((child) => child.path)]);
}

export function DestinationTree({
  root,
  selectedPath,
  onSelect,
  outOfScopeSets,
  query: controlledQuery,
  onQueryChange,
}: DestinationTreeProps) {
  const { t, locale } = useI18n();
  const [localQuery, setLocalQuery] = useState("");
  const query = controlledQuery ?? localQuery;
  const setQuery = onQueryChange ?? setLocalQuery;
  const [expanded, setExpanded] = useState<Set<string>>(() => initialExpansion(root));
  const [alsoOpen, setAlsoOpen] = useState(false);
  const label = useNodeLabel();

  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => filterTree(root, needle), [root, needle]);

  // A folder that appears after a decision has to be openable without the user
  // knowing it appeared. Newly-seen top-level branches start expanded.
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

  // A search should show its hits, not make the user open five levels to them.
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
      className="rounded-xl border border-border bg-card p-3.5"
    >
      <div className="mb-2.5 flex items-center gap-2">
        <h2 className="text-3xs font-semibold uppercase tracking-[0.08em] text-faint">
          {t("review.tree.title")}
        </h2>
        <span className="flex-1" />
        <button
          type="button"
          onClick={() => setExpanded(new Set([""]))}
          className="text-3xs text-faint underline decoration-dotted underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("review.tree.collapseAll")}
        </button>
      </div>

      <label className="mb-2.5 flex items-center gap-2 rounded-lg border border-border bg-background px-2.5 py-1.5">
        <FiSearch className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
        <span className="sr-only">{t("review.tree.jumpTo")}</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || query === "") return;
            event.preventDefault();
            event.stopPropagation();
            setQuery("");
          }}
          placeholder={t("review.tree.jumpTo")}
          className="min-w-0 flex-1 bg-transparent text-xs placeholder:text-faint focus-visible:outline-none"
        />
      </label>

      {filtered && filtered.count > 0 ? (
        <ul className="max-h-[min(26rem,45dvh)] overflow-y-auto">
          <Row
            node={filtered}
            depth={0}
            expanded={effectiveExpanded}
            onToggle={toggle}
            selectedPath={selectedPath}
            onSelect={onSelect}
            locale={locale}
            label={label}
            t={t}
          />
        </ul>
      ) : (
        <p className="px-1 py-3 text-xs text-faint">
          {needle ? t("review.tree.noMatches", { query }) : t("review.tree.empty")}
        </p>
      )}

      {/* Sets whose members are not both in this run. Collapsed, because they
          are not this run's business — but stated, because "why is this set not
          listed?" is otherwise unanswerable from the screen. */}
      {outOfScopeSets > 0 && (
        <div className="mt-3 border-t border-border pt-2.5">
          <button
            type="button"
            aria-expanded={alsoOpen}
            onClick={() => setAlsoOpen((open) => !open)}
            className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {alsoOpen ? (
              <FiChevronDown className="h-3 w-3 shrink-0" aria-hidden />
            ) : (
              <FiChevronRight className="h-3 w-3 shrink-0" aria-hidden />
            )}
            {t("review.browse.alsoInLibrary", { count: outOfScopeSets })}
          </button>
          {alsoOpen && (
            <p className="mt-1.5 pl-4 text-xs leading-relaxed text-faint">
              {t("review.browse.alsoInLibrary.rule")}
            </p>
          )}
        </div>
      )}

      <p className="mt-3 border-t border-border pt-2.5 text-xs leading-relaxed text-faint">
        {t("review.tree.note")}
      </p>
    </section>
  );
}
