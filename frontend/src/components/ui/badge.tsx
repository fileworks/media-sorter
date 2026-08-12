/**
 * The one state chip.
 *
 * Every surface that had to say "open", "decided", "3 sets", "recommended" was
 * writing its own pill — six different paddings and four different radii for
 * one idea. This is that idea once: a compact, tinted, semibold label that
 * carries *state or category*, never decoration.
 *
 * The floor is 10px, one step above the mockup's 9px. Nine is below what this
 * tool can ask somebody to read all afternoon, and the chips are load-bearing:
 * "open" versus "decided" is the whole duplicate queue.
 */

import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type BadgeTone = "neutral" | "primary" | "success" | "warning" | "error" | "info";

const TONE_CLASS: Record<BadgeTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  primary: "bg-tint-primary text-primary",
  success: "bg-tint-success text-success",
  warning: "bg-tint-warning text-warning",
  error: "bg-tint-error text-error",
  info: "bg-tint-info text-info",
};

export function Badge({
  tone = "neutral",
  className,
  children,
  ...rest
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
} & Omit<React.HTMLAttributes<HTMLSpanElement>, "children" | "className">) {
  return (
    <span
      className={cn(
        "inline-flex w-max shrink-0 items-center gap-1 rounded-[5px] px-1.5 py-0.5",
        "text-3xs font-bold tracking-[0.02em] tabular-nums",
        TONE_CLASS[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
}
