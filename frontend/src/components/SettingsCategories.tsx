/**
 * Settings, grouped and searchable, with each value saying where it came from.
 *
 * Basic categories are open; advanced ones are collapsed but still searchable,
 * because a setting nobody can find is as good as missing while a screen of
 * ninety controls is as good as unusable.
 *
 * Every control carries a scope badge — app, library, or this run — so nobody
 * has to guess whether what they just changed will be saved.
 */

import { useMemo, useState, type ReactNode } from "react";

import { useI18n } from "@/i18n/I18nContext";
import {
  categorize,
  effectiveValue,
  revertRunOverride,
  safetyConsequences,
  scopeBadge,
  searchSettings,
  unsavedState,
  type ScopedValues,
  type SettingDefinition,
} from "@/lib/configScopes";

const BADGE_CLASS = {
  neutral: "text-muted-foreground",
  info: "text-info",
  warning: "text-warning",
} as const;

interface SettingsCategoriesProps {
  definitions: SettingDefinition[];
  scopes: ScopedValues;
  defaults?: Record<string, unknown>;
  /** Renders the actual input for one setting. */
  control: (definition: SettingDefinition) => ReactNode;
  onScopesChange?: (scopes: ScopedValues) => void;
  onSave?: () => void;
}

export function SettingsCategories({
  definitions,
  scopes,
  defaults = {},
  control,
  onScopesChange,
  onSave,
}: SettingsCategoriesProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(new Set());

  const matched = useMemo(() => searchSettings(definitions, query), [definitions, query]);
  const categories = useMemo(() => categorize(matched), [matched]);
  const effective = useMemo(
    () =>
      Object.fromEntries(
        definitions.map((definition) => [
          definition.key,
          effectiveValue(definition, scopes, defaults),
        ]),
      ),
    [definitions, scopes, defaults],
  );
  const pending = unsavedState(definitions, scopes.profile, scopes.profile);
  const consequences = safetyConsequences(effective);

  const searching = query.trim().length > 0;

  return (
    <section className="space-y-4">
      <label className="block">
        <span className="sr-only">Search settings</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("settings.search", undefined, "Search settings…")}
          className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
        />
      </label>

      {categories.length === 0 && (
        <p className="text-sm text-muted-foreground">Nothing matches “{query}”.</p>
      )}

      {categories.map((category) => {
        const expanded = searching || !category.advanced || open.has(category.id);
        return (
          <section key={category.id} className="rounded-lg border border-border">
            <button
              type="button"
              aria-expanded={expanded}
              onClick={() =>
                setOpen((current) => {
                  const next = new Set(current);
                  if (next.has(category.id)) next.delete(category.id);
                  else next.add(category.id);
                  return next;
                })
              }
              className="flex w-full items-center justify-between px-3 py-2 text-left"
            >
              <span className="text-sm text-foreground">{category.label}</span>
              <span className="text-2xs text-muted-foreground">
                {category.advanced ? "Advanced" : ""} {category.settings.length}
              </span>
            </button>

            {expanded && (
              <ul className="divide-y divide-border border-t border-border">
                {category.settings.map((definition) => {
                  const setting = effective[definition.key];
                  const badge = scopeBadge(setting);
                  return (
                    <li key={definition.key} className="space-y-1 px-3 py-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-sm text-foreground">{definition.label}</span>
                        <span className={`text-2xs ${BADGE_CLASS[badge.tone]}`} title={badge.title}>
                          {badge.label}
                        </span>
                      </div>
                      {control(definition)}
                      {setting.overridden && onScopesChange && (
                        <button
                          type="button"
                          onClick={() => onScopesChange(revertRunOverride(scopes, definition.key))}
                          className="text-2xs text-muted-foreground underline"
                        >
                          Use the saved value instead
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        );
      })}

      {consequences.length > 0 && (
        <div className="rounded-lg border border-border p-3">
          <h3 className="text-sm text-foreground">What this run will do</h3>
          <ul className="mt-1 space-y-1 text-xs">
            {consequences.map((consequence) => (
              <li
                key={consequence.key}
                className={
                  consequence.severity === "warning" ? "text-warning" : "text-muted-foreground"
                }
              >
                {consequence.text}
              </li>
            ))}
          </ul>
        </div>
      )}

      {onSave && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={onSave}
            className="rounded-lg border border-primary px-3 py-1 text-sm text-primary"
          >
            Save to this library
          </button>
          <span className="text-xs text-muted-foreground">{pending.summary}</span>
        </div>
      )}
    </section>
  );
}
