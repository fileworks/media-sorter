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
import { useSettingsDiff, type NestedConfigField } from "@/context/settings-diff-context";
import { useSettingsLocked } from "@/context/settings-lock-context";
import { useI18n } from "@/i18n/I18nContext";
import { configFieldLabel, formatConfigValue } from "@/lib/configDiff";
import { cn } from "@/lib/utils";
import type { Config } from "@/types/api";

/** The `Config` field a row edits, or the several it edits as one decision. */
export type SettingField = keyof Config | readonly (keyof Config)[] | NestedConfigField;

function isNestedConfigField(field: SettingField): field is NestedConfigField {
  return !Array.isArray(field) && typeof field === "object" && "property" in field;
}

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

  const nested = isNestedConfigField(field) ? field : null;
  const fields: readonly (keyof Config)[] = nested
    ? []
    : Array.isArray(field)
      ? field
      : [field as keyof Config];
  const changed = fields.filter((key) => diff.changed.has(key));
  const nestedDiff = nested ? diff.nested(nested) : null;
  if (nested ? !nestedDiff?.changed : changed.length === 0) return null;

  // With one field the row's own label already names it. Where the row writes
  // several — "min and max size", "format and quality" — a bare value would not
  // say which of them moved, so each is named even when only one has.
  const defaultValue = nested
    ? formatConfigValue(nestedDiff?.defaultValue)
    : changed
        .map((key) =>
          fields.length === 1
            ? formatConfigValue(diff.defaults[key])
            : `${configFieldLabel(key)}: ${formatConfigValue(diff.defaults[key])}`,
        )
        .join(" · ");

  // A dot with a halo, at the size the mockup gives it: this is the one mark
  // that has to be findable while scrolling past forty settings.
  // `block` is load-bearing: an inline span ignores width and height, so the
  // dot collapsed to nothing and only its ring painted — a pale square.
  const dot = (
    <span
      className="block h-2 w-2 shrink-0 rounded-full bg-primary shadow-[0_0_0_4px_hsl(var(--tint-primary))]"
      aria-hidden
    />
  );

  // Named, not implied. The baseline is the recipe in force, so "changed" here
  // means "you have taken this away from Safe sort" — a different and far more
  // useful claim than "this differs from what the product shipped with".
  const named = { value: defaultValue, baseline: diff.baselineLabel };

  if (diff.locked) {
    return (
      <Tooltip label={t("config.changed.default", named)}>
        <span
          className="grid h-8 w-8 shrink-0 place-items-center"
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
        onClick={() => (nested ? diff.revertNested(nested) : diff.revert(fields))}
        aria-label={t("config.changed.revert", named)}
        className="group/revert grid h-8 w-8 shrink-0 place-items-center rounded-control text-primary transition-colors hover:bg-tint-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="grid place-items-center group-hover/revert:hidden group-focus-visible/revert:hidden">
          {dot}
        </span>
        <FiRotateCcw
          className="hidden h-3.5 w-3.5 group-hover/revert:block group-focus-visible/revert:block"
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
      // A stable hook for anything that needs to find "the row this control
      // belongs to". Tests used to reach for `closest("[class*='px-5']")`,
      // which made a spacing decision load-bearing: condensing the row broke
      // five of them, and re-pointing those at `px-4` would only move the
      // breakage to the next time somebody changed the padding.
      data-setting-row=""
      className={cn(
        // 16/12 rather than 20/14, and both on the 4px scale. A settings row
        // is a label, a sentence and a control; at 20px side padding inside a
        // card that already has its own, and 14px above and below an 18px line
        // of text, the air was doing more work than the content.
        "px-4 py-3",
        !last && "border-b border-border",
        // The row is read-only rather than faded: its own controls carry
        // the disabled styling, and its label and help text must stay
        // readable — that is the whole reason to leave the row visible.
        disabled && "read-only-region",
        // The rail scrolls a row into view; leave it clear of the sticky group
        // header, and no further — `useScrollSpy`'s offset is matched to this.
        // 4.5rem of header plus the 1rem inset it now rests at.
        id && "scroll-mt-[5.5rem]",
      )}
    >
      <div
        className={cn(
          "settings-row-layout flex flex-col gap-2",
          !stacked && "sm:flex-row sm:items-center sm:gap-4",
        )}
      >
        <div className="min-w-0 flex-1">
          <div className="flex min-h-6 flex-wrap items-center gap-2">
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
            "settings-control-group flex min-w-0 flex-wrap items-center gap-3",
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
        <p className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-faint">
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
    <div className="settings-row-layout flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex min-h-6 items-center gap-2">
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
      <div className="settings-control-group flex min-w-0 flex-wrap items-center gap-3 sm:shrink-0">
        {children}
      </div>
    </div>
  );
}

