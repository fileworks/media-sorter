/**
 * Starting points, not destinations.
 *
 * A recipe writes a named set of fields and nothing else — which is what makes
 * "everything is adjustable in the next step" true rather than a slogan. The
 * field set is explicit per recipe so the diff shown before applying is the
 * whole truth, and so a recipe can never quietly reach into a setting it does
 * not claim.
 *
 * ## The set, and where it comes from
 *
 * One card per *job somebody actually has*, established with the operator
 * rather than derived from the settings screen:
 *
 * | Card | The job | The shape of it |
 * | --- | --- | --- |
 * | `consolidate` | combine scattered folders or import new media | copy, dated, original names, duplicates reviewed |
 * | `tidy_library` | a library that is already organised | find duplicates and junk, place nothing |
 * | `archive_normalize` | odd formats and broken files | consolidate plus conversion and repair |
 * | `scratch` | none of the above | the smallest coherent run, to build on |
 *
 * The previous set was organised around *settings* — "safe sort", "clean
 * sweep", "archive & convert", "find duplicates only", "blank" — and two of
 * those cards differed from each other by a single boolean while nothing named
 * the recurring import, which is the job people do most often.
 *
 * Initial consolidation and recurring imports share the same safe starting
 * point. Moving and renaming are explicit adjustments, not consequences of
 * choosing an import card. The retired import_dump id stays reserved.
 *
 * Local AI tagging and categorisation are deliberately off in every card. They
 * are the one capability a recipe cannot promise: the model has to be
 * downloaded and the tier is decided by a hardware probe, so a card that
 * switched them on would be a card that sometimes describes a run the machine
 * cannot perform.
 */

import type { Config, SavedRecipe } from "@/types/api";
import { diffConfig } from "@/lib/configDiff";
import { requestedCapabilities } from "@/lib/configGates";

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

/**
 * Organize Only, *and* the settings that would contradict it.
 *
 * A profile alone is not a coherent configuration. The backend asks what a
 * configuration *requests* (`integrity_policy._requested_capabilities`), and it
 * counts `override_metadata`, and `ai_tagging_enabled && embed_tags_in_files`,
 * as requests to rewrite file bytes. A recipe that declared `organize_only`
 * while leaving either of those on produced a configuration the backend
 * refuses — disabling "Preview changes" and naming four settings the user never
 * touched, on a screen with no way forward.
 *
 * So the patch turns them off in the same breath. Returning them together is
 * the point: they are one decision, and splitting them is what let them drift.
 *
 * Every field the profile forbids is listed here, not just the two that were
 * reported. Most recipes already set `repair_enabled` and `convert_*` to false
 * themselves — but "Blank (defaults)" did not, because it only writes keys the
 * backend's defaults happen to carry, and it could therefore leave repair on
 * under a profile that refuses it. Making the invariant hold here means no
 * recipe has to remember it.
 */
function organizeOnly(current: Config): Partial<Config> {
  return {
    preservation_profile: {
      ...current.preservation_profile,
      mode: "organize_only",
      allow_embedded_metadata_edits: false,
      allow_repair: false,
      allow_conversion: false,
      allow_compression: false,
      authorization_origin: "run_override",
      requires_review: false,
    },
    override_metadata: false,
    embed_tags_in_files: false,
    repair_enabled: false,
    convert_images: false,
    convert_videos: false,
  };
}

