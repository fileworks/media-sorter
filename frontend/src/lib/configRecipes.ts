/**
 * Starting points, not destinations.
 *
 * A recipe writes a named set of fields and nothing else — which is what makes
 * "everything is adjustable in the next step" true rather than a slogan. The
 * field set is explicit per recipe so the diff shown before applying is the
 * whole truth, and so a recipe can never quietly reach into a setting it does
 * not claim.
 *
 * The four here mirror the four cards on the Sources screen, in that order.
 */

import type { Config, SavedRecipe } from "@/types/api";
import { diffConfig } from "@/lib/configDiff";

export interface ConfigRecipe {
  id: string;
  labelKey: string;
  descriptionKey: string;
  consequenceKey: string;
  /** Surfaces a confirmation step: this one changes files, not just placement. */
  irreversible: boolean;
  /** The single card the design marks "Recommended". */
  recommended?: boolean;
  /** Drawn as an outline card — it takes options away rather than adding them. */
  outline?: boolean;
  /** A user's own saved recipe, deletable; built-ins are not. */
  custom?: boolean;
  fields: (current: Config) => Partial<Config>;
}

function organizeOnly(current: Config): Config["preservation_profile"] {
  return {
    ...current.preservation_profile,
    mode: "organize_only",
    allow_repair: false,
    allow_conversion: false,
    allow_compression: false,
    authorization_origin: "run_override",
    requires_review: false,
  };
}

function mutationProfile(current: Config): Config["preservation_profile"] {
  return {
    ...current.preservation_profile,
    mode: "explicit_mutation",
    allow_repair: true,
    allow_conversion: true,
    allow_compression: true,
    authorization_origin: "run_override",
    acknowledged_at: new Date().toISOString(),
    requires_review: false,
  };
}

function optimizationProfile(current: Config): Config["optimization_profile"] {
  return {
    ...current.optimization_profile,
    profile_id: "recipe-visually-lossless",
    name: "Recipe: visually lossless conversion",
    mode: "visually_lossless",
    acknowledged_at: new Date().toISOString(),
    tool: "bundled",
    tool_version: "managed",
    parameters: {},
    validation_contract: "recipe-preview-v1",
    retain_original: true,
  };
}

function disabledOptimization(current: Config): Config["optimization_profile"] {
  return {
    ...current.optimization_profile,
    profile_id: "optimization-disabled",
    name: "Optimization disabled",
    mode: "disabled",
    acknowledged_at: null,
    tool: null,
    tool_version: null,
    parameters: {},
    validation_contract: null,
    retain_original: true,
  };
}

