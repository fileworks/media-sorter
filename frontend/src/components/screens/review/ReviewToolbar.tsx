/**
 * Search, sort, and view controls for the review browser — and, while files
 * are selected, what can be done with them.
 *
 * The selection actions used to be a bar `fixed` to the viewport above the
 * action bar: centred on the *window* rather than on the pane it acted on, so
 * it sat off-axis from the list under it, and on a short window it covered the
 * rows it was describing. It swaps into this strip instead, exactly as Resolve
 * does with its bulk actions — the toolbar is already the row that says what
 * you can do here.
 */

import { FiGrid, FiList, FiSearch } from "react-icons/fi";

import { Button } from "@/components/ui/button";

import { SortControl } from "@/components/screens/review/SortControl";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/I18nContext";
import type { ReviewSort } from "@/lib/reviewSort";
import { cn } from "@/lib/utils";

export type ViewMode = "grid" | "list";

interface ReviewToolbarProps {
  search: string;
  onSearch: (search: string) => void;
  view: ViewMode;
  onView: (view: ViewMode) => void;
  /** Shared with Resolve, so one order governs the whole screen. */
  sort: ReviewSort;
  onSort: (sort: ReviewSort) => void;
  /** What the pane is currently showing, as a sentence. */
  scopeLabel: string;
  /** Above zero, the strip becomes the actions for that selection. */
  selectedCount: number;
  selectionActions: {
    label: string;
    enabled: boolean;
    reason?: string;
    onClick: () => void;
  }[];
  onClearSelection: () => void;
}

export function ReviewToolbar({
  search,
  onSearch,
  view,
  onView,
  sort,
  onSort,
  scopeLabel,
  selectedCount,
  selectionActions,
  onClearSelection,
}: ReviewToolbarProps) {
  const { t } = useI18n();

  /**
   * A sibling of the controls, not their container: wrapping the buttons in
   * `aria-live` re-announced every label on every selection change. Mounted in
   * both branches so the first selection updates an existing region rather
   * than creating one, which is what makes it announce at all.
   */
  const announcement = (
    <span
      role="status"
      aria-live="polite"
      className={cn("text-xs font-semibold text-foreground", selectedCount > 0 && "mr-auto")}
    >
      {selectedCount > 0 ? t("review.selected", { count: selectedCount }) : ""}
    </span>
  );

  if (selectedCount > 0) {
    return (
      <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
        {announcement}
        {selectionActions.map((action) => (
          <Tooltip
            key={action.label}
            label={action.enabled ? action.label : (action.reason ?? action.label)}
          >
            <Button
              size="sm"
              variant="outline"
              disabled={!action.enabled}
              aria-label={action.label}
              aria-description={action.enabled ? undefined : action.reason}
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          </Tooltip>
        ))}
        <Button size="sm" variant="ghost" onClick={onClearSelection}>
          {t("review.clearSelection")}
        </Button>
      </div>
    );
  }

  return (
    // Let search grow but wrap before its label becomes unreadable.
    <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
      {announcement}
      <p className="sr-only" role="status">
        {scopeLabel}
      </p>

      <label className="relative min-w-[11rem] flex-1 sm:max-w-sm">
        <span className="sr-only">{t("review.search")}</span>
        <FiSearch
          className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint"
          aria-hidden
        />
        <input
          type="search"
          value={search}
          onChange={(event) => onSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape" || search === "") return;
            event.preventDefault();
            event.stopPropagation();
            onSearch("");
          }}
          placeholder={t("review.search")}
          className="h-8 w-full rounded-control border border-input bg-card py-1 pl-8 pr-3 text-xs text-foreground transition-colors placeholder:text-faint hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>

      <SortControl id="review-browse-sort" value={sort} onChange={onSort} />

      <div
        className="flex shrink-0 rounded-control border border-border bg-card p-0.5"
        role="group"
      >
        {(["list", "grid"] as const).map((mode) => (
          <Tooltip key={mode} label={t(`review.view.${mode}`)}>
            <button
              type="button"
              aria-pressed={view === mode}
              aria-label={t(`review.view.${mode}`)}
              onClick={() => onView(mode)}
              className={cn(
                "grid h-7 w-7 place-items-center rounded-control transition-colors",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                view === mode
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {mode === "grid" ? (
                <FiGrid className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <FiList className="h-3.5 w-3.5" aria-hidden />
              )}
            </button>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}
