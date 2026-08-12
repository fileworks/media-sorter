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

import { useMemo, useState, type ReactNode } from "react";
import type { IconType } from "react-icons";
import {
  FiCheck,
  FiClipboard,
  FiEye,
  FiEyeOff,
  FiFolder,
  FiInfo,
  FiMapPin,
  FiPlus,
  FiX,
} from "react-icons/fi";

import { ScreenHeader } from "@/components/screens/ScreenHeader";
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
import type { AnalysisResult, Config } from "@/types/api";

const ROLE_BADGE: Record<RootRole, string> = {
  input: "bg-tint-primary text-primary",
  reference: "bg-tint-info text-info",
  destination: "bg-tint-success text-success",
};

type Translate = ReturnType<typeof useI18n>["t"];

interface SourcesScreenProps {
  cards: RootCard[];
  excludedForRun: string[];
  analysis: AnalysisResult | null;
  config: Config;
  disabled?: boolean;
  onChange: (cards: RootCard[]) => void;
  onExcludeForRun: (excluded: string[]) => void;
  onAddFolder: (role: RootRole) => void;
  onChangeFolder: (rootId: string) => void;
  onRemove: (rootId: string) => void;
  onRemap?: (rootId: string) => void;
}

function factLines(
  card: RootCard,
  analysis: AnalysisResult | null,
  primaryInput: boolean,
  copyMode: boolean,
  t: Translate,
  locale: string,
): string[] {
  if (card.role === "destination") {
    const disk = analysis?.disk_space;
    // Both lines, not one: the second is true before a scan as well, and a card
    // that states one fact where its neighbour states two is the card whose
    // buttons sit a line higher than everything beside it.
    if (!disk) {
      return [t("sources.facts.destinationUnscanned"), t("sources.facts.moveNeedsNothing")];
    }
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
  //
  // The unscanned card names the scan rather than describing its own emptiness.
  // Counting the media here instead was asked for and declined: over the drives
  // this is built for, a recursive walk is minutes, and the scan already
  // produces the figure.
  const unscanned = [t("sources.facts.inputUnscanned"), t("sources.facts.scanToCount")];
  if (!analysis) return unscanned;
  if (!primaryInput) {
    return card.indexedFiles === null
      ? unscanned
      : [
          t("sources.facts.indexed", { count: card.indexedFiles.toLocaleString(locale) }),
          t("sources.facts.inputPurpose"),
        ];
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
    kinds || t("sources.facts.inputPurpose"),
  ];
}

function FolderCard({
  card,
  facts,
  conflicts,
  excluded,
  disabled,
  rolePanel,
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
  /** The role-change conflict panel, when this card is the one being changed. */
  rolePanel: ReactNode;
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
    <li>
      <div
        className={cn(
          "grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-3 rounded-xl border bg-card p-3",
          "sm:grid-cols-[2.5rem_minmax(0,1fr)_auto]",
          status.tone === "error" ? "border-error/50" : "border-border",
          card.role === "reference" && "border-info/25 bg-tint-info/40",
          card.role === "destination" && "border-success/25 bg-tint-success/30",
          // The chip carries the state in words. Dimming the whole card made
          // every fact and control fail contrast in a real browser, so use a
          // structural treatment that leaves its contents fully readable.
          excluded && "border-dashed bg-surface-muted",
        )}
      >
        <span
          className={cn(
            "flex h-10 w-10 items-center justify-center rounded-lg",
            ROLE_BADGE[card.role],
          )}
          aria-hidden
        >
          <FiFolder className="h-[1.125rem] w-[1.125rem]" />
        </span>
        <div className="min-w-0">
          <div className="flex h-5 min-w-0 items-center gap-1.5">
            <p
              className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground"
              title={card.path}
            >
              {card.displayName ?? card.path.split(/[\\/]/).filter(Boolean).pop() ?? card.path}
            </p>
            {excluded && (
              <span className="shrink-0 rounded-full border border-warning/40 bg-tint-warning px-2 py-0.5 text-3xs font-semibold leading-none text-warning">
                {t("sources.excludedThisRun")}
              </span>
            )}
            {ownConflict && (
              <span
                className={cn(
                  "shrink-0 rounded-full border px-2 py-0.5 text-3xs font-semibold leading-none",
                  ownConflict.blocking
                    ? "border-error/40 bg-tint-error text-error"
                    : "border-warning/40 bg-tint-warning text-warning",
                )}
              >
                {t("sources.conflictChip")}
              </span>
            )}
          </div>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={card.path}>
            {card.path}
          </p>

          {/* One line, not a stack of paragraphs. A folder card is an entry in a
            list of three to five, and the previous layout spent a full screen
            on two of them by giving each fact, each button and the baseline
            toggle's restated description a row of its own. */}
          <p className="mt-1 truncate text-xs text-muted-foreground" title={facts.join(" · ")}>
            {facts.map((line) => line.replace(/\.$/, "")).join(" · ")}
          </p>

          {/* A conflict needs the sentence a chip cannot carry, so that one card
            grows. Ordinary and merely skipped cards spend no row on absence. */}
          {ownConflict && (
            <p
              className={cn("mt-1.5 text-xs", ownConflict.blocking ? "text-error" : "text-warning")}
              role={ownConflict.blocking ? "alert" : "status"}
            >
              {t(`sources.conflict.${ownConflict.kind}`, ownConflict.params, ownConflict.message)}
            </p>
          )}
        </div>

        {/* Below `sm` the card is two columns, so the controls take a row of
            their own rather than tucking under the folder icon. */}
        <div className="col-span-2 flex shrink-0 flex-wrap items-center justify-end gap-1 sm:col-span-1">
          {/* The section this card sits in already says what a baseline is for,
              so the toggle needs the word and not the explanation. */}
          {onToggleBaseline && (
            <label className="mr-1 flex cursor-pointer items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
              <input
                type="checkbox"
                checked={card.role === "reference"}
                disabled={disabled}
                onChange={(event) => onToggleBaseline(event.target.checked)}
                className="h-3.5 w-3.5 shrink-0 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              {t("sources.baseline")}
            </label>
          )}
          <button
            type="button"
            onClick={onChangeFolder}
            disabled={disabled}
            className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {t("sources.change")}
          </button>
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              disabled={disabled}
              className="rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {t("sources.remove")}
            </button>
          )}
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
      </div>

      {/* Attached to the card whose role was changed rather than to the foot of
          the page: an explanation of a conflict a screenful away from the
          control that caused it is one the reader has to go looking for. */}
      {rolePanel}
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
  disabled = false,
  onChange,
  onExcludeForRun,
  onAddFolder,
  onChangeFolder,
  onRemove,
  onRemap,
}: SourcesScreenProps) {
  const { t, locale } = useI18n();
  const [pendingRole, setPendingRole] = useState<{ rootId: string; role: RootRole } | null>(null);

  const active = useMemo(() => activeCards(cards, excludedForRun), [cards, excludedForRun]);
  const conflicts = useMemo(() => validateRoots(active), [active]);

  const inputs = useMemo(() => cards.filter((card) => card.role === "input"), [cards]);
  const references = useMemo(() => cards.filter((card) => card.role === "reference"), [cards]);
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

  /**
   * The conflicts worth a callout — which does not include having added nothing
   * yet.
   *
   * `no_input` and `no_destination` still gate the stage, but on a screen the
   * user has only just opened they are not faults: the empty dropzone already
   * asks for the folder, and the footer already says which one is missing.
   * Rendering them as red alerts greeted a first run with two errors it had
   * done nothing to earn, and said the same sentence a third and fourth time.
   */
  const globalConflicts = conflicts.filter(
    (conflict) =>
      conflict.rootIds.length === 0 &&
      conflict.kind !== "no_input" &&
      conflict.kind !== "no_destination",
  );

  const rolePanelFor = (rootId: string): ReactNode => {
    if (!preview || !pendingRole || pendingRole.rootId !== rootId) return null;
    return (
      <div className="mt-2 rounded-xl border border-error/40 bg-tint-error p-3.5" role="alert">
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
    );
  };

  const cardFor = (card: RootCard, isDestination: boolean) => (
    <FolderCard
      key={card.rootId}
      card={card}
      facts={factLines(card, analysis, false, config.copy_instead_of_move, t, locale)}
      conflicts={conflicts}
      excluded={excludedForRun.includes(card.rootId)}
      disabled={disabled}
      rolePanel={rolePanelFor(card.rootId)}
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
        <ScreenHeader
          eyebrow={t("stage.position", { current: 1, total: 6 })}
          title={t("sources.title")}
          subtitle={t("sources.description")}
        />

        <div className="space-y-5">
          <section aria-labelledby="sources-inputs" className="min-w-0">
            <div className="mb-2 flex items-end gap-2">
              <div>
                <h2
                  id="sources-inputs"
                  className="text-3xs font-bold uppercase tracking-[0.09em] text-faint"
                >
                  {t("sources.inputFolders")}
                </h2>
                <p className="mt-0.5 text-3xs text-faint">
                  {t("sources.role.input.description", undefined, ROLE_DESCRIPTION.input)}
                </p>
              </div>
              <span className="flex-1" />
              {inputs.length > 0 && (
                <button
                  type="button"
                  onClick={() => onAddFolder("input")}
                  disabled={disabled}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  <FiPlus className="h-3.5 w-3.5" aria-hidden />
                  {t("sources.addFolder")}
                </button>
              )}
            </div>

            {inputs.length === 0 ? (
              <button
                type="button"
                onClick={() => onAddFolder("input")}
                disabled={disabled}
                className="flex w-full flex-col items-center gap-2 rounded-xl border border-dashed border-border px-4 py-8 text-center transition-colors hover:border-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              >
                {/* The section heading immediately above already says what an
                    input folder is for; the dropzone only has to offer the
                    action. It used to repeat that sentence word for word. */}
                <FiFolder className="h-5 w-5 text-faint" aria-hidden />
                <span className="text-xs font-medium text-foreground">
                  {t("sources.empty.input")}
                </span>
              </button>
            ) : (
              <ul className="space-y-2.5">{inputs.map((card) => cardFor(card, false))}</ul>
            )}
          </section>

          {references.length > 0 && (
            <section aria-labelledby="sources-references" className="min-w-0">
              <div className="mb-2 flex items-end gap-2">
                <div>
                  <h2
                    id="sources-references"
                    className="text-3xs font-bold uppercase tracking-[0.09em] text-faint"
                  >
                    {t("sources.baseline")}
                  </h2>
                  <p className="mt-0.5 text-3xs text-faint">{t("sources.baselineHelp")}</p>
                </div>
                <span className="flex-1" />
                {references.length > 0 && (
                  <button
                    type="button"
                    onClick={() => onAddFolder("reference")}
                    disabled={disabled}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                  >
                    <FiPlus className="h-3.5 w-3.5" aria-hidden />
                    {t("sources.empty.reference")}
                  </button>
                )}
              </div>

              <ul className="space-y-2.5">{references.map((card) => cardFor(card, false))}</ul>
            </section>
          )}

          <section aria-labelledby="sources-destination" className="min-w-0">
            <div className="mb-2">
              <h2
                id="sources-destination"
                className="text-3xs font-bold uppercase tracking-[0.09em] text-faint"
              >
                {t("sources.role.destination", undefined, ROLE_LABEL.destination)}
              </h2>
              <p className="mt-0.5 text-3xs text-faint">
                {t("sources.role.destination.description", undefined, ROLE_DESCRIPTION.destination)}
              </p>
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
              </button>
            ) : (
              <ul className="space-y-2.5">{cardFor(destination, true)}</ul>
            )}
          </section>
        </div>

        {destination && (
          <aside className="mt-5 flex items-start gap-3 rounded-xl border border-info/25 bg-tint-info/35 p-3.5">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-tint-info text-info">
              <FiInfo className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-xs font-semibold text-foreground">{t("sources.boundary.title")}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                {t("sources.boundary.detail", { path: destination.path })}
              </p>
            </div>
          </aside>
        )}

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
      </div>
    </div>
  );
}
