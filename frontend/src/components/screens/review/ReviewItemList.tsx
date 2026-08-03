import { useMemo } from "react";
import { FiLock } from "react-icons/fi";

import { Thumbnail } from "@/components/ui/thumbnail";
import { Tooltip } from "@/components/ui/tooltip";
import { useVirtualWindow } from "@/hooks/useVirtualWindow";
import { useViewportBudget } from "@/hooks/useViewportBudget";
import { useI18n } from "@/i18n/I18nContext";

type Translate = ReturnType<typeof useI18n>["t"];
import { formatBytes } from "@/lib/formatters";
import { groupIntoStacks, isStack, type ReviewRow, type Stack } from "@/lib/reviewRows";
import { SELECTABLE_KEEPER_POLICIES, type KeeperPolicyId } from "@/types/api";
import { cn } from "@/lib/utils";
import type { ViewMode } from "@/components/screens/review/ReviewToolbar";

const ROW_HEIGHT = 44;
const STACK_HEADER_HEIGHT = 36;
const LIST_CHROME = 340;
const LIST_MIN_HEIGHT = 280;

/** A stack header or one file, flattened so the list renders a single sequence. */
type Entry = { kind: "stack"; stack: Stack } | { kind: "row"; row: ReviewRow; inStack: boolean };

function flatten(rows: ReviewRow[]): Entry[] {
  const out: Entry[] = [];
  for (const entry of groupIntoStacks(rows)) {
    if (isStack(entry)) {
      out.push({ kind: "stack", stack: entry });
      for (const row of entry.rows) out.push({ kind: "row", row, inStack: true });
    } else {
      out.push({ kind: "row", row: entry, inStack: false });
    }
  }
  return out;
}

interface ReviewItemListProps {
  rows: ReviewRow[];
  view: ViewMode;
  selected: ReadonlySet<string>;
  onToggle: (source: string, shiftKey: boolean) => void;
  onDissolve: (stackId: string) => void;
  onKeepOnly: (row: ReviewRow) => void;
  onCompareStack: (stack: Stack) => void;
  /** Apply a keep rule to one stack only, leaving every other stack alone. */
  onOverrideKeeper: (stackId: string, policy: KeeperPolicyId) => void;
  dissolvePending: string | null;
  keeperPending: string | null;
}

/**
 * The one item list.
 *
 * Grid and list are two renderings of the same rows, not two screens — the
 * selection, the filters and the counts are shared, which is what stops a tile
 * and a tab disagreeing about the same run.
 */
