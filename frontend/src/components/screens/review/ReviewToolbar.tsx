import { FiGrid, FiList, FiSearch } from "react-icons/fi";

import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/I18nContext";
import { FILTER_KEYS, type FilterKey, type RowCounts } from "@/lib/reviewRows";
import { cn } from "@/lib/utils";
import { SELECTABLE_KEEPER_POLICIES, type KeeperPolicyId } from "@/services/api";

export type ViewMode = "grid" | "list";

interface ReviewToolbarProps {
  counts: RowCounts;
  /** Chips whose set contains at least one decision get a dot. */
  decided: ReadonlySet<FilterKey>;
  filter: FilterKey;
  onFilter: (filter: FilterKey) => void;
  search: string;
  onSearch: (search: string) => void;
  view: ViewMode;
  onView: (view: ViewMode) => void;
  keepPolicy: KeeperPolicyId;
  onKeepPolicy: (policy: KeeperPolicyId) => void;
  /** How many stacks the keep rule would change, for the preview before applying. */
  exactStacks: number;
  onApplyKeepPolicy: () => void;
  applyPending: boolean;
}

export function ReviewToolbar({
  counts,
  decided,
  filter,
  onFilter,
  search,
  onSearch,
  view,
  onView,
  keepPolicy,
  onKeepPolicy,
  exactStacks,
  onApplyKeepPolicy,
  applyPending,
}: ReviewToolbarProps) {
  const { t, locale } = useI18n();

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <ul className="flex min-w-0 flex-wrap gap-1">
          {FILTER_KEYS.map((key) => {
            const active = filter === key;
            const count = counts[key];
            // A chip with nothing in it is noise, except "All", which anchors
            // the row, and the current one, which must not vanish under you.
            if (count === 0 && key !== "all" && !active) return null;
            return (
              <li key={key}>
                <Tooltip label={t(`review.filter.${key}.help`)}>
                  <button
                    type="button"
                    aria-pressed={active}
                    onClick={() => onFilter(key)}
                    className={cn(
                      "rounded-lg px-3 py-1.5 text-xs transition-colors",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      active
                        ? "border border-border bg-card font-semibold text-foreground shadow-card"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                    )}
                  >
                    {t(`review.filter.${key}`)}
                    <span className="ml-1.5 font-semibold">{count.toLocaleString(locale)}</span>
                    {decided.has(key) && (
                      <span
                        aria-label={t("review.filter.hasDecisions")}
                        className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-primary align-middle"
                      />
                    )}
                  </button>
                </Tooltip>
              </li>
            );
          })}
        </ul>

        <span className="flex-1" />

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
      </div>

      {counts.duplicates > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
          <label className="flex items-center gap-2 text-xs text-foreground">
            {t("review.keepRule")}
            <select
              value={keepPolicy}
              onChange={(event) => onKeepPolicy(event.target.value as KeeperPolicyId)}
              className="rounded-lg border border-border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {SELECTABLE_KEEPER_POLICIES.map((policy) => (
                <option key={policy} value={policy}>
                  {t(`config.keeper.${policy}`)}
                </option>
              ))}
            </select>
          </label>
          {/* Stated as a per-run override, because it is: it does not edit the
              recipe, and the next run starts from the configured default. */}
          <span className="text-xs text-muted-foreground">{t("review.keepRule.scope")}</span>
          <span className="flex-1" />
          <Tooltip
            label={
              exactStacks === 0
                ? t("review.keepRule.nothingToApply")
                : t("review.keepRule.willChange", { count: exactStacks })
            }
          >
            <button
              type="button"
              disabled={exactStacks === 0 || applyPending}
              onClick={onApplyKeepPolicy}
              className="rounded-lg border border-border px-3 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              {applyPending
                ? t("review.keepRule.applying")
                : t("review.keepRule.apply", { count: exactStacks })}
            </button>
          </Tooltip>
        </div>
      )}
    </div>
  );
}
