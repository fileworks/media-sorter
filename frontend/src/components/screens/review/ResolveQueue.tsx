/** Duplicate resolver with explicit draft and confirmed states. */

import { useCallback, useEffect, useMemo, useState } from "react";
import { FiArrowLeft, FiArrowRight, FiCheck, FiLock } from "react-icons/fi";

import { RuleImpactModal, type RuleImpact } from "@/components/screens/review/RuleImpactModal";
import { SortControl } from "@/components/screens/review/SortControl";
import { StackVisual } from "@/components/screens/review/StackVisual";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectItem } from "@/components/ui/select";
import { Thumbnail } from "@/components/ui/thumbnail";
import { useI18n } from "@/i18n/I18nContext";
import { isDecidedState, isProposedState, sourceFolder } from "@/lib/duplicateDecisions";
import { formatBytes } from "@/lib/formatters";
import { formatMetadataSource } from "@/lib/metadataSource";
import { cn } from "@/lib/utils";
import type { SetEntry } from "@/lib/reviewBrowse";
import { folderLeaf, relativeDestination, type ReviewRow } from "@/lib/reviewRows";
import { sortRows, sortSets, type ReviewSort } from "@/lib/reviewSort";
import { SELECTABLE_KEEPER_POLICIES, type KeeperPolicyId } from "@/types/api";

