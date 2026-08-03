/**
 * One shape for every setting, so Configure reads as a list rather than a form.
 *
 * The row is: what it is on the left, what it does underneath in a lighter
 * weight, and the control hard right. That single arrangement — repeated for a
 * toggle, a segmented choice, a dropdown, a slider — is what lets somebody skim
 * forty settings and stop only at the one they came for.
 *
 * The description is not optional help text hidden behind an icon. If a setting
 * needs explaining, it is explained where it is read.
 */

import { Fragment, useId, type ReactNode } from "react";
import { FiRotateCcw } from "react-icons/fi";

import { Tooltip } from "@/components/ui/tooltip";
import { useSettingsDiff } from "@/context/settings-diff-context";
import { useI18n } from "@/i18n/I18nContext";
import { configFieldLabel, formatConfigValue } from "@/lib/configDiff";
import { cn } from "@/lib/utils";
import type { Config } from "@/types/api";

/** The `Config` field a row edits, or the several it edits as one decision. */
export type SettingField = keyof Config | readonly (keyof Config)[];

interface SettingRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** Rendered right of the label — the control itself. */
  children: ReactNode;
  /** Associates the label with a control that has this id. */
  htmlFor?: string;
  /** A badge beside the label, e.g. "runs fully offline". */
  badge?: ReactNode;
  /** Last row in a group draws no bottom rule. */
  last?: boolean;
  disabled?: boolean;
  /** Shown instead of the description while disabled, when there is a reason. */
  disabledReason?: string | null;
  /** Anchor target so the rail can jump to this row. */
  id?: string;
  /**
   * Put the control on its own line under the label, full width. For controls
   * that grow with their content — a tag list, a pattern editor — which would
   * otherwise crush the label column down to one word per line.
   */
  stacked?: boolean;
  /**
   * Which `Config` field(s) this row writes. Declaring it is what lets the row
   * mark itself as changed from the default and offer a way back; a row that
   * edits nothing — a stated guarantee, a read-only destination — declares none.
   */
  field?: SettingField;
}

/**
 * "You changed this, and here is the way back."
 *
 * One control, not two: the marker is the revert. A dot that says a setting has
 * moved but offers no way to move it back is a reproach rather than a tool, and
 * a separate revert button beside a separate dot would double the visual noise
 * on every row a user has touched. While the settings are locked by a running
 * operation the marker stays — the fact is still true — but it stops being a
 * button, because nothing may be written.
 */
function ChangedMarker({ field }: { field: SettingField }) {
  const { t } = useI18n();
  const diff = useSettingsDiff();
  if (!diff) return null;

  const fields: readonly (keyof Config)[] = Array.isArray(field)
    ? field
    : [field as keyof Config];
  const changed = fields.filter((key) => diff.changed.has(key));
  if (changed.length === 0) return null;

  // With one field the row's own label already names it. Where the row writes
  // several — "min and max size", "format and quality" — a bare value would not
  // say which of them moved, so each is named even when only one has.
  const defaultValue = changed
    .map((key) =>
      fields.length === 1
        ? formatConfigValue(diff.defaults[key])
        : `${configFieldLabel(key)}: ${formatConfigValue(diff.defaults[key])}`,
    )
    .join(" · ");

  const dot = (
    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />
  );

  if (diff.locked) {
    return (
      <Tooltip label={t("config.changed.default", { value: defaultValue })}>
        <span className="inline-flex items-center" aria-label={t("config.changed.marker")}>
          {dot}
        </span>
      </Tooltip>
    );
  }

  return (
    <Tooltip label={t("config.changed.revert", { value: defaultValue })}>
      <button
        type="button"
        onClick={() => diff.revert(fields)}
        aria-label={t("config.changed.revert", { value: defaultValue })}
        className="group/revert inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-primary transition-colors hover:bg-tint-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {dot}
        <FiRotateCcw
          className="h-2.5 w-2.5 opacity-0 transition-opacity group-hover/revert:opacity-100 group-focus-visible/revert:opacity-100"
          aria-hidden
        />
      </button>
    </Tooltip>
  );
}

