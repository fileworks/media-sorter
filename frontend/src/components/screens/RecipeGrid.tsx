/**
 * The recipe cards: four starting points, plus whatever the user has saved.
 *
 * A recipe is presented as a choice, not as a button that fires — the selected
 * one stays marked, so the screen always answers "what am I about to do?"
 *
 * The grid draws cards and nothing else. What a chosen card *would* change, and
 * the control that commits it, are the Recipe screen's own region below this
 * one: a panel that appears next to the thing that summoned it pushes the grid
 * down as it opens, and a screen that moves under the pointer that is choosing
 * on it is a screen people learn to distrust.
 */

import { FiCheck, FiTrash2 } from "react-icons/fi";

import { Tooltip } from "@/components/ui/tooltip";
import { useI18n } from "@/i18n/I18nContext";
import { cn } from "@/lib/utils";
import { recipeName, type ConfigRecipe } from "@/lib/configRecipes";

interface RecipeGridProps {
  recipes: readonly ConfigRecipe[];
  /** The recipe the current configuration still corresponds to, if any. */
  selectedId: string | null;
  /** The recipe whose difference is being read right now. */
  pendingId: string | null;
  onSelect: (recipe: ConfigRecipe) => void;
  onDelete: (recipeId: string) => void;
  disabled?: boolean;
}

export function RecipeGrid({
  recipes,
  selectedId,
  pendingId,
  onSelect,
  onDelete,
  disabled = false,
}: RecipeGridProps) {
  const { t } = useI18n();

  return (
    <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {recipes.map((recipe) => {
        const active = selectedId === recipe.id;
        const reading = pendingId === recipe.id;
        return (
          <li key={recipe.id} className="relative">
            <button
              type="button"
              disabled={disabled}
              aria-pressed={active}
              onClick={() => onSelect(recipe)}
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
                // Being read is not the same as being in force. A ring rather
                // than a border, so marking it costs no layout.
                reading && !active && "ring-2 ring-inset ring-brand/40",
              )}
            >
              <span className="flex items-center gap-2">
                <span
                  className={cn(
                    "text-xs font-bold",
                    recipe.outline && !active ? "text-muted-foreground" : "text-foreground",
                  )}
                >
                  {recipeName(recipe, t)}
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
              <Tooltip label={t("recipes.delete", { name: recipeName(recipe, t) })}>
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
  );
}