/** Still awaiting a decision: no baseline copy, and nothing decided yet. */
function isOpenSet(entry: SetEntry): boolean {
  return !entry.hasBaseline && !isDecidedState(entry.decisionState);
}

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
  const { t, locale } = useI18n();
  const [preferredFolder, setPreferredFolder] = useState("");
  const [draftSource, setDraftSource] = useState<string | null>(null);
  const [editingDecision, setEditingDecision] = useState(false);
  const [queueLimit, setQueueLimit] = useState(40);
  const [ruleImpactOpen, setRuleImpactOpen] = useState(false);

  const currentResolved =
    current !== null && (current.hasBaseline || isDecidedState(current.decisionState));
  const confirmedSource = currentResolved ? (current?.keeper?.source ?? null) : null;

  useEffect(() => {
    setDraftSource(confirmedSource);
    setEditingDecision(false);
  }, [confirmedSource, current?.id]);

  // Render large queues incrementally in the screen-wide order.
  const orderedSets = useMemo(() => sortSets(allSets, sort, locale), [allSets, locale, sort]);

  useEffect(() => {
    if (current === null) return;
    const currentIndex = orderedSets.findIndex((entry) => entry.id === current.id);
    if (currentIndex >= queueLimit) setQueueLimit(currentIndex + 1);
  }, [current, orderedSets, queueLimit]);

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
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
  const proposedRow = current?.rows.find((row) => row.stack?.isProposedKeeper === true) ?? null;
  const listedSets = orderedSets.slice(0, queueLimit);
  const remainingSets = Math.max(0, orderedSets.length - listedSets.length);
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
    <div>
      <p id="review-set-selection-empty" className="sr-only">
        {t("review.setSelection.none")}
      </p>
      <p id="review-set-selection-no-folders" className="sr-only">
        {t("review.setSelection.noFolders")}
      </p>

      {/* Separate rule, order, selection, and queue-position controls. */}
      <div className="flex min-h-14 flex-wrap items-center gap-x-2.5 gap-y-2 border-b border-border bg-card px-2.5 py-2">
        <div
          className="flex min-w-0 flex-wrap items-center gap-2"
          aria-label={t("review.keepRule")}
        >
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
          <Button
            size="sm"
            variant="outline"
            disabled={openSets.length === 0}
            onClick={() => setRuleImpactOpen(true)}
          >
            {t("review.ruleImpact.check")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={proposalCount === 0}
            onClick={onAcceptAllProposals}
          >
            {t("review.proposal.acceptAll", { count: proposalCount })}
          </Button>
        </div>

        <div className="flex items-center border-border pl-2.5 sm:border-l">
          <SortControl id="review-resolve-sort" value={sort} onChange={onSort} />
        </div>

        <div className="flex flex-wrap items-center gap-2 border-border pl-2.5 sm:border-l">
          <span className="text-3xs text-muted-foreground" role="status">
            {t("review.setSelection.count", { count: selectedSets.length })}
          </span>
          <Button
            size="sm"
            variant="ghost"
            disabled={selectableSetIds.length === 0}
            onClick={() => onSelectSets(selectableSetIds)}
          >
            {t("review.setSelection.selectAll", { count: selectableSetIds.length })}
          </Button>
          {selectedSets.length > 0 && (
            <Button size="sm" variant="ghost" onClick={onClearSetSelection}>
              {t("review.clearSelection")}
            </Button>
          )}
        </div>

        <div className="ml-auto flex items-center gap-2 border-border pl-2.5 sm:border-l">
          <Button
            size="sm"
            variant="ghost"
            disabled={nextOpen === undefined}
            onClick={() => nextOpen && onOpenSet(nextOpen.id)}
          >
            {t("review.resolve.nextOpen")}
          </Button>
          <span className="whitespace-nowrap text-3xs tabular-nums text-muted-foreground">
            {t("review.resolve.decidedCount", { decided: decidedCount, total: allSets.length })}
          </span>
        </div>
      </div>

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

      {selectedSets.length > 0 && (
        <div className="border-b border-border bg-muted/30 p-2">
          <label className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            {t("review.bulk.folder")}
            <select
              value={preferredFolder}
              disabled={folderOptions.length === 0}
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
          <div className="grid gap-2 sm:grid-cols-3">
            <BulkAction
              id="rule"
              label={t("review.bulk.applyRule")}
              decide={ruleCanDecide}
              skip={selectedSets.length - ruleCanDecide}
              cannotKey="review.bulk.cannotRule"
              disabled={false}
              disabledReasonId="review-set-selection-empty"
              onApply={() => applyChoices(ruleChoices)}
            />
            <BulkAction
              id="distinct"
              label={t("review.bulk.notDuplicates")}
              decide={selectedSets.length}
              skip={0}
              disabled={false}
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
              disabled={preferredFolder === ""}
              disabledReasonId="review-set-selection-no-folders"
              onApply={() => applyChoices(folderChoices)}
            />
          </div>
        </div>
      )}

      <div className="grid min-h-[32rem] min-w-0 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <aside className="min-w-0 overflow-hidden border-b border-border bg-card lg:border-b-0 lg:border-r">
          <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
            <strong className="text-xs text-foreground">{t("review.resolve.allSets")}</strong>
            <Badge tone={openCount > 0 ? "primary" : "success"} className="ml-auto">
              {t("review.resolve.openCount", { count: openCount })}
            </Badge>
          </div>
          <ul className="grid max-h-[min(32rem,60dvh)] gap-1 overflow-y-auto overscroll-contain p-1.5 sm:grid-cols-2 lg:grid-cols-1">
            {listedSets.map((entry) => {
              const active = current?.id === entry.id;
              const decided = entry.hasBaseline || isDecidedState(entry.decisionState);
              const proposed = isProposedState(entry.decisionState);
              return (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => onOpenSet(entry.id)}
                    className={cn(
                      "grid min-h-[3.75rem] w-full grid-cols-[2.625rem_minmax(0,1fr)_auto] items-center gap-2 rounded-panel p-1.5 text-left transition-colors",
                      active ? "bg-tint-primary" : "hover:bg-muted",
                    )}
                  >
                    <StackVisual paths={entry.rows.map((row) => row.source)} />
                    <span className="min-w-0">
                      <span className="block truncate text-xs font-semibold text-foreground">
                        {entry.keeper?.name ?? entry.rows[0]?.name ?? entry.id}
                      </span>
                      <span className="mt-0.5 block truncate text-3xs text-muted-foreground">
                        {decided
                          ? t("review.resolve.queueDecided")
                          : proposed
                            ? t("review.resolve.queueProposed")
                            : entry.setKind === "exact"
                              ? t("review.stack.match.exact")
                              : entry.setKind === "similar" && entry.similarity !== null
                                ? t("review.stack.match.similar", {
                                    percent: entry.similarity,
                                  })
                                : t(`review.stack.kind.${entry.setKind}`)}
                      </span>
                    </span>
                    <span
                      className={cn("h-2 w-2 rounded-full", decided ? "bg-success" : "bg-primary")}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
          {remainingSets > 0 && (
            <div className="border-t border-border p-2">
              <Button
                size="sm"
                variant="ghost"
                className="w-full"
                onClick={() => setQueueLimit((limit) => limit + 40)}
              >
                {t("review.resolve.showMoreSets", { count: Math.min(40, remainingSets) })}
              </Button>
            </div>
          )}
        </aside>

        <div className="min-w-0 p-2.5 sm:p-3">
          {current === null ? (
            <div className="grid min-h-80 place-items-center text-center">
              <div>
                <p className="text-sm font-semibold text-foreground">
                  {t("review.resolve.doneTitle")}
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
              <header className="flex flex-wrap items-start gap-2 pb-2.5">
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
                <label className="mt-0.5 flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-3xs text-muted-foreground">
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
                        : t("review.resolve.resolvedHelp", {
                            count: Math.max(0, current.rows.length - 1),
                          })}
                    </p>
                  </div>
                  {!current.hasBaseline && (
                    <Button size="sm" variant="outline" onClick={() => setEditingDecision(true)}>
                      {t("review.resolve.editDecision")}
                    </Button>
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
                        <Copy
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

                  {/* Keep evidence and decision actions visually separate. */}
                  <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-panel border border-border bg-card px-2.5 py-2.5">
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
                        if (draftSource !== null) onKeep(current.id, draftSource);
                      }}
                    >
                      {t("review.resolve.confirmSelection")}
                    </Button>
                    {isProposedState(current.decisionState) && proposedRow && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onAcceptProposal(current.id)}
                      >
                        {t("review.proposal.acceptOne")}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={current.hasBaseline}
                      aria-describedby={current.hasBaseline ? "review-baseline-rule" : undefined}
                      onClick={() => onKeepAll(current.id)}
                    >
                      {t("review.resolve.keepAll")}
                    </Button>
                  </div>
                </>
              )}

              {(individualOnly.perceptual > 0 || individualOnly.unmeasured > 0) && (
                <div className="mt-2 space-y-1 text-3xs text-muted-foreground">
                  {individualOnly.perceptual > 0 && (
                    <p>
                      {t("review.resolve.individualOnly", { count: individualOnly.perceptual })}
                    </p>
                  )}
                  {individualOnly.unmeasured > 0 && (
                    <p>
                      {t("review.resolve.unmeasuredOnly", { count: individualOnly.unmeasured })}
                    </p>
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
    <div className="rounded-lg border border-border bg-card p-2.5">
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

/** One candidate with textual proposal, draft, and confirmed states. */
function Copy({
  row,
  position,
  selected,
  confirmed,
  isProposed,
  note,
  onSelect,
  onOpenDetail,
  destinationRoot,
  locale,
}: {
  row: ReviewRow;
  position: number;
  selected: boolean;
  confirmed: boolean;
  isProposed: boolean;
  /** One comparative fact about this copy, or null when there is none. */
  note: string | null;
  onSelect: () => void;
  onOpenDetail: () => void;
  /** Library root, stripped from the planned destination so the cell shows the tail. */
  destinationRoot: string;
  locale: string;
}) {
  const { t } = useI18n();
  const baseline = row.status === "baseline";

  return (
    <article
      className={cn(
        "candidate-grid relative min-h-[4.875rem] min-w-0 rounded-panel border bg-card px-2 py-1.5",
        "transition-[border-color,box-shadow,background-color,transform] duration-150",
        baseline ? "cursor-default" : "cursor-pointer",
        selected && "selection-set",
        selected
          ? "border-primary bg-tint-primary/50 shadow-[inset_0_0_0_1px_hsl(var(--primary))]"
          : isProposed
            ? "border-dashed border-success hover:border-border-strong"
            : "border-border hover:border-border-strong",
      )}
    >
      <div className="relative">
        <Thumbnail path={row.source} maxPx={160} className="h-[3.625rem] w-[3.625rem] rounded-md" />
        {/* Overlay state remains visible regardless of filename length. */}
        <span
          className={cn(
            "pointer-events-none absolute left-1 top-1 z-10 flex items-center gap-1 rounded px-1.5 py-0.5 text-3xs font-bold shadow-sm",
            selected
              ? "bg-primary text-primary-foreground"
              : baseline
                ? "bg-card/90 text-muted-foreground"
                : "bg-card/90 text-muted-foreground",
          )}
        >
          {baseline ? (
            <>
              <FiLock className="h-2.5 w-2.5" aria-hidden />
              {t("review.resolve.protected")}
            </>
          ) : selected ? (
            <>
              <FiCheck className="h-2.5 w-2.5" aria-hidden />
              {confirmed ? t("review.resolve.kept") : t("review.resolve.selected")}
            </>
          ) : (
            t("review.resolve.selectThis")
          )}
        </span>
      </div>

      <div className="min-w-0">
        {/* Sibling controls keep selection and detail actions independent. */}
        <button
          type="button"
          disabled={baseline}
          aria-describedby={baseline ? "review-baseline-rule" : undefined}
          aria-pressed={selected}
          onClick={onSelect}
          aria-label={t("review.resolve.keepThis", { name: row.name, number: position + 1 })}
          className="absolute inset-0 rounded-panel focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
        />
        <button
          type="button"
          onClick={onOpenDetail}
          className="relative z-10 block max-w-full truncate text-left text-2xs font-semibold text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {row.name}
        </button>
        <span className="block truncate text-3xs text-muted-foreground" title={row.folder}>
          {folderLeaf(row.folder)}
        </span>
        {note !== null && (
          <p
            className={cn(
              "mt-0.5 flex items-center gap-1.5 truncate text-3xs leading-snug",
              isProposed ? "font-semibold text-success" : "text-muted-foreground",
            )}
          >
            <span
              className={cn(
                "h-1 w-1 shrink-0 rounded-full",
                isProposed ? "bg-success" : "bg-border-strong",
              )}
              aria-hidden
            />
            <span className="truncate">{note}</span>
          </p>
        )}
      </div>

      <span className="text-right text-3xs tabular-nums text-muted-foreground">
        {formatBytes(row.sizeBytes, { locale })}
      </span>

      <span className="candidate-date text-right text-3xs text-muted-foreground">
        {row.date === null ? t("review.resolve.noDate") : row.date}
      </span>

      <span className="candidate-date-source text-right text-3xs text-faint">
        {row.date === null ? "" : formatMetadataSource(row.dateSource, t)}
      </span>

      <span
        className="candidate-destination truncate font-mono text-3xs text-faint"
        title={row.destination ?? undefined}
      >
        {row.destination !== null && `→ ${relativeDestination(row.destination, destinationRoot)}`}
      </span>

      {isProposed && !selected && (
        <span className="candidate-recommendation-badge pointer-events-none absolute right-1.5 top-1.5 z-10 rounded border border-success/40 bg-tint-success px-1.5 py-0.5 text-3xs font-bold text-success">
          {t("review.resolve.recommendation")}
        </span>
      )}
    </article>
  );
}
