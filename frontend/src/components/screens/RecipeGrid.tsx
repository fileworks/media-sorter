/**
 * The recipe row: four starting points, plus whatever the user has saved.
 *
 * A recipe is presented as a choice, not as a button that fires — the selected
 * one stays marked, so the screen always answers "what am I about to do?" A
 * recipe that changes files rather than only moving them asks first, and the
 * confirmation names the fields it will write rather than saying "this cannot
 * be undone" and leaving the user to guess what "this" is.
 */

import { useState } from "react";
import { FiCheck, FiTrash2 } from "react-icons/fi";

import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/I18nContext";
import {
  CONFIG_RECIPES,
  activeRecipeId,
  applyRecipe,
  recipeChanges,
  toConfigRecipe,
  type ConfigRecipe,
} from "@/lib/configRecipes";
import { cn } from "@/lib/utils";
import type { Config, SavedRecipe } from "@/types/api";

interface RecipeGridProps {
  config: Config;
  savedRecipes: SavedRecipe[];
  onApply: (patch: Partial<Config>) => void;
  onDelete: (recipeId: string) => void;
  disabled?: boolean;
  /** A computed plan exists, so applying any recipe discards it. */
  planExists?: boolean;
}

export function RecipeGrid({
  config,
  savedRecipes,
  onApply,
  onDelete,
  disabled = false,
  planExists = false,
}: RecipeGridProps) {
  const { t } = useI18n();
  const [pending, setPending] = useState<ConfigRecipe | null>(null);

  const recipes: ConfigRecipe[] = [...CONFIG_RECIPES, ...savedRecipes.map(toConfigRecipe)];
  const selected = activeRecipeId(config, recipes);

  const commit = (recipe: ConfigRecipe) => {
    onApply(applyRecipe(config, recipe));
    setPending(null);
  };

  // A custom recipe carries its name literally; a built-in carries a message key.
  const nameOf = (recipe: ConfigRecipe) => (recipe.custom ? recipe.labelKey : t(recipe.labelKey));

  return (
    <section aria-labelledby="recipe-title">
      <h2 id="recipe-title" className="text-sm font-bold text-foreground">
        {t("recipes.title")}
      </h2>
      <p className="mb-3.5 mt-0.5 text-xs text-muted-foreground">{t("recipes.help")}</p>

      <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {recipes.map((recipe) => {
          const active = selected === recipe.id;
          return (
            <li key={recipe.id} className="relative">
              <button
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() =>
                  recipe.irreversible || planExists ? setPending(recipe) : commit(recipe)
                }
                className={cn(
                  "flex h-full w-full flex-col rounded-xl p-4 text-left transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  "disabled:cursor-not-allowed disabled:opacity-60",
                  recipe.outline
                    ? "border border-dashed border-border bg-transparent hover:border-faint"
                    : "bg-card hover:border-faint",
                  !recipe.outline &&
                    (active ? "border-[1.5px] border-brand" : "border border-border"),
                  recipe.outline && active && "border-[1.5px] border-solid border-brand",
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "text-xs font-bold",
                      recipe.outline && !active ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {nameOf(recipe)}
                  </span>
                  <span className="flex-1" />
                  {active && (
                    <span
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground"
                      aria-hidden
                    >
                      <FiCheck className="h-2.5 w-2.5" />
                    </span>
                  )}
                </span>
                <span
                  className={cn(
                    "mt-1.5 block text-xs leading-relaxed",
                    recipe.outline ? "text-faint" : "text-muted-foreground",
                  )}
                >
                  {t(recipe.descriptionKey)}
                </span>
                {recipe.recommended && (
                  <span className="mt-2.5 inline-block w-fit rounded-full bg-tint-success px-2.5 py-0.5 text-3xs font-semibold text-success">
                    {t("recipes.recommended")}
                  </span>
                )}
              </button>

              {recipe.custom && !disabled && (
                <Tooltip label={t("recipes.delete", { name: nameOf(recipe) })}>
                  <button
                    type="button"
                    onClick={() => onDelete(recipe.id)}
                    className="absolute right-2 top-2 rounded-lg p-1.5 text-faint transition-colors hover:bg-muted hover:text-error focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <FiTrash2 className="h-3.5 w-3.5" aria-hidden />
                  </button>
                </Tooltip>
              )}
            </li>
          );
        })}
      </ul>

      {pending && (
        <div
          className="mt-3 rounded-xl border border-warning/40 bg-tint-warning p-3.5"
          role="alert"
        >
          <p className="text-xs font-semibold text-warning">{nameOf(pending)}</p>
          {pending.irreversible && (
            <p className="mt-1 text-xs text-foreground">{t(pending.consequenceKey)}</p>
          )}
          {planExists && (
            <p className="mt-1 text-xs text-foreground">{t("recipes.discardsPlan")}</p>
          )}
          <ul className="mt-2 grid gap-x-4 text-3xs text-muted-foreground sm:grid-cols-2">
            {recipeChanges(config, applyRecipe(config, pending))
              .slice(0, 8)
              .map((change) => (
                <li key={change.key}>
                  <code className="font-mono">{change.key}</code>
                </li>
              ))}
          </ul>
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
    </section>
  );
}
