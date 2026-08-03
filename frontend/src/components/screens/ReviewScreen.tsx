/**
 * Screen 3 — the dry run. Nothing has happened yet, and this screen's whole job
 * is to make that reviewable rather than to make it reassuring.
 *
 * Layout: the figures across the top, the folder tree this would produce down
 * the left, and the work itself in tabs on the right. The four tabs the design
 * specifies are always present; the specialist workbenches this app also has —
 * burst review, destination reconciliation, library checks — appear as extra
 * tabs only when the run actually contains that kind of work, so the default
 * screen stays the design's four.
 */

import { Suspense, lazy, useCallback, useMemo, useState } from "react";

import { PlanSummary } from "@/components/screens/review/PlanSummary";
import { DestinationTree } from "@/components/screens/review/DestinationTree";
import { DuplicatesTab } from "@/components/screens/review/DuplicatesTab";
import { JunkTab } from "@/components/screens/review/JunkTab";
import { WarningsTab } from "@/components/screens/review/WarningsTab";
import { CompareModal } from "@/components/screens/review/CompareModal";
import { ScreenHeader } from "@/components/screens/ScreenHeader";
import { StateView } from "@/components/StateView";
import { useReviewGroups } from "@/hooks/useReviewGroups";
import { useI18n } from "@/i18n/I18nContext";
import { formatBytes } from "@/lib/formatters";
import {
  destinationRootName,
  destinationTree,
  planTotals,
  planWarnings,
  tabCounts,
  warningTotal,
} from "@/lib/reviewPlan";
import { PRIMARY_REVIEW_VIEWS, type View } from "@/lib/stageModel";
import type { DuplicateGroup, GroupMember, GroupPlan } from "@/lib/reviewWorkbench";
import { cn } from "@/lib/utils";
import { api } from "@/services/api";
import type { Config, PreviewItem, PreviewResult } from "@/types/api";

const PreviewPanel = lazy(() =>
  import("@/components/PreviewPanel").then((module) => ({ default: module.PreviewPanel })),
);
const BurstReviewPanel = lazy(() =>
  import("@/components/BurstReviewPanel").then((module) => ({
    default: module.BurstReviewPanel,
  })),
);
const DestinationReconciliationPanel = lazy(() =>
  import("@/components/DestinationReconciliationPanel").then((module) => ({
    default: module.DestinationReconciliationPanel,
  })),
);
const LibraryAuditPanel = lazy(() =>
  import("@/components/LibraryAuditPanel").then((module) => ({
    default: module.LibraryAuditPanel,
  })),
);

interface ReviewScreenProps {
  result: PreviewResult;
  config: Config;
  view: View;
  onSelectView: (view: View) => void;
  /** Jump to Configure, scrolled to a specific setting row. */
  onOpenSetting: (anchorId: string) => void;
  onRerunPreview: () => void;
}

