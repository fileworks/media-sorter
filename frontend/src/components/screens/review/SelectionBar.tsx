import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/I18nContext";
import type { ReviewRow, SelectionActions } from "@/lib/reviewRows";

interface SelectionBarProps {
  selected: ReviewRow[];
  actions: SelectionActions;
  onKeepOnlyThis: () => void;
  onCompare: () => void;
  onClear: () => void;
}

/**
 * What can be done with the current selection, and why not when it cannot.
 *
 * Selection acts on duplicate decisions and comparison only. Run scope is
 * directory-level and is chosen on Sources before files are scanned.
 */
export function SelectionBar({
  selected,
  actions,
  onKeepOnlyThis,
  onCompare,
  onClear,
}: SelectionBarProps) {
  const { t, locale } = useI18n();
  if (selected.length === 0) return null;

  const button = (
    label: string,
    enabled: boolean,
    reason: string | undefined,
    onClick: () => void,
  ) => (
    <Tooltip label={enabled ? label : (reason ?? label)}>
      <button
        type="button"
        disabled={!enabled}
        aria-label={label}
        aria-description={!enabled ? reason : undefined}
        onClick={onClick}
        className="rounded-lg px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
      >
        {label}
      </button>
    </Tooltip>
  );

  return (
    <div
      className="flex flex-wrap items-center gap-2 rounded-lg border border-primary/40 bg-tint-info px-3 py-2"
      role="status"
    >
      <span className="text-xs font-semibold text-foreground">
        {t("review.selected", { count: selected.length.toLocaleString(locale) })}
      </span>
      {button(
        t("review.keepOnlyThis"),
        actions.canKeepOnlyThis,
        actions.reasons.keepOnlyThis,
        onKeepOnlyThis,
      )}
      {button(t("review.compare"), actions.canCompare, actions.reasons.compare, onCompare)}
      <span className="flex-1" />
      <button
        type="button"
        onClick={onClear}
        className="rounded-lg px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("review.clearSelection")}
      </button>
    </div>
  );
}
