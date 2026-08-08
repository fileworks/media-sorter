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
 *
 * The description says what the setting *is*, and never moves: a sentence that
 * rewrites itself as its own value changes is one the reader stops trusting
 * mid-sentence. Anything that follows from the current value — what "move" will
 * do to the originals, which copy the selected keep rule keeps, why a row cannot
 * be touched right now — goes on the `consequence` line under the control, and
 * anything a setting *reveals* goes in the indented `sub` block under the row.
 */

import { Fragment, useId, type ReactNode } from "react";
import { FiLock, FiRotateCcw } from "react-icons/fi";

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
  /**
   * What the setting is. Invariant: it must read the same whatever the value,
   * whatever an async probe reports, and whether or not the row is disabled.
   */
  description?: ReactNode;
  /**
   * What follows from the current value, on its own line under the control.
   * This is where per-value guidance, figures from a probe, and any other text
   * that moves with the setting belong — never in `description`.
   */
  consequence?: ReactNode;
  /**
   * Settings this row reveals, as an indented block beneath it. Each one
   * carries its own label — use `SubSetting`. Revealed controls do not go in
   * `children`, where they wrap into the parent's control container and read as
   * part of the parent's own control.
   */
  sub?: ReactNode;
  /** Rendered right of the label — the control itself. */
  children: ReactNode;
  /** Associates the label with a control that has this id. */
  htmlFor?: string;
  /** A badge beside the label, e.g. "runs fully offline". */
  badge?: ReactNode;
  /** Last row in a group draws no bottom rule. */
  last?: boolean;
  disabled?: boolean;
  /** Why the row cannot be changed. Rendered on the consequence line, locked. */
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

  const fields: readonly (keyof Config)[] = Array.isArray(field) ? field : [field as keyof Config];
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

  const dot = <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary" aria-hidden />;

  // Named, not implied. The baseline is the recipe in force, so "changed" here
  // means "you have taken this away from Safe sort" — a different and far more
  // useful claim than "this differs from what the product shipped with".
  const named = { value: defaultValue, baseline: diff.baselineLabel };

  if (diff.locked) {
    return (
      <Tooltip label={t("config.changed.default", named)}>
        <span
          className="inline-flex items-center"
          aria-label={t("config.changed.marker", { baseline: diff.baselineLabel })}
        >
          {dot}
        </span>
      </Tooltip>
    );
  }

  return (
    <Tooltip label={t("config.changed.revert", named)}>
      <button
        type="button"
        onClick={() => diff.revert(fields)}
        aria-label={t("config.changed.revert", named)}
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
  consequence,
  sub,
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
  const reason = disabled ? (disabledReason ?? null) : null;
  return (
    <div
      id={id}
      className={cn(
        "px-5 py-3.5",
        !last && "border-b border-border",
        disabled && "opacity-60",
        // The rail scrolls a row into view; leave it clear of the sticky group
        // header, and no further — `useScrollSpy`'s offset is matched to this.
        id && "scroll-mt-[4.5rem]",
      )}
    >
      <div
        className={cn("flex flex-col gap-3", !stacked && "sm:flex-row sm:items-center sm:gap-5")}
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
          {description && (
            <p className="mt-0.5 text-xs leading-relaxed text-faint">{description}</p>
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

      {/* Why it cannot be changed comes before what it currently does: a reader
          who cannot act needs that fact first, and the padlock says it without
          a sentence. */}
      {reason && (
        <p className="mt-2 flex items-start gap-1.5 text-xs leading-relaxed text-faint">
          <FiLock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
          <span className="min-w-0">{reason}</span>
        </p>
      )}
      {consequence && <p className="mt-2 text-xs leading-relaxed text-faint">{consequence}</p>}

      {sub && <div className="mt-3 space-y-3 border-l-2 border-border pl-4">{sub}</div>}
    </div>
  );
}

/**
 * One setting revealed by the row above it.
 *
 * It gets its own label for the same reason the parent has one: a slider that
 * appears beside a format dropdown when conversion is switched on is not "part
 * of" conversion to anybody reading it — it is the quality, and saying so is
 * one word.
 */
export function SubSetting({
  label,
  children,
  htmlFor,
  description,
  field,
}: {
  label: ReactNode;
  children: ReactNode;
  htmlFor?: string;
  description?: ReactNode;
  /**
   * The field this sub-setting writes. It carries its own marker rather than
   * folding into the parent's: reverting "how similar counts as similar" must
   * not also reset whether near-duplicates are detected at all.
   */
  field?: SettingField;
}) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <Label
            {...(htmlFor ? { htmlFor } : {})}
            className={cn("block text-xs font-medium text-foreground", htmlFor && "cursor-pointer")}
          >
            {label}
          </Label>
          {field !== undefined && <ChangedMarker field={field} />}
        </div>
        {description && <p className="mt-0.5 text-xs leading-relaxed text-faint">{description}</p>}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2.5 sm:shrink-0">{children}</div>
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
