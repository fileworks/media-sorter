/** Duplicate resolver with explicit draft and confirmed states. */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FiArrowLeft, FiArrowRight, FiCheck } from "react-icons/fi";

import { RuleImpactModal, type RuleImpact } from "@/components/screens/review/RuleImpactModal";
import { CopyRow } from "@/components/screens/review/CopyRow";
import { ResolveToolbar } from "@/components/screens/review/ResolveToolbar";
import { SetQueueList } from "@/components/screens/review/SetQueueList";
import { SetSelectionBar } from "@/components/screens/review/SetSelectionBar";
import { Button } from "@/components/ui/button";
import { useVirtualWindow } from "@/hooks/useVirtualWindow";
import { useI18n } from "@/i18n/I18nContext";
import { isDecidedState, isProposedState, sourceFolder } from "@/lib/duplicateDecisions";
import { formatBytes } from "@/lib/formatters";
import { isOpenSet, type SetEntry } from "@/lib/reviewBrowse";
import type { ReviewRow } from "@/lib/reviewRows";
import { sortRows, type ReviewSort } from "@/lib/reviewSort";
import type { KeeperPolicyId } from "@/types/api";

/** Derive one factual comparison note without inferring media quality. */
function candidateNote(
  row: ReviewRow,
  rows: readonly ReviewRow[],
  t: (key: string, params?: Record<string, string | number>) => string,
  locale: string,
): string | null {
  const largest = rows.reduce((most, candidate) => Math.max(most, candidate.sizeBytes), 0);
  const dated = rows.filter((candidate) => candidate.date !== null);
  const newest = dated.reduce<string | null>(
    (latest, candidate) => (latest === null || candidate.date! > latest ? candidate.date : latest),
    null,
  );
  const isNewest =
    newest !== null && row.date === newest && dated.some((other) => other.date !== newest);

  if (row.sizeBytes === largest && largest > 0) {
    const smaller = rows.some((candidate) => candidate.sizeBytes < largest);
    if (smaller) {
      return isNewest
        ? t("review.resolve.note.largestAndNewest")
        : t("review.resolve.note.largest");
    }
  } else if (largest > row.sizeBytes) {
    return t("review.resolve.note.smallerBy", {
      amount: formatBytes(largest - row.sizeBytes, { locale }),
    });
  }
  return isNewest ? t("review.resolve.note.newest") : null;
}

interface ResolveQueueProps {
  queue: SetEntry[];
  allSets: SetEntry[];
  current: SetEntry | null;
  index: number;
  onGo: (index: number) => void;
  onOpenSet: (setId: string) => void;
  onKeep: (setId: string, source: string) => void;
  onKeepAll: (setId: string) => void;
  onReset?: (setId: string) => void;
  onResetAll?: () => void;
  onAcceptProposal: (setId: string) => void;
  onCompare: (entry: SetEntry) => void;
  onOpenDetail: (source: string) => void;
  onBackToBrowse: () => void;
  rule: KeeperPolicyId;
  onRule: (rule: KeeperPolicyId) => void;
  proposalCount: number;
  onAcceptAllProposals: () => void;
  selectedSetIds: ReadonlySet<string>;
  onToggleSetSelection: (setId: string) => void;
  onSelectSets: (setIds: readonly string[]) => void;
  onClearSetSelection: () => void;
  keepSourceByRule: (setId: string, rule: KeeperPolicyId) => string | null;
  individualOnly: { perceptual: number; unmeasured: number };
  /** Library root, stripped from planned destinations so rows show the tail. */
  destinationRoot: string;
  /** The screen-wide order, shared with Browse. */
  sort: ReviewSort;
  onSort: (sort: ReviewSort) => void;
}

