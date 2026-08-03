/**
 * Screen 1 — where the media is, and what each folder is *for*.
 *
 * The three roles are three columns rather than a radio group on every card,
 * because the role is the consequential choice on this screen: a reference
 * folder is never written to, a destination always is, and reading that off the
 * layout is faster and harder to misread than reading it off a control.
 *
 * Changing a role is still possible — from the card's own menu — and still
 * previews its conflicts before it applies, because "I put that in the wrong
 * column" must not require deleting and re-adding a folder.
 */

import { useMemo, useState } from "react";
import type { IconType } from "react-icons";
import {
  FiCheck,
  FiClipboard,
  FiEye,
  FiEyeOff,
  FiFolder,
  FiMapPin,
  FiPlus,
  FiX,
} from "react-icons/fi";

import { ScreenHeader } from "@/components/screens/ScreenHeader";
import { RecipeGrid } from "@/components/screens/RecipeGrid";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/I18nContext";
import { formatBytes } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import {
  ROLE_DESCRIPTION,
  ROLE_LABEL,
  activeCards,
  blockingConflicts,
  cardStatus,
  changeRole,
  excludeForRun,
  validateRoots,
  type Conflict,
  type RootCard,
  type RootRole,
} from "@/lib/sourcesStage";
import type { AnalysisResult, Config, SavedRecipe } from "@/types/api";

const ROLE_BADGE: Record<RootRole, string> = {
  input: "bg-tint-primary text-primary",
  reference: "bg-muted text-muted-foreground",
  destination: "bg-tint-success text-success",
};

type Translate = ReturnType<typeof useI18n>["t"];

interface SourcesScreenProps {
  cards: RootCard[];
  excludedForRun: string[];
  analysis: AnalysisResult | null;
  config: Config;
  savedRecipes: SavedRecipe[];
  disabled?: boolean;
  onChange: (cards: RootCard[]) => void;
  onExcludeForRun: (excluded: string[]) => void;
  onAddFolder: (role: RootRole) => void;
  onChangeFolder: (rootId: string) => void;
  onRemove: (rootId: string) => void;
  onRemap?: (rootId: string) => void;
  onApplyConfig: (patch: Partial<Config>) => void;
  /** A computed plan exists, so applying a recipe discards it. */
  planExists?: boolean;
  onDeleteRecipe: (recipeId: string) => void;
}

/** The two or three lines of figures under a card's path. */
function cardFacts(
  card: RootCard,
  analysis: AnalysisResult | null,
  primaryInput: boolean,
  copyMode: boolean,
  t: Translate,
  locale: string,
): string[] {
  if (card.role === "destination") {
    const disk = analysis?.disk_space;
    if (!disk) return [t("sources.facts.destinationUnscanned")];
    const lines: string[] = [];
    if (disk.free_space_known === false) {
      lines.push(t("sources.facts.freeUnknown"));
    } else {
      lines.push(
        t(copyMode ? "sources.facts.freeCopy" : "sources.facts.freeMove", {
          free: formatBytes(disk.destination_free_bytes, { locale }),
          needed: formatBytes(disk.source_size_bytes, { locale }),
        }),
      );
    }
    lines.push(t("sources.facts.moveNeedsNothing"));
    return lines;
  }

  if (card.role === "reference") {
    return [
      card.indexedFiles === null
        ? t("sources.facts.referenceUnscanned")
        : t("sources.facts.referenceIndexed", {
            count: card.indexedFiles.toLocaleString(locale),
          }),
      t("sources.facts.referencePurpose"),
    ];
  }

  // Input. The scan reports one aggregate, not a per-root split, so the totals
  // belong to the first input card and the rest state only what they indexed.
  if (!analysis) return [t("sources.facts.inputUnscanned")];
  if (!primaryInput) {
    return card.indexedFiles === null
      ? [t("sources.facts.inputUnscanned")]
      : [t("sources.facts.indexed", { count: card.indexedFiles.toLocaleString(locale) })];
  }
  const byType = analysis.by_type ?? {};
  const kinds = Object.entries(byType)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([kind, count]) => `${kind} ${count.toLocaleString(locale)}`)
    .join(" · ");
  return [
    t("sources.facts.inputTotals", {
      count: analysis.total_files.toLocaleString(locale),
      size: formatBytes(analysis.total_size_bytes, { locale }),
    }),
    kinds,
  ].filter(Boolean);
}