export function ReviewItemList({
  rows,
  view,
  selected,
  onToggle,
  onDissolve,
  onKeepOnly,
  onCompareStack,
  onOverrideKeeper,
  dissolvePending,
  keeperPending,
}: ReviewItemListProps) {
  const { t, locale } = useI18n();
  const entries = useMemo(() => flatten(rows), [rows]);
  const maxHeight = useViewportBudget({ reserved: LIST_CHROME, min: LIST_MIN_HEIGHT });

  const windowing = useVirtualWindow({
    count: entries.length,
    estimateSize: ROW_HEIGHT,
    maxHeight,
    overscan: 12,
    anchorKey: entries[0] ? entryKey(entries[0]) : null,
  });

  if (view === "grid") {
    return (
      <div
        className="overflow-y-auto rounded-xl border border-border"
        style={{ maxHeight }}
        role="group"
        aria-label={t("review.items")}
      >
        <ul className="grid grid-cols-2 gap-2 p-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
          {rows.map((row) => (
            <li key={row.source}>
              <GridTile
                row={row}
                selected={selected.has(row.source)}
                onToggle={(shiftKey) => onToggle(row.source, shiftKey)}
              />
            </li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div
      ref={windowing.scrollRef}
      onScroll={windowing.onScroll}
      className="overflow-y-auto rounded-xl border border-border"
      style={{ maxHeight }}
      role="group"
      aria-label={t("review.items")}
    >
      <div style={{ height: windowing.totalSize, position: "relative" }}>
        {windowing.virtualItems.map((virtual) => {
          const entry = entries[virtual.index];
          if (entry === undefined) return null;
          return (
            <div
              key={entryKey(entry)}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                right: 0,
                transform: `translateY(${virtual.start}px)`,
              }}
            >
              {entry.kind === "stack" ? (
                <StackHeader
                  stack={entry.stack}
                  dissolving={dissolvePending === entry.stack.id}
                  overridePending={keeperPending === entry.stack.id}
                  onDissolve={() => onDissolve(entry.stack.id)}
                  onCompare={() => onCompareStack(entry.stack)}
                  onOverrideKeeper={(policy) => onOverrideKeeper(entry.stack.id, policy)}
                />
              ) : (
                <ListRow
                  row={entry.row}
                  inStack={entry.inStack}
                  selected={selected.has(entry.row.source)}
                  onToggle={(shiftKey) => onToggle(entry.row.source, shiftKey)}
                  onKeepOnly={() => onKeepOnly(entry.row)}
                  locale={locale}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function entryKey(entry: Entry): string {
  return entry.kind === "stack" ? `stack:${entry.stack.id}` : `row:${entry.row.source}`;
}

function StackHeader({
  stack,
  dissolving,
  overridePending,
  onDissolve,
  onCompare,
  onOverrideKeeper,
}: {
  stack: Stack;
  dissolving: boolean;
  overridePending: boolean;
  onDissolve: () => void;
  onCompare: () => void;
  onOverrideKeeper: (policy: KeeperPolicyId) => void;
}) {
  const { t } = useI18n();
  // A keep *rule* only decides an exact stack. A perceptual match — similar or
  // burst — is not proof that two files are the same file, so the backend never
  // resolves one in bulk and neither does this menu; those stacks are decided
  // one file at a time, with Compare and "Keep only this".
  const ruleApplies = stack.kind === "exact" && !stack.hasBaseline;
  const ruleReason = stack.hasBaseline
    ? t("review.stack.keeperBaseline")
    : t("review.stack.keeperPerceptual");
  return (
    <div
      className="flex items-center gap-2 border-b border-border bg-muted/50 px-3"
      style={{ height: STACK_HEADER_HEIGHT }}
    >
      <span className="text-xs font-semibold text-foreground">
        {t("review.stack.copies", { count: stack.rows.length })}
      </span>
      <span className="rounded-full border border-border px-2 py-0.5 text-3xs font-semibold text-muted-foreground">
        {t(`review.stack.kind.${stack.kind}`)}
      </span>
      {stack.hasBaseline && (
        <Tooltip label={t("review.stack.baselineHelp")}>
          <span className="flex items-center gap-1 text-3xs font-semibold text-muted-foreground">
            <FiLock className="h-3 w-3" aria-hidden />
            {t("review.stack.baseline")}
          </span>
        </Tooltip>
      )}
      {stack.keeper && (
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {t(stack.keeperPromoted ? "review.stack.keepingInstead" : "review.stack.keeping", {
            name: stack.keeper.name,
          })}
        </span>
      )}
      {stack.keeper === null && stack.rows.length > 0 && (
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {t("review.stack.allExcluded")}
        </span>
      )}
      <span className="flex-1" />
      <Tooltip label={ruleApplies ? t("review.stack.keeperOverrideHelp") : ruleReason}>
        <label className="flex items-center gap-1.5 text-3xs text-muted-foreground">
          <span className="sr-only">{t("review.stack.keeperOverride")}</span>
          <select
            value=""
            disabled={!ruleApplies || overridePending}
            aria-label={t("review.stack.keeperOverride")}
            onChange={(event) => {
              if (event.target.value) onOverrideKeeper(event.target.value as KeeperPolicyId);
            }}
            className="rounded-md border border-border bg-background px-1.5 py-0.5 text-3xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <option value="">
              {overridePending
                ? t("review.stack.keeperApplying")
                : t("review.stack.keeperOverride")}
            </option>
            {SELECTABLE_KEEPER_POLICIES.map((policy) => (
              <option key={policy} value={policy}>
                {t(`config.keeper.${policy}`)}
              </option>
            ))}
          </select>
        </label>
      </Tooltip>
      <button
        type="button"
        onClick={onCompare}
        className="rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {t("review.compare")}
      </button>
      <Tooltip label={t("review.stack.notDuplicatesHelp")}>
        <button
          type="button"
          disabled={dissolving || stack.hasBaseline}
          onClick={onDissolve}
          className="rounded-lg px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          {dissolving ? t("review.stack.dissolving") : t("review.stack.notDuplicates")}
        </button>
      </Tooltip>
    </div>
  );
}

/** The destination cell, in plain language rather than a status word. */
function destinationLabel(row: ReviewRow, t: Translate): string {
  switch (row.status) {
    case "excluded":
      return t("review.destination.excluded");
    case "baseline":
      return t("review.destination.baseline");
    case "keep_in_place":
      return t("review.destination.keepInPlace");
    case "unreadable":
      return t("review.destination.unreadable");
    case "duplicate":
      return t("review.destination.setAside", { folder: "_duplicates/" });
    case "junk":
      return t("review.destination.setAside", { folder: "_junk/" });
    case "already_there":
      return t("review.destination.alreadyThere");
    default:
      return row.destination === null
        ? t("review.destination.none")
        : `→ ${row.destination.replace(/\\/g, "/").split("/").slice(-3, -1).join("/")}/`;
  }
}

function ListRow({
  row,
  inStack,
  selected,
  onToggle,
  onKeepOnly,
  locale,
}: {
  row: ReviewRow;
  inStack: boolean;
  selected: boolean;
  onToggle: (shiftKey: boolean) => void;
  onKeepOnly: () => void;
  locale: string;
}) {
  const { t } = useI18n();
  const locked = row.status === "baseline";

  return (
    <div
      className={cn(
        "flex items-center gap-2.5 border-b border-border px-3 text-xs",
        inStack && "pl-8",
        selected && "bg-accent",
        row.excluded && "opacity-60",
      )}
      style={{ height: ROW_HEIGHT }}
      data-selected={selected}
    >
      <input
        type="checkbox"
        checked={selected}
        disabled={locked}
        aria-label={row.name}
        onChange={(event) =>
          onToggle((event.nativeEvent as MouseEvent | undefined)?.shiftKey ?? false)
        }
        onClick={(event) => {
          if (event.shiftKey) {
            event.preventDefault();
            onToggle(true);
          }
        }}
        className="h-3.5 w-3.5 shrink-0 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
      />

      {locked && (
        <Tooltip label={t("review.stack.baselineHelp")}>
          <FiLock className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
        </Tooltip>
      )}

      <Tooltip label={row.source}>
        <span
          className={cn(
            "min-w-0 flex-1 truncate font-medium text-foreground",
            row.excluded && "line-through",
          )}
        >
          {row.name}
        </span>
      </Tooltip>

      {/* A companion never travels alone: excluding one member of a media unit
          takes the whole unit, so the row says how many files that is before
          the checkbox is ticked, not after. */}
      {row.companionCount > 0 && (
        <Tooltip label={t("review.row.companionsHelp")}>
          <span className="hidden shrink-0 text-3xs text-faint sm:inline">
            {t("review.row.companions", { count: row.companionCount })}
          </span>
        </Tooltip>
      )}

      <span className="hidden shrink-0 text-muted-foreground sm:inline">
        {formatBytes(row.sizeBytes, { locale })}
      </span>

      <span className="min-w-0 shrink-0 truncate text-muted-foreground">
        {destinationLabel(row, t)}
      </span>

      {row.flags.map((flag) => (
        <Tooltip key={flag} label={t(`review.flag.${flag}.help`)}>
          <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-3xs font-semibold text-muted-foreground">
            {t(`review.flag.${flag}`)}
          </span>
        </Tooltip>
      ))}

      {row.stack !== null && !row.stack.isKeeper && !locked && (
        <button
          type="button"
          onClick={onKeepOnly}
          className="shrink-0 rounded-lg px-2 py-0.5 text-3xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t("review.keepOnlyThis")}
        </button>
      )}
    </div>
  );
}

function GridTile({
  row,
  selected,
  onToggle,
}: {
  row: ReviewRow;
  selected: boolean;
  onToggle: (shiftKey: boolean) => void;
}) {
  const { t } = useI18n();
  const locked = row.status === "baseline";
  return (
    <Tooltip label={`${row.name} — ${destinationLabel(row, t)}`}>
      <button
        type="button"
        aria-pressed={selected}
        disabled={locked}
        onClick={(event) => onToggle(event.shiftKey)}
        className={cn(
          "relative block w-full overflow-hidden rounded-lg border text-left transition-colors",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          selected ? "border-primary" : "border-border hover:border-faint",
          row.excluded && "opacity-60",
          locked && "cursor-not-allowed",
        )}
      >
        <Thumbnail path={row.source} maxPx={240} className="aspect-square w-full" />
        <span
          className={cn(
            "block truncate px-2 py-1 text-3xs font-medium text-foreground",
            row.excluded && "line-through",
          )}
        >
          {row.name}
        </span>
        {locked && (
          <span className="absolute left-1 top-1 rounded bg-card/90 p-1">
            <FiLock className="h-3 w-3 text-muted-foreground" aria-hidden />
          </span>
        )}
      </button>
    </Tooltip>
  );
}
