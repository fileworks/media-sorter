import { useState } from "react";
import { FiChevronDown, FiRotateCcw } from "react-icons/fi";
import { cn } from "@/lib/utils";
import type { ConfigDiffEntry } from "@/lib/configDiff";

interface ChangedFromDefaultsProps {
  entries: ConfigDiffEntry[];
  onResetAll: () => void;
  /** Label for the reset button; defaults to "Reset all". */
  resetLabel?: string;
  disabled?: boolean;
}

/**
 * Compact, accurate summary of which settings deviate from the factory defaults
 * and how. Collapsed by default; expands to a "current ← default" list. Driven
 * by the backend's own defaults so it never drifts from the real Config.
 */
export function ChangedFromDefaults({
  entries,
  onResetAll,
  resetLabel = "Reset all",
  disabled,
}: ChangedFromDefaultsProps) {
  const [open, setOpen] = useState(false);
  const count = entries.length;

  if (count === 0) {
    return null;
  }

  return (
    <div className="mb-4 rounded-lg border border-primary/30 bg-primary/5">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex flex-1 items-center gap-2 text-left text-xs font-medium text-foreground"
          aria-expanded={open}
        >
          <span className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-primary" />
          <span>
            {count} {count === 1 ? "setting" : "settings"} in this section{" "}
            {count === 1 ? "differs" : "differ"} from defaults
          </span>
          <FiChevronDown
            className={cn(
              "h-3.5 w-3.5 text-muted-foreground transition-transform",
              open && "rotate-180",
            )}
          />
        </button>
        {!disabled && (
          <button
            type="button"
            onClick={onResetAll}
            className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10"
            title="Reset this section's settings to their defaults"
          >
            <FiRotateCcw className="h-3 w-3" />
            {resetLabel}
          </button>
        )}
      </div>

      {open && (
        <ul className="space-y-1 border-t border-primary/20 px-3 py-2 text-xs">
          {entries.map((e) => (
            <li key={e.key} className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">{e.label}</span>
              <span className="flex items-baseline gap-1.5 text-right">
                <span className="font-medium text-foreground">{e.current}</span>
                <span className="text-muted-foreground/60 line-through">{e.default}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