function FolderCard({
  card,
  facts,
  conflicts,
  excluded,
  disabled,
  onToggleBaseline,
  onChangeFolder,
  onRemove,
  onToggleExcluded,
  onRemap,
  t,
}: {
  card: RootCard;
  facts: string[];
  conflicts: Conflict[];
  excluded: boolean;
  disabled: boolean;
  /** Absent on the destination, which cannot be a baseline. */
  onToggleBaseline: ((baseline: boolean) => void) | undefined;
  onChangeFolder: () => void;
  onRemove: (() => void) | undefined;
  onToggleExcluded: (() => void) | undefined;
  onRemap: (() => void) | undefined;
  t: Translate;
}) {
  const [copied, setCopied] = useState(false);
  const status = cardStatus(card, conflicts);
  const ownConflict = conflicts.find((conflict) => conflict.rootIds.includes(card.rootId));
  const offline = card.state === "offline" || card.state === "unreadable";

  const copyPath = async () => {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(card.path);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      // Copying a path is a convenience; failing at it is not worth a toast.
    }
  };

  return (
    <li
      className={cn(
        "rounded-xl border bg-card p-4",
        status.tone === "error" ? "border-error/50" : "border-border",
        excluded && "opacity-55",
      )}
    >
      <p className="truncate text-sm font-semibold text-foreground" title={card.path}>
        {card.displayName ?? card.path.split(/[\\/]/).filter(Boolean).pop() ?? card.path}
      </p>
      <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={card.path}>
        {card.path}
      </p>

      <div className="mt-2.5 space-y-0.5 text-xs text-muted-foreground">
        {facts.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>

      {ownConflict && (
        <p
          className={cn("mt-2 text-xs", ownConflict.blocking ? "text-error" : "text-warning")}
          role={ownConflict.blocking ? "alert" : "status"}
        >
          {t(`sources.conflict.${ownConflict.kind}`, ownConflict.params, ownConflict.message)}
        </p>
      )}
      {excluded && <p className="mt-2 text-xs text-warning">{t("sources.excludedThisRun")}</p>}

      <div className="mt-3.5 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={onChangeFolder}
          disabled={disabled}
          className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {t("sources.change")}
        </button>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            disabled={disabled}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {t("sources.remove")}
          </button>
        )}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
        {onToggleBaseline && (
          <label className="flex min-w-0 items-start gap-2 py-1">
            <input
              type="checkbox"
              checked={card.role === "reference"}
              disabled={disabled}
              onChange={(event) => onToggleBaseline(event.target.checked)}
              className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-foreground">
                {t("sources.baseline")}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t("sources.baselineHelp")}
              </span>
            </span>
          </label>
        )}

        <span className="flex-1" />

        <IconButton
          label={copied ? t("sources.pathCopied") : t("sources.copyPath")}
          onClick={() => void copyPath()}
          icon={copied ? FiCheck : FiClipboard}
        />
        {onToggleExcluded && (
          <IconButton
            label={t(excluded ? "sources.includeNextRun" : "sources.skipRun")}
            disabled={disabled}
            onClick={onToggleExcluded}
            icon={excluded ? FiEye : FiEyeOff}
          />
        )}
        {offline && onRemap && (
          <IconButton label={t("sources.locate")} onClick={onRemap} icon={FiMapPin} />
        )}
      </div>
    </li>
  );
}

function IconButton({
  label,
  icon: Icon,
  onClick,
  disabled = false,
}: {
  label: string;
  icon: IconType;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className="flex h-8 w-8 items-center justify-center rounded-lg text-faint transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
      </button>
    </Tooltip>
  );
}

