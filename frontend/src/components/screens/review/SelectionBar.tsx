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

/** Actions available for the current review selection. */
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
        className="rounded-lg border border-transparent px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-faint"
      >
        {label}
      </button>
    </Tooltip>
  );

  return (
    <div className="fixed inset-x-3 bottom-[4.5rem] z-40 mx-auto flex max-w-2xl flex-wrap items-center gap-2 rounded-xl border border-primary/40 bg-card/95 px-3 py-2 shadow-card backdrop-blur sm:inset-x-6">
      {/* The live region is a sibling of the controls, not their container.
          Wrapping the buttons in `aria-live` made every selection change
          re-announce the entire toolbar — each label, each disabled reason —
          instead of the one thing that changed. It mounts empty so the first
          selection is an update to an existing region rather than a new region
          appearing, which is what makes it announce at all. */}
      <span role="status" aria-live="polite" className="text-xs font-semibold text-foreground">
        {selected.length > 0
          ? t("review.selected", { count: selected.length.toLocaleString(locale) })
          : ""}
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
