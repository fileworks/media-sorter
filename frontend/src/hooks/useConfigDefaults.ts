import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { activeRecipeId, allRecipes } from "@/lib/configRecipes";
import type { Config, SavedRecipe } from "@/types/api";

/**
 * The factory-default config, fetched from the backend so "deviates from
 * default" detection is always accurate (no client-side mirror to drift). The
 * defaults are immutable for a given build → cached for the whole session.
 */
export function useConfigDefaults() {
  const { data } = useQuery<Partial<Config>>({
    queryKey: ["config", "defaults"],
    queryFn: () => api.getConfigDefaults(),
    staleTime: Infinity,
    gcTime: Infinity,
  });
  return data;
}

/** Where the "you changed this" marker measures from, and what to call it. */
export interface SettingsBaseline {
  values: Partial<Config> | undefined;
  /**
   * The recipe the baseline came from, or `null` when it is the factory
   * defaults. The marker names it, because "changed" is only a useful word once
   * the reader knows changed *from what*.
   */
  origin: { id: string; labelKey: string; custom: boolean } | null;
}

/**
 * The baseline a setting is judged against: the selected recipe, over the
 * factory defaults for everything the recipe does not claim.
 *
 * Measuring against the factory defaults alone was right when there were no
 * recipes. With them, applying *Safe sort* marks a dozen rows as changed and
 * offers a revert that puts each one back to a shipped value the recipe
 * deliberately moved — quietly dismantling the recipe the user just chose. The
 * question at that marker is "have I deviated from *Safe sort*", not "does this
 * differ from what the product shipped with".
 *
 * Derived, never stored. `activeRecipeId` already answers "which recipe does
 * this configuration correspond to" from the configuration itself, so there is
 * no second, weaker answer to drift from it. When nothing matches — the settings
 * have been taken somewhere of their own — the baseline is the factory defaults,
 * which is exactly the old behaviour.
 */
export function useSettingsBaseline(
  config: Config | undefined,
  savedRecipes: readonly SavedRecipe[],
): SettingsBaseline {
  const defaults = useConfigDefaults();

  return useMemo<SettingsBaseline>(() => {
    if (!defaults || !config) return { values: defaults, origin: null };

    const recipes = allRecipes(savedRecipes, defaults);
    const selectedId = activeRecipeId(config, recipes);
    const selected = recipes.find((recipe) => recipe.id === selectedId);
    if (!selected) return { values: defaults, origin: null };

    return {
      values: { ...defaults, ...selected.fields(config) },
      origin: { id: selected.id, labelKey: selected.labelKey, custom: selected.custom === true },
    };
  }, [config, defaults, savedRecipes]);
}
