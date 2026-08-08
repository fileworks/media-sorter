import type { InputHTMLAttributes } from "react";

import { cn } from "@/lib/utils";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  className?: string;
}

/**
 * The text field, deliberately the same object as `Select`: same height, same
 * radius, same border, same hover and focus. A row that puts a field next to a
 * dropdown should not look like it borrowed one of them from another toolkit.
 */
export function Input({ className = "", ...props }: InputProps) {
  return (
    <input
      className={cn(
        "block h-9 w-full rounded-lg border border-input bg-background px-3 py-1.5",
        "text-sm text-foreground transition-colors placeholder:text-faint",
        "hover:border-faint",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    />
  );
}
