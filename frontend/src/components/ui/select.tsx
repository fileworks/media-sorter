import { ReactNode, SelectHTMLAttributes } from "react";
import { FiChevronDown } from "react-icons/fi";
import { cn } from "@/lib/utils";

interface SelectItemProps {
  value: string;
  children: ReactNode;
}

export function SelectItem({ value, children }: SelectItemProps) {
  return <option value={value}>{children}</option>;
}

interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, "onChange"> {
  value: string;
  onValueChange: (value: string) => void;
  children: ReactNode;
  className?: string;
}

export function Select({
  value,
  onValueChange,
  children,
  className = "",
  disabled,
  ...rest
}: SelectProps) {
  // `className` sizes the control (e.g. `max-w-xs`); the native arrow is hidden
  // (`appearance-none`) and replaced with a chevron we can theme + animate.
  return (
    <div className={cn("group relative", className)}>
      <select
        value={value}
        onChange={(e) => onValueChange(e.target.value)}
        disabled={disabled}
        className={cn(
          "block w-full cursor-pointer appearance-none rounded-md border border-input bg-background py-2 pl-3 pr-9",
          "text-sm text-foreground shadow-sm transition-colors",
          "hover:border-primary/60",
          "focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
        {...rest}
      >
        {children}
      </select>
      <FiChevronDown
        aria-hidden
        className={cn(
          "pointer-events-none absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground transition-colors",
          "group-hover:text-foreground",
          disabled && "opacity-50",
        )}
      />
    </div>
  );
}

// Composable aliases kept for ergonomic imports.
export function SelectTrigger({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function SelectContent({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export function SelectValue({ placeholder }: { placeholder?: string }) {
  return <span className="text-muted-foreground">{placeholder}</span>;
}
