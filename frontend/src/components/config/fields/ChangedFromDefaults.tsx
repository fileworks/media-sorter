import { useState } from "react";
import { FiChevronDown, FiRotateCcw } from "react-icons/fi";
import { cn } from "@/lib/utils";
import { useI18n } from "@/i18n/I18nContext";
import type { ConfigDiffEntry } from "@/lib/configDiff";

interface ChangedFromDefaultsProps {
  entries: ConfigDiffEntry[];
  onResetAll: () => void;
  onResetKey?: (key: string) => void;
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
  onResetKey,
  resetLabel,
  disabled,
}: ChangedFromDefaultsProps) {
  const { t } = useI18n();
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
            {t(count === 1 ? "common.sectionDiff.one" : "common.sectionDiff.other", { count })}
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
            className="flex shrink-0 items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t("common.resetSectionTitle")}
          >
            <FiRotateCcw className="h-3 w-3" />
            {resetLabel ?? t("common.resetAll")}
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
                {onResetKey && !disabled && (
                  <button
                    type="button"
                    onClick={() => onResetKey(e.key)}
                    className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-primary hover:bg-primary/10"
                    aria-label={t("settings.resetOne", { label: e.label })}
                  >
                    <FiRotateCcw className="h-3 w-3" aria-hidden />
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
