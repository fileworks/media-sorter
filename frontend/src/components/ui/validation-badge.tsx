import { cn } from "@/lib/utils";

type Severity = "error" | "warning" | "info" | "success";

interface ValidationBadgeProps {
  message: string;
  severity?: Severity;
  className?: string;
}

const styles: Record<Severity, string> = {
  error: "bg-error/10 text-error border-error/20",
  warning: "bg-warning/10 text-warning border-warning/20",
  info: "bg-info/10 text-info border-info/20",
  success: "bg-success/10 text-success border-success/20",
};

const icons: Record<Severity, string> = {
  error: "✕",
  warning: "⚠",
  info: "ℹ",
  success: "✓",
};

export function ValidationBadge({ message, severity = "error", className }: ValidationBadgeProps) {
  return (
    <p
      role="alert"
      className={cn(
        "flex items-start gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium",
        styles[severity],
        className,
      )}
    >
      <span className="mt-px shrink-0 text-[11px] font-bold">{icons[severity]}</span>
      {message}
    </p>
  );
}
