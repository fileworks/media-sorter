import { useState } from "react";
import type { IconType } from "react-icons";
import { FiCopy, FiMove, FiSearch } from "react-icons/fi";

import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nContext";
import {
  CONFIG_RECIPES,
  applyRecipe,
  recipeChanges,
  type ConfigRecipe,
  type RecipeChange,
} from "@/lib/configRecipes";
import type { Config } from "@/types/api";

const RECIPE_ICONS: Record<ConfigRecipe["id"], IconType> = {
  duplicates_only: FiSearch,
  full_cleanup: FiMove,
  copy_cleanup: FiCopy,
};

function displayValue(value: unknown): string {
  if (typeof value === "boolean") return value ? "on" : "off";
  if (Array.isArray(value)) return value.join(", ");
  if (value && typeof value === "object") return "updated safety permissions";
  return String(value);
}

export function RecipeChooser({
  config,
  onApply,
}: {
  config: Config;
  onApply: (patch: Partial<Config>) => void;
}) {
  const { t } = useI18n();
  const [pending, setPending] = useState<ConfigRecipe | null>(null);
  const [applied, setApplied] = useState<RecipeChange[]>([]);

  const commit = (recipe: ConfigRecipe) => {
    const patch = applyRecipe(config, recipe);
    const changes = recipeChanges(config, patch);
    onApply(patch);
    setApplied(changes);
    setPending(null);
  };

  return (
    <section
      className="space-y-3 rounded-xl border border-border p-4"
      aria-labelledby="recipe-title"
    >
      <header>
        <h2 id="recipe-title" className="text-sm font-semibold text-foreground">
          {t("recipes.title")}
        </h2>
        <p className="text-xs text-muted-foreground">{t("recipes.help")}</p>
      </header>

      <div className="grid gap-2 md:grid-cols-3">
        {CONFIG_RECIPES.map((recipe) => {
          const Icon = RECIPE_ICONS[recipe.id];
          return (
            <button
              key={recipe.id}
              type="button"
              onClick={() => (recipe.irreversible ? setPending(recipe) : commit(recipe))}
              className="group rounded-xl border border-border/80 bg-card p-3.5 text-left shadow-sm transition-all hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <span className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                <Icon className="h-4 w-4" aria-hidden />
              </span>
              <span className="block text-sm font-semibold text-foreground">
                {t(recipe.labelKey)}
              </span>
              <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                {t(recipe.descriptionKey)}
              </span>
              <span
                className={`mt-2.5 block text-[11px] leading-relaxed ${
                  recipe.irreversible ? "text-warning" : "text-success"
                }`}
              >
                {t(recipe.consequenceKey)}
              </span>
            </button>
          );
        })}
      </div>

      {pending && (
        <div className="rounded-lg border border-warning/40 bg-warning/5 p-3" role="alert">
          <p className="text-sm font-medium text-warning">{t(pending.labelKey)}</p>
          <p className="mt-1 text-xs text-foreground">{t(pending.consequenceKey)}</p>
          <div className="mt-3 flex gap-2">
            <Button size="sm" onClick={() => commit(pending)}>
              {t("recipes.apply")}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setPending(null)}>
              {t("common.cancel")}
            </Button>
          </div>
        </div>
      )}

      {applied.length > 0 && (
        <div className="rounded-lg border border-success/30 bg-success/5 p-3" role="status">
          <p className="text-xs font-medium text-success">
            {t("recipes.changed", { count: applied.length })}
          </p>
          <ul className="mt-1 grid gap-x-4 text-[11px] text-muted-foreground sm:grid-cols-2">
            {applied.map((change) => (
              <li key={change.key}>
                <code>{change.key}</code>: {displayValue(change.after)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