export function SettingRow({
  label,
  description,
  children,
  htmlFor,
  badge,
  last = false,
  disabled = false,
  disabledReason,
  id,
  stacked = false,
  field,
}: SettingRowProps) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div
      id={id}
      className={cn(
        "flex flex-col gap-3 px-5 py-3.5",
        !stacked && "sm:flex-row sm:items-center sm:gap-5",
        !last && "border-b border-border",
        disabled && "opacity-60",
        // The rail scrolls a row into view; leave it clear of the sticky group
        // header, and no further — `useScrollSpy`'s offset is matched to this.
        id && "scroll-mt-[4.5rem]",
      )}
    >
      <div className="min-w-0 flex-1">
        {/* The marker sits beside the label rather than inside it: a `<label>`
            forwards every click to its control, so a revert button nested in
            one would also flip the toggle it is meant to put back. */}
        <div className="flex flex-wrap items-center gap-1.5">
          <Label
            {...(htmlFor ? { htmlFor } : {})}
            className={cn(
              "flex flex-wrap items-center gap-2 text-xs font-semibold text-foreground",
              htmlFor && !disabled && "cursor-pointer",
            )}
          >
            {label}
            {badge}
          </Label>
          {field !== undefined && <ChangedMarker field={field} />}
        </div>
        {(disabled && disabledReason ? disabledReason : description) && (
          <p className="mt-0.5 text-xs leading-relaxed text-faint">
            {disabled && disabledReason ? disabledReason : description}
          </p>
        )}
      </div>
      <div
        className={cn(
          "flex min-w-0 flex-wrap items-center gap-2.5",
          stacked ? "w-full" : "sm:shrink-0",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * A full-width strip under a row, showing the concrete result of the settings
 * above it — the example path, the example filename. Reading an example beats
 * reading a description of one.
 */
export function SettingPreview({ children, last = false }: { children: ReactNode; last?: boolean }) {
  return (
    <div
      className={cn(
        "bg-muted px-5 py-2.5 text-xs",
        last ? "rounded-b-xl" : "border-b border-border",
      )}
    >
      {children}
    </div>
  );
}

/**
 * One numbered group of settings. The ordinal is not decoration: Sort → Clean →
 * Enrich is the order the work actually happens in, and numbering it is what
 * makes the sequence legible at a glance.
 *
 * The header sticks to the top of the page while its rows are being read, so
 * "which group is this setting in?" never needs a scroll back up. That is also
 * why the card cannot clip its overflow: `overflow: hidden` makes the section
 * its own scroll container, and a sticky child of a box that never scrolls
 * never sticks. The corners are rounded on the header instead.
 */
export function SettingGroup({
  ordinal,
  title,
  subtitle,
  id,
  children,
}: {
  ordinal: string;
  title: string;
  subtitle: string;
  id?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      className={cn("rounded-xl border border-border bg-card", id && "scroll-mt-4")}
    >
      <header className="sticky top-0 z-10 flex flex-wrap items-baseline gap-2.5 rounded-t-xl border-b border-border bg-card px-5 py-3.5">
        <span className="font-mono text-xs font-bold text-primary">{ordinal}</span>
        <h2 id={headingId} className="text-sm font-bold tracking-tight text-foreground">
          {title}
        </h2>
        <span className="text-xs text-faint">{subtitle}</span>
      </header>
      {children}
    </section>
  );
}

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  /** Explains the option on hover and to assistive tech. */
  title?: string;
  disabled?: boolean;
}

/**
 * A small set of mutually exclusive choices, all visible at once.
 *
 * A radio group under the hood, so arrow keys move between options and a screen
 * reader announces "2 of 5" — which a row of styled buttons would not.
 */
export function Segmented<T extends string>({
  name,
  value,
  options,
  onChange,
  label,
  disabled = false,
}: {
  name: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <fieldset
      className={cn(
        "inline-flex overflow-hidden rounded-lg border border-border",
        disabled && "opacity-50",
      )}
      disabled={disabled}
    >
      <legend className="sr-only">{label}</legend>
      {options.map((option, index) => {
        const active = option.value === value;
        const control = (
          <label
            className={cn(
              "cursor-pointer whitespace-nowrap px-3.5 py-1.5 text-xs transition-colors",
              index > 0 && "border-l border-border",
              active
                ? "bg-primary font-semibold text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
              (option.disabled || disabled) && "cursor-not-allowed opacity-60",
              "focus-within:outline-none focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring",
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={active}
              disabled={disabled || option.disabled}
              onChange={() => onChange(option.value)}
              className="sr-only"
            />
            {option.label}
          </label>
        );
        return option.title ? (
          <Tooltip key={option.value} label={option.title}>
            {control}
          </Tooltip>
        ) : (
          <Fragment key={option.value}>{control}</Fragment>
        );
      })}
    </fieldset>
  );
}

/** A read-only value shown the way it will appear on disk. */
export function MonoValue({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className="max-w-[16rem] truncate rounded-md bg-muted px-2.5 py-1 font-mono text-xs text-muted-foreground"
    >
      {children}
    </span>
  );
}
