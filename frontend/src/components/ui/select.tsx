/**
 * The one dropdown.
 *
 * A native `<select>` under a themed chevron, because the OS popup is faster,
 * keyboard-correct and type-ahead-correct for free — but with two rules the
 * hand-rolled copies scattered through the app kept breaking.
 *
 * First, the type never shrinks below `text-xs`. A select styled at 10px still
 * opens its popup at the platform's own size and anchors it to the control's
 * text box, so the list lands visibly off the trigger; that was the misaligned
 * "Use as Input" menu. Second, one border, one hover, one focus ring, shared
 * with the app's text inputs, so a row of a text field and a dropdown does not
 * read as two different toolkits.
 */

import type { ReactNode, SelectHTMLAttributes } from "react";
import { FiChevronDown } from "react-icons/fi";

import { cn } from "@/lib/utils";

export type SelectSize = "sm" | "md";

// Two control heights, shared with `Button` and `Segmented`: 32px for a
// toolbar and 36px for a form. There used to be four across the three
// components — 32, 36, 38 and 40 — so a select beside a button in the same
// row stood 6px taller than it for no reason anybody could name.
const SIZE_CLASS: Record<SelectSize, string> = {
  // The *type* never drops below 12px, whatever the height: a select styled
  // smaller still opens its popup at the platform's own size and anchors it to
  // the control's text box, so the list lands visibly off the trigger.
  sm: "h-8 py-1 pl-3 pr-8 text-[0.75rem]",
  md: "h-9 py-1 pl-3 pr-9 text-xs",
};

const CHEVRON_CLASS: Record<SelectSize, string> = {
  sm: "right-2 h-3.5 w-3.5",
  md: "right-3 h-4 w-4",
};

interface SelectItemProps {
  value: string | number;
  children: ReactNode;
}

export function SelectItem({ value, children }: SelectItemProps) {
  return <option value={value}>{children}</option>;
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange" | "size"> {
  value: string | number;
  onValueChange: (value: string) => void;
  children: ReactNode;
  size?: SelectSize;
  /** Sizes the control (e.g. `max-w-xs`, `w-full`); never its type scale. */
  className?: string;
}

export function Select({
  value,
  onValueChange,
  children,
  className,
  size = "md",
  disabled,
  ...rest
}: SelectProps) {
  return (
    <div className={cn("group relative inline-flex min-w-0", className)}>
      <select
        value={value}
        onChange={(event) => onValueChange(event.target.value)}
        disabled={disabled}
        className={cn(
          "w-full min-w-0 cursor-pointer appearance-none truncate rounded-control border border-input bg-card",
          "font-medium text-foreground transition-colors",
          "hover:border-border-strong",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          // A disabled control changes its fill, its edge and its ink. Opacity
          // would fade the option text along with everything else, and a
          // value nobody can read is worse than one nobody can change.
          "disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-faint disabled:hover:border-border",
          SIZE_CLASS[size],
        )}
        {...rest}
      >
        {children}
      </select>
      <FiChevronDown
        aria-hidden
        className={cn(
          "pointer-events-none absolute top-1/2 -translate-y-1/2 text-muted-foreground transition-colors",
          "group-hover:text-foreground",
          CHEVRON_CLASS[size],
          disabled && "text-faint group-hover:text-faint",
        )}
      />
    </div>
  );
}