export const CONFIG_RECIPES: readonly ConfigRecipe[] = [
  {
    // Copy, date folders, duplicates parked. Nothing in the input folder moves
    // and nothing anywhere is rewritten — the only recipe that is true no-ops
    // away from a mistake.
    id: "safe_sort",
    labelKey: "recipes.safeSort.label",
    descriptionKey: "recipes.safeSort.description",
    consequenceKey: "recipes.safeSort.consequence",
    irreversible: false,
    recommended: true,
    fields: (current) => ({
      run_mode: "organize",
      sort: true,
      sort_criteria: ["year", "month"],
      copy_instead_of_move: true,
      remove_duplicates: true,
      duplicate_exact_enabled: true,
      duplicate_perceptual_enabled: true,
      junk_filter_enabled: false,
      convert_images: false,
      convert_videos: false,
      repair_enabled: false,
      preservation_profile: organizeOnly(current),
      optimization_profile: disabledOptimization(current),
    }),
  },
  {
    // Move, so the input folder actually empties, with junk parked too. Content
    // is still untouched — relocating a file is organizing, not rewriting — but
    // the originals do leave, so it asks first.
    id: "clean_sweep",
    labelKey: "recipes.cleanSweep.label",
    descriptionKey: "recipes.cleanSweep.description",
    consequenceKey: "recipes.cleanSweep.consequence",
    irreversible: true,
    fields: (current) => ({
      run_mode: "organize",
      sort: true,
      sort_criteria: ["year", "month"],
      copy_instead_of_move: false,
      remove_duplicates: true,
      duplicate_exact_enabled: true,
      duplicate_perceptual_enabled: true,
      junk_filter_enabled: true,
      convert_images: false,
      convert_videos: false,
      repair_enabled: false,
      preservation_profile: organizeOnly(current),
      optimization_profile: disabledOptimization(current),
    }),
  },
  {
    // The only recipe that rewrites pixels and frames, so it is the only one
    // that turns on explicit mutation and a validated optimization contract.
    id: "archive_convert",
    labelKey: "recipes.archiveConvert.label",
    descriptionKey: "recipes.archiveConvert.description",
    consequenceKey: "recipes.archiveConvert.consequence",
    irreversible: true,
    fields: (current) => ({
      run_mode: "organize",
      sort: true,
      sort_criteria: ["year", "month"],
      copy_instead_of_move: true,
      remove_duplicates: true,
      duplicate_exact_enabled: true,
      duplicate_perceptual_enabled: true,
      junk_filter_enabled: true,
      convert_images: true,
      image_format: "jpeg",
      convert_videos: true,
      video_format: "mp4",
      repair_enabled: true,
      preservation_profile: mutationProfile(current),
      optimization_profile: optimizationProfile(current),
    }),
  },
  {
    // Everything off. Not a shortcut — a clean slate to build a recipe on.
    // Use case (c): the input tree is already organised the way its owner
    // wants it. They want the duplicates gone and nothing else touched, which
    // is why this is a run mode and not a sort with everything switched off.
    id: "find_duplicates_only",
    labelKey: "recipes.findDuplicatesOnly.label",
    descriptionKey: "recipes.findDuplicatesOnly.description",
    consequenceKey: "recipes.findDuplicatesOnly.consequence",
    irreversible: false,
    fields: (current) => ({
      run_mode: "deduplicate_only" as const,
      sort: true,
      remove_duplicates: true,
      duplicate_exact_enabled: true,
      duplicate_perceptual_enabled: true,
      junk_filter_enabled: false,
      convert_images: false,
      convert_videos: false,
      repair_enabled: false,
      preservation_profile: organizeOnly(current),
      optimization_profile: disabledOptimization(current),
    }),
  },
  {
    id: "scratch",
    labelKey: "recipes.scratch.label",
    descriptionKey: "recipes.scratch.description",
    consequenceKey: "recipes.scratch.consequence",
    irreversible: false,
    outline: true,
    fields: (current) => ({
      sort: false,
      copy_instead_of_move: true,
      remove_duplicates: false,
      duplicate_exact_enabled: false,
      duplicate_perceptual_enabled: false,
      junk_filter_enabled: false,
      rename: false,
      categorize_enabled: false,
      convert_images: false,
      convert_videos: false,
      repair_enabled: false,
      rules_enabled: false,
      ai_tagging_enabled: false,
      preservation_profile: organizeOnly(current),
      optimization_profile: disabledOptimization(current),
    }),
  },
] as const;

export interface RecipeChange {
  key: keyof Config;
  before: Config[keyof Config];
  after: Config[keyof Config];
}

export function recipeChanges(current: Config, patch: Partial<Config>): RecipeChange[] {
  const next = { ...current, ...patch };
  return diffConfig(next, current).map(({ key }) => ({
    key,
    before: current[key],
    after: next[key],
  }));
}

export function applyRecipe(current: Config, recipe: ConfigRecipe): Partial<Config> {
  return recipe.fields(current);
}

/**
 * Whether the configuration still looks like the recipe that produced it.
 *
 * Only the fields the recipe claims are compared, and the two profile objects
 * only by mode: a recipe is a posture, and an acknowledgement timestamp moving
 * on does not mean the user has left it.
 */
export function matchesRecipe(current: Config, recipe: ConfigRecipe): boolean {
  const patch = recipe.fields(current);
  return (Object.keys(patch) as (keyof Config)[]).every((key) => {
    const wanted = patch[key];
    const actual = current[key];
    if (key === "preservation_profile" || key === "optimization_profile") {
      return (
        (wanted as { mode?: string } | undefined)?.mode ===
        (actual as { mode?: string } | undefined)?.mode
      );
    }
    if (Array.isArray(wanted) && Array.isArray(actual)) {
      return wanted.length === actual.length && wanted.every((item, i) => item === actual[i]);
    }
    return wanted === actual;
  });
}

/** The recipe the current configuration corresponds to, if any still does. */
export function activeRecipeId(current: Config, recipes: readonly ConfigRecipe[]): string | null {
  return recipes.find((recipe) => matchesRecipe(current, recipe))?.id ?? null;
}

