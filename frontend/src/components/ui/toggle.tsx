import { cn } from "@/lib/utils";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label?: string;
  id?: string;
}

export function Toggle({ checked, onChange, disabled = false, label, id }: ToggleProps) {
  return (
    <span
      className={cn(
        "relative inline-flex h-6 w-9 shrink-0 items-center rounded-full",
        disabled && "cursor-not-allowed",
      )}
    >
      <input
        type="checkbox"
        role="switch"
        checked={checked}
        aria-label={label}
        id={id}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="toggle-control peer absolute inset-0 z-10 m-0 h-full w-full cursor-pointer appearance-none rounded-full opacity-0 focus-visible:outline-none disabled:cursor-not-allowed"
      />
      <span
        className={cn(
          "pointer-events-none absolute inset-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out",
          "peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2",
          disabled ? "border-border bg-muted" : checked ? "bg-primary" : "bg-input",
        )}
        aria-hidden
      >
        <span
          className={cn(
            "absolute left-0 top-1/2 block h-4 w-4 -translate-y-1/2 rounded-full bg-background shadow-lg ring-0",
            "transition-transform duration-200 ease-in-out",
            checked ? "translate-x-4" : "translate-x-0",
            disabled && "bg-faint shadow-none",
          )}
        />
      </span>
    </span>
  );
}
