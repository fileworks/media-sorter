/**
 * Resolve's one control strip: what the rule offers, and what you picked.
 *
 * There used to be two strips — a toolbar in flow at the top and a *floating*
 * bulk bar docked over the action bar whenever a set was ticked. Between them
 * they put ten controls on screen, in two places, with the second one covering
 * the page it acted on.
 *
 * They became one strip that swaps rather than stacks, and the swap held its
 * height only as long as nothing wrapped: measured at 360px, the default state
 * stood at 223px and the selection state at 109px, so ticking a checkbox pulled
 * the list up by 114 pixels — the exact defect floating the bar had been meant
 * to avoid. Both states are drawn into one grid cell now, so the band is the
 * height of the taller one at every width and a checkbox cannot move it.
 *
 * The strip holds the two ways a set gets decided, and only those:
 *
 * - **the rule**, on the left — which rule is making the offer, and taking that
 *   offer over every open set;
 * - **your own selection**, on the right — pick sets, then decide exactly those.
 *
 * The rule sits *outside* the swapping cell, and that placement is the point.
 * It used to be inside it, so ticking a set replaced the rule with the
 * selection controls — and the bulk dialog that opened next silently applied
 * the rule that had just vanished. "Which rule is this about to use?" had no
 * answer on screen at the moment it mattered most.
 *
 * The button beside it says "apply", not "accept recommendations". Accepting is
 * not a second, cleverer algorithm standing next to the rule: it is the rule,
 * run over every set nobody has answered. Naming it after the rule it applies —
 * and putting it immediately after the control that chooses that rule — is what
 * makes the sentence readable left to right.
 *
 * Everything that acts on the *list* rather than on a decision — its order,
 * walking to the next open set, clearing what has been decided — lives in the
 * list's own header. Selecting all and clearing that selection are two halves
 * of one gesture and had ended up on opposite sides of the screen; both are
 * here, beside the action they feed.
 */
import { FiCheckCircle } from "react-icons/fi";

import { Button } from "@/components/ui/button";
import { Select, SelectItem } from "@/components/ui/select";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";
import { SELECTABLE_KEEPER_POLICIES, type KeeperPolicyId } from "@/types/api";

/**
 * Both states occupy one cell, so neither can resize the band.
 *
 * Its own row under the rule on a narrow screen, and beside it from `md` up.
 * The rule owns row 1 column 1 unconditionally: that is what stops a selection
 * from taking it off the screen.
 */
const STATE_CLASS =
  "col-start-1 row-start-2 md:col-start-2 md:row-start-1 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2";

