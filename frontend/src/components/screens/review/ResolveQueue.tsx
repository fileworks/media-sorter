/**
 * One set at a time: which copy do you keep?
 *
 * The list could show a set. It could not make deciding twelve of them feel
 * like a task with an end, because a list is a shape for scanning and this is a
 * shape for choosing. So the queue shows one set, large, with every copy side by
 * side and the facts that actually settle it underneath each.
 *
 * **Clicking a copy keeps it.** The old surface put the decision in a `<select>`
 * used as a command menu — a control that offers a *rule* where the user has
 * already looked at the pictures and knows which one they want. The rule still
 * exists, as a bulk action that states its scope before it acts and leaves every
 * result overridable. What it no longer does is stand between a person and the
 * copy they are pointing at.
 *
 * Keyboard-first, because that is what makes twelve of these bearable: number
 * keys pick a copy, arrows move between sets, and nothing here needs a pointer.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { FiArrowLeft, FiArrowRight, FiCheck, FiLock } from "react-icons/fi";

import { Button } from "@/components/ui/button";
import { Thumbnail } from "@/components/ui/thumbnail";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/I18nContext";
import { formatBytes } from "@/lib/formatters";
import { formatMetadataSource } from "@/lib/metadataSource";
import { isDecidedState, isProposedState, sourceFolder } from "@/lib/duplicateDecisions";
import { cn } from "@/lib/utils";
import type { SetEntry } from "@/lib/reviewBrowse";
import type { ReviewRow } from "@/lib/reviewRows";
import { SELECTABLE_KEEPER_POLICIES, type KeeperPolicyId } from "@/types/api";

interface ResolveQueueProps {
  /** Every set in the queue, in Browse's order. */
  queue: SetEntry[];
  /** Every set in the plan, including ones already decided. */
  allSets: SetEntry[];
  /** The set being decided; null once the queue is finished. */
  current: SetEntry | null;
  index: number;
  onGo: (index: number) => void;
  onKeep: (setId: string, source: string) => void;
  onKeepAll: (setId: string) => void;
  /** Accept one non-binding rule proposal. */
  onAcceptProposal: (setId: string) => void;
  onCompare: (entry: SetEntry) => void;
  onOpenDetail: (source: string) => void;
  onBackToBrowse: () => void;
  /** The bulk rule: how many sets it would decide, and applying it. */
  rule: KeeperPolicyId;
  onRule: (rule: KeeperPolicyId) => void;
  proposalCount: number;
  onAcceptAllProposals: () => void;
  /** The same set selection Browse owns. */
  selectedSetIds: ReadonlySet<string>;
  onToggleSetSelection: (setId: string) => void;
  onSelectSets: (setIds: readonly string[]) => void;
  onClearSetSelection: () => void;
  /** A rule winner in source-path form, or null when it cannot rank the set. */
  keepSourceByRule: (setId: string, rule: KeeperPolicyId) => string | null;
  /**
   * Sets the rule cannot decide, split by why — a visual match that no rule
   * should resolve in bulk, and a set with no measured facts to rank at all.
   * Two different reasons deserve two different sentences.
   */
  individualOnly: { perceptual: number; unmeasured: number };
}

