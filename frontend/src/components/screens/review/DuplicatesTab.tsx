/**
 * Duplicate groups, as cards or as a list.
 *
 * The rule bar at the top is the whole ergonomic argument of this screen: most
 * groups are decided correctly by one rule, so the user sets that rule once and
 * spends their attention only on the handful the rule was wrong about. Applying
 * it in bulk shows what it would touch before it touches anything, and refuses
 * to run against a set that has changed since the preview.
 *
 * Members from a reference root are drawn, labelled and unactionable. That is
 * not a disabled control — the backend refuses the decision too. The UI says so
 * because a protection nobody can see is a protection nobody trusts.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FiSearch } from "react-icons/fi";

import { CompareIcon, ReferenceLockIcon } from "@/components/icons";
import { StateView } from "@/components/StateView";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { Select, SelectItem } from "@/components/ui/select";
import { Segmented } from "@/components/ui/setting-row";
import { Thumbnail } from "@/components/ui/thumbnail";
import { useReviewGroups } from "@/hooks/useReviewGroups";
import { useI18n } from "@/i18n/I18nContext";
import { formatBytes } from "@/lib/formatters";
import { getBasename } from "@/lib/pathUtils";
import { cn } from "@/lib/utils";
import {
  factLabel,
  filterKey,
  groupRow,
  resolutionLabel,
  type BulkImpact,
  type DuplicateGroup,
  type GroupMember,
  type GroupPlan,
} from "@/lib/reviewWorkbench";
import { api } from "@/services/api";
import { SELECTABLE_KEEPER_POLICIES, type KeeperPolicyId } from "@/types/api";

type ViewMode = "cards" | "list";
type Scope = "unresolved" | "all" | "resolved" | "near";

interface DuplicatesTabProps {
  defaultPolicy: KeeperPolicyId;
  onCompare: (group: DuplicateGroup, plan: GroupPlan | undefined) => void;
}

/** The member a group is currently keeping, whether by rule or by hand. */
function keeperIdOf(group: DuplicateGroup, plan: GroupPlan | undefined): string | null {
  return plan?.keeper_member_id ?? group.anchor_member_id ?? group.members[0]?.member_id ?? null;
}

function MemberCard({
  member,
  isKeeper,
  locale,
  onOpen,
  t,
}: {
  member: GroupMember;
  isKeeper: boolean;
  locale: string;
  onOpen: () => void;
  t: (key: string, params?: Record<string, string | number>, fallback?: string) => string;
}) {
  const isReference = member.role === "reference";
  return (
    <li
      className={cn(
        "relative overflow-hidden rounded-lg",
        isReference
          ? "border-[1.5px] border-dashed border-success"
          : isKeeper
            ? "border-2 border-success"
            : // "Set aside" is said by the badge and the plain border; dimming
              // the whole card said it a third time and dropped its text under
              // 4.5:1 while doing so. Only the picture recedes.
              "border border-border [&_img]:opacity-70",
      )}
    >
      <span
        className={cn(
          "absolute left-2 top-2 z-10 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-3xs font-bold",
          // The tint/ink pair every other badge in the app uses. A solid green
          // with white on it reads at 3:1 against the lighter dark-mode green.
          isReference || isKeeper
            ? "bg-tint-success text-success"
            : "bg-muted text-muted-foreground",
        )}
      >
        {isReference && <ReferenceLockIcon className="h-2.5 w-2.5" />}
        {isReference
          ? t("review.badge.reference")
          : isKeeper
            ? t("review.badge.keep")
            : t("review.badge.setAside")}
      </span>

      <Thumbnail
        path={member.observed_path}
        className="h-[6.5rem] w-full"
        onOpen={onOpen}
        openLabel={t("preview.openFile", { name: getBasename(member.relative_path) })}
      />

      <div className="bg-card px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        <p className={cn("truncate", isKeeper && "font-semibold text-foreground")}>
          {getBasename(member.relative_path)}
        </p>
        <p>
          {factLabel(member.facts.captured_at)} · {formatBytes(member.facts.size_bytes, { locale })}
        </p>
        <p className="truncate">{resolutionLabel(member.facts)}</p>
      </div>
    </li>
  );
}

