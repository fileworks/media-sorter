import { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "destructive" | "ghost" | "outline" | "suggest";
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
  // A disabled ghost stays transparent. Filling it made the one action the
  // toolbar cannot take the heaviest thing in the row, above the ones it can.
  ghost:
    "border-transparent bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring disabled:border-transparent disabled:bg-transparent disabled:hover:border-transparent disabled:hover:bg-transparent",
  // The outline button darkens its edge *and* raises its fill on hover. Fill
  // alone left it indistinguishable from a hovered row behind it.
  outline:
    "border-border bg-card text-foreground hover:border-border-strong hover:bg-muted focus-visible:ring-ring",
  // "Take the recommendation", wearing the recommendation's own colours.
  // Accepting a proposal used to be a neutral outline button sitting under a
  // card that had just recommended something, so the one control that acts on
  // the recommendation was the one thing on screen not connected to it. It
  // wears `suggest` rather than `success`: this control takes an offer, and
  // the green that means "settled" belongs to what it produces, not to the
  // offer itself. Tinted rather than filled — the primary action is still the
  // choice the user made themselves.
  suggest:
    "border-suggest/40 bg-tint-suggest text-suggest hover:border-suggest hover:bg-suggest/10 focus-visible:ring-[hsl(var(--color-suggest))]",
};

// One weight and one type size across all three, from `--text-ui` in the
// mockup: a control label is not body copy, and letting the default button
// carry 14px made every toolbar taller than the rails around it.
const sizeClasses: Record<Size, string> = {
  default: "min-h-9 gap-2 px-3 py-2 text-2xs",
  sm: "min-h-8 gap-2 px-3 py-1 text-2xs",
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
        "disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-faint disabled:opacity-100 disabled:shadow-none disabled:active:translate-y-0",
        "disabled:hover:border-border disabled:hover:bg-muted disabled:hover:text-faint",
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
