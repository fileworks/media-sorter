/**
 * The saved-recipe library behind the Recipe screen.
 *
 * A list and two mutations that only that screen consumes — panel data, which
 * `docs/architecture-ownership.md` keeps outside the desktop-navigation seam.
 * The page still owns what *applying* a recipe invalidates; that is a stage
 * decision and stays with the stage gates.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type RecipeSettings } from "@/services/api";

interface UseRecipesOptions {
  /** Nothing is fetched until the backend answers. */
  enabled: boolean;
  onSaved: (name: string) => void;
  onDeleteFailed: () => void;
}

export function useRecipes({ enabled, onSaved, onDeleteFailed }: UseRecipesOptions) {
  const queryClient = useQueryClient();

  const { data: savedRecipes = [] } = useQuery({
    queryKey: ["recipes"],
    queryFn: () => api.listRecipes(),
    enabled,
    staleTime: 60_000,
  });

  const saveRecipe = useMutation({
    mutationFn: ({ name, settings }: { name: string; settings: RecipeSettings }) =>
      api.saveRecipe(name, settings),
    onSuccess: (recipe) => {
      void queryClient.invalidateQueries({ queryKey: ["recipes"] });
      onSaved(recipe.name);
    },
  });

  const deleteRecipe = useMutation({
    mutationFn: (recipeId: string) => api.deleteRecipe(recipeId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["recipes"] }),
    onError: onDeleteFailed,
  });

  return { savedRecipes, saveRecipe, deleteRecipe };
}
