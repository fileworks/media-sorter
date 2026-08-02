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

import { useId, type ReactNode } from "react";

import { cn } from "@/lib/utils";

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
}: SettingRowProps) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div
      id={id}
      className={cn(
        "flex flex-col gap-3 px-5 py-3.5 sm:flex-row sm:items-center sm:gap-5",
        !last && "border-b border-border",
        disabled && "opacity-60",
        // The rail scrolls a row into view; leave it clear of the sticky header.
        id && "scroll-mt-24",
      )}
    >
      <div className="min-w-0 flex-1">
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
        {(disabled && disabledReason ? disabledReason : description) && (
          <p className="mt-0.5 text-xs leading-relaxed text-faint">
            {disabled && disabledReason ? disabledReason : description}
          </p>
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2.5">{children}</div>
    </div>
  );
}

/**
 * A full-width strip under a row, showing the concrete result of the settings
 * above it — the example path, the example filename. Reading an example beats
 * reading a description of one.
 */
export function SettingPreview({ children }: { children: ReactNode }) {
  return (
    <div className="border-b border-border bg-muted px-5 py-2.5 text-xs">{children}</div>
  );
}

/**
 * One numbered group of settings. The ordinal is not decoration: Sort → Clean →
 * Enrich is the order the work actually happens in, and numbering it is what
 * makes the sequence legible at a glance.
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
      className={cn("overflow-hidden rounded-xl border border-border bg-card", id && "scroll-mt-20")}
    >
      <header className="flex flex-wrap items-baseline gap-2.5 border-b border-border px-5 py-3.5">
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
        return (
          <label
            key={option.value}
            title={option.title}
            className={cn(
              "cursor-pointer px-3.5 py-1.5 text-xs transition-colors",
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