export function ResolveQueue({
  queue,
  allSets,
  current,
  index,
  onGo,
  onKeep,
  onKeepAll,
  onAcceptProposal,
  onCompare,
  onOpenDetail,
  onBackToBrowse,
  rule,
  onRule,
  proposalCount,
  onAcceptAllProposals,
  selectedSetIds,
  onToggleSetSelection,
  onSelectSets,
  onClearSetSelection,
  keepSourceByRule,
  individualOnly,
}: ResolveQueueProps) {
  const { t, locale } = useI18n();
  const [preferredFolder, setPreferredFolder] = useState("");

  const selectableSetIds = useMemo(
    () => allSets.filter((entry) => !entry.hasBaseline).map((entry) => entry.id),
    [allSets],
  );
  const selectedSets = useMemo(
    () => allSets.filter((entry) => selectedSetIds.has(entry.id) && !entry.hasBaseline),
    [allSets, selectedSetIds],
  );
  const folderOptions = useMemo(
    () =>
      [
        ...new Set(
          selectedSets.flatMap((entry) => entry.rows.map((row) => sourceFolder(row.source))),
        ),
      ]
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b)),
    [selectedSets],
  );

  useEffect(() => {
    if (folderOptions.length === 0) setPreferredFolder("");
    else if (!folderOptions.includes(preferredFolder)) setPreferredFolder(folderOptions[0]);
  }, [folderOptions, preferredFolder]);

  const ruleChoices = useMemo(
    () =>
      selectedSets.map((entry) => ({
        setId: entry.id,
        source: keepSourceByRule(entry.id, rule),
      })),
    [keepSourceByRule, rule, selectedSets],
  );
  const folderChoices = useMemo(
    () =>
      selectedSets.map((entry) => {
        const candidates = entry.rows.filter(
          (row) => row.status !== "baseline" && sourceFolder(row.source) === preferredFolder,
        );
        return { setId: entry.id, source: candidates.length === 1 ? candidates[0].source : null };
      }),
    [preferredFolder, selectedSets],
  );

  const ruleCanDecide = ruleChoices.filter((choice) => choice.source !== null).length;
  const folderCanDecide = folderChoices.filter((choice) => choice.source !== null).length;

  const applyChoices = (choices: typeof ruleChoices) => {
    for (const choice of choices) {
      if (choice.source !== null) onKeep(choice.setId, choice.source);
    }
  };

  const keepByNumber = useCallback(
    (position: number): boolean => {
      if (current === null) return false;
      const row = current.rows[position];
      if (row === undefined || row.status === "baseline") return false;
      onKeep(current.id, row.source);
      return true;
    },
    [current, onKeep],
  );

  // Registered on the window rather than on a focused container: the whole
  // point is that the queue is usable without ever moving focus into it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      // Ignore fields where a number is data, not every element implemented as
      // an `<input>`. The Browse/Resolve segmented control is a radio group; it
      // retains focus after switching modes, and treating that radio as text
      // entry made the very first number shortcut silently do nothing.
      if (
        target?.isContentEditable ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        (target?.tagName === "INPUT" &&
          !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset"].includes(
            (target as HTMLInputElement).type,
          ))
      ) {
        return;
      }
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowRight" && index < queue.length - 1) {
        event.preventDefault();
        onGo(index + 1);
      } else if (event.key === "ArrowLeft" && index > 0) {
        event.preventDefault();
        onGo(index - 1);
      } else if (/^[1-9]$/.test(event.key)) {
        if (keepByNumber(Number(event.key) - 1)) event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [index, keepByNumber, onGo, queue.length]);

  return (
    <div className="space-y-3">
      {/* The bulk rule, above the queue rather than inside a set's header: it is
          about every set, and putting it on one made it read as that set's. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5">
        <p id="review-set-selection-empty" className="sr-only">
          {t("review.setSelection.none")}
        </p>
        <p id="review-set-selection-no-folders" className="sr-only">
          {t("review.setSelection.noFolders")}
        </p>
        <label className="flex items-center gap-2 text-xs text-foreground">
          {t("review.keepRule")}
          <select
            value={rule}
            onChange={(event) => onRule(event.target.value as KeeperPolicyId)}
            className="rounded-lg border border-border bg-background px-2 py-1 text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {SELECTABLE_KEEPER_POLICIES.map((policy) => (
              <option key={policy} value={policy}>
                {t(`config.keeper.${policy}`)}
              </option>
            ))}
          </select>
        </label>
        <span id="review-rule-impact" className="text-xs text-muted-foreground">
          {t("review.keepRule.scope")}{" "}
          {proposalCount === 0
            ? t("review.keepRule.nothingToApply")
            : t("review.proposal.batchImpact", { count: proposalCount })}
        </span>
        <span className="flex-1" />
        <Button
          size="sm"
          variant="outline"
          disabled={proposalCount === 0}
          aria-describedby="review-rule-impact"
          onClick={onAcceptAllProposals}
        >
          {t("review.proposal.acceptAll", { count: proposalCount })}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card px-3.5 py-2.5">
        <p className="text-xs font-semibold text-foreground" role="status">
          {t("review.setSelection.count", { count: selectedSets.length })}
        </p>
        <Button
          size="sm"
          variant="ghost"
          disabled={selectableSetIds.length === 0}
          aria-describedby={
            selectableSetIds.length === 0 ? "review-set-selection-empty" : undefined
          }
          onClick={() => onSelectSets(selectableSetIds)}
        >
          {t("review.setSelection.selectAll", { count: selectableSetIds.length })}
        </Button>
        {selectedSets.length > 0 && (
          <Button size="sm" variant="ghost" onClick={onClearSetSelection}>
            {t("review.clearSelection")}
          </Button>
        )}
        <span className="flex-1" />
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          {t("review.bulk.folder")}
          <select
            value={preferredFolder}
            disabled={folderOptions.length === 0}
            aria-describedby={
              folderOptions.length === 0 ? "review-set-selection-no-folders" : undefined
            }
            onChange={(event) => setPreferredFolder(event.target.value)}
            className="max-w-48 rounded-lg border border-border bg-background px-2 py-1 text-xs text-foreground"
          >
            {folderOptions.map((folder) => (
              <option key={folder} value={folder}>
                {folder}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <BulkAction
          id="rule"
          label={t("review.bulk.applyRule")}
          decide={ruleCanDecide}
          skip={selectedSets.length - ruleCanDecide}
          cannotKey="review.bulk.cannotRule"
          disabled={selectedSets.length === 0}
          disabledReasonId="review-set-selection-empty"
          onApply={() => applyChoices(ruleChoices)}
        />
        <BulkAction
          id="distinct"
          label={t("review.bulk.notDuplicates")}
          decide={selectedSets.length}
          skip={0}
          disabled={selectedSets.length === 0}
          disabledReasonId="review-set-selection-empty"
          onApply={() => {
            for (const entry of selectedSets) onKeepAll(entry.id);
          }}
        />
        <BulkAction
          id="folder"
          label={t("review.bulk.keepFromFolder")}
          decide={folderCanDecide}
          skip={selectedSets.length - folderCanDecide}
          cannotKey="review.bulk.cannotFolder"
          disabled={selectedSets.length === 0 || preferredFolder === ""}
          disabledReasonId={
            selectedSets.length === 0
              ? "review-set-selection-empty"
              : "review-set-selection-no-folders"
          }
          onApply={() => applyChoices(folderChoices)}
        />
      </div>

      {/* Said once, here, instead of a disabled control on every set the rule
          cannot touch — which is what the old surface did. */}
      {individualOnly.perceptual > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("review.resolve.individualOnly", { count: individualOnly.perceptual })}
        </p>
      )}
      {individualOnly.unmeasured > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("review.resolve.unmeasuredOnly", { count: individualOnly.unmeasured })}
        </p>
      )}

      {queue.length === 0 || current === null ? (
        <div className="rounded-xl border border-border bg-card p-8 text-center">
          <p className="text-sm font-semibold text-foreground">{t("review.resolve.doneTitle")}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t("review.resolve.doneHelp")}</p>
          <Button size="sm" variant="outline" className="mt-4" onClick={onBackToBrowse}>
            <FiArrowLeft className="h-3.5 w-3.5" aria-hidden />
            {t("review.resolve.backToBrowse")}
          </Button>
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card">
          <header className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
            <input
              type="checkbox"
              checked={selectedSetIds.has(current.id)}
              aria-label={t("review.setSelection.toggle", {
                name: current.keeper?.name ?? current.id,
              })}
              onChange={() => onToggleSetSelection(current.id)}
              className="h-4 w-4 rounded border-border text-primary focus-visible:ring-2 focus-visible:ring-ring"
            />
            <h2 id="review-queue-position" className="text-xs font-semibold text-foreground">
              {t("review.resolve.position", { index: index + 1, total: queue.length })}
            </h2>
            <span className="rounded-full border border-border px-2 py-0.5 text-3xs font-semibold text-muted-foreground">
              {t(`review.stack.kind.${current.setKind}`)}
            </span>
            <span className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              disabled={index === 0}
              onClick={() => onGo(index - 1)}
              aria-label={t("review.resolve.previous")}
              aria-describedby="review-queue-position"
            >
              <FiArrowLeft className="h-3.5 w-3.5" aria-hidden />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={index >= queue.length - 1}
              onClick={() => onGo(index + 1)}
              aria-label={t("review.resolve.next")}
              aria-describedby="review-queue-position"
            >
              <FiArrowRight className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </header>

          {/* A set with a baseline is already settled: the reference wins, and
            the copies beside it are what would be set aside. Said once at the
            top rather than as a disabled control on every copy. */}
          {current.hasBaseline && (
            <p
              id="review-baseline-rule"
              className="border-b border-border px-4 py-2 text-xs text-muted-foreground"
            >
              {t("review.resolve.baselineWins")}
            </p>
          )}

          <ul className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {current.rows.map((row, position) => (
              <li key={row.source}>
                <Copy
                  row={row}
                  position={position}
                  isKeeper={row.stack?.isKeeper === true && isDecidedState(current.decisionState)}
                  isProposed={
                    row.stack?.isProposedKeeper === true && !isDecidedState(current.decisionState)
                  }
                  onKeep={() => onKeep(current.id, row.source)}
                  onOpenDetail={() => onOpenDetail(row.source)}
                  locale={locale}
                />
              </li>
            ))}
          </ul>

          <footer className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-2.5">
            <p className="min-w-0 flex-1 text-3xs text-faint">{t("review.resolve.keyboardHelp")}</p>
            <Button size="sm" variant="outline" onClick={() => onCompare(current)}>
              {t("review.compare")}
            </Button>
            {isProposedState(current.decisionState) && (
              <Button size="sm" onClick={() => onAcceptProposal(current.id)}>
                {t("review.proposal.acceptOne")}
              </Button>
            )}
            {/* "These are not duplicates" — every copy is kept and placed, which
              is a decision in its own right rather than the absence of one. */}
            <Button
              size="sm"
              variant="outline"
              disabled={current.hasBaseline}
              aria-describedby={current.hasBaseline ? "review-baseline-rule" : undefined}
              onClick={() => onKeepAll(current.id)}
            >
              {t("review.resolve.keepAll")}
            </Button>
          </footer>
        </div>
      )}
    </div>
  );
}

