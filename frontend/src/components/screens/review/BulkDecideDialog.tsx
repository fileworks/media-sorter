/**
 * Deciding many duplicate sets at once, having first been told what that does.
 *
 * There were two surfaces for this and both were wrong in the same direction.
 * A modal previewed the keep rule over the whole queue; the selection-scoped
 * actions were three buttons and a folder picker crammed into one toolbar row,
 * where "Keep from folder" had no room to say what a folder had to do with it
 * and nothing said what any of them would leave alone.
 *
 * One surface now, for one job: name the scope, then give each action a card
 * with its own sentence, its own operand, and — on its button, not on hover —
 * the number of sets it would decide. Every count is read from live props, so
 * a selection that changes while this is open restates its impact rather than
 * applying to a scope nobody saw.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/ui/modal";
import { Select, SelectItem } from "@/components/ui/select";
import { useI18n } from "@/i18n/I18nContext";
import { sourceFolder } from "@/lib/duplicateDecisions";
import { formatBytes } from "@/lib/formatters";
import { decisionImpact, type SetEntry } from "@/lib/reviewBrowse";
import { SELECTABLE_KEEPER_POLICIES, type KeeperPolicyId } from "@/types/api";

export interface BulkChoice {
  id: string;
  /** The verb, as the button says it. */
  label: string;
  /** One sentence: what this does to the sets in scope. */
  description: string;
  /** Sets this action would decide, out of `scope`. */
  decide: number;
  /**
   * What it does to the *files*, which is the part a person is agreeing to.
   *
   * A count of sets is a count of decisions, not of consequences: "decides 12
   * of 15" says nothing about how many photographs move, or how much comes
   * back. Omitted where an action moves nothing.
   */
  consequence?: string;
  /** Why the rest are left alone, as a counted message key. */
  cannotKey?: string;
  /** A control the action needs before it can run — a folder, a rule. */
  operand?: ReactNode;
  disabled: boolean;
  /** Stated beside the action, never only as a disabled colour. */
  disabledReason?: string;
  /**
   * Which claim this action is making.
   *
   * Taking the rule's offer wears `suggest`, the colour the offer itself is
   * drawn in everywhere else — the control that accepts a recommendation
   * should not be the one thing on the screen unconnected to it.
   */
  tone?: "default" | "suggest";
  onApply: () => void;
}

/**
 * The keep rule, as an operand of the action that runs it.
 *
 * Both dialogs decide sets *by the rule*, and both used to name it in a
 * sentence and offer no way to see or change it — while the strip that had the
 * control swapped it out the moment a set was ticked. Whichever door you came
 * through, the rule the button is about to apply is on screen and adjustable
 * beside the button.
 */
function RuleOperand({
  rule,
  onRule,
}: {
  rule: KeeperPolicyId;
  onRule?: (rule: KeeperPolicyId) => void;
}) {
  const { t } = useI18n();
  if (onRule === undefined) return null;
  return (
    <label className="flex flex-wrap items-center gap-2 text-3xs text-muted-foreground">
      <span className="shrink-0">{t("review.bulk.ruleOperand")}</span>
      <Select
        size="sm"
        value={rule}
        aria-label={t("review.bulk.ruleOperand")}
        onValueChange={(value) => onRule(value as KeeperPolicyId)}
        className="max-w-full"
      >
        {SELECTABLE_KEEPER_POLICIES.map((policy) => (
          <SelectItem key={policy} value={policy}>
            {t(`config.keeper.${policy}`)}
          </SelectItem>
        ))}
      </Select>
    </label>
  );
}