export function ReviewScreen({
  result,
  config,
  view,
  onSelectView,
  onOpenSetting,
  onRerunPreview,
}: ReviewScreenProps) {
  const { t, locale } = useI18n();
  const [statusFilter, setStatusFilter] = useState<PreviewItem["status"][] | null>(null);
  const [comparing, setComparing] = useState<{
    group: DuplicateGroup;
    plan: GroupPlan | undefined;
  } | null>(null);

  // The duplicate figures come from the workbench's own catalog query, not from
  // the dry run's skip count, so the tile, the tab badge and the tab agree.
  const { tally: duplicateTally } = useReviewGroups();

  const warnings = useMemo(() => planWarnings(result), [result]);
  const totals = useMemo(
    () => planTotals(result, warningTotal(warnings), duplicateTally),
    [duplicateTally, result, warnings],
  );
  const counts = useMemo(
    () => tabCounts(result, warnings, duplicateTally),
    [duplicateTally, result, warnings],
  );
  const tree = useMemo(
    () =>
      destinationTree(result.items, destinationRootName(config), {
        rootPath: config.target_directory,
      }),
    [config, result.items],
  );

  const inputRoot = config.library_profile.roots.find((root) => root.role === "input");
  const destinationRoot = config.library_profile.roots.find(
    (root) => root.role === "destination",
  );
  const rootCount = config.library_profile.roots.filter(
    (root) => root.role !== "destination",
  ).length;

  const hasBursts = config.burst_detection_enabled && Boolean(inputRoot);
  const hasReconciliation = result.items.some(
    (item) => item.status === "already_in_destination",
  );
  const hasLibraryChecks = Boolean(destinationRoot?.path);

  const advancedViews: View[] = [
    ...(hasBursts ? (["bursts"] as View[]) : []),
    ...(hasReconciliation ? (["reconciliation"] as View[]) : []),
    ...(hasLibraryChecks ? (["library"] as View[]) : []),
  ];
  const tabs: View[] = [...PRIMARY_REVIEW_VIEWS, ...advancedViews];

  const tabCount = (tab: View): number | null => {
    if (tab === "duplicates") return counts.duplicates;
    if (tab === "junk") return counts.junk;
    if (tab === "changes") return counts.changes;
    if (tab === "warnings") return counts.warnings;
    return null;
  };

  const showFiles = useCallback(
    (statuses: PreviewItem["status"][]) => {
      setStatusFilter(statuses);
      onSelectView("changes");
    },
    [onSelectView],
  );

  // Comparison acts on the two members the user is choosing between: the
  // current keeper, and the first copy that is not it and not protected.
  const comparePair = useMemo((): { a: GroupMember; b: GroupMember; keeperId: string } | null => {
    if (!comparing) return null;
    const { group, plan } = comparing;
    const keeperId =
      plan?.keeper_member_id ?? group.anchor_member_id ?? group.members[0]?.member_id ?? null;
    const a = group.members.find((member) => member.member_id === keeperId);
    const b = group.members.find(
      (member) => member.member_id !== keeperId && member.role !== "reference",
    );
    return a && b && keeperId ? { a, b, keeperId } : null;
  }, [comparing]);

  const decideFromCompare = async (memberId: string) => {
    if (!comparing) return;
    await api.decideReview({
      groupId: comparing.group.group_id,
      memberId,
      action: "replace_keeper",
    });
    setComparing(null);
  };

  const keepBothFromCompare = async () => {
    if (!comparing) return;
    await api.quarantineAllExcept(
      comparing.group.group_id,
      comparing.group.members.map((member) => member.member_id),
    );
    setComparing(null);
  };

  return (
    <div className="space-y-5">
      <div>
        <ScreenHeader title={t("review.title")} subtitle={t("review.subtitle")} />
        <PlanSummary
          totals={totals}
          sizeLabel={formatBytes(result.impact.required_bytes, { locale })}
          rootCount={rootCount}
          onOpen={onSelectView}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-[17rem_minmax(0,1fr)]">
        <div className="lg:sticky lg:top-4 lg:self-start">
          <DestinationTree root={tree} />
        </div>

        <div className="min-w-0 space-y-3">
          <nav aria-label={t("view.navigation")} className="-mx-1 overflow-x-auto px-1 pb-1">
            <ul className="flex min-w-max gap-1">
              {tabs.map((tab) => {
                const active = view === tab;
                const count = tabCount(tab);
                return (
                  <li key={tab}>
                    <button
                      type="button"
                      aria-current={active ? "page" : undefined}
                      onClick={() => {
                        setStatusFilter(null);
                        onSelectView(tab);
                      }}
                      className={cn(
                        "rounded-lg px-3.5 py-1.5 text-xs transition-colors",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active
                          ? "border border-border bg-card font-semibold text-foreground shadow-card"
                          : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      )}
                    >
                      {t(`view.${tab}`)}
                      {count !== null && count > 0 && (
                        <span
                          className={cn(
                            "ml-1.5 font-semibold",
                            tab === "warnings" ? "text-warning" : "text-primary",
                          )}
                        >
                          {count.toLocaleString(locale)}
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>

          <Suspense fallback={<StateView variant="loading" layout="page" title={t("state.loading")} />}>
            {view === "duplicates" && (
              <DuplicatesTab
                defaultPolicy={config.duplicate_keeper_policy}
                onCompare={(group, plan) => setComparing({ group, plan })}
              />
            )}

            {view === "junk" && <JunkTab items={result.items} onOpenSetting={onOpenSetting} />}

            {view === "changes" && (
              <PreviewPanel
                result={
                  statusFilter
                    ? {
                        ...result,
                        items: result.items.filter((item) =>
                          statusFilter.includes(item.status),
                        ),
                      }
                    : result
                }
                loading={false}
                error={null}
                onRetry={onRerunPreview}
                copyInsteadOfMove={config.copy_instead_of_move}
                categorizeEnabled={config.categorize_enabled}
                sortCriteria={config.sort_criteria ?? ["year", "month"]}
              />
            )}

            {view === "warnings" && (
              <WarningsTab
                warnings={warnings}
                onShowFiles={showFiles}
                onOpenSetting={onOpenSetting}
              />
            )}

            {view === "bursts" && inputRoot && (
              <BurstReviewPanel
                root={inputRoot.path}
                items={result.items}
                enabled={config.burst_detection_enabled}
              />
            )}

            {view === "reconciliation" && (
              <DestinationReconciliationPanel items={result.items} />
            )}

            {view === "library" && destinationRoot?.path && (
              <LibraryAuditPanel root={destinationRoot.path} />
            )}
          </Suspense>
        </div>
      </div>

      {comparePair && (
        <CompareModal
          a={comparePair.a}
          b={comparePair.b}
          keeperId={comparePair.keeperId}
          onKeep={(memberId) => void decideFromCompare(memberId)}
          onKeepBoth={() => void keepBothFromCompare()}
          onClose={() => setComparing(null)}
        />
      )}
    </div>
  );
}