/** The exact fields a "save as recipe" snapshot captures. */
export const RECIPE_SETTING_KEYS = [
  "run_mode",
  "sort",
  "sort_criteria",
  "copy_instead_of_move",
  "rename",
  "rename_pattern",
  "remove_duplicates",
  "duplicate_exact_enabled",
  "duplicate_perceptual_enabled",
  "duplicate_perceptual_threshold",
  "duplicate_keeper_policy",
  "junk_filter_enabled",
  "categorize_enabled",
  "convert_images",
  "image_format",
  "image_quality",
  "convert_videos",
  "video_format",
  "video_quality",
  "repair_enabled",
  "rules_enabled",
  "ai_tagging_enabled",
  "embed_tags_in_files",
  "ai_model_tier",
] as const satisfies readonly (keyof Config)[];

export type RecipeSettingKey = (typeof RECIPE_SETTING_KEYS)[number];

/**
 * "Blank (defaults)" — every recipe-scoped setting back to what it shipped as.
 *
 * Not the same card as **From scratch**, which switches every optional stage
 * *off*. The factory default has duplicate detection on and a date structure
 * set; a user who has been experimenting and wants the product's own opinion
 * back has, until now, had no card that gives it to them.
 *
 * Built from the backend's own defaults rather than a mirror in the frontend,
 * which is why it is a function of them and not a constant: with no defaults
 * available there is nothing honest to offer, and the caller omits the card.
 */
export function blankRecipe(defaults: Partial<Config>): ConfigRecipe {
  return {
    id: "blank_defaults",
    labelKey: "recipes.blank.label",
    descriptionKey: "recipes.blank.description",
    consequenceKey: "recipes.blank.consequence",
    irreversible: false,
    outline: true,
    fields: (current) => {
      const patch: Partial<Config> = {};
      for (const key of RECIPE_SETTING_KEYS) {
        if (key in defaults) patch[key] = defaults[key] as never;
      }
      // The two profiles are not recipe settings, but every other recipe sets
      // them, so leaving them alone would make "blank" the one card that can
      // leave an explicit-mutation posture standing.
      patch.preservation_profile = defaults.preservation_profile ?? organizeOnly(current);
      patch.optimization_profile = defaults.optimization_profile ?? disabledOptimization(current);
      return patch;
    },
  };
}

/**
 * Lift the recipe-relevant slice out of a configuration, ready to persist.
 *
 * Spelled out field by field rather than looped over `RECIPE_SETTING_KEYS`, so
 * the compiler checks that the snapshot and `RecipeSettings` stay in step —
 * adding a field to one and forgetting the other becomes a build error rather
 * than a recipe that silently drops a setting.
 */
export function captureRecipeSettings(config: Config): SavedRecipe["settings"] {
  return {
    run_mode: config.run_mode,
    sort: config.sort,
    sort_criteria: config.sort_criteria,
    copy_instead_of_move: config.copy_instead_of_move,
    rename: config.rename,
    rename_pattern: config.rename_pattern,
    remove_duplicates: config.remove_duplicates,
    duplicate_exact_enabled: config.duplicate_exact_enabled,
    duplicate_perceptual_enabled: config.duplicate_perceptual_enabled,
    duplicate_perceptual_threshold: config.duplicate_perceptual_threshold,
    duplicate_keeper_policy: config.duplicate_keeper_policy,
    junk_filter_enabled: config.junk_filter_enabled,
    categorize_enabled: config.categorize_enabled,
    convert_images: config.convert_images,
    image_format: config.image_format,
    image_quality: config.image_quality,
    convert_videos: config.convert_videos,
    video_format: config.video_format,
    video_quality: config.video_quality,
    repair_enabled: config.repair_enabled,
    rules_enabled: config.rules_enabled,
    ai_tagging_enabled: config.ai_tagging_enabled,
    embed_tags_in_files: config.embed_tags_in_files,
    ai_model_tier: config.ai_model_tier,
  };
}

/** Present a persisted recipe using the same shape as the built-ins. */
export function toConfigRecipe(saved: SavedRecipe): ConfigRecipe {
  return {
    id: saved.recipe_id,
    labelKey: saved.name,
    descriptionKey: "recipes.custom.description",
    consequenceKey: "recipes.custom.consequence",
    irreversible: !saved.settings.copy_instead_of_move,
    custom: true,
    fields: (current) => ({
      ...saved.settings,
      preservation_profile:
        saved.settings.convert_images || saved.settings.convert_videos
          ? mutationProfile(current)
          : organizeOnly(current),
      optimization_profile:
        saved.settings.convert_images || saved.settings.convert_videos
          ? optimizationProfile(current)
          : disabledOptimization(current),
    }),
  };
}
