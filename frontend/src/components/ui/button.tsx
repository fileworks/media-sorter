import { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "destructive" | "ghost" | "outline";
type Size = "sm" | "default";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  className?: string;
}

const variantClasses: Record<Variant, string> = {
  default:
    "bg-primary text-primary-foreground hover:bg-primary/90 focus:ring-ring disabled:bg-primary/50",
  destructive:
    "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus:ring-destructive disabled:bg-destructive/50",
  ghost:
    "bg-transparent text-foreground hover:bg-accent hover:text-accent-foreground focus:ring-ring disabled:text-muted-foreground",
  outline:
    "bg-background border border-input text-foreground hover:bg-accent hover:text-accent-foreground focus:ring-ring disabled:text-muted-foreground",
};

const sizeClasses: Record<Size, string> = {
  default: "px-4 py-2 text-sm",
  sm: "px-3 py-1.5 text-xs",
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
      className={cn(
        "inline-flex items-center justify-center rounded-md font-medium",
        "transition-colors focus:outline-none focus:ring-2 focus:ring-offset-1",
        "active:scale-[0.98] active:transition-none",
        "disabled:cursor-not-allowed",
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
