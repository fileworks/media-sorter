/**
 * The folder tree this run would produce — a preview, not a filesystem view.
 *
 * Counts sit on every folder because "2,206 files would land in 08 — August" is
 * the sentence that catches a mis-set date criterion, and it catches it before
 * anything has moved. Folders that do not exist yet are badged: the difference
 * between adding to a library and creating one is worth one word.
 */

import { useMemo, useState } from "react";
import { FiChevronDown, FiChevronRight, FiSearch } from "react-icons/fi";

import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";
import type { TreeNode } from "@/lib/reviewPlan";

interface DestinationTreeProps {
  root: TreeNode;
  /** Highlighted branch, e.g. the folder a selected item lands in. */
  selectedPath?: string | null;
  onSelect?: (path: string) => void;
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

function Row({
  node,
  depth,
  expanded,
  onToggle,
  selectedPath,
  onSelect,
  locale,
  newLabel,
}: {
  node: TreeNode;
  depth: number;
  expanded: ReadonlySet<string>;
  onToggle: (path: string) => void;
  selectedPath?: string | null;
  onSelect?: (path: string) => void;
  locale: string;
  newLabel: string;
}) {
  const hasChildren = node.children.length > 0;
  const isOpen = expanded.has(node.path);
  const selected = selectedPath === node.path;

  return (
    <li>
      <div
        className={cn(
          "flex items-center gap-1.5 rounded-lg py-1 pr-2 text-xs",
          selected ? "bg-tint-primary" : "hover:bg-muted",
        )}
        style={{ paddingLeft: `${depth * 0.9 + 0.375}rem` }}
      >
        {hasChildren ? (
          <button
            type="button"
            onClick={() => onToggle(node.path)}
            aria-expanded={isOpen}
            aria-label={node.name}
            className="rounded p-0.5 text-faint transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {isOpen ? (
              <FiChevronDown className="h-3 w-3" aria-hidden />
            ) : (
              <FiChevronRight className="h-3 w-3" aria-hidden />
            )}
          </button>
        ) : (
          <span className="w-4" aria-hidden />
        )}

        <button
          type="button"
          onClick={() => onSelect?.(node.path)}
          className="min-w-0 flex-1 truncate text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={node.path || node.name}
        >
          <span
            className={cn(
              "truncate",
              selected && "font-semibold text-primary",
              !selected && (node.isReview ? "text-muted-foreground" : "text-foreground"),
            )}
          >
            {node.name}
          </span>
        </button>

        <span className={cn("shrink-0 tabular-nums", selected ? "text-primary" : "text-faint")}>
          {node.count.toLocaleString(locale)}
        </span>
        {node.isNew && !node.isReview && (
          <span className="shrink-0 rounded-full bg-tint-success px-1.5 py-px text-3xs font-semibold text-success">
            {newLabel}
          </span>
        )}
      </div>

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
              newLabel={newLabel}
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

export function DestinationTree({ root, selectedPath, onSelect }: DestinationTreeProps) {
  const { t, locale } = useI18n();
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<Set<string>>(() => initialExpansion(root));

  const needle = query.trim().toLowerCase();
  const filtered = useMemo(() => filterTree(root, needle), [root, needle]);

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
          placeholder={t("review.tree.jumpTo")}
          className="min-w-0 flex-1 bg-transparent text-xs placeholder:text-faint focus-visible:outline-none"
        />
      </label>

      {filtered && filtered.count > 0 ? (
        <ul className="max-h-[26rem] overflow-y-auto">
          <Row
            node={filtered}
            depth={0}
            expanded={effectiveExpanded}
            onToggle={toggle}
            selectedPath={selectedPath}
            onSelect={onSelect}
            locale={locale}
            newLabel={t("review.tree.new")}
          />
        </ul>
      ) : (
        <p className="px-1 py-3 text-xs text-faint">
          {needle ? t("review.tree.noMatches", { query }) : t("review.tree.empty")}
        </p>
      )}

      <p className="mt-3 border-t border-border pt-2.5 text-xs leading-relaxed text-faint">
        {t("review.tree.note")}
      </p>
    </section>
  );
}
