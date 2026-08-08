/**
 * Search, and how the contents pane draws itself. Nothing else.
 *
 * This used to carry ten filter chips and a keep-rule bar. Both were doing the
 * modes' job before the modes existed: the chips were a flat way to answer
 * "where do these files go", which the destination tree now answers as a
 * structure, and the keep rule belongs beside the sets it decides — in Resolve,
 * where its scope can be stated before it acts.
 */

import { FiGrid, FiList, FiSearch } from "react-icons/fi";

import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";

export type ViewMode = "grid" | "list";

interface ReviewToolbarProps {
  search: string;
  onSearch: (search: string) => void;
  view: ViewMode;
  onView: (view: ViewMode) => void;
  /** What the pane is currently showing, as a sentence. */
  scopeLabel: string;
}

export function ReviewToolbar({ search, onSearch, view, onView, scopeLabel }: ReviewToolbarProps) {
  const { t } = useI18n();

  return (
    <div className="flex flex-wrap items-center gap-2">
      <p className="min-w-0 flex-1 text-xs text-muted-foreground" role="status">
        {scopeLabel}
      </p>

      <label className="relative min-w-0">
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
          className="w-44 rounded-lg border border-border bg-background py-1.5 pl-8 pr-2.5 text-xs text-foreground placeholder:text-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>

      <div className="flex shrink-0 rounded-lg border border-border p-0.5" role="group">
        {(["list", "grid"] as const).map((mode) => (
          <Tooltip key={mode} label={t(`review.view.${mode}`)}>
            <button
              type="button"
              aria-pressed={view === mode}
              aria-label={t(`review.view.${mode}`)}
              onClick={() => onView(mode)}
              className={cn(
                "rounded-md p-1.5 transition-colors",
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
      <p className="basis-full text-right text-3xs text-faint">{t("review.browse.keyboardHelp")}</p>
    </div>
  );
}
