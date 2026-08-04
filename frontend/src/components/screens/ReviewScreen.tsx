/**
 * Screen 3 — the dry run. Nothing has happened yet, and this screen's whole job
 * is to make that reviewable rather than to make it reassuring.
 *
 * One surface, not four tabs: the destination tree on the left, filter chips and
 * a toolbar across the top, and a single item list. Everything on it — the
 * tiles, the chips, the tree, the list — is the same arithmetic over the same
 * rows, which is why a tile can no longer read "0 duplicates found" beside four
 * duplicate stacks.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { PlanSummary } from "@/components/screens/review/PlanSummary";
import { DestinationTree } from "@/components/screens/review/DestinationTree";
import { CompareModal } from "@/components/screens/review/CompareModal";
import { ReviewItemList } from "@/components/screens/review/ReviewItemList";
import { ReviewToolbar } from "@/components/screens/review/ReviewToolbar";
import { SelectionBar } from "@/components/screens/review/SelectionBar";
import { ScreenHeader } from "@/components/screens/ScreenHeader";
import { StateView } from "@/components/StateView";
import { Button } from "@/components/ui/button";
import { useReviewGroups } from "@/hooks/useReviewGroups";
import { useReviewSurface } from "@/hooks/useReviewSurface";
import { useI18n } from "@/i18n/I18nContext";
import { extractErrorMessage } from "@/lib/errorUtils";
import { formatBytes } from "@/lib/formatters";
import { planTotals, planWarnings, warningTotal } from "@/lib/reviewPlan";
import {
  comparePair,
  excludedTally,
  selectionActions,
  type ReviewRow,
  type Stack,
} from "@/lib/reviewRows";
import type { DuplicateGroup, GroupMember, GroupPlan } from "@/lib/reviewWorkbench";
import type { View } from "@/lib/stageModel";
import { api } from "@/services/api";
import type { Config, KeeperPolicyId, PreviewResult } from "@/types/api";

interface ReviewScreenProps {
  result: PreviewResult;
  config: Config;
  view: View;
  onSelectView: (view: View) => void;
  /** Jump to Configure, scrolled to a specific setting row. */
  onOpenSetting: (anchorId: string) => void;
  onRerunPreview: () => void;
  /** Run-scoped decisions, lifted so Execute can send them with the run. */
  onDecisionsChange?: (decisions: {
    excludedSources: string[];
    /** What those exclusions take off the plan, for the Execute preflight. */
    excludedTally: { transfers: number; quarantine: number; bytes: number };
  }) => void;
}

