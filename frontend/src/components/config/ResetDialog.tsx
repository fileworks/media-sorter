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
      className="max-w-full overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      tabIndex={0}
      role="region"
      aria-label={t("config.reset.comparison")}
    >
      <table className="min-w-[32rem] w-full text-left text-xs">
        <thead>
          <tr className="border-b border-border text-muted-foreground">
            <th scope="col" className="whitespace-nowrap py-1.5 pr-3 font-medium">
              {t("config.reset.setting")}
            </th>
            <th scope="col" className="whitespace-nowrap py-1.5 pr-3 font-medium">
              {t("config.reset.current")}
            </th>
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                aria-current={column.emphasized ? "true" : undefined}
                className={cn(
                  "whitespace-nowrap px-2 py-1.5 font-medium",
                  column.emphasized && "bg-tint-primary text-primary",
                )}
              >
                {column.label}
                {column.emphasized && (
                  <span className="ml-1.5 rounded-full border border-current px-1.5 py-0.5 text-3xs">
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
              <th scope="row" className="whitespace-nowrap py-1.5 pr-3 font-medium text-foreground">
                {row.setting}
              </th>
              <td className="py-1.5 pr-3 text-muted-foreground">{row.current}</td>
              {columns.map((column) => {
                const result = byColumn.get(column.id)?.get(row.key);
                const unchanged = result === undefined || result.unchanged === true;
                return (
                  <td
                    key={column.id}
                    className={cn(
                      "px-2 py-1.5 font-medium text-foreground",
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
 */
export function ResetDialog({ open, title, destinations, onClose, onConfirm }: ResetDialogProps) {
  const { t } = useI18n();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      size="md"
      // Reopening for a different group must not carry the previous choice.
      key={title}
    >
      <ModalHeader />
      <ModalBody>
        <SettingChangeTable
          columns={destinations.map((destination) => ({
            id: destination.id,
            label: destination.label,
            rows: destination.rows,
          }))}
        />
      </ModalBody>
      <ModalFooter>
        <div className="flex w-full flex-col gap-3">
          <div className="flex flex-wrap justify-end gap-3">
            {destinations.map((destination, index) => {
              const reasonId = `reset-destination-reason-${index}`;
              return (
                <div key={destination.id} className="flex max-w-xs flex-col items-end gap-1">
                  <Button
                    disabled={Boolean(destination.unavailable) || destination.rows.length === 0}
                    aria-describedby={destination.unavailable ? reasonId : undefined}
                    onClick={() => onConfirm(destination)}
                  >
                    {destinations.length === 1
                      ? t("config.reset.confirm", { count: destination.rows.length })
                      : t("config.reset.confirmDestination", {
                          count: destination.rows.length,
                          target: destination.label,
                        })}
                  </Button>
                  {destination.unavailable && (
                    <p id={reasonId} className="text-right text-3xs text-muted-foreground">
                      {destination.unavailable}
                    </p>
                  )}
                </div>
              );
            })}
          </div>
          <div className="flex justify-end">
            <Button variant="ghost" onClick={onClose}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      </ModalFooter>
    </Modal>
  );
}
