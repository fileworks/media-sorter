/**
 * The duplicate review workbench: a virtualized group list beside an inspector.
 *
 * The list never holds more rows than fit on screen, the keeper stays pinned
 * while its group is compared, and every row states its concrete outcome in
 * plain language. Reference members are visible, labelled, and unactionable —
 * they are why a keeper can exist without anything being moved at all.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { MediaModal } from "@/components/MediaModal";
import { MediaPreviewModal } from "@/components/MediaPreviewModal";
import { StateView } from "@/components/StateView";
import { useVirtualWindow } from "@/hooks/useVirtualWindow";
import { useI18n } from "@/i18n/I18nContext";
import { openSingle, type ModalState } from "@/lib/mediaModal";
import { formatBytesShort } from "@/lib/optimizationProjection";
import { getBasename } from "@/lib/pathUtils";
import {
  availableActions,
  bulkImpactView,
  deserializeUiState,
  factLabel,
  factTitle,
  filterKey,
  filterRows,
  groupRow,
  nextUnresolved,
  outcomeLabel,
  outcomeTone,
  resolutionLabel,
  serializeUiState,
  REVIEW_STATE_KEY,
  type BulkImpact,
  type DuplicateGroup,
  type GroupMember,
  type GroupPlan,
  type ReviewFilters,
} from "@/lib/reviewWorkbench";
import { api } from "@/services/api";
import type { PreviewItem } from "@/types/api";

const ROW_HEIGHT = 64;
const LIST_HEIGHT = 520;

const TONE_CLASS = {
  neutral: "text-muted-foreground",
  warning: "text-warning",
  danger: "text-error",
} as const;

type Translate = ReturnType<typeof useI18n>["t"];

function MemberRow({
  member,
  group,
  plan,
  onDecide,
  onExplain,
  explainLabel,
  busy,
  t,
}: {
  member: GroupMember;
  group: DuplicateGroup;
  plan: GroupPlan | undefined;
  onDecide: (memberId: string, action: string) => void;
  onExplain?: (origin: HTMLButtonElement) => void;
  explainLabel: string;
  busy: boolean;
  t: Translate;
}) {
  const outcome = plan?.outcomes.find((item) => item.member_id === member.member_id);
  const isKeeper = plan?.keeper_member_id === member.member_id;
  const actions = availableActions(member, group, plan);

  return (
    <li
      className={`rounded-lg border p-3 ${
        isKeeper ? "border-primary" : "border-border"
      } ${member.role === "reference" ? "bg-muted/30" : ""}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm text-foreground">
            {getBasename(member.relative_path)}
            {isKeeper && (
              <span className="ml-2 rounded bg-primary/10 px-2 py-0.5 text-[11px] text-primary">
                {t("review.keeper")}
              </span>
            )}
            {member.role === "reference" && (
              <span className="ml-2 rounded bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {t("review.referenceProtected")}
              </span>
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">{member.observed_path}</p>
          <dl className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
            <span>{formatBytesShort(member.facts.size_bytes)}</span>
            <span title={factTitle(member.facts.width)}>{resolutionLabel(member.facts)}</span>
            <span title={factTitle(member.facts.captured_at)}>
              {t("review.taken", { value: factLabel(member.facts.captured_at) })}
            </span>
            <span>{t("review.confidence", { value: member.evidence.confidence })}</span>
            {member.evidence.distance !== null && (
              <span>{t("review.distance", { value: member.evidence.distance })}</span>
            )}
          </dl>
          {outcome && (
            <p className={`mt-1 text-xs ${TONE_CLASS[outcomeTone(outcome)]}`}>
              {outcomeLabel(outcome)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {onExplain && (
            <button
              type="button"
              onClick={(event) => onExplain(event.currentTarget)}
              className="rounded-lg border border-border px-2 py-1 text-xs hover:border-primary"
            >
              {explainLabel}
            </button>
          )}
          {actions.map((action) => (
            <button
              key={action.action}
              type="button"
              disabled={!action.enabled || busy}
              title={
                action.disabledReason
                  ? t("review.referenceImmutable", undefined, action.disabledReason)
                  : undefined
              }
              onClick={() => onDecide(member.member_id, action.action)}
              className="rounded-lg border border-border px-2 py-1 text-xs hover:border-primary disabled:opacity-40"
            >
              {t(`review.action.${action.action}`, undefined, action.label)}
            </button>
          ))}
        </div>
      </div>
    </li>
  );
}

export function ReviewWorkbench({
  kindFilter,
  items = [],
}: {
  kindFilter?: "exact" | "similar";
  items?: PreviewItem[];
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const restored = useMemo(
    () =>
      deserializeUiState(
        typeof localStorage === "undefined" ? null : localStorage.getItem(REVIEW_STATE_KEY),
      ),
    [],
  );
  const [filters, setFilters] = useState<ReviewFilters>(restored.filters);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(restored.selectedGroupId);
  const [impact, setImpact] = useState<BulkImpact | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [outcomeItem, setOutcomeItem] = useState<PreviewItem | null>(null);
  const originFocusRef = useRef<HTMLElement | null>(null);
  const previewBySource = useMemo(
    () => new Map(items.map((item) => [item.source, item])),
    [items],
  );

  const kind = kindFilter ?? (filters.kind === "similar" ? "similar" : "exact");
  const { data, isLoading } = useQuery({
    queryKey: ["review", "groups", kind],
    queryFn: () => api.listReviewGroups(kind, { limit: 200 }),
  });

  const groups = useMemo(() => (data?.groups ?? []) as DuplicateGroup[], [data]);
  const [plans, setPlans] = useState<Record<string, GroupPlan>>({});
  const selected = groups.find((group) => group.group_id === selectedGroupId) ?? null;

  const rows = useMemo(
    () => groups.map((group) => groupRow(group, plans[group.group_id])),
    [groups, plans],
  );
  const visible = useMemo(() => filterRows(rows, filters), [rows, filters]);
  const windowing = useVirtualWindow({
    count: visible.length,
    estimateSize: ROW_HEIGHT,
    maxHeight: LIST_HEIGHT,
    anchorKey: selectedGroupId,
  });
  const generation = groups[0]?.catalog_generation ?? 0;
  const scopeKey = filterKey(filters, generation);

  useEffect(() => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(
      REVIEW_STATE_KEY,
      serializeUiState({
        filters,
        selectedGroupId,
        scrollTop: windowing.scrollTop,
        view: kind,
      }),
    );
  }, [filters, selectedGroupId, windowing.scrollTop, kind]);

  // A changed scope invalidates any pending bulk preview: it no longer
  // describes the set the user is looking at.
  useEffect(() => setImpact(null), [scopeKey]);

  const decide = useMutation({
    mutationFn: (input: { groupId: string; memberId: string; action: string }) =>
      api.decideReview(input),
    onSuccess: (plan) => setPlans((current) => ({ ...current, [plan.group_id]: plan })),
  });

  const applyPolicy = useMutation({
    mutationFn: (frozen: BulkImpact) =>
      api.applyPolicy({ scope: frozen.scope, impact: frozen, filterKey: scopeKey }),
    onSuccess: () => {
      setImpact(null);
      void queryClient.invalidateQueries({ queryKey: ["review", "groups"] });
    },
  });

  const goNextUnresolved = useCallback(() => {
    const next = nextUnresolved(visible, selectedGroupId);
    if (next) setSelectedGroupId(next);
  }, [visible, selectedGroupId]);

  const goPrevious = useCallback(() => {
    if (visible.length === 0) return;
    const current = visible.findIndex((row) => row.groupId === selectedGroupId);
    const previous = current <= 0 ? visible.length - 1 : current - 1;
    setSelectedGroupId(visible[previous].groupId);
  }, [visible, selectedGroupId]);

  const previewSelected = useCallback(() => {
    if (!selected || selected.members.length === 0) return;
    originFocusRef.current = document.activeElement as HTMLElement | null;
    const order = selected.members.map((member) => member.member_id);
    setModal(
      openSingle(selected.members[0].member_id, {
        origin: selected.kind,
        order,
        restore: {
          selectionId: selected.group_id,
          scrollTop: windowing.scrollTop,
          focusId: selected.group_id,
        },
      }),
    );
  }, [selected, windowing.scrollTop]);

  const undoSelected = useCallback(() => {
    if (!selectedGroupId) return;
    void api
      .undoReview(selectedGroupId)
      .then((plan) => setPlans((current) => ({ ...current, [plan.group_id]: plan })));
  }, [selectedGroupId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target?.matches("input, textarea, select, [role='textbox']")
      ) {
        return;
      }
      if (event.key === "?") {
        event.preventDefault();
        setShortcutsOpen((open) => !open);
        return;
      }
      if (!event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        goNextUnresolved();
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        goPrevious();
      } else if (event.key.toLowerCase() === "p") {
        event.preventDefault();
        previewSelected();
      } else if (event.key.toLowerCase() === "z") {
        event.preventDefault();
        undoSelected();
      } else if (event.key === "Enter" && selected) {
        const memberId = selected.anchor_member_id ?? selected.members[0]?.member_id;
        if (memberId) {
          event.preventDefault();
          decide.mutate({
            groupId: selected.group_id,
            memberId,
            action: "replace_keeper",
          });
        }
      } else if (/^[1-9]$/.test(event.key) && selected) {
        const member = selected.members[Number(event.key) - 1];
        if (member) {
          event.preventDefault();
          decide.mutate({
            groupId: selected.group_id,
            memberId: member.member_id,
            action: "replace_keeper",
          });
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [decide, goNextUnresolved, goPrevious, previewSelected, selected, undoSelected]);

  const selectedPlan = selectedGroupId ? plans[selectedGroupId] : undefined;
  const impactView = impact ? bulkImpactView(impact, scopeKey) : null;

  return (
    <section className="grid gap-4 lg:grid-cols-[minmax(0,360px)_minmax(0,1fr)]">
      <div className="space-y-3">
        <div className="flex flex-wrap gap-2">
          {!kindFilter &&
            (["all", "exact", "similar"] as const).map((value) => (
              <button
                key={value}
                type="button"
                aria-pressed={filters.kind === value}
                onClick={() => setFilters({ ...filters, kind: value })}
                className={`rounded-lg border px-3 py-1 text-xs ${
                  filters.kind === value ? "border-primary text-primary" : "border-border"
                }`}
              >
                {t(`review.filter.${value}`)}
              </button>
            ))}
          <button
            type="button"
            onClick={() =>
              setFilters({
                ...filters,
                state: filters.state === "unresolved" ? "all" : "unresolved",
              })
            }
            aria-pressed={filters.state === "unresolved"}
            className={`rounded-lg border px-3 py-1 text-xs ${
              filters.state === "unresolved" ? "border-primary text-primary" : "border-border"
            }`}
          >
            {t("review.unresolvedOnly")}
          </button>
        </div>

        <label className="block">
          <span className="sr-only">{t("review.searchLabel")}</span>
          <input
            type="search"
            value={filters.search}
            onChange={(event) => setFilters({ ...filters, search: event.target.value })}
            placeholder={t("review.search")}
            className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
          />
        </label>

        <div
          ref={windowing.scrollRef}
          tabIndex={0}
          onScroll={windowing.onScroll}
          className="overflow-auto rounded-lg border border-border"
          style={{ height: LIST_HEIGHT }}
        >
          {isLoading ? (
            <StateView
              variant="loading"
              compact
              title={t("review.loading")}
            />
          ) : visible.length === 0 ? (
            <StateView
              variant="empty"
              compact
              title={t("review.empty")}
              detail={t("review.emptyHelp")}
            />
          ) : (
            <div
              role="listbox"
              aria-label={t("review.groupsLabel")}
              style={{ height: windowing.totalSize, position: "relative" }}
            >
              {windowing.virtualItems.map((virtualRow) => {
                const row = visible[virtualRow.index];
                return (
                  <button
                    key={row.groupId}
                    type="button"
                    role="option"
                    aria-selected={row.groupId === selectedGroupId}
                    onClick={() => setSelectedGroupId(row.groupId)}
                    style={{
                      height: ROW_HEIGHT,
                      position: "absolute",
                      top: virtualRow.start,
                      left: 0,
                      right: 0,
                    }}
                    className={`flex w-full flex-col justify-center border-b border-border px-3 text-left ${
                      row.groupId === selectedGroupId ? "bg-primary/5" : ""
                    }`}
                  >
                    <span className="truncate text-sm text-foreground">
                      {getBasename(row.representativePath)}
                    </span>
                    <span className="truncate text-[11px] text-muted-foreground">
                      {t(`review.kind.${row.kind}`)} ·{" "}
                      {t("review.fileCount", { count: row.memberCount })} ·{" "}
                      {t("review.reclaimable", {
                        bytes: formatBytesShort(row.potentialBytes),
                      })}
                      {row.hasReference && ` · ${t("review.hasReference")}`}
                      {row.state === "stale" && ` · ${t("review.needsReview")}`}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={goPrevious}
            className="rounded-lg border border-border px-3 py-1 text-xs hover:border-primary"
          >
            {t("review.previous")} (Alt+↑)
          </button>
          <button
            type="button"
            onClick={goNextUnresolved}
            className="rounded-lg border border-border px-3 py-1 text-xs hover:border-primary"
          >
            {t("review.next")} (Alt+↓)
          </button>
          <button
            type="button"
            disabled={!selected}
            onClick={previewSelected}
            className="rounded-lg border border-border px-3 py-1 text-xs hover:border-primary disabled:opacity-40"
          >
            {t("review.preview")} (Alt+P)
          </button>
          <button
            type="button"
            onClick={() => setShortcutsOpen((open) => !open)}
            aria-expanded={shortcutsOpen}
            className="rounded-lg border border-border px-3 py-1 text-xs hover:border-primary"
          >
            {t("review.shortcuts")} (?)
          </button>
          <button
            type="button"
            onClick={() =>
              api
                .previewPolicy({ scope: "all_unresolved_exact", filterKey: scopeKey })
                .then(setImpact)
            }
            className="rounded-lg border border-border px-3 py-1 text-xs hover:border-primary"
          >
            {t("review.previewPolicy")}
          </button>
        </div>

        {shortcutsOpen && (
          <div
            className="rounded-lg border border-border p-3 text-xs"
            role="region"
            aria-label={t("review.shortcuts")}
          >
            <p className="font-medium text-foreground">
              {t("review.shortcuts")}
            </p>
            <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
              <dt>Alt+↑ / Alt+↓</dt>
              <dd>{t("review.shortcut.groups")}</dd>
              <dt>Alt+1…9</dt>
              <dd>{t("review.shortcut.keeper")}</dd>
              <dt>Alt+P</dt>
              <dd>{t("review.preview")}</dd>
              <dt>Alt+Enter</dt>
              <dd>{t("review.shortcut.confirm")}</dd>
              <dt>Alt+Z</dt>
              <dd>
                {t("review.shortcut.undo")}
              </dd>
              <dt>?</dt>
              <dd>{t("review.shortcut.reference")}</dd>
            </dl>
          </div>
        )}

        {impactView && (
          <div
            className={`rounded-lg border p-3 text-xs ${
              impactView.invalidated ? "border-warning/50 bg-warning/5" : "border-border"
            }`}
            role="status"
          >
            <p className="font-medium text-foreground">{impactView.headline}</p>
            <ul className="mt-1 space-y-1 text-muted-foreground">
              {impactView.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            {impactView.requiresAcknowledgement && !impactView.invalidated && (
              <label className="mt-2 flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                {t("review.acknowledgeInputChanges")}
              </label>
            )}
            <button
              type="button"
              disabled={
                impactView.invalidated ||
                applyPolicy.isPending ||
                (impactView.requiresAcknowledgement && !acknowledged)
              }
              onClick={() => impact && applyPolicy.mutate(impact)}
              className="mt-2 rounded-lg border border-border px-3 py-1 hover:border-primary disabled:opacity-40"
            >
              {t("review.applyPolicy")}
            </button>
          </div>
        )}
      </div>

      <div className="min-w-0">
        {selected === null ? (
          <p className="text-sm text-muted-foreground">
            {t("review.selectGroup")}
          </p>
        ) : (
          <div className="space-y-3">
            <header>
              <h2 className="text-base font-semibold text-foreground">
                {t(
                  selected.kind === "exact"
                    ? "review.identicalFiles"
                    : "review.similarFiles",
                )}
              </h2>
              <p className="text-xs text-muted-foreground">{selected.evidence_summary}</p>
              {selectedPlan?.stale_reason && (
                <p className="mt-1 text-xs text-warning">
                  {t("review.stalePlan", { reason: selectedPlan.stale_reason })}
                </p>
              )}
            </header>
            <ul className="space-y-2">
              {selected.members.map((member) => (
                <MemberRow
                  key={member.member_id}
                  member={member}
                  group={selected}
                  plan={selectedPlan}
                  busy={decide.isPending}
                  onDecide={(memberId, action) =>
                    decide.mutate({ groupId: selected.group_id, memberId, action })
                  }
                  onExplain={
                    previewBySource.has(member.observed_path)
                      ? (origin) => {
                          originFocusRef.current = origin;
                          setOutcomeItem(previewBySource.get(member.observed_path) ?? null);
                        }
                      : undefined
                  }
                  explainLabel={t("review.explainOutcome")}
                  t={t}
                />
              ))}
            </ul>
            <button
              type="button"
              onClick={undoSelected}
              className="rounded-lg border border-border px-3 py-1 text-xs hover:border-primary"
            >
              {t("review.undo")} (Alt+Z)
            </button>
          </div>
        )}
      </div>

      {modal && selected && (
        <MediaModal
          state={modal}
          resolve={(id) => {
            const member = selected.members.find((candidate) => candidate.member_id === id);
            return member ? { id, path: member.observed_path, available: true } : null;
          }}
          onChange={setModal}
          onClose={() => {
            setModal(null);
            requestAnimationFrame(() => originFocusRef.current?.focus());
          }}
        />
      )}
      {outcomeItem && (
        <MediaPreviewModal
          item={outcomeItem}
          items={items}
          onClose={() => {
            setOutcomeItem(null);
            requestAnimationFrame(() => originFocusRef.current?.focus());
          }}
        />
      )}
    </section>
  );
}
