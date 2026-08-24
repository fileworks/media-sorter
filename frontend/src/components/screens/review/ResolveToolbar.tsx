/**
 * Resolve's controls: the keep rule, the bulk proposals, the order, entering
 * selection, and where the queue stands.
 *
 * Split out of `ResolveQueue` so the panel's orchestration is readable — the
 * toolbar is presentation over values the panel already derives.
 */
import { Button } from "@/components/ui/button";
import { Select, SelectItem } from "@/components/ui/select";
import { SortControl } from "@/components/screens/review/SortControl";
import { useI18n } from "@/i18n/I18nContext";
import type { ReviewSort } from "@/lib/reviewSort";
import { SELECTABLE_KEEPER_POLICIES, type KeeperPolicyId } from "@/types/api";
import { FiCheckCircle } from "react-icons/fi";

export function ResolveToolbar({
  rule,
  onRule,
  openCount,
  decidedCount,
  totalSets,
  proposalCount,
  onCheckImpact,
  onAcceptAllProposals,
  onResetAll,
  sort,
  onSort,
  selectableSetIds,
  onSelectSets,
  hasNextOpen,
  onNextOpen,
}: {
  rule: KeeperPolicyId;
  onRule: (rule: KeeperPolicyId) => void;
  openCount: number;
  decidedCount: number;
  totalSets: number;
  proposalCount: number;
  onCheckImpact: () => void;
  onAcceptAllProposals: () => void;
  /** Optional: the panel omits it where nothing can be reset. */
  onResetAll?: () => void;
  sort: ReviewSort;
  onSort: (sort: ReviewSort) => void;
  selectableSetIds: readonly string[];
  onSelectSets: (ids: readonly string[]) => void;
  hasNextOpen: boolean;
  onNextOpen: () => void;
}) {
  const { t, tCount } = useI18n();
  // Rule, order, selection, and queue position, kept as separate groups.
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-border bg-card px-2.5 py-2">
      <div className="flex min-w-0 flex-wrap items-center gap-2" aria-label={t("review.keepRule")}>
        <Button size="sm" disabled={proposalCount === 0} onClick={onAcceptAllProposals}>
          <FiCheckCircle className="h-3.5 w-3.5" aria-hidden />
          {tCount("review.proposal.acceptAll", proposalCount)}
        </Button>
        <label
          htmlFor="review-keep-rule"
          className="whitespace-nowrap text-3xs text-muted-foreground"
        >
          {t("review.keepRule")}
        </label>
        <Select
          id="review-keep-rule"
          size="sm"
          value={rule}
          onValueChange={(value) => onRule(value as KeeperPolicyId)}
          className="min-w-[13rem]"
        >
          {SELECTABLE_KEEPER_POLICIES.map((policy) => (
            <SelectItem key={policy} value={policy}>
              {t(`config.keeper.${policy}`)}
            </SelectItem>
          ))}
        </Select>
        <Button size="sm" variant="outline" disabled={openCount === 0} onClick={onCheckImpact}>
          {t("review.ruleImpact.check")}
        </Button>
        <Button size="sm" variant="ghost" disabled={decidedCount === 0} onClick={onResetAll}>
          {t("review.resolve.resetAll")}
        </Button>
      </div>

      <div className="flex items-center border-border pl-2.5 sm:border-l">
        <SortControl id="review-resolve-sort" value={sort} onChange={onSort} />
      </div>

      <div className="flex flex-wrap items-center gap-2 border-border pl-2.5 sm:border-l">
        {/* Selecting is entered here; what is selected, and what can be done
          with it, is stated once — in the bar that appears with it. */}
        <Button
          size="sm"
          variant="ghost"
          disabled={selectableSetIds.length === 0}
          onClick={() => onSelectSets(selectableSetIds)}
        >
          {tCount("review.setSelection.selectAll", selectableSetIds.length)}
        </Button>
      </div>

      <div className="ml-auto flex items-center gap-2 border-border pl-2.5 sm:border-l">
        <Button size="sm" variant="ghost" disabled={!hasNextOpen} onClick={onNextOpen}>
          {t("review.resolve.nextOpen")}
        </Button>
        <span className="whitespace-nowrap text-3xs tabular-nums text-muted-foreground">
          {t("review.resolve.decidedCount", { decided: decidedCount, total: totalSets })}
        </span>
      </div>
    </div>
  );
}
