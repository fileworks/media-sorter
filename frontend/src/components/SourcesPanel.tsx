/**
 * The Sources stage: one card per folder, each stating what it is *for*.
 *
 * The role is the important control on this screen — it decides whether a folder
 * can be written to at all — so it is a labelled radio group rather than a
 * dropdown, and every conflict names both folders involved instead of saying
 * "invalid configuration".
 */

import { useMemo, useState } from "react";
import {
  FiArrowDown,
  FiArrowUp,
  FiCheck,
  FiClipboard,
  FiEye,
  FiEyeOff,
  FiFolder,
  FiMapPin,
  FiPlus,
} from "react-icons/fi";

import { RecipeChooser } from "@/components/RecipeChooser";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useI18n } from "@/i18n/I18nContext";
import type { Config } from "@/types/api";
import {
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  activeCards,
  blockingConflicts,
  cardStatus,
  changeRole,
  excludeForRun,
  reorder,
  sourcesReadiness,
  validateRoots,
  type Conflict,
  type RootCard,
  type RootRole,
} from "@/lib/sourcesStage";

const ROLES: RootRole[] = ["input", "reference", "destination"];

const TONE_CLASS = {
  ready: "text-success",
  warning: "text-warning",
  error: "text-error",
} as const;

type Translate = ReturnType<typeof useI18n>["t"];

interface SourcesPanelProps {
  cards: RootCard[];
  excludedForRun?: string[];
  onChange: (cards: RootCard[]) => void;
  onExcludeForRun?: (excluded: string[]) => void;
  onPickFolder?: () => void;
  onRemap?: (rootId: string) => void;
  config?: Config;
  onApplyConfig?: (patch: Partial<Config>) => void;
}

