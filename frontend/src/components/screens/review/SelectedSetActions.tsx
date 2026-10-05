import { useRef, useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nContext";
import { isDecidedState } from "@/lib/duplicateDecisions";
import type { SetEntry } from "@/lib/reviewBrowse";

/** The same selection scope and actions in Browse and duplicate review. */
export function SelectedSetActions({
  sets,
  onDecide,
  onClearDecisions,
  onClearSelection,
  onReview,
}: {
  sets: readonly SetEntry[];
  onDecide: () => void;
  onClearDecisions?: (ids: readonly string[]) => void;
  onClearSelection: () => void;
  onReview?: () => void;
}) {
  const { t, tCount } = useI18n();
  const [confirmReset, setConfirmReset] = useState(false);
  const decideButton = useRef<HTMLButtonElement>(null);
  const decided = sets.filter((set) => !set.hasBaseline && isDecidedState(set.decisionState));

  return (
    <>
      <span
        role="status"
        aria-live="polite"
        className="mr-auto text-xs font-semibold text-foreground"
      >
        {tCount("review.setSelection.count", sets.length)}
        <span className="ml-2 font-normal text-muted-foreground">
          {tCount("review.setSelection.decided", decided.length)}
        </span>
      </span>
      <Button ref={decideButton} size="sm" onClick={onDecide}>
        {t("review.bulk.open")}
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={decided.length === 0 || !onClearDecisions}
        onClick={() => setConfirmReset(true)}
      >
        {t("review.setSelection.reset")}
      </Button>
      {onReview && (
        <Button size="sm" variant="outline" onClick={onReview}>
          {t("review.setSelection.review")}
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={onClearSelection}>
        {t("review.setSelection.clear")}
      </Button>
      <ConfirmDialog
        open={confirmReset}
        title={t("review.setSelection.reset.title")}
        description={tCount("review.setSelection.reset.description", decided.length)}
        confirmLabel={t("review.setSelection.reset.confirm")}
        variant="default"
        onClose={() => setConfirmReset(false)}
        onConfirm={() => {
          setConfirmReset(false);
          onClearDecisions?.(decided.map((set) => set.id));
          // The reset trigger becomes disabled. Return to the next useful
          // selection action after React commits the cleared decisions.
          queueMicrotask(() => decideButton.current?.focus({ preventScroll: true }));
        }}
      />
    </>
  );
}
