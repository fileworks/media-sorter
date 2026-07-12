import { cn } from "@/lib/utils";

interface ProgressBarProps {
  /** 0–100 for a determinate bar; omit or pass `undefined` for indeterminate. */
  value?: number;
  className?: string;
}

export function ProgressBar({ value, className = "" }: ProgressBarProps) {
  const isIndeterminate = value === undefined;
  const clamped = isIndeterminate ? 0 : Math.min(100, Math.max(0, value));

  return (
    <div
      className={cn(
        "h-2.5 w-full overflow-hidden rounded-full bg-secondary",
        isIndeterminate && "progress-indeterminate",
        className,
      )}
      role="progressbar"
      aria-valuenow={isIndeterminate ? undefined : clamped}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-busy={isIndeterminate ? true : undefined}
    >
      {!isIndeterminate && (
        <div
          className="h-full rounded-full bg-primary transition-all duration-300 ease-in-out"
          style={{ width: `${clamped}%` }}
        />
      )}
    </div>
  );
}