function ConflictList({ conflicts, t }: { conflicts: Conflict[]; t: Translate }) {
  if (conflicts.length === 0) return null;
  return (
    <ul className="space-y-2" role="list">
      {conflicts.map((conflict) => (
        <li
          key={`${conflict.kind}:${conflict.rootIds.join("-")}`}
          className={`rounded-lg border p-3 text-xs ${
            conflict.blocking ? "border-error/40 bg-error/5" : "border-warning/40 bg-warning/5"
          }`}
        >
          <div role={conflict.blocking ? "alert" : "status"}>
            <p className="text-foreground">
              {t(`sources.conflict.${conflict.kind}`, conflict.params, conflict.message)}
            </p>
            {conflict.remedy && (
              <p className="mt-1 text-muted-foreground">
                {t(`sources.conflict.${conflict.kind}.remedy`, conflict.params, conflict.remedy)}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

function LocationCard({
  card,
  conflicts,
  onRole,
  onMove,
  onExclude,
  onRemap,
  excluded,
  canMoveEarlier,
  canMoveLater,
  t,
}: {
  card: RootCard;
  conflicts: Conflict[];
  onRole: (role: RootRole) => void;
  onMove: (direction: -1 | 1) => void;
  onExclude: (() => void) | undefined;
  onRemap: (() => void) | undefined;
  excluded: boolean;
  canMoveEarlier: boolean;
  canMoveLater: boolean;
  t: Translate;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "error">("idle");
  const status = cardStatus(card, conflicts);
  const ownConflict = conflicts.find((conflict) => conflict.rootIds.includes(card.rootId));
  const statusLabel =
    status.label === "Conflict"
      ? t("sources.status.conflict")
      : status.label === "Check this"
        ? t("sources.status.check")
        : status.label === "Not checked"
          ? t("sources.status.notChecked")
          : t("sources.status.ready");
  const statusDetail = ownConflict
    ? t(`sources.conflict.${ownConflict.kind}`, ownConflict.params, ownConflict.message)
    : card.state === "unknown"
      ? t("sources.status.notScanned")
      : t("sources.status.indexed", {
          count: card.indexedFiles ?? 0,
          freshness: t(`sources.freshness.${card.freshness}`),
        });
  const offline = card.state === "offline" || card.state === "unreadable";
  const copyPath = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(card.path);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 1800);
    } catch {
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 2400);
    }
  };

  return (
    <li
      className={`rounded-xl border bg-card p-4 shadow-sm transition-opacity ${
        status.tone === "error" ? "border-error/50" : "border-border"
      } ${excluded ? "opacity-50" : ""}`}
    >
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <FiFolder className="h-4 w-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-foreground" title={card.path}>
              {card.displayName ?? card.path}
            </p>
            <p className="truncate text-xs text-muted-foreground" title={card.path}>
              {card.path}
              {card.volume && ` · ${card.volume}`}
            </p>
            <p className={`mt-1.5 flex items-start gap-1.5 text-xs ${TONE_CLASS[status.tone]}`}>
              <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-current" aria-hidden />
              <span>
                {statusLabel} — {statusDetail}
              </span>
            </p>
          </div>
          {card.exclusions.length > 0 && (
            <p className="mt-1 text-2xs text-muted-foreground">
              {t("sources.excludedSubfolders", { count: card.exclusions.length })}
            </p>
          )}
        </div>

        <div className="flex shrink-0 flex-col gap-2 xl:items-end">
          <fieldset
            className="flex w-full gap-1 rounded-lg bg-muted p-1 xl:w-auto"
            aria-label={t("sources.roleFor", { path: card.path })}
          >
            {ROLES.map((role) => (
              <label
                key={role}
                title={t(`sources.role.${role}.description`, undefined, ROLE_DESCRIPTION[role])}
                className={`flex-1 cursor-pointer rounded-md px-2.5 py-1.5 text-center text-xs font-medium transition-colors xl:flex-none ${
                  card.role === role
                    ? "bg-card text-primary shadow-sm"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                <input
                  type="radio"
                  className="sr-only"
                  name={`role-${card.rootId}`}
                  checked={card.role === role}
                  onChange={() => onRole(role)}
                />
                {t(`sources.role.${role}`, undefined, ROLE_LABEL[role])}
              </label>
            ))}
          </fieldset>
          <div className="flex flex-wrap items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onMove(-1)}
              disabled={!canMoveEarlier}
              aria-label={t("sources.moveEarlier", { path: card.path })}
              title={t("sources.moveEarlier", { path: card.path })}
              className="h-8 w-8"
            >
              <FiArrowUp className="h-3.5 w-3.5" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onMove(1)}
              disabled={!canMoveLater}
              aria-label={t("sources.moveLater", { path: card.path })}
              title={t("sources.moveLater", { path: card.path })}
              className="h-8 w-8"
            >
              <FiArrowDown className="h-3.5 w-3.5" aria-hidden />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void copyPath()}
              className={copyState === "error" ? "text-error" : "text-muted-foreground"}
            >
              {copyState === "copied" ? (
                <FiCheck className="h-3.5 w-3.5" aria-hidden />
              ) : (
                <FiClipboard className="h-3.5 w-3.5" aria-hidden />
              )}
              {copyState === "copied"
                ? t("sources.pathCopied")
                : copyState === "error"
                  ? t("sources.copyFailed")
                  : t("sources.copyPath")}
            </Button>
            {offline && onRemap && (
              <Button variant="ghost" size="sm" onClick={onRemap}>
                <FiMapPin className="h-3.5 w-3.5" aria-hidden />
                {t("sources.locate")}
              </Button>
            )}
            {onExclude && (
              <Button variant="ghost" size="sm" onClick={onExclude}>
                {excluded ? (
                  <FiEye className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <FiEyeOff className="h-3.5 w-3.5" aria-hidden />
                )}
                {t(excluded ? "sources.includeNextRun" : "sources.skipRun")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </li>
  );
}

export function SourcesPanel({
  cards,
  excludedForRun = [],
  onChange,
  onExcludeForRun,
  onPickFolder,
  onRemap,
  config,
  onApplyConfig,
}: SourcesPanelProps) {
  const { t } = useI18n();
  const [pendingRole, setPendingRole] = useState<{ rootId: string; role: RootRole } | null>(null);

  const active = useMemo(() => activeCards(cards, excludedForRun), [cards, excludedForRun]);
  const conflicts = useMemo(() => validateRoots(active), [active]);
  const readiness = useMemo(() => sourcesReadiness(active), [active]);

  // A role change that would introduce a blocking conflict is previewed rather
  // than applied: the user gets to see what it breaks before it breaks.
  const preview = pendingRole ? changeRole(cards, pendingRole.rootId, pendingRole.role) : null;
  const previewBlocking = preview ? blockingConflicts(preview.conflicts) : [];

  return (
    <section className="space-y-4">
      {config && onApplyConfig && <RecipeChooser config={config} onApply={onApplyConfig} />}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">{t("sources.title")}</h2>
          <p className="text-xs text-muted-foreground">{t("sources.description")}</p>
        </div>
        {onPickFolder && (
          <Button variant="outline" size="sm" onClick={onPickFolder}>
            <FiPlus className="h-3.5 w-3.5" aria-hidden />
            {t("sources.addFolder")}
          </Button>
        )}
      </header>

      {cards.length === 0 ? (
        <Card className="border-dashed shadow-none">
          <CardContent className="flex flex-col items-center py-10 text-center">
            <span className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
              <FiFolder className="h-5 w-5" aria-hidden />
            </span>
            <p className="text-sm text-muted-foreground">{t("sources.empty")}</p>
          </CardContent>
        </Card>
      ) : (
        <ul className="space-y-2">
          {[...cards]
            .sort((a, b) => a.priority - b.priority)
            .map((card, index, sortedCards) => (
              <LocationCard
                key={card.rootId}
                card={card}
                conflicts={conflicts}
                excluded={excludedForRun.includes(card.rootId)}
                canMoveEarlier={index > 0}
                canMoveLater={index < sortedCards.length - 1}
                onRole={(role) => setPendingRole({ rootId: card.rootId, role })}
                onMove={(direction) => onChange(reorder(cards, card.rootId, direction))}
                onExclude={
                  onExcludeForRun
                    ? () =>
                        onExcludeForRun(
                          excludedForRun.includes(card.rootId)
                            ? excludedForRun.filter((id) => id !== card.rootId)
                            : excludeForRun(excludedForRun, card.rootId),
                        )
                    : undefined
                }
                onRemap={onRemap ? () => onRemap(card.rootId) : undefined}
                t={t}
              />
            ))}
        </ul>
      )}

      {preview && (
        <div className="rounded-lg border border-border p-3 text-xs" role="status">
          {previewBlocking.length === 0 ? (
            <p className="text-foreground">
              {t("sources.roleChangeSafe", {
                role: t(
                  `sources.role.${pendingRole!.role}`,
                  undefined,
                  ROLE_LABEL[pendingRole!.role],
                ).toLocaleLowerCase(),
              })}
            </p>
          ) : (
            <>
              <p className="text-error">{t("sources.roleChangeConflict")}</p>
              <ul className="mt-1 space-y-1 text-muted-foreground">
                {previewBlocking.map((conflict) => (
                  <li key={conflict.kind}>{conflict.message}</li>
                ))}
              </ul>
            </>
          )}
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              onClick={() => {
                onChange(preview.cards);
                setPendingRole(null);
              }}
              className="rounded-lg border border-border px-3 py-1 hover:border-primary"
            >
              {t("common.apply")}
            </button>
            <button
              type="button"
              onClick={() => setPendingRole(null)}
              className="rounded-lg border border-border px-3 py-1"
            >
              {t("common.cancel")}
            </button>
          </div>
        </div>
      )}

      <ConflictList conflicts={conflicts} t={t} />

      <p
        className={`text-sm ${readiness.ready ? "text-success" : "text-muted-foreground"}`}
        role="status"
      >
        {readiness.ready
          ? t("sources.ready")
          : (() => {
              const conflict = conflicts.find((item) => item.blocking);
              return conflict
                ? t(`sources.conflict.${conflict.kind}`, conflict.params, conflict.message)
                : readiness.reason;
            })()}
      </p>
    </section>
  );
}
