/**
 * What Browse says about duplicate decisions, and how it takes them.
 *
 * Browse is the landing tab and answers "what would this run do". A reader who
 * does not care which copy of a duplicate survives should be able to finish the
 * whole run from here — and could not, because every set had to become an
 * explicit decision before Execute unlocked and the only bulk way to do that
 * lived on the other tab.
 *
 * So the two decisions that are not about one file live here as well: take the
 * keep rule's offer over every set still open, and act on a chosen selection.
 * Both open the same dialogs the queue opens, against the same decisions, so
 * there is one behaviour and two doors to it.
 */
import { useState } from "react";
import { FiCheckCircle } from "react-icons/fi";

import {
  AcceptRecommendationsDialog,
  SelectionDecisionsDialog,
} from "@/components/screens/review/BulkDecideDialog";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nContext";
import type { SetEntry } from "@/lib/reviewBrowse";
import type { KeeperPolicyId } from "@/types/api";

export function BrowseDecisionBar({
  openSets,
  proposalCount,
  undecidedCount,
  rule,
  ruleLabel,
  onRule,
  onAcceptAll,
  selectedSets,
  keepSourceByRule,
  onKeepMany,
  onKeepAllMany,
  onReviewSelected,
  onClearSelection,
}: {
  /** Sets with no binding decision, whether or not the rule can rank them. */
  openSets: readonly SetEntry[];
  /** Of those, the ones the rule ranks — what accepting would decide. */
  proposalCount: number;
  /** Of those, the ones no rule can rank, which need a person. */
  undecidedCount: number;
  rule: KeeperPolicyId;
  ruleLabel: string;
  /** Browse can change the rule too, from inside the dialog that applies it. */
  onRule?: (rule: KeeperPolicyId) => void;
  onAcceptAll: () => void;
  /** The current set selection, baselines already excluded. */
  selectedSets: readonly SetEntry[];
  keepSourceByRule: (setId: string, rule: KeeperPolicyId) => string | null;
  onKeepMany: (choices: readonly { setId: string; source: string }[]) => void;
  onKeepAllMany: (setIds: readonly string[]) => void;
  onReviewSelected: () => void;
  onClearSelection: () => void;
}) {
  const { t, tCount } = useI18n();
  const [bulkScope, setBulkScope] = useState<"selection" | "recommendations" | null>(null);
  const selecting = selectedSets.length > 0;
  const openCount = openSets.length;

  return (
    <>
      {openCount > 0 && (
        <div
          role="group"
          aria-label={t("review.browse.decisions")}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-panel border border-suggest/40 bg-tint-suggest px-3 py-2"
        >
          <FiCheckCircle className="h-4 w-4 shrink-0 text-suggest" aria-hidden />
          <div className="mr-auto min-w-0">
            <p className="text-xs font-semibold text-foreground">
              {tCount("review.browse.openSets", openCount)}
            </p>
            <p className="mt-0.5 text-3xs text-muted-foreground">
              {proposalCount > 0
                ? t("review.browse.recommendedBy", { count: proposalCount, rule: ruleLabel })
                : t("review.browse.noRecommendations")}
              {undecidedCount > 0 && ` · ${tCount("review.browse.needAPerson", undecidedCount)}`}
            </p>
          </div>
          <Button
            size="sm"
            variant="suggest"
            disabled={proposalCount === 0}
            aria-describedby={proposalCount === 0 ? "review-browse-no-proposals" : undefined}
            onClick={() => setBulkScope("recommendations")}
          >
            {tCount("review.keepRule.applyToOpen", proposalCount)}
          </Button>
          <p id="review-browse-no-proposals" className="sr-only">
            {t("review.resolve.noProposals")}
          </p>
        </div>
      )}

      {selecting && (
        <div
          role="group"
          aria-label={tCount("review.setSelection.count", selectedSets.length)}
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-panel border border-primary/40 bg-tint-primary px-3 py-2"
        >
          <span className="mr-auto text-xs font-semibold text-foreground">
            {tCount("review.setSelection.count", selectedSets.length)}
          </span>
          <Button size="sm" onClick={() => setBulkScope("selection")}>
            {t("review.bulk.open")}
          </Button>
          <Button size="sm" variant="outline" onClick={onReviewSelected}>
            {t("review.setSelection.review")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onClearSelection}>
            {t("review.setSelection.clear")}
          </Button>
        </div>
      )}

      <AcceptRecommendationsDialog
        open={bulkScope === "recommendations"}
        openSets={openSets}
        proposalCount={proposalCount}
        rule={rule}
        ruleLabel={ruleLabel}
        onRule={onRule}
        onAccept={onAcceptAll}
        onClose={() => setBulkScope(null)}
      />
      <SelectionDecisionsDialog
        open={bulkScope === "selection"}
        sets={selectedSets}
        rule={rule}
        ruleLabel={ruleLabel}
        onRule={onRule}
        keepSourceByRule={keepSourceByRule}
        onKeepMany={onKeepMany}
        onKeepAllMany={onKeepAllMany}
        onClose={() => setBulkScope(null)}
      />
    </>
  );
}
