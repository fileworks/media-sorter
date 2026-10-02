import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/ui/modal";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";
import type { Config } from "@/types/api";

export interface ResetRow {
  /** Stable config key; labels are localized/display text and are not identity. */
  key: string;
  setting: string;
  current: string;
  result: string;
  /** This destination keeps the value produced by the preceding destination. */
  unchanged?: boolean;
}

export interface SettingChangeColumn {
  id: string;
  label: string;
  rows: ResetRow[];
  /** The destination this particular action will apply. */
  emphasized?: boolean;
}

/**
 * One table: what each setting is now, and what it is about to become.
 *
 * Shared by every path that rewrites settings in bulk — reset all, reset a
 * group, revert one row, and applying a recipe — because a raw list of field
 * identifiers ("junk_filter_enabled") answers a question nobody asked. The
 * values are run through the same formatters the settings themselves use.
 */
export function SettingChangeTable({
  columns,
  rowUniverse,
}: {
  columns: SettingChangeColumn[];
  /**
   * Rows that stay visible even when one destination column is hidden.
   * Recipe uses this so ticking the wider scope changes emphasis, not layout.
   */
  rowUniverse?: ResetRow[];
}) {
  const { t } = useI18n();
  const rows = new Map<string, ResetRow>();
  for (const row of rowUniverse ?? columns.flatMap((column) => column.rows)) {
    if (!rows.has(row.key)) rows.set(row.key, row);
  }
  for (const column of columns) {
    for (const row of column.rows) if (!rows.has(row.key)) rows.set(row.key, row);
  }
  const orderedRows = [...rows.values()].sort((a, b) => a.setting.localeCompare(b.setting));
  const byColumn = new Map(
    columns.map((column) => [column.id, new Map(column.rows.map((row) => [row.key, row]))]),
  );

  if (orderedRows.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("config.reset.nothingToDo")}</p>;
  }

  return (
    <div
      className="max-w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      tabIndex={0}
      role="region"
      aria-label={t("config.reset.comparison")}
    >
      {/* At phone/zoom widths the comparison is a stack, not a squeezed table.
          Every current/result value remains labelled and the region itself has
          no horizontal scrolling surface. */}
      <div className="grid gap-2 sm:hidden">
        {orderedRows.map((row) => (
          <article key={row.key} className="min-w-0 rounded-panel border border-border p-3 text-xs">
            <h3 className="break-words font-semibold text-foreground">{row.setting}</h3>
            <dl className="mt-2 grid gap-2">
              <div className="grid min-w-0 grid-cols-[minmax(5rem,0.45fr)_minmax(0,1fr)] gap-2">
                <dt className="text-muted-foreground">{t("config.reset.current")}</dt>
                <dd className="min-w-0 break-words text-foreground">{row.current}</dd>
              </div>
              {columns.map((column) => {
                const result = byColumn.get(column.id)?.get(row.key);
                const unchanged = result === undefined || result.unchanged === true;
                return (
                  <div
                    key={column.id}
                    aria-current={column.emphasized ? "true" : undefined}
                    className={cn(
                      "grid min-w-0 grid-cols-[minmax(5rem,0.45fr)_minmax(0,1fr)] gap-2 rounded-control px-1 py-0.5",
                      column.emphasized && "bg-tint-primary",
                    )}
                  >
                    <dt className={cn("break-words", column.emphasized && "text-primary")}>
                      {column.label}
                      {column.emphasized && (
                        <span className="mt-0.5 block text-3xs font-semibold">
                          {t("config.reset.selected")}
                        </span>
                      )}
                    </dt>
                    <dd className="min-w-0 break-words font-medium text-foreground">
                      {result?.result ?? row.current}
                      {unchanged && (
                        <span className="block text-3xs font-normal text-muted-foreground">
                          {t("config.reset.unchanged")}
                        </span>
                      )}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </article>
        ))}
      </div>

      <div className="hidden max-w-full overflow-x-auto sm:block">
        <table className="w-full text-left text-xs">
          <thead>
            <tr className="border-b border-border text-muted-foreground">
              <th scope="col" className="whitespace-nowrap py-2 pr-3 font-medium">
                {t("config.reset.setting")}
              </th>
              <th scope="col" className="whitespace-nowrap py-2 pr-3 font-medium">
                {t("config.reset.current")}
              </th>
              {columns.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  aria-current={column.emphasized ? "true" : undefined}
                  className={cn(
                    "whitespace-nowrap px-2 py-2 font-medium",
                    column.emphasized && "bg-tint-primary text-primary",
                  )}
                >
                  {column.label}
                  {column.emphasized && (
                    <span className="ml-2 rounded-full border border-current px-2 py-0.5 text-3xs">
                      {t("config.reset.selected")}
                    </span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {orderedRows.map((row) => (
              <tr key={row.key} className="border-b border-border last:border-0">
                <th scope="row" className="whitespace-nowrap py-2 pr-3 font-medium text-foreground">
                  {row.setting}
                </th>
                <td className="py-2 pr-3 text-muted-foreground">{row.current}</td>
                {columns.map((column) => {
                  const result = byColumn.get(column.id)?.get(row.key);
                  const unchanged = result === undefined || result.unchanged === true;
                  return (
                    <td
                      key={column.id}
                      className={cn(
                        "px-2 py-2 font-medium text-foreground",
                        column.emphasized && "bg-tint-primary",
                      )}
                    >
                      <span className="block">{result?.result ?? row.current}</span>
                      {unchanged && (
                        <span className="block text-3xs font-normal text-muted-foreground">
                          {t("config.reset.unchanged")}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** One place a reset can aim at: the recipe in force, or the factory defaults. */
export interface ResetDestination {
  id: string;
  /** Named, not implied — "back" has two meanings on this screen. */
  label: string;
  rows: ResetRow[];
  patch: Partial<Config>;
  /** Set when this destination would change nothing, and says so. */
  unavailable?: string;
}

interface ResetDialogProps {
  open: boolean;
  title: string;
  destinations: ResetDestination[];
  onClose: () => void;
  onConfirm: (destination: ResetDestination) => void;
}

/** The first destination that would actually change something. */
function firstUsable(destinations: readonly ResetDestination[]): string | null {
  return (
    destinations.find((destination) => !destination.unavailable && destination.rows.length > 0)
      ?.id ??
    destinations[0]?.id ??
    null
  );
}

/**
 * What a reset would change, before it changes it — and where "back" is.
 *
 * Reset used to write new values and say nothing about what they replaced, so
 * the only way to find out what a reset had done was to remember what had been
 * there. Every reset path — all settings, one group and one row — renders this
 * same table.
 *
 * Once a recipe is in force there are two honest answers to "put it back": back
 * to the recipe, and back to what the product shipped with. Both are offered and
 * both are named, because a single unlabelled "Reset" that silently picks one is
 * how a user ends up dismantling the recipe they just chose. A destination that
 * would change nothing is shown and disabled with the reason, rather than the
 * button doing nothing when pressed.
 *
 * The shape is the recipe preview's, deliberately and down to the pill: one
 * destination is *chosen*, the table marks that column as the one the button
 * will write, and one primary action commits it. The two surfaces answer the
 * same question — "these settings are about to change; here is to what" — and
 * they used to answer it in two different shapes, one with an emphasised
 * column and one with a row of competing buttons whose labels were the only
 * clue as to which column each belonged to.
 */
export function ResetDialog({ open, title, destinations, onClose, onConfirm }: ResetDialogProps) {
  const { t, tCount } = useI18n();
  const [chosenId, setChosenId] = useState<string | null>(() => firstUsable(destinations));
  const chosen =
    destinations.find((destination) => destination.id === chosenId) ?? destinations[0] ?? null;
  const blocked = chosen === null || Boolean(chosen.unavailable) || chosen.rows.length === 0;
  const reasonId = "reset-destination-reason";

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="lg"
      // Reopening for a different group must not carry the previous choice.
      key={title}
    >
      <ModalHeader />
      <ModalBody>
        <div className="space-y-3">
          <SettingChangeTable
            columns={destinations.map((destination) => ({
              id: destination.id,
              label: destination.label,
              rows: destination.rows,
              emphasized: destination.id === chosen?.id,
            }))}
          />

          {/* With one destination there is nothing to choose, and a radio
              group of one is a control that answers a question nobody asked. */}
          {destinations.length > 1 && (
            <fieldset>
              <legend className="mb-2 text-xs font-semibold text-foreground">
                {t("config.reset.chooseDestination")}
              </legend>
              <div className="grid gap-2">
                {destinations.map((destination) => {
                  const selected = destination.id === chosen?.id;
                  const disabled =
                    Boolean(destination.unavailable) || destination.rows.length === 0;
                  return (
                    <label
                      key={destination.id}
                      className={cn(
                        "flex min-h-6 cursor-pointer items-start gap-2 rounded-control border px-3 py-2",
                        "transition-colors focus-within:ring-2 focus-within:ring-ring",
                        selected
                          ? "border-primary bg-tint-primary"
                          : "border-border hover:border-border-strong hover:bg-muted/50",
                        disabled && "cursor-not-allowed border-border bg-muted text-faint",
                      )}
                    >
                      <input
                        type="radio"
                        name="reset-destination"
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 border-border-strong text-primary focus-visible:outline-none"
                        checked={selected}
                        disabled={disabled}
                        onChange={() => setChosenId(destination.id)}
                      />
                      <span className="min-w-0">
                        <span className="block text-xs font-medium text-foreground">
                          {destination.label}
                        </span>
                        <span className="block text-3xs text-muted-foreground">
                          {destination.unavailable ??
                            tCount("config.reset.willChange", destination.rows.length)}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
          )}
        </div>
      </ModalBody>
      <ModalFooter>
        {chosen?.unavailable && (
          <p id={reasonId} className="mr-auto text-3xs text-muted-foreground">
            {chosen.unavailable}
          </p>
        )}
        <Button variant="ghost" onClick={onClose}>
          {t("common.cancel")}
        </Button>
        <Button
          disabled={blocked}
          aria-describedby={chosen?.unavailable ? reasonId : undefined}
          onClick={() => chosen && onConfirm(chosen)}
        >
          {destinations.length === 1
            ? tCount("config.reset.confirm", chosen?.rows.length ?? 0)
            : t("config.reset.confirmDestination", {
                count: chosen?.rows.length ?? 0,
                target: chosen?.label ?? "",
              })}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