export function SourcesScreen({
  cards,
  excludedForRun,
  analysis,
  config,
  savedRecipes,
  disabled = false,
  onChange,
  onExcludeForRun,
  onAddFolder,
  onChangeFolder,
  onRemove,
  onRemap,
  onApplyConfig,
  planExists = false,
  onDeleteRecipe,
}: SourcesScreenProps) {
  const { t, locale } = useI18n();
  const [pendingRole, setPendingRole] = useState<{ rootId: string; role: RootRole } | null>(null);

  const active = useMemo(() => activeCards(cards, excludedForRun), [cards, excludedForRun]);
  const conflicts = useMemo(() => validateRoots(active), [active]);

  // Inputs and baselines are one list: a baseline is an input folder that is
  // only ever compared against, which is a property of the folder, not a
  // separate place to put one.
  const inputs = useMemo(() => cards.filter((card) => card.role !== "destination"), [cards]);
  const destination = useMemo(
    () => cards.find((card) => card.role === "destination") ?? null,
    [cards],
  );

  // Turning a folder into a baseline can introduce a blocking conflict, so it
  // is previewed rather than applied behind the user's back.
  const preview = pendingRole ? changeRole(cards, pendingRole.rootId, pendingRole.role) : null;
  const previewBlocking = preview ? blockingConflicts(preview.conflicts) : [];

  const requestRole = (rootId: string, role: RootRole) => {
    const attempt = changeRole(cards, rootId, role);
    if (blockingConflicts(attempt.conflicts).length > 0) {
      setPendingRole({ rootId, role });
      return;
    }
    onChange(attempt.cards);
  };

  const globalConflicts = conflicts.filter((conflict) => conflict.rootIds.length === 0);

  const cardFor = (card: RootCard, isDestination: boolean) => (
    <FolderCard
      key={card.rootId}
      card={card}
      facts={cardFacts(card, analysis, false, config.copy_instead_of_move, t, locale)}
      conflicts={conflicts}
      excluded={excludedForRun.includes(card.rootId)}
      disabled={disabled}
      onToggleBaseline={
        isDestination
          ? undefined
          : (baseline) => requestRole(card.rootId, baseline ? "reference" : "input")
      }
      onChangeFolder={() => onChangeFolder(card.rootId)}
      onRemove={isDestination ? undefined : () => onRemove(card.rootId)}
      onToggleExcluded={
        isDestination
          ? undefined
          : () =>
              onExcludeForRun(
                excludedForRun.includes(card.rootId)
                  ? excludedForRun.filter((id) => id !== card.rootId)
                  : excludeForRun(excludedForRun, card.rootId),
              )
      }
      onRemap={onRemap ? () => onRemap(card.rootId) : undefined}
      t={t}
    />
  );

  return (
    <div className="space-y-7">
      <div>
        <ScreenHeader title={t("sources.title")} subtitle={t("sources.description")} />

        <div className="grid gap-4 lg:grid-cols-2">
          <section aria-labelledby="sources-inputs" className="min-w-0">
            <div className="mb-2.5 flex items-center gap-2">
              <span
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-lg",
                  ROLE_BADGE.input,
                )}
                aria-hidden
              >
                <FiFolder className="h-3.5 w-3.5" />
              </span>
              <h2
                id="sources-inputs"
                className="text-3xs font-semibold uppercase tracking-[0.08em] text-faint"
              >
                {t("sources.inputFolders")}
              </h2>
            </div>

            {inputs.length === 0 ? (
              <button
                type="button"
                onClick={() => onAddFolder("input")}
                disabled={disabled}
                className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-center transition-colors hover:border-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FiFolder className="h-5 w-5 text-faint" aria-hidden />
                <span className="text-xs font-medium text-foreground">
                  {t("sources.empty.input")}
                </span>
                <span className="text-xs text-faint">
                  {t("sources.role.input.description", undefined, ROLE_DESCRIPTION.input)}
                </span>
              </button>
            ) : (
              <ul className="space-y-2.5">{inputs.map((card) => cardFor(card, false))}</ul>
            )}

            <button
              type="button"
              onClick={() => onAddFolder("input")}
              disabled={disabled}
              className="mt-2.5 inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              <FiPlus className="h-3.5 w-3.5" aria-hidden />
              {t("sources.addFolder")}
            </button>
          </section>

          <section aria-labelledby="sources-destination" className="min-w-0">
            <div className="mb-2.5 flex items-center gap-2">
              <span
                className={cn(
                  "flex h-6 w-6 items-center justify-center rounded-lg",
                  ROLE_BADGE.destination,
                )}
                aria-hidden
              >
                <FiFolder className="h-3.5 w-3.5" />
              </span>
              <h2
                id="sources-destination"
                className="text-3xs font-semibold uppercase tracking-[0.08em] text-faint"
              >
                {t("sources.role.destination", undefined, ROLE_LABEL.destination)}
              </h2>
            </div>

            {destination === null ? (
              <button
                type="button"
                onClick={() => onAddFolder("destination")}
                disabled={disabled}
                className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-center transition-colors hover:border-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                <FiFolder className="h-5 w-5 text-faint" aria-hidden />
                <span className="text-xs font-medium text-foreground">
                  {t("sources.empty.destination")}
                </span>
                <span className="text-xs text-faint">
                  {t(
                    "sources.role.destination.description",
                    undefined,
                    ROLE_DESCRIPTION.destination,
                  )}
                </span>
              </button>
            ) : (
              <ul className="space-y-2.5">{cardFor(destination, true)}</ul>
            )}
          </section>
        </div>

        {/* The live region sits inside each item, not on it: a `listitem` may
            not also be an `alert`, and moving the role inward keeps both the
            list semantics and the announcement. */}
        {globalConflicts.length > 0 && (
          <ul className="mt-4 space-y-2">
            {globalConflicts.map((conflict) => (
              <li key={conflict.kind}>
                <div
                  className={cn(
                    "rounded-xl border p-3 text-xs",
                    conflict.blocking
                      ? "border-error/40 bg-tint-error"
                      : "border-warning/40 bg-tint-warning",
                  )}
                  role={conflict.blocking ? "alert" : "status"}
                >
                  <p className="text-foreground">
                    {t(`sources.conflict.${conflict.kind}`, conflict.params, conflict.message)}
                  </p>
                  {conflict.remedy && (
                    <p className="mt-0.5 text-muted-foreground">
                      {t(
                        `sources.conflict.${conflict.kind}.remedy`,
                        conflict.params,
                        conflict.remedy,
                      )}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}

        {preview && pendingRole && (
          <div className="mt-4 rounded-xl border border-error/40 bg-tint-error p-3.5" role="alert">
            <div className="flex items-start gap-2">
              <p className="min-w-0 flex-1 text-xs font-semibold text-error">
                {t("sources.roleChangeConflict")}
              </p>
              <button
                type="button"
                onClick={() => setPendingRole(null)}
                aria-label={t("common.cancel")}
                className="shrink-0 rounded p-0.5 text-faint hover:text-foreground"
              >
                <FiX className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
            <ul className="mt-1.5 space-y-1 text-xs text-foreground">
              {previewBlocking.map((conflict) => (
                <li key={conflict.kind}>
                  {t(`sources.conflict.${conflict.kind}`, conflict.params, conflict.message)}
                </li>
              ))}
            </ul>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => {
                  onChange(preview.cards);
                  setPendingRole(null);
                }}
                className="rounded-lg border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted"
              >
                {t("sources.roleChangeAnyway")}
              </button>
              <button
                type="button"
                onClick={() => setPendingRole(null)}
                className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted"
              >
                {t("common.cancel")}
              </button>
            </div>
          </div>
        )}
      </div>

      <RecipeGrid
        config={config}
        savedRecipes={savedRecipes}
        onApply={onApplyConfig}
        planExists={planExists}
        onDelete={onDeleteRecipe}
        disabled={disabled}
      />
    </div>
  );
}