export function BulkDecideDialog({
  open,
  title,
  scope,
  scopeLabel,
  choices,
  footnote,
  onClose,
}: {
  open: boolean;
  title: string;
  /** How many sets the actions below would act on. */
  scope: number;
  scopeLabel: string;
  choices: readonly BulkChoice[];
  /** One line under the actions — what this never touches. */
  footnote: string;
  onClose: () => void;
}) {
  const { t, tCount } = useI18n();

  return (
    <Modal open={open} onClose={onClose} title={title} size="md">
      <ModalHeader />
      <ModalBody>
        <p className="text-xs text-muted-foreground">{scopeLabel}</p>

        <ul className="mt-3 space-y-2">
          {choices.map((choice) => {
            const skip = Math.max(0, scope - choice.decide);
            return (
              <li
                key={choice.id}
                data-bulk-choice={choice.id}
                className="rounded-panel border border-border bg-card p-3"
              >
                <p className="text-xs font-semibold text-foreground">{choice.label}</p>
                <p className="mt-1 text-3xs leading-relaxed text-muted-foreground">
                  {choice.description}
                </p>
                {choice.consequence !== undefined && (
                  <p className="mt-1 text-3xs font-semibold text-foreground">
                    {choice.consequence}
                  </p>
                )}

                {choice.operand !== undefined && <div className="mt-2">{choice.operand}</div>}

                {/* Why a count is short of the scope, beside the count rather
                    than as one line for the whole dialog: three actions fall
                    short for three different reasons. */}
                {choice.cannotKey !== undefined && skip > 0 && (
                  <p
                    id={`review-bulk-${choice.id}-shortfall`}
                    className="mt-2 text-3xs leading-relaxed text-warning"
                  >
                    {tCount(choice.cannotKey, skip)}
                  </p>
                )}
                {choice.disabled && choice.disabledReason !== undefined && (
                  <p
                    id={`review-bulk-${choice.id}-blocked`}
                    className="mt-2 text-3xs leading-relaxed text-muted-foreground"
                  >
                    {choice.disabledReason}
                  </p>
                )}

                <div className="mt-3 flex items-center justify-end">
                  <Button
                    size="sm"
                    variant={choice.tone === "suggest" ? "suggest" : "default"}
                    disabled={choice.disabled || choice.decide === 0}
                    // The name is the action. The impact is a description of
                    // it — folding the counts in made every button answer to
                    // "Apply rule to selection 12 of 15 Decides 12 of…".
                    aria-label={choice.label}
                    aria-describedby={[
                      `review-bulk-${choice.id}-impact`,
                      choice.disabled && choice.disabledReason !== undefined
                        ? `review-bulk-${choice.id}-blocked`
                        : null,
                    ]
                      .filter((id): id is string => id !== null)
                      .join(" ")}
                    onClick={() => {
                      choice.onApply();
                      onClose();
                    }}
                  >
                    {choice.label}
                    {/* Inherits the button's colour, disabled included: an
                        opacity here would take the count below AA exactly
                        where somebody is reading it. */}
                    <span className="ml-1 font-normal tabular-nums">
                      {t("review.bulk.impactShort", { decide: choice.decide, total: scope })}
                    </span>
                  </Button>
                  <span id={`review-bulk-${choice.id}-impact`} className="sr-only">
                    {t("review.bulk.impact", { decide: choice.decide, skip })}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>

        <p className="mt-3 text-3xs leading-relaxed text-faint">{footnote}</p>
      </ModalBody>
      <ModalFooter>
        <Button size="sm" variant="outline" onClick={onClose}>
          {t("common.cancel")}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

/**
 * Taking the keep rule's offer over every set nobody has answered.
 *
 * Reachable from both surfaces that meet duplicate sets, because a reader who
 * never opens the decision queue must still be able to finish a run — and the
 * only bulk way to do that used to live on the queue.
 */
export function AcceptRecommendationsDialog({
  open,
  openSets,
  proposalCount,
  rule,
  ruleLabel,
  onRule,
  onAccept,
  onClose,
}: {
  open: boolean;
  /** The sets with no binding decision yet, in full. */
  openSets: readonly SetEntry[];
  /** Of those, the ones the rule ranks — exactly what accepting decides. */
  proposalCount: number;
  rule: KeeperPolicyId;
  ruleLabel: string;
  /** Optional: where the caller can change the rule, it is offered here too. */
  onRule?: (rule: KeeperPolicyId) => void;
  onAccept: () => void;
  onClose: () => void;
}) {
  const { t, tCount, locale } = useI18n();
  const openCount = openSets.length;
  const impact = useMemo(
    () => decisionImpact(openSets, (entry) => entry.proposedKeeper?.source ?? null),
    [openSets],
  );

  return (
    <BulkDecideDialog
      open={open}
      title={t("review.bulk.recommendTitle")}
      scope={openCount}
      scopeLabel={tCount("review.bulk.recommendScope", openCount)}
      footnote={t("review.keepRule.scope")}
      onClose={onClose}
      choices={[
        {
          id: "recommend",
          label: t("review.bulk.acceptRecommendations"),
          description: t("review.bulk.acceptRecommendations.help", { rule: ruleLabel }),
          operand: <RuleOperand rule={rule} onRule={onRule} />,
          decide: proposalCount,
          consequence: t("review.bulk.consequence.keep", {
            setAside: impact.setAside,
            bytes: formatBytes(impact.bytes, { locale }),
          }),
          cannotKey: "review.bulk.cannotRule",
          disabled: false,
          tone: "suggest",
          onApply: onAccept,
        },
      ]}
    />
  );
}

/** Every copy of a set's source folders, for the folder-scoped choice. */
function folderOptionsFor(sets: readonly SetEntry[]): string[] {
  return [...new Set(sets.flatMap((entry) => entry.rows.map((row) => sourceFolder(row.source))))]
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

/** The one copy a folder names in a set, or null where it names none or many. */
function folderKeeper(entry: SetEntry, folder: string): string | null {
  const candidates = entry.rows.filter(
    (row) => row.status !== "baseline" && sourceFolder(row.source) === folder,
  );
  return candidates.length === 1 ? candidates[0].source : null;
}

/**
 * The three decisions that can be taken over a chosen set of duplicate sets.
 *
 * Every count is derived from the `sets` prop on each render, so a selection
 * that changes while this dialog is open restates its impact rather than
 * applying to a scope nobody saw.
 */
export function SelectionDecisionsDialog({
  open,
  sets,
  rule,
  ruleLabel,
  onRule,
  keepSourceByRule,
  onKeepMany,
  onKeepAllMany,
  onClose,
}: {
  open: boolean;
  /** The selected sets, baselines already excluded. */
  sets: readonly SetEntry[];
  rule: KeeperPolicyId;
  ruleLabel: string;
  /** Optional: where the caller can change the rule, it is offered here too. */
  onRule?: (rule: KeeperPolicyId) => void;
  keepSourceByRule: (setId: string, rule: KeeperPolicyId) => string | null;
  onKeepMany: (choices: readonly { setId: string; source: string }[]) => void;
  onKeepAllMany: (setIds: readonly string[]) => void;
  onClose: () => void;
}) {
  const { t, tCount, locale } = useI18n();
  const [folder, setFolder] = useState("");
  const folders = useMemo(() => folderOptionsFor(sets), [sets]);

  useEffect(() => {
    if (folders.length === 0) setFolder("");
    else if (!folders.includes(folder)) setFolder(folders[0]);
  }, [folder, folders]);

  const byRule = useMemo(
    () =>
      sets.flatMap((entry) => {
        const source = keepSourceByRule(entry.id, rule);
        return source === null ? [] : [{ setId: entry.id, source }];
      }),
    [keepSourceByRule, rule, sets],
  );
  const byFolder = useMemo(
    () =>
      folder === ""
        ? []
        : sets.flatMap((entry) => {
            const source = folderKeeper(entry, folder);
            return source === null ? [] : [{ setId: entry.id, source }];
          }),
    [folder, sets],
  );

  // Both consequences are derived from the live props, so changing the folder
  // restates what that folder costs rather than leaving the last one's figures
  // beside a different choice.
  const ruleImpact = useMemo(
    () => decisionImpact(sets, (entry) => keepSourceByRule(entry.id, rule)),
    [keepSourceByRule, rule, sets],
  );
  const folderImpact = useMemo(
    () => decisionImpact(sets, (entry) => (folder === "" ? null : folderKeeper(entry, folder))),
    [folder, sets],
  );

  return (
    <BulkDecideDialog
      open={open}
      title={t("review.bulk.selectionTitle")}
      scope={sets.length}
      scopeLabel={tCount("review.setSelection.count", sets.length)}
      footnote={t("review.keepRule.scope")}
      onClose={onClose}
      choices={[
        {
          id: "rule",
          label: t("review.bulk.applyRule"),
          description: t("review.bulk.applyRule.help", { rule: ruleLabel }),
          operand: <RuleOperand rule={rule} onRule={onRule} />,
          decide: byRule.length,
          consequence: t("review.bulk.consequence.keep", {
            setAside: ruleImpact.setAside,
            bytes: formatBytes(ruleImpact.bytes, { locale }),
          }),
          cannotKey: "review.bulk.cannotRule",
          disabled: false,
          onApply: () => onKeepMany(byRule),
        },
        {
          id: "distinct",
          label: t("review.bulk.notDuplicates"),
          description: t("review.bulk.notDuplicates.help"),
          decide: sets.length,
          consequence: t("review.bulk.consequence.keepAll"),
          disabled: false,
          onApply: () => onKeepAllMany(sets.map((entry) => entry.id)),
        },
        {
          id: "folder",
          label: t("review.bulk.keepFromFolder"),
          description: t("review.bulk.keepFromFolder.help"),
          decide: byFolder.length,
          consequence:
            folder === ""
              ? undefined
              : t("review.bulk.consequence.keepFromFolder", {
                  folder,
                  setAside: folderImpact.setAside,
                  bytes: formatBytes(folderImpact.bytes, { locale }),
                }),
          cannotKey: "review.bulk.cannotFolder",
          disabled: folders.length === 0,
          disabledReason: t("review.setSelection.noFolders"),
          operand:
            folders.length === 0 ? undefined : (
              <label className="flex flex-wrap items-center gap-2 text-3xs text-muted-foreground">
                <span className="shrink-0">{t("review.bulk.folder")}</span>
                <Select
                  size="sm"
                  value={folder}
                  aria-label={t("review.bulk.folder")}
                  onValueChange={setFolder}
                  className="max-w-full"
                >
                  {folders.map((option) => (
                    <SelectItem key={option} value={option}>
                      {option}
                    </SelectItem>
                  ))}
                </Select>
              </label>
            ),
          onApply: () => onKeepMany(byFolder),
        },
      ]}
    />
  );
}