function BulkAction({
  id,
  label,
  decide,
  skip,
  cannotKey,
  disabled,
  disabledReasonId,
  onApply,
}: {
  id: string;
  label: string;
  decide: number;
  skip: number;
  cannotKey?: string;
  disabled: boolean;
  disabledReasonId: string;
  onApply: () => void;
}) {
  const { t } = useI18n();
  const impactId = `review-bulk-${id}-impact`;
  return (
    <div className="rounded-xl border border-border bg-card p-2.5">
      <Button
        size="sm"
        variant="outline"
        className="w-full"
        disabled={disabled}
        aria-describedby={`${impactId}${disabled ? ` ${disabledReasonId}` : ""}`}
        onClick={onApply}
      >
        {label}
      </Button>
      <p id={impactId} className="mt-1.5 text-3xs leading-relaxed text-muted-foreground">
        {t("review.bulk.impact", { decide, skip })}
        {skip > 0 && cannotKey ? ` ${t(cannotKey, { count: skip })}` : ""}
      </p>
    </div>
  );
}

function Copy({
  row,
  position,
  isKeeper,
  isProposed,
  onKeep,
  onOpenDetail,
  locale,
}: {
  row: ReviewRow;
  position: number;
  isKeeper: boolean;
  isProposed: boolean;
  onKeep: () => void;
  onOpenDetail: () => void;
  locale: string;
}) {
  const { t } = useI18n();
  const baseline = row.status === "baseline";

  return (
    <div
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-xl border",
        isKeeper
          ? "border-[1.5px] border-success"
          : isProposed
            ? "border-[1.5px] border-primary"
            : "border-border",
      )}
    >
      <button
        type="button"
        disabled={baseline}
        aria-describedby={baseline ? "review-baseline-rule" : undefined}
        aria-pressed={isKeeper}
        onClick={onKeep}
        aria-label={t("review.resolve.keepThis", { name: row.name, number: position + 1 })}
        className={cn(
          "relative block w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
          baseline ? "cursor-not-allowed" : "cursor-pointer",
        )}
      >
        <Thumbnail path={row.source} maxPx={480} className="aspect-[4/3] w-full" />
        <span className="absolute left-2 top-2 flex h-5 w-5 items-center justify-center rounded-full bg-card/90 font-mono text-3xs font-bold text-foreground">
          {position + 1}
        </span>
        {isKeeper && (
          <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-success px-2 py-0.5 text-3xs font-bold text-white">
            <FiCheck className="h-3 w-3" aria-hidden />
            {t("review.resolve.kept")}
          </span>
        )}
        {isProposed && (
          <span className="absolute right-2 top-2 rounded-full bg-primary px-2 py-0.5 text-3xs font-bold text-primary-foreground">
            {t("review.state.proposed")}
          </span>
        )}
        {baseline && (
          <Tooltip label={t("review.stack.baselineHelp")}>
            <span className="absolute right-2 top-2 flex items-center gap-1 rounded-full bg-card/90 px-2 py-0.5 text-3xs font-semibold text-muted-foreground">
              <FiLock className="h-3 w-3" aria-hidden />
              {t("review.resolve.protected")}
            </span>
          </Tooltip>
        )}
      </button>

      <div className="flex min-w-0 flex-1 flex-col gap-0.5 px-3 py-2 text-3xs">
        <button
          type="button"
          onClick={onOpenDetail}
          className="truncate text-left text-xs font-medium text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {row.name}
        </button>
        <span className="text-muted-foreground">{formatBytes(row.sizeBytes, { locale })}</span>
        <span className="truncate text-faint" title={row.folder}>
          {t("review.browse.from", { folder: row.folder })}
        </span>
        <span className="text-faint">
          {row.date === null
            ? t("review.resolve.noDate")
            : t("review.resolve.dated", {
                date: row.date,
                source: formatMetadataSource(row.dateSource, t),
              })}
        </span>
      </div>
    </div>
  );
}