/** A settings group with a sticky heading and a stable inline reset slot. */
export function SettingGroup({
  title,
  subtitle,
  id,
  onReset,
  resetLabel,
  children,
}: {
  title: string;
  subtitle: string;
  id?: string;
  onReset?: () => void;
  resetLabel?: string;
  children: ReactNode;
}) {
  const headingId = useId();
  const { t } = useI18n();
  const locked = useSettingsLocked();
  return (
    <section
      id={id}
      aria-labelledby={headingId}
      data-locked={locked || undefined}
      className={cn("rounded-window border border-border bg-card", id && "scroll-mt-4")}
    >
      {/* Matches the rows below it: same 16px gutter, and 8px above and below a
          28px control rather than 12px around a 20px heading. It is a sticky
          band the reader passes under repeatedly, so its height is paid on
          every group.
          Pin flush to the scrollport: a gap above the sticky band exposed
          clipped text from the rows passing beneath it. */}
      <header
        data-setting-header
        className="sticky top-0 z-10 rounded-t-window border-b border-border bg-card px-4 py-2"
      >
        <div className="flex flex-wrap items-center gap-3">
          <h2 id={headingId} className="text-sm font-bold tracking-tight text-foreground">
            {title}
          </h2>
          {/* The one banner at the top of the screen scrolls away, and a group
              heading that never mentions the lock leaves rows below it looking
              like ordinary rows whose controls have stopped answering. */}
          {locked && (
            <span className="inline-flex shrink-0 items-center gap-1 rounded-control border border-border bg-muted px-2 py-0.5 text-3xs font-semibold text-muted-foreground">
              <FiLock className="h-3 w-3" aria-hidden />
              {t("stage.locked.chip")}
            </span>
          )}
          <span className="grid h-7 w-7 shrink-0 place-items-center" aria-hidden={!onReset}>
            {onReset && (
              <Tooltip label={resetLabel ?? title}>
                <button
                  type="button"
                  onClick={onReset}
                  aria-label={resetLabel ?? title}
                  className="grid h-7 w-7 place-items-center rounded-control text-faint transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <FiRotateCcw className="h-3.5 w-3.5" aria-hidden />
                </button>
              </Tooltip>
            )}
          </span>
          <span className="text-xs text-faint">{subtitle}</span>
        </div>
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
  compact = false,
}: {
  name: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  label: string;
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    // `disabled:bg-muted` as well as the prop, because this control can also be
    // disabled from *above*: a read-only stage wraps its screen in a disabled
    // fieldset, which disables every input beneath it without any prop reaching
    // here. Styling that branched only on the prop left a locked segmented
    // control drawn exactly like a live one — a solid brand-coloured segment
    // that nothing on screen said had stopped answering.
    <fieldset
      data-segmented
      className={cn(
        "flex min-w-0 max-w-full overflow-hidden rounded-control border border-border bg-card",
        "disabled:bg-muted",
        disabled && "bg-muted",
      )}
      disabled={disabled}
    >
      <legend className="sr-only">{label}</legend>
      {options.map((option, index) => {
        const active = option.value === value;
        const control = (
          <label
            className={cn(
              "flex min-w-0 flex-1 cursor-pointer items-center justify-center text-center text-2xs font-medium leading-snug transition-colors sm:flex-none sm:whitespace-nowrap",
              // 36px, the same as a default Button and a `md` Select. It
              // stood at 38px, which made a mode switch the tallest thing in
              // any row it appeared in.
              compact ? "min-h-8 px-3 py-1" : "min-h-9 px-3 py-1 sm:px-4",
              index > 0 && "border-l border-border",
              active
                ? "bg-primary font-semibold text-primary-foreground"
                : "text-muted-foreground hover:bg-muted hover:text-foreground",
              (option.disabled || disabled) &&
                "cursor-not-allowed border-border bg-muted text-faint opacity-100 hover:bg-muted hover:text-faint",
              // The same treatment, reached through the input's own state, so a
              // fieldset disabled anywhere above this row still shows.
              "has-[:disabled]:cursor-not-allowed has-[:disabled]:border-border",
              "has-[:disabled]:bg-muted has-[:disabled]:text-faint",
              "has-[:disabled]:hover:bg-muted has-[:disabled]:hover:text-faint",
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
      className="max-w-[16rem] truncate rounded-panel bg-muted px-3 py-1 font-mono text-xs text-muted-foreground"
    >
      {children}
    </span>
  );
}
