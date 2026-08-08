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

const SIZE_CLASS: Record<SelectSize, string> = {
  // Both sit at 12px/14px — never smaller, or the native popup misaligns.
  sm: "h-8 py-1 pl-2.5 pr-8 text-xs",
  md: "h-9 py-1.5 pl-3 pr-9 text-sm",
};

const CHEVRON_CLASS: Record<SelectSize, string> = {
  sm: "right-2 h-3.5 w-3.5",
  md: "right-2.5 h-4 w-4",
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
          "w-full min-w-0 cursor-pointer appearance-none truncate rounded-lg border border-input bg-background",
          "font-medium text-foreground transition-colors",
          "hover:border-faint",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
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
          disabled && "opacity-50",
        )}
      />
    </div>
  );
}
