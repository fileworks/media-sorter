import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { SectionId } from "@/components/config/constants";
import type { SectionGroup } from "@/components/config/sectionMeta";

export function SettingsRail({
  items,
  selected,
  onSelect,
}: {
  items: {
    id: SectionId;
    label: string;
    icon: ReactNode;
    active: boolean;
    error: boolean;
    group: SectionGroup;
  }[];
  selected: SectionId;
  onSelect: (id: SectionId) => void;
}) {
  return (
    <nav
      aria-label="Settings sections"
      className="flex gap-1 overflow-x-auto lg:flex-col lg:gap-0.5 lg:overflow-visible"
    >
      {items.map((it, i) => {
        // Group headers read the vertical rail as three blocks; in the
        // horizontal (mobile) layout they would break scrolling, so they are
        // desktop-only.
        const isGroupStart = i === 0 || items[i - 1].group !== it.group;
        return (
          <div key={it.id} className="contents">
            {isGroupStart && (
              <p
                className={cn(
                  "hidden select-none px-3 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70 lg:block",
                  i === 0 ? "pt-1" : "pt-3",
                )}
                aria-hidden
              >
                {it.group}
              </p>
            )}
            <button
              type="button"
              onClick={() => onSelect(it.id)}
              aria-current={selected === it.id ? "page" : undefined}
              className={cn(
                "flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md px-3 py-2 text-sm transition-colors lg:w-full",
                selected === it.id
                  ? "bg-primary/10 font-medium text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <span className="text-muted-foreground">{it.icon}</span>
              <span>{it.label}</span>
              {it.error ? (
                <span
                  className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-error/15 text-[9px] font-bold leading-none text-error lg:ml-auto"
                  title="This section has an error that needs fixing"
                  role="img"
                  aria-label="Has an error"
                >
                  !
                </span>
              ) : (
                it.active && (
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-primary lg:ml-auto"
                    title="Modified"
                    aria-label="Modified from default"
                  />
                )
              )}
            </button>
          </div>
        );
      })}
    </nav>
  );
}
