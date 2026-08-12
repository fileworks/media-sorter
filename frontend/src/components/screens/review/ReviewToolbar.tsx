/** Search, sort, and view controls for the review browser. */

import { FiGrid, FiList, FiSearch } from "react-icons/fi";

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
}

export function ReviewToolbar({
  search,
  onSearch,
  view,
  onView,
  sort,
  onSort,
  scopeLabel,
}: ReviewToolbarProps) {
  const { t } = useI18n();

  return (
    // Let search grow but wrap before its label becomes unreadable.
    <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
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
          className="h-10 w-full rounded-control border border-input bg-card py-1.5 pl-8 pr-2.5 text-xs text-foreground transition-colors placeholder:text-faint hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
                "grid h-[2.125rem] w-[2.125rem] place-items-center rounded-[5px] transition-colors",
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
