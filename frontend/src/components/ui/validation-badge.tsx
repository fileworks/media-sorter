import { cn } from "@/lib/utils";

type Severity = "error" | "warning" | "info" | "success";

interface ValidationBadgeProps {
  message: string;
  severity?: Severity;
  className?: string;
}

const styles: Record<Severity, string> = {
  error: "bg-error/10 text-error border-error/40",
  warning: "bg-warning/10 text-warning border-warning/40",
  info: "bg-info/10 text-info border-info/40",
  success: "bg-success/10 text-success border-success/40",
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
        "flex items-start gap-2 rounded-panel border px-3 py-2 text-xs font-medium",
        styles[severity],
        className,
      )}
    >
      <span className="mt-px shrink-0 text-2xs font-bold">{icons[severity]}</span>
      {message}
    </p>
  );
}