function mutationProfile(current: Config): Config["preservation_profile"] {
  return {
    ...current.preservation_profile,
    mode: "explicit_mutation",
    allow_embedded_metadata_edits: true,
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

/** Every recipe that places files under a date names them the same way. */
const DATED_RENAME_PATTERN = "YYYY-MM-DD_NAME";

export const CONFIG_RECIPES: readonly ConfigRecipe[] = [
  {
    // Several folders and old drives into one dated library. Copy, so the
    // input tree is untouched and a wrong answer costs disk space and nothing
    // else — which is why this is the card the screen opens on.
    id: "consolidate",
    labelKey: "recipes.consolidate.label",
    descriptionKey: "recipes.consolidate.description",
    consequenceKey: "recipes.consolidate.consequence",
    irreversible: false,
    recommended: true,
    fields: (current) => ({
      run_mode: "organize",
      sort: true,
      sort_criteria: ["year", "month"],
      copy_instead_of_move: true,
      rename: false,
      rename_pattern: DATED_RENAME_PATTERN,
      remove_duplicates: true,
      duplicate_exact_enabled: true,
      duplicate_perceptual_enabled: true,
      junk_filter_enabled: true,
      categorize_enabled: false,
      ai_tagging_enabled: false,
      convert_images: false,
      convert_videos: false,
      repair_enabled: false,
      ...organizeOnly(current),
      optimization_profile: disabledOptimization(current),
    }),
  },
  {
    // The library is already the shape its owner wants. Nothing is placed by
    // date; only the copies and the junk leave where they were found.
    id: "tidy_library",
    labelKey: "recipes.tidyLibrary.label",
    descriptionKey: "recipes.tidyLibrary.description",
    consequenceKey: "recipes.tidyLibrary.consequence",
    irreversible: true,
    fields: (current) => ({
      run_mode: "deduplicate_only" as const,
      sort: true,
      copy_instead_of_move: false,
      // Nothing is placed by date in this mode, so a rename pattern would
      // describe a name no file receives.
      rename: false,
      remove_duplicates: true,
      duplicate_exact_enabled: true,
      duplicate_perceptual_enabled: true,
      junk_filter_enabled: true,
      categorize_enabled: false,
      ai_tagging_enabled: false,
      convert_images: false,
      convert_videos: false,
      repair_enabled: false,
      ...organizeOnly(current),
      optimization_profile: disabledOptimization(current),
    }),
  },
  {
    // The only recipe that rewrites pixels and frames, so it is the only one
    // that turns on explicit mutation and a validated optimization contract.
    // Copy-based: it is already rewriting content, and taking the originals
    // away in the same run would leave nothing to compare the result against.
    id: "archive_normalize",
    labelKey: "recipes.archiveNormalize.label",
    descriptionKey: "recipes.archiveNormalize.description",
    consequenceKey: "recipes.archiveNormalize.consequence",
    irreversible: true,
    fields: (current) => ({
      run_mode: "organize",
      sort: true,
      sort_criteria: ["year", "month"],
      copy_instead_of_move: true,
      rename: true,
      rename_pattern: DATED_RENAME_PATTERN,
      remove_duplicates: true,
      duplicate_exact_enabled: true,
      duplicate_perceptual_enabled: true,
      junk_filter_enabled: true,
      categorize_enabled: false,
      ai_tagging_enabled: false,
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
    // The floor, not a blank.
    //
    // There used to be two cards here — "From scratch", which switched every
    // optional stage off, and "Blank (defaults)", which restored the shipped
    // values. Between them they answered the same question twice and neither
    // answered it well: everything-off is not a configuration anybody runs,
    // and a factory dump is a card whose contents change with the build.
    //
    // One card, writing the smallest set of values that still makes a coherent
    // run: place by year, copy, catch exact duplicates. Everything that costs
    // time, rewrites bytes, or needs a model is left off for the user to add.
    id: "scratch",
    labelKey: "recipes.scratch.label",
    descriptionKey: "recipes.scratch.description",
    consequenceKey: "recipes.scratch.consequence",
    irreversible: false,
    outline: true,
    fields: (current) => ({
      run_mode: "organize",
      sort: true,
      sort_criteria: ["year"],
      copy_instead_of_move: true,
      rename: false,
      remove_duplicates: true,
      duplicate_exact_enabled: true,
      // Perceptual matching is the expensive half and the half that needs a
      // human answer per set. It is opt-in from here.
      duplicate_perceptual_enabled: false,
      junk_filter_enabled: false,
      preserve_subfolders: false,
      categorize_enabled: false,
      rules_enabled: false,
      ai_tagging_enabled: false,
      convert_images: false,
      convert_videos: false,
      repair_enabled: false,
      ...organizeOnly(current),
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

/**
 * What to call a recipe. A user's own carries its name literally; a built-in
 * carries a message key, so the two cannot be printed the same way.
 */
export function recipeName(recipe: ConfigRecipe, t: (key: string) => string): string {
  return recipe.custom ? recipe.labelKey : t(recipe.labelKey);
}

/**
 * Every recipe on offer, in the order they are shown.
 *
 * One list, built in one place: Setup draws recipe cards from it and
 * Configure resolves its baseline from it, and the two answering "which recipe
 * is this?" from different lists is how a heading and a marker come to disagree.
 */
export function allRecipes(savedRecipes: readonly SavedRecipe[]): ConfigRecipe[] {
  return [...CONFIG_RECIPES, ...savedRecipes.map(toConfigRecipe)];
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
  "recursive_scan",
  "max_recursion_depth",
  "preserve_subfolders",
  "override_metadata",
  "copy_instead_of_move",
  "companion_handling",
  "rename",
  "rename_pattern",
  "remove_duplicates",
  "duplicate_exact_enabled",
  "duplicate_perceptual_enabled",
  "duplicate_perceptual_threshold",
  "duplicate_keeper_policy",
  "burst_detection_enabled",
  "burst_time_window_seconds",
  "burst_perceptual_distance",
  "burst_require_camera_identity",
  "junk_filter_enabled",
  "junk_min_file_size_kb",
  "junk_min_image_dimension",
  "junk_filename_patterns",
  "categorize_enabled",
  "categorize_confidence_threshold",
  "categorize_min_margin",
  "convert_images",
  "image_format",
  "image_quality",
  "convert_videos",
  "video_format",
  "video_quality",
  "repair_enabled",
  "rules_enabled",
  "ai_tagging_enabled",
  "ai_tagging_confidence_threshold",
  "ai_tagging_max_tags",
  "embed_tags_in_files",
  "exclude_patterns",
  "min_file_size_kb",
  "max_file_size_mb",
  "camera_subfolder_enabled",
  "exif_sanity_check_enabled",
  "ai_model_tier",
] as const satisfies readonly (keyof Config)[];

export type RecipeSettingKey = (typeof RECIPE_SETTING_KEYS)[number];

/**
 * The settings a recipe does *not* claim, at their shipped defaults.
 *
 * A recipe writes only the fields it names, which is what makes the before/after
 * table the whole truth. The cost is that applying one to a machine that has
 * been used leaves a configuration part recipe and part archaeology: settings
 * moved in an earlier session persist in `config.json`, still differ from their
 * shipped values, and are still marked as deviating from the recipe just chosen.
 * No single action resolved that — the recipe will not touch them, and "reset
 * everything" discards the recipe too.
 *
 * So this is the missing half, offered rather than imposed: the narrow rule
 * stays the default, and the user can ask for the wider scope.
 *
 * Scoped to `RECIPE_SETTING_KEYS`, so it can never reach a setting no recipe is
 * allowed to write. The two profile objects are deliberately not among them:
 * they are the recipe's own posture, and reopening them here would let a reset
 * of the settings *around* a recipe quietly contradict it.
 */
export function unclaimedDefaults(
  recipe: ConfigRecipe,
  current: Config,
  defaults: Partial<Config> | undefined,
): Partial<Config> {
  if (!defaults) return {};
  const claimed = new Set(Object.keys(recipe.fields(current)));
  const patch: Partial<Config> = {};
  for (const key of RECIPE_SETTING_KEYS) {
    if (claimed.has(key)) continue;
    if (key in defaults) patch[key] = defaults[key] as never;
  }
  return patch;
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
    recursive_scan: config.recursive_scan,
    max_recursion_depth: config.max_recursion_depth,
    preserve_subfolders: config.preserve_subfolders,
    override_metadata: config.override_metadata,
    copy_instead_of_move: config.copy_instead_of_move,
    companion_handling: config.companion_handling,
    rename: config.rename,
    rename_pattern: config.rename_pattern,
    remove_duplicates: config.remove_duplicates,
    duplicate_exact_enabled: config.duplicate_exact_enabled,
    duplicate_perceptual_enabled: config.duplicate_perceptual_enabled,
    duplicate_perceptual_threshold: config.duplicate_perceptual_threshold,
    duplicate_keeper_policy: config.duplicate_keeper_policy,
    burst_detection_enabled: config.burst_detection_enabled,
    burst_time_window_seconds: config.burst_time_window_seconds,
    burst_perceptual_distance: config.burst_perceptual_distance,
    burst_require_camera_identity: config.burst_require_camera_identity,
    junk_filter_enabled: config.junk_filter_enabled,
    junk_min_file_size_kb: config.junk_min_file_size_kb,
    junk_min_image_dimension: config.junk_min_image_dimension,
    junk_filename_patterns: config.junk_filename_patterns,
    categorize_enabled: config.categorize_enabled,
    categorize_confidence_threshold: config.categorize_confidence_threshold,
    categorize_min_margin: config.categorize_min_margin,
    convert_images: config.convert_images,
    image_format: config.image_format,
    image_quality: config.image_quality,
    convert_videos: config.convert_videos,
    video_format: config.video_format,
    video_quality: config.video_quality,
    repair_enabled: config.repair_enabled,
    rules_enabled: config.rules_enabled,
    ai_tagging_enabled: config.ai_tagging_enabled,
    ai_tagging_confidence_threshold: config.ai_tagging_confidence_threshold,
    ai_tagging_max_tags: config.ai_tagging_max_tags,
    embed_tags_in_files: config.embed_tags_in_files,
    exclude_patterns: config.exclude_patterns,
    min_file_size_kb: config.min_file_size_kb,
    max_file_size_mb: config.max_file_size_mb,
    camera_subfolder_enabled: config.camera_subfolder_enabled,
    exif_sanity_check_enabled: config.exif_sanity_check_enabled,
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
    fields: (current) => {
      // The profile follows the *capabilities the saved settings request*, not
      // conversion alone. Reading only `convert_*` produced a saved recipe that
      // declared Organize Only while `override_metadata` asked to rewrite file
      // bytes — a configuration the backend refuses, restored by a card the
      // user had every reason to trust.
      const requested = requestedCapabilities({ ...current, ...saved.settings } as Config);
      const mutates = requested.length > 0;
      return {
        ...saved.settings,
        ...(mutates ? { preservation_profile: mutationProfile(current) } : organizeOnly(current)),
        optimization_profile: requested.includes("conversion")
          ? optimizationProfile(current)
          : disabledOptimization(current),
      };
    },
  };
}
