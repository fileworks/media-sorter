import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/I18nContext";
import type { ReviewRow, SelectionActions } from "@/lib/reviewRows";

interface SelectionBarProps {
  selected: ReviewRow[];
  actions: SelectionActions;
  onExclude: () => void;
  onInclude: () => void;
  onKeepOnlyThis: () => void;
  onCompare: () => void;
  onClear: () => void;
}

/**
 * What can be done with the current selection, and why not when it cannot.
 *
 * Excluding is deliberately not confirmed: the row stays visible, struck
 * through, and one click puts it back. A dialog in front of a visibly
 * reversible action teaches people to dismiss dialogs.
 */
export function SelectionBar({
  selected,
  actions,
  onExclude,
  onInclude,
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
      {button(t("review.exclude"), actions.canExclude, actions.reasons.exclude, onExclude)}
      {button(t("review.include"), actions.canInclude, actions.reasons.include, onInclude)}
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