export function ResolveToolbar({
  rule,
  onRule,
  openCount,
  decidedCount,
  totalSets,
  proposalCount,
  onAcceptAllProposals,
  selectableSetIds,
  onSelectSets,
  selectedCount,
  onOpenBulk,
  onClearSelection,
}: {
  rule: KeeperPolicyId;
  onRule: (rule: KeeperPolicyId) => void;
  openCount: number;
  decidedCount: number;
  totalSets: number;
  /** Sets the rule ranks that nobody has answered — what "accept all" covers. */
  proposalCount: number;
  onAcceptAllProposals: () => void;
  selectableSetIds: readonly string[];
  onSelectSets: (ids: readonly string[]) => void;
  /** Above zero, the strip becomes the way into the bulk actions. */
  selectedCount: number;
  onOpenBulk: () => void;
  onClearSelection: () => void;
}) {
  const { t, tCount } = useI18n();
  const selecting = selectedCount > 0;

  return (
    <div
      data-resolve-toolbar={selecting ? "selection" : "default"}
      className="grid gap-x-3 gap-y-2 border-b border-border bg-card px-3 py-2 md:grid-cols-[auto_minmax(0,1fr)] md:items-center"
    >
      {/* The rule, never swapped out. Everything that decides a set in bulk —
          this strip's apply button, and both bulk dialogs — runs this rule, so
          it has to be legible at the moment those are reached for. */}
      <div className="col-start-1 row-start-1 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-2">
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
          className="min-w-[11rem]"
        >
          {SELECTABLE_KEEPER_POLICIES.map((policy) => (
            <SelectItem key={policy} value={policy}>
              {t(`config.keeper.${policy}`)}
            </SelectItem>
          ))}
        </Select>
        <Button
          size="sm"
          variant="suggest"
          disabled={proposalCount === 0}
          aria-describedby={
            proposalCount === 0
              ? "review-no-proposals review-keep-rule-help"
              : "review-keep-rule-help"
          }
          onClick={onAcceptAllProposals}
        >
          <FiCheckCircle className="h-3.5 w-3.5" aria-hidden />
          {tCount("review.keepRule.applyToOpen", proposalCount)}
        </Button>
      </div>

      {/* `inert` as well as `invisible`: a hidden control that is still tabbable
          is a keyboard trap nobody can see, and `inert` takes a real boolean —
          React 19 reads an empty string as `false`. */}
      <div className={cn(STATE_CLASS, selecting && "invisible")} inert={selecting || undefined}>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto"
          disabled={selectableSetIds.length === 0}
          aria-describedby={selectableSetIds.length === 0 ? "review-nothing-open" : undefined}
          onClick={() => onSelectSets(selectableSetIds)}
        >
          {tCount("review.setSelection.selectAll", selectableSetIds.length)}
        </Button>
      </div>

      <div className={cn(STATE_CLASS, !selecting && "invisible")} inert={!selecting || undefined}>
        {/* Announced on its own: wrapping the controls in a live region
            re-reads every label on each selection change. */}
        <span
          role="status"
          aria-live="polite"
          className="shrink-0 text-xs font-semibold text-foreground"
        >
          {tCount("review.setSelection.count", selectedCount)}
        </span>

        <Button size="sm" onClick={onOpenBulk}>
          {t("review.bulk.open")}
        </Button>

        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClearSelection}>
          {t("review.setSelection.clear")}
        </Button>
      </div>

      {/* How far the whole screen has got, which is not a fact about the
          current state and so does not disappear when a set is ticked. */}
      <div className="col-start-1 row-start-3 mt-1 flex min-h-4 flex-wrap items-center justify-between gap-x-3 text-3xs leading-4 text-muted-foreground md:col-span-2 md:row-start-2">
        {/* What a rule *is* on this screen, in the row that already exists so
            it costs no height. The rule ranks; it does not decide, and nothing
            about a set changes until somebody applies it, takes it on that set,
            or picks a copy — the distinction "Accept N recommendations" lost.
            Anchored to a span, never to the rule's `<label>` or to the apply
            button: a tooltip names an unnamed trigger, so on the label it would
            have become the select's accessible name instead of "Keep rule", and
            on the button it would have replaced the button's own visible name
            (WCAG 2.5.3). The sr-only copy is what the button points at. */}
        <Tooltip label={t("review.keepRule.explains")}>
          <span
            tabIndex={0}
            className="shrink-0 cursor-help underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("review.keepRule.howItDecides")}
          </span>
        </Tooltip>
        <p id="review-keep-rule-help" className="sr-only">
          {t("review.keepRule.explains")}
        </p>
        {/* The standing paragraph that explained "to review" versus "proposal
            waiting" sat under this strip on every visit, the same two
            sentences every time. It hangs off the number it describes. */}
        <Tooltip label={t("review.resolve.openStatesHelp")}>
          <span
            tabIndex={0}
            className="shrink-0 cursor-help whitespace-nowrap tabular-nums underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("review.resolve.decidedCount", { decided: decidedCount, total: totalSets })}
            {openCount > 0 && ` · ${t("review.resolve.openCount", { count: openCount })}`}
          </span>
        </Tooltip>
      </div>
    </div>
  );
}
