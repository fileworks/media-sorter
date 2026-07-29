import { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type Variant = "default" | "destructive" | "ghost" | "outline";
type Size = "sm" | "default" | "icon";

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
  default: "min-h-10 gap-2 px-4 py-2 text-sm",
  sm: "min-h-8 gap-1.5 px-3 py-1.5 text-xs",
  icon: "h-9 w-9 p-0",
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
        "inline-flex shrink-0 items-center justify-center rounded-lg font-medium [&>svg]:shrink-0",
        "transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-background",
        "active:scale-[0.98] active:transition-none",
        "disabled:cursor-not-allowed disabled:active:scale-100",
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
