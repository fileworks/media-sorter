/**
 * Bulk actions for the sets currently selected in Resolve.
 *
 * Docked rather than in flow, and deliberately the same floating shape as
 * Browse's `SelectionBar`: as an in-flow band this pushed the queue and the
 * set being read half a screen down the moment a checkbox was ticked, so the
 * act of selecting moved the thing being selected.
 *
 * Each action keeps its impact in view as text. What a bulk decision is about
 * to do to dozens of files is not hover-only information.
 */
import { useI18n } from "@/i18n/I18nContext";

export interface BulkActionSpec {
  id: string;
  label: string;
  /** Sets this action would decide, and sets it would leave alone. */
  decide: number;
  skip: number;
  /** Why the skipped ones are skipped, as a counted message key. */
  cannotKey?: string;
  disabled: boolean;
  disabledReasonId: string;
  onApply: () => void;
}

interface SetSelectionBarProps {
  selectedCount: number;
  actions: readonly BulkActionSpec[];
  folders: readonly string[];
  folder: string;
  onFolderChange: (folder: string) => void;
  onClear: () => void;
}

export function SetSelectionBar({
  selectedCount,
  actions,
  folders,
  folder,
  onFolderChange,
  onClear,
}: SetSelectionBarProps) {
  const { t, tCount } = useI18n();
  if (selectedCount === 0) return null;

  return (
    <div className="fixed inset-x-3 bottom-[4.5rem] z-40 mx-auto max-w-5xl rounded-xl border border-primary/40 bg-card/95 px-3 py-2 shadow-card backdrop-blur sm:inset-x-6">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        {/* Announced on its own, as in Browse: wrapping the controls in a live
            region re-reads every label on each selection change. */}
        <span
          role="status"
          aria-live="polite"
          className="shrink-0 self-center text-xs font-semibold text-foreground"
        >
          {tCount("review.setSelection.count", selectedCount)}
        </span>

        {actions.map((action) => {
          const impactId = `review-bulk-${action.id}-impact`;
          return (
            <div key={action.id} className="min-w-0 flex-1 basis-44">
              <button
                type="button"
                disabled={action.disabled}
                aria-describedby={`${impactId}${action.disabled ? ` ${action.disabledReasonId}` : ""}`}
                onClick={action.onApply}
                className="w-full rounded-control border border-border bg-card px-2.5 py-1 text-2xs font-semibold text-foreground transition-colors hover:border-border-strong hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-faint"
              >
                {action.label}
              </button>
              {/* The folder this action keeps from belongs to the action, not
                  to the bar: apart from it, it was a control with no evident
                  subject. */}
              {action.id === "folder" && (
                <label className="mt-1 flex items-center gap-1.5 text-3xs text-muted-foreground">
                  <span className="shrink-0">{t("review.bulk.folder")}</span>
                  <select
                    value={folder}
                    disabled={folders.length === 0}
                    onChange={(event) => onFolderChange(event.target.value)}
                    className="min-w-0 flex-1 rounded-control border border-input bg-card px-1.5 py-0.5 text-3xs text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {folders.map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <p id={impactId} className="mt-1 text-3xs leading-snug text-muted-foreground">
                {t("review.bulk.impact", { decide: action.decide, skip: action.skip })}
                {action.skip > 0 && action.cannotKey
                  ? ` ${tCount(action.cannotKey, action.skip)}`
                  : ""}
              </p>
            </div>
          );
        })}

        {/* Named for what it clears: the pane below has a "Clear selection"
            of its own, which drops the draft keeper for one set. */}
        <button
          type="button"
          onClick={onClear}
          className="shrink-0 self-center rounded-control px-2.5 py-1 text-2xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("review.setSelection.clear")}
        </button>
      </div>
    </div>
  );
}
