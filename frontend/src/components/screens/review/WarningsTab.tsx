/**
 * Everything about this plan that deserves a second look.
 *
 * Each row states the finding, then what will happen to it — because every one
 * of these already has a safe default, and the useful question is not "what is
 * wrong" but "is the automatic answer the one I want". Where a setting would
 * change that answer, the row links straight to it; where nothing would, the
 * row says so rather than offering a control that does nothing.
 *
 * "Show files" hands off to the Every-change tab with the relevant statuses
 * selected, so a warning is never a dead end.
 */

import { FiAlertTriangle, FiXCircle } from "react-icons/fi";

import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";
import type { PlanWarning } from "@/lib/reviewPlan";
import type { PreviewItem } from "@/types/api";

interface WarningsTabProps {
  warnings: PlanWarning[];
  onShowFiles: (statuses: PreviewItem["status"][], warningId: PlanWarning["id"]) => void;
  /** Jumps to the Configure screen, scrolled to the named setting row. */
  onOpenSetting: (anchorId: string) => void;
}

/** The setting that changes a warning's outcome, when one exists. */
const SETTING_FOR: Partial<Record<PlanWarning["id"], string>> = {
  no_date: "setting-structure",
  fallback_date: "setting-structure",
  suspicious_date: "setting-maintenance",
  future_date: "setting-maintenance",
  unreadable: "setting-maintenance",
  deferred_duplicate: "setting-duplicates",
};

export function WarningsTab({ warnings, onShowFiles, onOpenSetting }: WarningsTabProps) {
  const { t, locale } = useI18n();

  if (warnings.length === 0) {
    return (
      <div className="rounded-xl border border-border bg-card px-5 py-10 text-center">
        <p className="text-xs font-semibold text-success">{t("review.warnings.none")}</p>
        <p className="mt-1 text-xs text-muted-foreground">{t("review.warnings.noneHelp")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className="text-xs text-faint">{t("review.warnings.intro")}</p>
      <ul className="space-y-2">
        {warnings.map((warning) => {
          const setting = SETTING_FOR[warning.id];
          const Icon = warning.severity === "error" ? FiXCircle : FiAlertTriangle;
          return (
            <li
              key={warning.id}
              className={cn(
                "flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-border bg-card px-4 py-3",
                warning.severity === "error"
                  ? "border-l-[3px] border-l-error"
                  : "border-l-[3px] border-l-warning",
              )}
            >
              <Icon
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  warning.severity === "error" ? "text-error" : "text-warning",
                )}
                aria-hidden
              />
              <span
                className={cn(
                  "shrink-0 text-xs font-semibold",
                  warning.severity === "error" ? "text-error" : "text-warning",
                )}
              >
                {t(`review.warning.${warning.id}.title`, {
                  count: warning.count.toLocaleString(locale),
                })}
              </span>
              <span className="min-w-0 flex-1 text-xs text-muted-foreground">
                {t(`review.warning.${warning.id}.outcome`)}
              </span>

              {setting && (
                <button
                  type="button"
                  onClick={() => onOpenSetting(setting)}
                  className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {t("review.warnings.changeSetting")}
                </button>
              )}
              <button
                type="button"
                onClick={() => onShowFiles(warning.statuses, warning.id)}
                className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {t("review.warnings.showFiles")}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
