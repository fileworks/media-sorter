import { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "destructive" | "ghost" | "outline";
type Size = "sm" | "default" | "icon";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  className?: string;
}

// One hover per variant, and `focus-visible` rather than `focus` throughout:
// a `focus` ring fires on a mouse click too, which is why a pressed button here
// used to keep a ring that no other control in the app draws.
const variantClasses: Record<Variant, string> = {
  default:
    "border-primary bg-primary text-primary-foreground hover:border-primary-hover hover:bg-primary-hover focus-visible:ring-ring",
  destructive:
    "border-destructive bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive",
  ghost:
    "border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring",
  // The outline button darkens its edge *and* raises its fill on hover. Fill
  // alone left it indistinguishable from a hovered row behind it.
  outline:
    "border-border bg-card text-foreground hover:border-border-strong hover:bg-muted focus-visible:ring-ring",
};

// One weight and one type size across all three, from `--text-ui` in the
// mockup: a control label is not body copy, and letting the default button
// carry 14px made every toolbar taller than the rails around it.
const sizeClasses: Record<Size, string> = {
  default: "min-h-[2.375rem] gap-1.5 px-2.5 py-1.5 text-2xs",
  sm: "min-h-8 gap-1.5 px-2.5 py-1 text-2xs",
  icon: "h-9 w-9 p-0 text-2xs",
};

export function Button({
  variant = "default",
  size = "default",
  className = "",
  children,
  disabled,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled}
      data-size={size}
      className={cn(
        "ui-button inline-flex shrink-0 items-center justify-center rounded-control border font-semibold tracking-[0.02em] [&>svg]:shrink-0",
        "transition-[background-color,border-color,color,transform] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        // The press is a nudge downward, not a shrink: at these sizes a scale
        // reflows the label and the icon beside it reads as a stutter.
        "active:translate-y-px active:transition-none",
        "disabled:cursor-not-allowed disabled:opacity-45 disabled:active:translate-y-0",
        variantClasses[variant],
        sizeClasses[size],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