export function DuplicatesTab({ defaultPolicy, onCompare }: DuplicatesTabProps) {
  const { t, locale } = useI18n();
  const queryClient = useQueryClient();

  const [view, setView] = useState<ViewMode>("cards");
  const [scope, setScope] = useState<Scope>("unresolved");
  const [search, setSearch] = useState("");
  const [policy, setPolicy] = useState<KeeperPolicyId>(defaultPolicy);
  const [plans, setPlans] = useState<Record<string, GroupPlan>>({});
  const [impact, setImpact] = useState<BulkImpact | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lightbox, setLightbox] = useState<GroupMember | null>(null);

  // The configured default is the starting point, not a lock: picking a rule
  // here is explicitly a per-run override that never edits the recipe.
  useEffect(() => setPolicy(defaultPolicy), [defaultPolicy]);

  const { groups, isLoading: loading, isError: failed, refetch } = useReviewGroups(plans);
  const generation = groups[0]?.catalog_generation ?? 0;
  const scopeKey = filterKey(
    { kind: "all", state: "all", search, minBytes: 0, withReferencesOnly: false },
    generation,
  );

  // A changed scope invalidates a pending bulk preview: it no longer describes
  // the set the user is looking at.
  useEffect(() => setImpact(null), [scopeKey, policy]);

  const rows = useMemo(
    () => groups.map((group) => groupRow(group, plans[group.group_id])),
    [groups, plans],
  );
  const unresolvedCount = rows.filter((row) => row.state === "unresolved").length;
  const nearCount = groups.filter((group) => group.kind === "similar").length;
  const resolvedCount = rows.filter((row) => row.state === "reviewed").length;

  const needle = search.trim().toLowerCase();
  const visible = useMemo(
    () =>
      groups.filter((group) => {
        const plan = plans[group.group_id];
        const state = plan?.state ?? "unresolved";
        if (scope === "unresolved" && state !== "unresolved" && state !== "stale") return false;
        if (scope === "resolved" && state !== "reviewed") return false;
        if (scope === "near" && group.kind !== "similar") return false;
        if (!needle) return true;
        return group.members.some((member) =>
          member.relative_path.toLowerCase().includes(needle),
        );
      }),
    [groups, needle, plans, scope],
  );

  const decide = useMutation({
    mutationFn: (input: { groupId: string; memberId: string; action: string }) =>
      api.decideReview(input),
    onSuccess: (plan) => setPlans((current) => ({ ...current, [plan.group_id]: plan })),
    onError: () => setError(t("review.decideFailed")),
  });

  const keepAll = useMutation({
    mutationFn: (group: DuplicateGroup) =>
      api.quarantineAllExcept(
        group.group_id,
        group.members.map((member) => member.member_id),
      ),
    onSuccess: (plan) => setPlans((current) => ({ ...current, [plan.group_id]: plan })),
    onError: () => setError(t("review.decideFailed")),
  });

  const previewBulk = useMutation({
    mutationFn: () =>
      api.previewPolicy({ scope: "all_unresolved_exact", policyId: policy, filterKey: scopeKey }),
    onSuccess: (result) => {
      setError(null);
      setImpact(result);
    },
    onError: () => setError(t("review.bulkPreviewFailed")),
  });

  const applyBulk = useMutation({
    mutationFn: (frozen: BulkImpact) =>
      api.applyPolicy({
        scope: frozen.scope,
        impact: frozen,
        policyId: policy,
        filterKey: scopeKey,
      }),
    onSuccess: () => {
      setImpact(null);
      setPlans({});
      void queryClient.invalidateQueries({ queryKey: ["review", "groups"] });
    },
    onError: () => setError(t("review.bulkApplyFailed")),
  });

  const setGroupPolicy = useCallback(
    (group: DuplicateGroup, nextPolicy: KeeperPolicyId) => {
      void api
        .previewPolicy({
          scope: "selected_groups",
          groupIds: [group.group_id],
          policyId: nextPolicy,
          filterKey: scopeKey,
        })
        .then((frozen) =>
          api.applyPolicy({
            scope: "selected_groups",
            impact: frozen,
            groupIds: [group.group_id],
            policyId: nextPolicy,
            filterKey: scopeKey,
          }),
        )
        .then(() => queryClient.invalidateQueries({ queryKey: ["review", "groups"] }))
        .catch(() => setError(t("review.decideFailed")));
    },
    [queryClient, scopeKey, t],
  );

  const busy = decide.isPending || applyBulk.isPending || keepAll.isPending;

  const SCOPES: { id: Scope; label: string }[] = [
    { id: "unresolved", label: t("review.scope.unresolved", { count: unresolvedCount }) },
    { id: "all", label: t("review.scope.all") },
    { id: "near", label: t("review.scope.near", { count: nearCount }) },
    { id: "resolved", label: t("review.scope.resolved", { count: resolvedCount }) },
  ];

  return (
    <div className="space-y-3">
      {/* Toolbar: how it is shown, and what is shown. */}
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          name="duplicate-view"
          label={t("review.viewMode")}
          value={view}
          options={[
            { value: "cards", label: t("review.view.cards") },
            { value: "list", label: t("review.view.list") },
          ]}
          onChange={setView}
        />
        <label className="flex min-w-[12rem] flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3 py-1.5 sm:max-w-xs">
          <FiSearch className="h-3.5 w-3.5 shrink-0 text-faint" aria-hidden />
          <span className="sr-only">{t("review.searchLabel")}</span>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t("review.search")}
            className="min-w-0 flex-1 bg-transparent text-xs placeholder:text-faint focus-visible:outline-none"
          />
        </label>
      </div>

      {/* The rule bar: the rule and its action on one line, the note under it,
          the scope filter on the right once the window is wide enough to hold
          both — otherwise it wraps to its own line instead of squeezing the
          action button to nothing. */}
      <div className="flex flex-col gap-2.5 rounded-xl border border-border bg-card px-4 py-3 lg:flex-row lg:items-start">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-foreground">{t("review.keepRule")}</span>
            <Select
              size="sm"
              value={policy}
              aria-label={t("review.keepRule")}
              onValueChange={(value) => setPolicy(value as KeeperPolicyId)}
            >
              {SELECTABLE_KEEPER_POLICIES.map((option) => (
                <SelectItem key={option} value={option}>
                  {t(`config.keeper.${option}`)}
                </SelectItem>
              ))}
            </Select>
            <button
              type="button"
              disabled={unresolvedCount === 0 || previewBulk.isPending || busy}
              onClick={() => previewBulk.mutate()}
              className="rounded-lg bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
            >
              {t("review.applyToUnresolved", { count: unresolvedCount })}
            </button>
          </div>
          <p className="text-xs text-faint">{t("review.keepRuleNote")}</p>
        </div>

        <ul className="flex shrink-0 flex-wrap gap-1">
          {SCOPES.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                aria-pressed={scope === entry.id}
                onClick={() => setScope(entry.id)}
                className={cn(
                  "rounded-full px-2.5 py-1 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  scope === entry.id
                    ? "bg-muted font-semibold text-foreground"
                    : "text-faint hover:text-foreground",
                )}
              >
                {entry.label}
              </button>
            </li>
          ))}
        </ul>
      </div>

      {/* What the bulk rule would do, before it does it. */}
      {impact && (
        <div className="rounded-xl border border-border bg-card px-4 py-3" role="status">
          <p className="text-xs font-semibold text-foreground">
            {t("review.bulk.headline", {
              groups: impact.matched_groups.toLocaleString(locale),
              files: impact.matched_members.toLocaleString(locale),
            })}
          </p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {t("review.bulk.detail", {
              size: formatBytes(impact.quarantine_bytes, { locale }),
            })}
          </p>
          {impact.source_mutations > 0 && (
            <p className="mt-0.5 text-xs text-warning">
              {t("review.bulk.sourceMutations", {
                count: impact.source_mutations.toLocaleString(locale),
              })}
            </p>
          )}
          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={() => applyBulk.mutate(impact)}
              disabled={applyBulk.isPending}
              className="rounded-lg bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground disabled:opacity-50"
            >
              {t("review.bulk.confirm")}
            </button>
            <button
              type="button"
              onClick={() => setImpact(null)}
              className="rounded-lg px-3.5 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-error/40 bg-tint-error px-4 py-2.5" role="alert">
          <p className="text-xs text-error">{error}</p>
        </div>
      )}

      {loading ? (
        <StateView variant="loading" title={t("review.loading")} />
      ) : failed ? (
        <StateView
          variant="error"
          title={t("review.loadFailed")}
          onRetry={refetch}
        />
      ) : visible.length === 0 ? (
        <StateView variant="empty" title={t("review.empty")} detail={t("review.emptyHelp")} />
      ) : view === "cards" ? (
        <ul className="space-y-3">
          {visible.map((group) => {
            const plan = plans[group.group_id];
            const keeperId = keeperIdOf(group, plan);
            const hasReference = group.members.some((member) => member.role === "reference");
            return (
              <li
                key={group.group_id}
                className="rounded-xl border border-border bg-card px-4 py-4"
              >
                <div className="mb-3 flex flex-wrap items-center gap-2.5">
                  <span className="text-xs font-bold text-foreground">
                    {t("review.copiesOf", {
                      count: group.member_count,
                      name: getBasename(
                        group.members.find((m) => m.member_id === keeperId)?.relative_path ?? "",
                      ),
                    })}
                  </span>
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-3xs font-semibold",
                      group.kind === "similar"
                        ? "bg-tint-warning text-warning"
                        : "bg-tint-success text-success",
                    )}
                  >
                    {t(`review.kindBadge.${group.kind}`)}
                  </span>
                  {hasReference && (
                    <span className="inline-flex items-center gap-1 rounded-full bg-tint-success px-2 py-0.5 text-3xs font-semibold text-success">
                      <ReferenceLockIcon className="h-2.5 w-2.5" />
                      {t("review.alreadyInLibrary")}
                    </span>
                  )}

                  <span className="flex-1" />

                  {hasReference ? (
                    <span className="text-xs text-faint">{t("review.referenceWins")}</span>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => onCompare(group, plan)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <CompareIcon className="h-3 w-3" />
                        {t("review.compare")}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => keepAll.mutate(group)}
                        className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                      >
                        {t("review.notDuplicates")}
                      </button>
                      <Select
                        size="sm"
                        value=""
                        disabled={busy}
                        aria-label={t("review.groupKeepRule", { name: group.group_id })}
                        onValueChange={(value) => {
                          // The control is a menu, not a stored choice: it fires
                          // an action and snaps back to its prompt.
                          if (value) setGroupPolicy(group, value as KeeperPolicyId);
                        }}
                      >
                        <SelectItem value="">{t("review.chooseKeeper")}</SelectItem>
                        {SELECTABLE_KEEPER_POLICIES.map((option) => (
                          <SelectItem key={option} value={option}>
                            {t(`config.keeper.${option}`)}
                          </SelectItem>
                        ))}
                      </Select>
                    </>
                  )}
                </div>

                <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {group.members.map((member) => (
                    <MemberCard
                      key={member.member_id}
                      member={member}
                      isKeeper={member.member_id === keeperId}
                      locale={locale}
                      onOpen={() => setLightbox(member)}
                      t={t}
                    />
                  ))}
                </ul>

                {hasReference && (
                  <p className="mt-2.5 text-xs leading-relaxed text-faint">
                    {t("review.referenceExplain")}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[54rem] text-xs">
            <thead>
              <tr className="border-b border-border text-3xs uppercase tracking-[0.07em] text-faint">
                <th scope="col" className="px-4 py-2.5 text-left font-semibold">
                  {t("review.column.keep")}
                </th>
                <th scope="col" className="px-4 py-2.5 text-left font-semibold">
                  {t("review.column.file")}
                </th>
                <th scope="col" className="px-4 py-2.5 text-left font-semibold">
                  {t("review.column.location")}
                </th>
                <th scope="col" className="px-4 py-2.5 text-left font-semibold">
                  {t("review.column.date")}
                </th>
                <th scope="col" className="px-4 py-2.5 text-left font-semibold">
                  {t("review.column.size")}
                </th>
                <th scope="col" className="px-4 py-2.5 text-left font-semibold">
                  {t("review.column.resolution")}
                </th>
                <th scope="col" className="px-4 py-2.5 text-left font-semibold">
                  {t("review.column.outcome")}
                </th>
              </tr>
            </thead>
            {visible.map((group) => {
              const plan = plans[group.group_id];
              const keeperId = keeperIdOf(group, plan);
              return (
                <tbody key={group.group_id}>
                  <tr className="border-b border-border bg-muted">
                    <th
                      scope="colgroup"
                      colSpan={7}
                      className="px-4 py-2 text-left text-xs font-bold text-foreground"
                    >
                      {t("review.copiesOf", {
                        count: group.member_count,
                        name: getBasename(
                          group.members.find((m) => m.member_id === keeperId)?.relative_path ?? "",
                        ),
                      })}
                      <span className="ml-2 font-medium text-faint">
                        {t(`review.kindBadge.${group.kind}`)}
                      </span>
                    </th>
                  </tr>
                  {group.members.map((member) => {
                    const isKeeper = member.member_id === keeperId;
                    const isReference = member.role === "reference";
                    return (
                      <tr
                        key={member.member_id}
                        className={cn(
                          "border-b border-border",
                          isReference && "bg-tint-success",
                        )}
                      >
                        <td className="px-4 py-2">
                          {isReference ? (
                            <ReferenceLockIcon
                              className="h-3 w-3 text-success"
                              aria-label={t("review.badge.reference")}
                            />
                          ) : (
                            <label className="inline-flex">
                              <span className="sr-only">
                                {t("review.keepThis", {
                                  name: getBasename(member.relative_path),
                                })}
                              </span>
                              <input
                                type="radio"
                                name={`keeper-${group.group_id}`}
                                checked={isKeeper}
                                disabled={busy}
                                onChange={() =>
                                  decide.mutate({
                                    groupId: group.group_id,
                                    memberId: member.member_id,
                                    action: "replace_keeper",
                                  })
                                }
                              />
                            </label>
                          )}
                        </td>
                        <td className="max-w-[16rem] truncate px-4 py-2 font-mono text-foreground">
                          {getBasename(member.relative_path)}
                        </td>
                        <td className="max-w-[14rem] truncate px-4 py-2 font-mono text-faint">
                          {member.relative_path}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">
                          {factLabel(member.facts.captured_at)}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">
                          {formatBytes(member.facts.size_bytes, { locale })}
                        </td>
                        <td className="px-4 py-2 text-muted-foreground">
                          {resolutionLabel(member.facts)}
                        </td>
                        <td className="px-4 py-2">
                          {isReference ? (
                            <span className="font-semibold text-success">
                              {t("review.outcome.reference")}
                            </span>
                          ) : isKeeper ? (
                            <span className="font-bold text-success">
                              {t("review.outcome.keep")}
                            </span>
                          ) : (
                            <span className="text-faint">{t("review.outcome.setAside")}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              );
            })}
          </table>
        </div>
      )}

      {lightbox && (
        <ImageLightbox
          src={api.thumbnailUrl(lightbox.observed_path, 1600)}
          title={getBasename(lightbox.relative_path)}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}
