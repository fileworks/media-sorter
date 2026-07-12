/**
 * FormRow wraps a single config option: label (clickable) + toggle/input + help icon.
 * Ensures consistent spacing and alignment across ConfigPanel.
 */
import * as React from "react";
import { cn } from "@/lib/utils";
import { InfoTooltip } from "./info-tooltip";
import { Label } from "./label";

interface FormRowProps {
  label: string;
  htmlFor?: string;
  help?: React.ReactNode;
  helpSide?: "top" | "bottom" | "left" | "right";
  children: React.ReactNode;
  className?: string;
  /** If true, label and control are side-by-side (for toggles/checkboxes). */
  inline?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

export function FormRow({
  label,
  htmlFor,
  help,
  helpSide,
  children,
  className,
  inline = false,
  disabled,
  disabledReason,
}: FormRowProps) {
  return (
    <div className={cn("group relative", className)}>
      {inline ? (
        /* Toggle-style: control on left, label on right. The disabled reason
         * gets its own line *below* the row (indented to line up under the
         * label, past the toggle) rather than being crammed onto the same
         * flex row. */
        <>
          <div className="flex items-center gap-3">
            {children}
            <div className="flex flex-1 items-center gap-1.5">
              <Label
                htmlFor={htmlFor}
                className={cn(
                  "cursor-pointer text-sm font-normal",
                  disabled && "cursor-not-allowed opacity-50",
                )}
              >
                {label}
              </Label>
              {help && <InfoTooltip content={help} side={helpSide ?? "top"} />}
            </div>
          </div>
          {disabled && disabledReason && (
            <p className="mt-1 pl-12 text-xs text-muted-foreground">{disabledReason}</p>
          )}
        </>
      ) : (
        /* Stacked: label above, control below */
        <div className="space-y-1.5">
          <div className="flex items-center gap-1.5">
            <Label
              htmlFor={htmlFor}
              className={cn("text-sm font-medium", disabled && "opacity-50")}
            >
              {label}
            </Label>
            {help && <InfoTooltip content={help} side={helpSide ?? "right"} />}
          </div>
          {children}
          {disabled && disabledReason && (
            <p className="text-xs text-muted-foreground">{disabledReason}</p>
          )}
        </div>
      )}
    </div>
  );
}
