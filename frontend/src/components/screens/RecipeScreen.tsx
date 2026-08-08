/**
 * Stage 2 — the starting point everything else adjusts.
 *
 * Picking a recipe writes fifteen settings in one click. That made it the
 * largest decision in the flow and, until it got its own stage, the first card
 * *inside* Configure — visually a peer of the smallest decisions and sitting
 * above the screen's own heading. It is now named in the stepper, named in
 * Configure's heading, and revisitable without hunting for it.
 *
 * The difference region below the grid is permanent. It reserves its space
 * whether or not a card is being read, so choosing one never shifts the grid
 * above it, and a recipe whose diff is empty says so rather than looking like a
 * click that did nothing.
 *
 * `irreversible` sets the region's tone and adds the sentence about what the
 * recipe does to files. It does not decide whether the user is shown what they
 * are about to change: that is shown every time.
 */

import { useMemo, useState } from "react";

import { SettingChangeTable, type ResetRow } from "@/components/config/ResetDialog";
import { RecipeGrid } from "@/components/screens/RecipeGrid";
import { ScreenHeader } from "@/components/screens/ScreenHeader";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/i18n/I18nContext";
import { configFieldLabel, formatConfigValue } from "@/lib/configDiff";
import {
  CONFIG_RECIPES,
  activeRecipeId,
  allRecipes,
  applyRecipe,
  recipeChanges,
  recipeName,
  unclaimedDefaults,
  type ConfigRecipe,
} from "@/lib/configRecipes";
import { CAPABILITY_FIELDS, unauthorizedCapabilities } from "@/lib/configGates";
import { cn } from "@/lib/utils";
import type { Config, SavedRecipe } from "@/types/api";

interface RecipeScreenProps {
  config: Config;
  savedRecipes: SavedRecipe[];
  onApply: (patch: Partial<Config>) => void;
  onDelete: (recipeId: string) => void;
  disabled?: boolean;
  /** A computed plan exists, so applying any recipe discards it. */
  planExists?: boolean;
  /**
   * The factory defaults, which the **Blank** card restores. Absent while they
   * are still loading — and then the card is not offered, rather than offered
   * and doing nothing.
   */
  defaults?: Partial<Config>;
}