export function ResolveQueue({
  queue,
  allSets,
  current,
  index,
  onGo,
  onOpenSet,
  onKeep,
  onKeepAll,
  onReset,
  onResetAll,
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
  destinationRoot,
  sort,
  onSort,
}: ResolveQueueProps) {
  const { t, tCount, locale } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);
  const [preferredFolder, setPreferredFolder] = useState("");
  const [draftSource, setDraftSource] = useState<string | null>(null);
  const [editingDecision, setEditingDecision] = useState(false);
  const [ruleImpactOpen, setRuleImpactOpen] = useState(false);

  const currentResolved =
    current !== null && (current.hasBaseline || isDecidedState(current.decisionState));
  const confirmedSource = currentResolved ? (current?.keeper?.source ?? null) : null;

  useEffect(() => {
    setDraftSource(confirmedSource);
    setEditingDecision(false);
  }, [confirmedSource, current?.id]);

  // `allSets` arrives in the panel's one order — the list, the position
  // indicator and the arrow keys all read it, so it is not re-sorted here.
  const orderedSets = allSets;
  const setWindow = useVirtualWindow({
    count: orderedSets.length,
    estimateSize: 64,
    maxHeight: 512,
    overscan: 6,
    anchorKey: orderedSets[0]?.id ?? null,
  });

  // Opening a set from Browse also brings its row into the virtualized index.
  useEffect(() => {
    if (current === null || setWindow.scrollRef.current === null) return;
    const currentIndex = orderedSets.findIndex((entry) => entry.id === current.id);
    if (currentIndex < 0) return;
    const top = currentIndex * 64;
    const bottom = top + 64;
    const element = setWindow.scrollRef.current;
    const moveTo = (nextTop: number) => {
      if (typeof element.scrollTo === "function") element.scrollTo({ top: nextTop });
      else element.scrollTop = nextTop;
    };
    if (top < element.scrollTop) moveTo(top);
    else if (bottom > element.scrollTop + element.clientHeight) {
      moveTo(bottom - element.clientHeight);
    }
  }, [current, orderedSets, setWindow.scrollRef]);

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

  const applyChoices = (choices: typeof ruleChoices) => {
    for (const choice of choices) {
      if (choice.source !== null) onKeep(choice.setId, choice.source);
    }
  };

  const chooseByNumber = useCallback(
    (position: number): boolean => {
      const row = current?.rows[position];
      if (row === undefined || row.status === "baseline") return false;
      setDraftSource(row.source);
      setEditingDecision(true);
      return true;
    },
    [current],
  );

  // Activating Resolve moves focus into the queue, the standard tab-to-panel
  // behaviour. Without it the shortcuts below — now scoped to focus-within —
  // would be dead until the user tabbed in, which is how a correct
  // accessibility fix turns into a usability regression.
  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  // WCAG 2.1.4 (Character Key Shortcuts, Level A): a shortcut bound to a single
  // unmodified character must be switchable off, remappable, or **active only
  // while the relevant component has focus**. This takes the third option.
  //
  // Widening the tag-exclusion list below would not have satisfied it. The
  // criterion is about *where focus is*, not about which element type happens
  // to swallow the key — and this queue commits keeper decisions, so a stray
  // `3` typed at a button elsewhere on the screen used to change which file the
  // next confirmation would keep.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const container = containerRef.current;
      if (container === null || !container.contains(document.activeElement)) return;

      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        (target?.tagName === "INPUT" &&
          !["button", "checkbox", "radio", "range", "submit"].includes(
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
      } else if (/^[1-9]$/.test(event.key) && chooseByNumber(Number(event.key) - 1)) {
        event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chooseByNumber, index, onGo, queue.length]);

  const ruleCanDecide = ruleChoices.filter((choice) => choice.source !== null).length;
  const folderCanDecide = folderChoices.filter((choice) => choice.source !== null).length;
  // Memoize the full-queue scan for bulk-action rerenders.
  const openSets = useMemo(() => allSets.filter(isOpenSet), [allSets]);
  const openCount = openSets.length;
  const decidedCount = allSets.length - openCount;
  // Find the next open set in one pass, wrapping once.
  const nextOpen = useMemo(() => {
    if (current === null) return openSets[0];
    const from = allSets.findIndex((entry) => entry.id === current.id);
    for (let i = from + 1; i < allSets.length; i += 1) {
      if (isOpenSet(allSets[i])) return allSets[i];
    }
    return openSets.find((entry) => entry.id !== current.id);
  }, [allSets, current, openSets]);
  /**
   * Decide this set, then move to the next one still open.
   *
   * A queue that stays put after a decision makes every set cost two gestures
   * — decide, then navigate — and fifteen sets forty-five clicks. The set just
   * decided keeps its place in the list, so ← walks straight back to it, and
   * the last decision advances nowhere and lets the finished state show.
   */
  const decideAndAdvance = useCallback(
    (decide: () => void) => {
      const following = nextOpen;
      decide();
      if (following !== undefined && following.id !== current?.id) onOpenSet(following.id);
    },
    [current?.id, nextOpen, onOpenSet],
  );

  const proposedRow = current?.rows.find((row) => row.stack?.isProposedKeeper === true) ?? null;
  const candidates = current === null ? [] : sortRows(current.rows, sort, locale);

  // Measure the rule across open sets without touching manual decisions.
  const ruleDecidable = useMemo(
    () =>
      openSets
        .map((entry) => ({ setId: entry.id, source: keepSourceByRule(entry.id, rule) }))
        .filter((choice) => choice.source !== null),
    [keepSourceByRule, openSets, rule],
  );
  const ruleImpact: RuleImpact = {
    open: openSets.length,
    decides: ruleDecidable.length,
    cannotRank: openSets.length - ruleDecidable.length,
    keepsManual: decidedCount,
  };

  return (
    // `tabIndex={-1}` so the queue is a focus target in its own right: the
    // shortcuts below are scoped to focus-within, and a region the user cannot
    // focus is a region whose shortcuts they could never reach.
    <div ref={containerRef} tabIndex={-1} className="outline-none">
      <p id="review-set-selection-empty" className="sr-only">
        {t("review.setSelection.none")}
      </p>
      <p id="review-set-selection-no-folders" className="sr-only">
        {t("review.setSelection.noFolders")}
      </p>

      <ResolveToolbar
        rule={rule}
        onRule={onRule}
        openCount={openCount}
        decidedCount={decidedCount}
        totalSets={allSets.length}
        proposalCount={proposalCount}
        onCheckImpact={() => setRuleImpactOpen(true)}
        onAcceptAllProposals={onAcceptAllProposals}
        onResetAll={onResetAll}
        sort={sort}
        onSort={onSort}
        selectableSetIds={selectableSetIds}
        onSelectSets={onSelectSets}
        hasNextOpen={nextOpen !== undefined}
        onNextOpen={() => {
          if (nextOpen !== undefined) onOpenSet(nextOpen.id);
        }}
      />

      {openCount > 0 && (
        <p className="border-b border-border bg-muted/25 px-3 py-2 text-3xs leading-relaxed text-muted-foreground">
          {t("review.resolve.openStatesHelp")}
        </p>
      )}

      <RuleImpactModal
        open={ruleImpactOpen}
        ruleLabel={t(`config.keeper.${rule}`)}
        impact={ruleImpact}
        onClose={() => setRuleImpactOpen(false)}
        onApply={() => {
          applyChoices(ruleDecidable);
          setRuleImpactOpen(false);
        }}
      />

      <SetSelectionBar
        selectedCount={selectedSets.length}
        folders={folderOptions}
        folder={preferredFolder}
        onFolderChange={setPreferredFolder}
        onClear={onClearSetSelection}
        actions={[
          {
            id: "rule",
            label: t("review.bulk.applyRule"),
            decide: ruleCanDecide,
            skip: selectedSets.length - ruleCanDecide,
            cannotKey: "review.bulk.cannotRule",
            disabled: false,
            disabledReasonId: "review-set-selection-empty",
            onApply: () => applyChoices(ruleChoices),
          },
          {
            id: "distinct",
            label: t("review.bulk.notDuplicates"),
            decide: selectedSets.length,
            skip: 0,
            disabled: false,
            disabledReasonId: "review-set-selection-empty",
            onApply: () => {
              for (const entry of selectedSets) onKeepAll(entry.id);
            },
          },
          {
            id: "folder",
            label: t("review.bulk.keepFromFolder"),
            decide: folderCanDecide,
            skip: selectedSets.length - folderCanDecide,
            cannotKey: "review.bulk.cannotFolder",
            disabled: preferredFolder === "",
            disabledReasonId: "review-set-selection-no-folders",
            onApply: () => applyChoices(folderChoices),
          },
        ]}
      />

      {/* On a wide screen the workspace is bounded by the viewport and each
          pane scrolls inside it, so the decision buttons are never left under
          the sticky footer and the list never scrolls the page out from under
          the set being read. Narrow screens keep the natural flow, where one
          column and one scroll are the right answer. */}
      <div className="grid min-h-[32rem] min-w-0 lg:h-[calc(100dvh-theme(spacing.actionzone)-21rem)] lg:min-h-[26rem] lg:grid-cols-[17rem_minmax(0,1fr)]">
        <SetQueueList
          sets={orderedSets}
          currentId={current?.id ?? null}
          openCount={openCount}
          onOpenSet={onOpenSet}
          window={setWindow}
        />

        {/* `scroll-pb-*` matches the pinned decision bar: without it the browser
            scrolls a focused copy to the bottom edge, where that bar covers it
            (WCAG 2.4.11). Same reason `main` carries `scroll-pb-actionzone`. */}
        <div className="min-w-0 overflow-y-auto overscroll-contain p-2.5 sm:p-3 lg:scroll-pb-28">
          {/* Finishing is stated where the work was, not by replacing it: every
              set stays reachable afterwards, so a decision can still be read
              back or changed without hunting for the way in again. */}
          {openCount === 0 && allSets.length > 0 && (
            <div className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-panel border border-success/35 bg-tint-success px-3 py-2.5">
              <FiCheck className="h-4 w-4 shrink-0 text-success" aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold text-foreground">
                  {t("review.resolve.doneTitle")}
                </p>
                <p className="mt-0.5 text-3xs text-muted-foreground">
                  {t("review.resolve.doneHelp")}
                </p>
              </div>
              <Button size="sm" variant="outline" onClick={onBackToBrowse}>
                <FiArrowLeft className="h-3.5 w-3.5" aria-hidden />
                {t("review.resolve.backToBrowse")}
              </Button>
            </div>
          )}
          {current === null ? (
            <div className="grid min-h-80 place-items-center text-center">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {t("review.resolve.emptyTitle")}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">{t("review.resolve.doneHelp")}</p>
                <Button size="sm" variant="outline" className="mt-4" onClick={onBackToBrowse}>
                  <FiArrowLeft className="h-3.5 w-3.5" aria-hidden />
                  {t("review.resolve.backToBrowse")}
                </Button>
              </div>
            </div>
          ) : (
            <div>
              <header className="flex flex-wrap items-start gap-2 bg-card pb-2.5 lg:sticky lg:top-0 lg:z-10">
                <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
                  <span className="text-3xs font-semibold uppercase tracking-[0.08em] text-faint">
                    {current.setKind === "exact"
                      ? t("review.stack.match.exact")
                      : current.setKind === "similar" && current.similarity !== null
                        ? t("review.stack.match.similar", { percent: current.similarity })
                        : t(`review.stack.kind.${current.setKind}`)}
                  </span>
                  <h2
                    id="review-queue-position"
                    className="truncate text-sm font-semibold text-foreground"
                  >
                    {current.keeper?.name ?? current.rows[0]?.name ?? current.id}
                  </h2>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {t("review.resolve.position", { index: index + 1, total: queue.length })}
                    {" · "}
                    {t("review.stack.copies", { count: current.rows.length })}
                  </p>
                </div>
                {/* This labelled selection feeds the bulk actions. */}
                {/* `min-h-6` rather than `target-24`: this label carries visible
                    text, so its own box is the target and only needed height
                    (WCAG 2.2 SC 2.5.8). */}
                <label className="mt-0.5 flex min-h-6 cursor-pointer items-center gap-1.5 whitespace-nowrap text-3xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={selectedSetIds.has(current.id)}
                    aria-label={t("review.setSelection.toggle", {
                      name: current.keeper?.name ?? current.id,
                    })}
                    onChange={() => onToggleSetSelection(current.id)}
                    className="h-3.5 w-3.5 rounded border-border text-primary focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  {t("review.setSelection.forBulk")}
                </label>
                <Button size="sm" variant="outline" onClick={() => onCompare(current)}>
                  {t("review.compare")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index === 0}
                  onClick={() => onGo(index - 1)}
                  aria-label={t("review.resolve.previous")}
                >
                  <FiArrowLeft className="h-3.5 w-3.5" aria-hidden />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={index >= queue.length - 1}
                  onClick={() => onGo(index + 1)}
                  aria-label={t("review.resolve.next")}
                >
                  <FiArrowRight className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </header>

              {proposedRow && (
                <aside
                  aria-label={t("review.resolve.recommendationLabel")}
                  className="mb-2.5 grid grid-cols-[1.625rem_minmax(0,1fr)] items-start gap-2.5 rounded-panel border border-success/35 bg-tint-success/70 px-2.5 py-2.5"
                >
                  <span className="grid h-[1.625rem] w-[1.625rem] place-items-center rounded-md bg-success text-background">
                    <FiCheck className="h-3.5 w-3.5" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <strong className="block text-xs text-foreground">
                      {t("review.resolve.recommended", { name: proposedRow.name })}
                    </strong>
                    <p className="mt-0.5 text-3xs leading-relaxed text-muted-foreground">
                      {t("review.resolve.recommendationHelp", {
                        rule: t(`config.keeper.${current.proposalPolicy ?? rule}`),
                      })}
                    </p>
                    {current.proposalRationale && (
                      <dl className="mt-2 grid gap-1 text-3xs text-muted-foreground sm:grid-cols-2">
                        <div>
                          <dt className="font-semibold text-foreground">
                            {t("review.resolve.rationale.winningRung")}
                          </dt>
                          <dd>
                            {t(
                              current.proposalRationale.winningRung.key,
                              current.proposalRationale.winningRung.params,
                            )}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-semibold text-foreground">
                            {t("review.resolve.rationale.knownFacts")}
                          </dt>
                          <dd>
                            {current.proposalRationale.knownFacts
                              .map((fact) => t(fact.key, fact.params))
                              .join(", ")}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-semibold text-foreground">
                            {t("review.resolve.rationale.unknownFacts")}
                          </dt>
                          <dd>
                            {current.proposalRationale.unknownFacts.length > 0
                              ? current.proposalRationale.unknownFacts
                                  .map((fact) => t(fact.key, fact.params))
                                  .join(", ")
                              : t("review.resolve.rationale.none")}
                          </dd>
                        </div>
                        <div>
                          <dt className="font-semibold text-foreground">
                            {t("review.resolve.rationale.tieBreak")}
                          </dt>
                          <dd>
                            {current.proposalRationale.tieBreak
                              ? t(
                                  current.proposalRationale.tieBreak.key,
                                  current.proposalRationale.tieBreak.params,
                                )
                              : t("review.resolve.rationale.none")}
                          </dd>
                        </div>
                        {current.proposalRationale.limitation && (
                          <div className="sm:col-span-2">
                            <dt className="font-semibold text-foreground">
                              {t("review.resolve.rationale.limitation")}
                            </dt>
                            <dd>
                              {t(
                                current.proposalRationale.limitation.key,
                                current.proposalRationale.limitation.params,
                              )}
                            </dd>
                          </div>
                        )}
                      </dl>
                    )}
                  </div>
                </aside>
              )}

              {current.hasBaseline && (
                <p id="review-baseline-rule" className="mb-2.5 text-xs text-muted-foreground">
                  {t("review.resolve.baselineWins")}
                </p>
              )}

              {currentResolved && !editingDecision ? (
                <div className="flex flex-wrap items-center gap-3 rounded-panel border border-success/40 bg-tint-success px-3 py-3">
                  <FiCheck className="h-5 w-5 shrink-0 text-success" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <strong className="block truncate text-xs text-foreground">
                      {current.decisionKind === "keep_all"
                        ? t("review.resolve.resolvedAll")
                        : t("review.resolve.resolvedKeeping", {
                            name: current.keeper?.name ?? current.rows[0]?.name ?? current.id,
                          })}
                    </strong>
                    <p className="mt-0.5 text-3xs text-muted-foreground">
                      {current.decisionKind === "keep_all"
                        ? t("review.resolve.resolvedAllHelp")
                        : tCount(
                            "review.resolve.resolvedHelp",
                            Math.max(0, current.rows.length - 1),
                          )}
                    </p>
                  </div>
                  {!current.hasBaseline && (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setEditingDecision(true)}>
                        {t("review.resolve.editDecision")}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => onReset?.(current.id)}>
                        {t("review.resolve.resetOne")}
                      </Button>
                    </>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={nextOpen === undefined}
                    onClick={() => nextOpen && onOpenSet(nextOpen.id)}
                  >
                    {t("review.resolve.nextOpen")}
                  </Button>
                </div>
              ) : (
                <>
                  <div className="mb-2.5 rounded-panel border border-border bg-muted/50 px-2.5 py-2 text-xs text-muted-foreground">
                    <strong className="text-foreground">{t("review.resolve.notConfirmed")}</strong>{" "}
                    {t("review.resolve.chooseHelp")}
                  </div>

                  {/* Keep each duplicate set as one vertical comparison list. */}
                  <ul className="grid gap-2">
                    {candidates.map((row) => (
                      <li key={row.source}>
                        <CopyRow
                          row={row}
                          // Shortcut numbers follow stable set order.
                          position={current.rows.indexOf(row)}
                          selected={draftSource === row.source}
                          confirmed={confirmedSource === row.source}
                          isProposed={row.stack?.isProposedKeeper === true}
                          note={candidateNote(row, current.rows, t, locale)}
                          onSelect={() => {
                            setDraftSource((selected) =>
                              selected === row.source ? null : row.source,
                            );
                            setEditingDecision(true);
                          }}
                          onOpenDetail={() => onOpenDetail(row.source)}
                          destinationRoot={destinationRoot}
                          locale={locale}
                        />
                      </li>
                    ))}
                  </ul>

                  {/* Keep evidence and decision actions visually separate — and
                      on a bounded workspace, keep the actions in view: a long
                      set used to scroll its own confirm button away, so the
                      copies were readable and the decision was not. */}
                  <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-panel border border-border bg-card px-2.5 py-2.5 lg:sticky lg:bottom-0 lg:z-10 lg:shadow-card">
                    <div className="mr-auto min-w-0" aria-live="polite">
                      <strong className="block text-xs text-foreground">
                        {draftSource === null
                          ? t("review.resolve.nothingSelected")
                          : t("review.resolve.oneSelected", { total: current.rows.length })}
                      </strong>
                      <span className="block text-3xs text-muted-foreground">
                        {draftSource === null
                          ? t("review.resolve.selectAtLeastOne")
                          : t("review.resolve.selectionCanChange")}
                      </span>
                      <span className="mt-0.5 hidden text-3xs text-faint lg:block">
                        {t("review.resolve.keyboardHelp")}
                      </span>
                    </div>
                    {editingDecision && currentResolved && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setDraftSource(confirmedSource);
                          setEditingDecision(false);
                        }}
                      >
                        {t("common.cancel")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={draftSource === null}
                      onClick={() => setDraftSource(null)}
                    >
                      {t("review.clearSelection")}
                    </Button>
                    <Button
                      size="sm"
                      disabled={draftSource === null || draftSource === confirmedSource}
                      onClick={() => {
                        if (draftSource === null) return;
                        decideAndAdvance(() => onKeep(current.id, draftSource));
                      }}
                    >
                      {t("review.resolve.confirmSelection")}
                    </Button>
                    {isProposedState(current.decisionState) && proposedRow && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => decideAndAdvance(() => onAcceptProposal(current.id))}
                      >
                        {t("review.proposal.acceptOne")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={current.hasBaseline}
                      aria-describedby={current.hasBaseline ? "review-baseline-rule" : undefined}
                      onClick={() => decideAndAdvance(() => onKeepAll(current.id))}
                    >
                      {t("review.resolve.keepAll")}
                    </Button>
                  </div>
                </>
              )}

              {(individualOnly.perceptual > 0 || individualOnly.unmeasured > 0) && (
                <div className="mt-2 space-y-1 text-3xs text-muted-foreground">
                  {individualOnly.perceptual > 0 && (
                    <p>{tCount("review.resolve.individualOnly", individualOnly.perceptual)}</p>
                  )}
                  {individualOnly.unmeasured > 0 && (
                    <p>{tCount("review.resolve.unmeasuredOnly", individualOnly.unmeasured)}</p>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