export function ReviewScreen({
  result,
  config,
  onSelectView,
  onRerunPreview,
  onDecisionsChange,
}: ReviewScreenProps) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();
  const [plans] = useState<Record<string, GroupPlan | undefined>>({});
  const [comparing, setComparing] = useState<{
    a: GroupMember;
    b: GroupMember;
    keeperId: string | null;
    stackId: string;
  } | null>(null);

  const groups = useReviewGroups(plans, { bursts: config.burst_detection_enabled });
  const surface = useReviewSurface(result, groups.groups, plans, config.duplicate_keeper_policy);

  // Execute must acknowledge the counts that will actually happen, so the
  // decisions leave this screen rather than living only inside it.
  useEffect(() => {
    onDecisionsChange?.({
      excludedSources: [...surface.excluded],
      excludedTally: excludedTally(surface.rows),
    });
  }, [onDecisionsChange, surface.excluded, surface.rows]);

  const invalidateGroups = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["review", "groups"] });
  }, [queryClient]);

  const dissolve = useMutation({
    mutationFn: (stackId: string) =>
      api.quarantineAllExcept(
        stackId,
        (groups.groups.find((group) => group.group_id === stackId)?.members ?? []).map(
          (member) => member.member_id,
        ),
      ),
    onSuccess: invalidateGroups,
  });

  /** Choose a keeper by member id — the shape both Compare and the row use. */
  const decideKeeper = useMutation({
    mutationFn: (input: { groupId: string; memberId: string }) =>
      api.decideReview({ ...input, action: "replace_keeper" }),
    onSuccess: invalidateGroups,
  });

  const keepOnly = useMutation({
    mutationFn: (row: ReviewRow) =>
      api.decideReview({
        groupId: row.stack?.id ?? "",
        memberId: row.stack?.memberId ?? "",
        action: "replace_keeper",
      }),
    onSuccess: invalidateGroups,
  });

  /**
   * A keep rule applied to one stack, leaving every other stack alone.
   *
   * The same preview-then-apply pair as the global rule, scoped to
   * `this_group`: the set acted on is the set that was shown, even when that
   * set is one.
   */
  const overrideStackKeeper = useMutation({
    mutationFn: async (input: { stackId: string; policy: KeeperPolicyId }) => {
      const impact = await api.previewPolicy({
        policyId: input.policy,
        scope: "this_group",
        groupIds: [input.stackId],
      });
      return api.applyPolicy({
        policyId: input.policy,
        scope: "this_group",
        groupIds: [input.stackId],
        impact,
      });
    },
    onSuccess: invalidateGroups,
  });

  const applyKeepPolicy = useMutation({
    mutationFn: async () => {
      // Previewed then applied, so the set acted on is the set that was shown.
      const impact = await api.previewPolicy({
        policyId: surface.keepPolicy,
        scope: "current_filtered_exact",
      });
      return api.applyPolicy({
        policyId: surface.keepPolicy,
        scope: "current_filtered_exact",
        impact,
      });
    },
    onSuccess: invalidateGroups,
  });

  /** The comparison acts on catalog members, so rows are mapped back to them. */
  const openCompare = useCallback(
    (rows: [ReviewRow, ReviewRow] | null) => {
      if (rows === null) return;
      const [left, right] = rows;
      const stackId = left.stack?.id ?? right.stack?.id ?? null;
      const group: DuplicateGroup | undefined = groups.groups.find(
        (candidate) => candidate.group_id === stackId,
      );
      const find = (row: ReviewRow): GroupMember | undefined =>
        group?.members.find((member) => member.observed_path === row.source);
      const a = find(left);
      const b = find(right);
      if (a === undefined || b === undefined || stackId === null) return;
      setComparing({
        a,
        b,
        keeperId: left.stack?.isKeeper ? a.member_id : right.stack?.isKeeper ? b.member_id : null,
        stackId,
      });
    },
    [groups.groups],
  );

  const warnings = useMemo(() => planWarnings(result), [result]);
  const totals = useMemo(
    () => planTotals(result, warningTotal(warnings), groups.tally),
    [groups.tally, result, warnings],
  );
  const rootCount = config.library_profile.roots.filter(
    (root) => root.role !== "destination",
  ).length;

  const actions = selectionActions(surface.selectedRows);

  // Chips carrying a decision get a dot: excluded rows anywhere, and duplicates
  // once a stack has been resolved.
  const decided = useMemo(() => {
    const set = new Set<import("@/lib/reviewRows").FilterKey>();
    if (surface.counts.excluded > 0) set.add("excluded");
    if (surface.rows.some((row) => row.stack !== null && row.excluded)) set.add("duplicates");
    return set;
  }, [surface.counts.excluded, surface.rows]);

  // The set the keep rule acts on, read from the stacks themselves rather than
  // recounted off the rows. `current_filtered_exact` is every *exact* group the
  // catalog holds; counting distinct stacks in the preview rows answered a
  // different question — it dropped groups whose members fall outside this
  // scan, and included similar and burst stacks the policy cannot touch.
  const exactStacks = useMemo(
    () => groups.groups.filter((group) => group.kind === "exact").length,
    [groups.groups],
  );

  // Depends on the two callbacks, not on `surface`: the hook returns a fresh
  // object every render, so listing it here tore down and re-registered the
  // window listener on every keystroke, filter change and hover.
  const { clearSelection, selectAllVisible } = surface;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearSelection();
      if (event.key === "a" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        selectAllVisible();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [clearSelection, selectAllVisible]);

  // From a stack header, the keeper is pre-selected and the second copy asked
  // for — never an arbitrary partner picked for the user.
  const compareFromStack = (stack: Stack) => {
    const keeper = stack.keeper ?? stack.rows[0];
    const other = stack.rows.find((row) => row.source !== keeper.source);
    if (other) openCompare([keeper, other]);
  };

  const mutationFailure =
    dissolve.error ??
    keepOnly.error ??
    decideKeeper.error ??
    applyKeepPolicy.error ??
    overrideStackKeeper.error ??
    null;

  // A decision taken inside Compare belongs inside Compare: the dialog stays
  // open until it lands, and a refusal is shown there rather than behind it.
  const comparePending = decideKeeper.isPending || dissolve.isPending;
  const compareError = comparing
    ? ((decideKeeper.error ?? dissolve.error) &&
        extractErrorMessage(decideKeeper.error ?? dissolve.error, t("review.actionFailed"))
          .message) ||
      null
    : null;

  return (
    <div className="space-y-5">
      <div>
        <ScreenHeader title={t("review.title")} subtitle={t("review.subtitle")} />
        <PlanSummary
          totals={totals}
          sizeLabel={formatBytes(result.impact.required_bytes, { locale })}
          rootCount={rootCount}
          onOpen={(view) => {
            // Tiles are filter shortcuts now, not tabs.
            onSelectView(view);
            surface.setFilter(
              view === "duplicates"
                ? "duplicates"
                : view === "junk"
                  ? "junk"
                  : view === "warnings"
                    ? "no_date"
                    : "all",
            );
          }}
        />
      </div>

      {surface.droppedExclusions > 0 && (
        <StateView
          variant="info"
          compact
          title={t("review.exclusionsDropped", { count: surface.droppedExclusions })}
          action={
            <Button variant="ghost" size="sm" onClick={surface.acknowledgeDropped}>
              {t("common.dismiss")}
            </Button>
          }
        />
      )}

      {mutationFailure && (
        <StateView
          variant="error"
          compact
          title={t("review.actionFailed")}
          detail={extractErrorMessage(mutationFailure, t("review.actionFailed")).message}
          code={extractErrorMessage(mutationFailure, t("review.actionFailed")).code}
        />
      )}

      <div className="grid gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <div className="lg:sticky lg:top-4 lg:self-start">
          <DestinationTree
            root={surface.tree}
            selectedPath={surface.treePath}
            onSelect={(path) => surface.setTreePath(path === surface.treePath ? null : path)}
          />
        </div>

        <div className="min-w-0 space-y-3">
          <ReviewToolbar
            counts={surface.counts}
            decided={decided}
            filter={surface.filter}
            onFilter={surface.setFilter}
            search={surface.search}
            onSearch={surface.setSearch}
            view={surface.view}
            onView={surface.setView}
            keepPolicy={surface.keepPolicy}
            onKeepPolicy={surface.setKeepPolicy}
            exactStacks={exactStacks}
            onApplyKeepPolicy={() => applyKeepPolicy.mutate()}
            applyPending={applyKeepPolicy.isPending}
          />

          <SelectionBar
            selected={surface.selectedRows}
            actions={actions}
            onExclude={() => {
              surface.exclude(surface.selectedRows.map((row) => row.source));
              surface.clearSelection();
            }}
            onInclude={() => {
              surface.include(surface.selectedRows.map((row) => row.source));
              surface.clearSelection();
            }}
            onKeepOnlyThis={() => {
              const row = surface.selectedRows[0];
              if (row) keepOnly.mutate(row);
            }}
            onCompare={() => openCompare(comparePair(surface.selectedRows))}
            onClear={surface.clearSelection}
          />

          <p className="text-xs text-muted-foreground" role="status">
            {t("review.showing", {
              visible: surface.visible.length.toLocaleString(locale),
              total: surface.rows.length.toLocaleString(locale),
            })}
          </p>

          {groups.isError ? (
            <StateView
              variant="error"
              title={t("review.stacksFailed")}
              detail={t("review.stacksFailedHelp")}
              onRetry={groups.refetch}
            />
          ) : surface.rows.length === 0 ? (
            <StateView
              variant="empty"
              title={t("review.nothingScanned")}
              detail={t("review.nothingScannedHelp")}
              action={
                <Button size="sm" onClick={onRerunPreview}>
                  {t("preview.action")}
                </Button>
              }
            />
          ) : surface.counts.excluded === surface.rows.length ? (
            <StateView
              variant="warning"
              title={t("review.everythingExcluded")}
              detail={t("review.everythingExcludedHelp")}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => surface.include(surface.rows.map((row) => row.source))}
                >
                  {t("review.includeEverything")}
                </Button>
              }
            />
          ) : surface.visible.length === 0 ? (
            <StateView
              variant="empty"
              title={t("review.filterMatchesNothing")}
              action={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    surface.setFilter("all");
                    surface.setSearch("");
                    surface.setTreePath(null);
                  }}
                >
                  {t("review.clearFilter")}
                </Button>
              }
            />
          ) : (
            <ReviewItemList
              rows={surface.visible}
              view={surface.view}
              selected={surface.selected}
              onToggle={surface.toggle}
              onDissolve={(stackId) => dissolve.mutate(stackId)}
              onKeepOnly={(row) => keepOnly.mutate(row)}
              onCompareStack={compareFromStack}
              onOverrideKeeper={(stackId, policy) =>
                overrideStackKeeper.mutate({ stackId, policy })
              }
              dissolvePending={dissolve.isPending ? (dissolve.variables ?? null) : null}
              keeperPending={
                overrideStackKeeper.isPending
                  ? (overrideStackKeeper.variables?.stackId ?? null)
                  : null
              }
            />
          )}
        </div>
      </div>

      {comparing && (
        <CompareModal
          a={comparing.a}
          b={comparing.b}
          keeperId={comparing.keeperId}
          onClose={() => setComparing(null)}
          pending={comparePending}
          error={compareError}
          onKeep={(memberId) => {
            decideKeeper.mutate(
              { groupId: comparing.stackId, memberId },
              { onSuccess: () => setComparing(null) },
            );
          }}
          onKeepBoth={() => {
            dissolve.mutate(comparing.stackId, { onSuccess: () => setComparing(null) });
          }}
        />
      )}
    </div>
  );
}