export function RecipeScreen({
  config,
  savedRecipes,
  onApply,
  onDelete,
  disabled = false,
  planExists = false,
  defaults,
}: RecipeScreenProps) {
  const { t } = useI18n();

  // The same list Configure resolves its baseline from — two lists is how a
  // heading and a marker come to disagree about which recipe is in force.
  const recipes = useMemo<ConfigRecipe[]>(
    () => allRecipes(savedRecipes, defaults),
    [defaults, savedRecipes],
  );

  const selectedId = activeRecipeId(config, recipes);

  // On a first run nothing matches, so the region would open empty and the
  // recommended card would be a thing to notice rather than a thing already
  // chosen. Opening on it means a user who wants the recommendation reads what
  // it would do and applies it, and a user who does not simply continues.
  const [pendingId, setPendingId] = useState<string | null>(
    () => selectedId ?? CONFIG_RECIPES.find((recipe) => recipe.recommended)?.id ?? null,
  );
  const pending = recipes.find((recipe) => recipe.id === pendingId) ?? null;

  /**
   * Whether to also return the settings this recipe does not claim to their
   * defaults.
   *
   * Off unless asked for, and reset after every application: it is a decision
   * about this one application, not a mode the screen carries. Keyed off nothing
   * persisted, so the narrow behaviour is what happens by default, exactly as
   * before.
   */
  const [resetOthers, setResetOthers] = useState(false);

  const recipePatch = pending ? applyRecipe(config, pending) : null;
  // Compute the wider destination even while it is not selected. Its rows are
  // the stable universe of the comparison: checking the option may reveal and
  // emphasise a column, but it must not insert rows under the reader.
  const defaultsPatch = pending ? unclaimedDefaults(pending, config, defaults) : {};
  const fullPatch = recipePatch ? { ...recipePatch, ...defaultsPatch } : null;
  const patch = resetOthers ? fullPatch : recipePatch;
  const result = patch ? ({ ...config, ...patch } as Config) : null;

  const rowsFor = (candidate: Partial<Config> | null): ResetRow[] =>
    candidate
      ? recipeChanges(config, candidate).map((change) => ({
          key: String(change.key),
          setting: configFieldLabel(change.key),
          current: formatConfigValue(change.before),
          result: formatConfigValue(change.after),
        }))
      : [];
  const recipeRows = rowsFor(recipePatch);
  const recipeResult = { ...config, ...recipePatch } as Config;
  const fullRows = rowsFor(fullPatch).map((row) => ({
    ...row,
    unchanged:
      JSON.stringify(({ ...config, ...fullPatch } as Config)[row.key as keyof Config]) ===
      JSON.stringify(recipeResult[row.key as keyof Config]),
  }));
  const activeRows = resetOthers ? fullRows : recipeRows;
  const rowUniverse = [...recipeRows, ...fullRows];

  // The settings that would make the backend refuse the result. Should always
  // be empty — every recipe now leaves a coherent configuration — but a saved
  // recipe is user data, and a card that produces a dead end should say so here
  // rather than through a disabled button two stages away.
  const unauthorized = result
    ? [
        ...new Set(
          unauthorizedCapabilities(result).flatMap((capability) => CAPABILITY_FIELDS[capability]),
        ),
      ].filter((field) => Boolean(result[field]))
    : [];

  return (
    <div>
      <ScreenHeader title={t("recipes.title")} subtitle={t("recipes.help")} />

      <RecipeGrid
        recipes={recipes}
        selectedId={selectedId}
        pendingId={pendingId}
        onSelect={(recipe) => setPendingId(recipe.id)}
        onDelete={onDelete}
        disabled={disabled}
      />

      <section
        aria-labelledby="recipe-difference"
        className="mt-4 min-h-[9rem] rounded-xl border border-border bg-card p-4"
        aria-live="polite"
      >
        <h2 id="recipe-difference" className="text-xs font-bold text-foreground">
          {pending ? recipeName(pending, t) : t("recipes.difference.none")}
        </h2>

        {!pending ? (
          <p className="mt-1.5 text-xs text-muted-foreground">{t("recipes.difference.pick")}</p>
        ) : (
          <>
            {pending.irreversible && (
              <p
                className={cn(
                  "mt-1.5 rounded-lg border border-warning/40 bg-tint-warning px-3 py-2 text-xs text-foreground",
                )}
              >
                {t(pending.consequenceKey)}
              </p>
            )}
            {planExists && activeRows.length > 0 && (
              <p className="mt-1.5 text-xs text-foreground">{t("recipes.discardsPlan")}</p>
            )}

            {unauthorized.length > 0 && (
              /*
               * The backend would refuse this configuration. Said here, before
               * the click, naming the settings responsible — rather than after,
               * as a dead primary action listing fields nobody touched.
               */
              <p className="mt-1.5 text-xs font-medium text-error" role="alert">
                {t("recipes.wouldNotValidate", {
                  settings: unauthorized.map(configFieldLabel).join(", "),
                })}
              </p>
            )}

            {activeRows.length === 0 && (
              <p className="mt-2.5 text-xs text-muted-foreground">
                {selectedId === pending.id ? t("recipes.inForce") : t("recipes.noChanges")}
              </p>
            )}

            {rowUniverse.length > 0 && (
              <div className="mt-2.5">
                <SettingChangeTable
                  rowUniverse={rowUniverse}
                  columns={[
                    {
                      id: "recipe",
                      label: t("recipes.comparison.afterRecipe"),
                      rows: recipeRows,
                      emphasized: !resetOthers,
                    },
                    ...(resetOthers
                      ? [
                          {
                            id: "full-reset",
                            label: t("recipes.comparison.afterFullReset"),
                            rows: fullRows,
                            emphasized: true,
                          },
                        ]
                      : []),
                  ]}
                />
              </div>
            )}

            {/* The wider scope, offered where its consequences are listed. A
                recipe stays narrow unless the user asks otherwise, and ticking
                this grows the table above rather than changing what it means. */}
            <label className="mt-3 flex items-start gap-2">
              <input
                type="checkbox"
                checked={resetOthers}
                disabled={disabled || defaults === undefined}
                onChange={(event) => setResetOthers(event.target.checked)}
                className="mt-0.5 h-3.5 w-3.5 shrink-0 rounded border-border text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-40"
              />
              <span className="min-w-0">
                <span className="block text-xs font-medium text-foreground">
                  {t("recipes.resetOthers")}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {defaults === undefined
                    ? t("recipes.resetOthers.unavailable")
                    : t("recipes.resetOthers.help")}
                </span>
              </span>
            </label>

            <div className="mt-3">
              <Button
                size="sm"
                disabled={disabled || activeRows.length === 0}
                title={activeRows.length === 0 ? t("recipes.noChanges") : undefined}
                onClick={() => {
                  onApply(patch ?? {});
                  setResetOthers(false);
                }}
              >
                {t("recipes.apply")}
              </Button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
