import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { SectionId } from "@/components/config/constants";
import type { SectionGroup } from "@/components/config/sectionMeta";
import { useI18n } from "@/i18n/I18nContext";

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
  const { t } = useI18n();
  return (
    <nav
      aria-label={t("accessibility.settingsSections")}
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
                  "hidden select-none px-3 text-3xs font-semibold uppercase tracking-wider text-muted-foreground/70 lg:block",
                  i === 0 ? "pt-1" : "pt-3",
                )}
                aria-hidden
              >
                {t(`config.group.${it.group.toLocaleLowerCase()}`)}
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
                  className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-error/15 text-3xs font-bold leading-none text-error lg:ml-auto"
                  title={t("common.hasError")}
                  role="img"
                  aria-label={t("common.hasError")}
                >
                  !
                </span>
              ) : (
                it.active && (
                  <span
                    className="h-1.5 w-1.5 rounded-full bg-primary lg:ml-auto"
                    title={t("common.modified")}
                    aria-label={t("common.modified")}
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
