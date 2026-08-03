import { describe, expect, it } from "vitest";

import {
  CONFIG_RECIPES,
  activeRecipeId,
  applyRecipe,
  captureRecipeSettings,
  matchesRecipe,
  recipeChanges,
} from "@/lib/configRecipes";
import { SECTION_DEFAULTS } from "@/components/config/constants";
import type { Config } from "@/types/api";

const base = {
  sort: true,
  sort_criteria: ["year", "month", "day"],
  copy_instead_of_move: false,
  remove_duplicates: false,
  duplicate_exact_enabled: true,
  duplicate_perceptual_enabled: false,
  convert_images: false,
  image_format: "png",
  convert_videos: false,
  video_format: "mkv",
  repair_enabled: false,
  preservation_profile: {
    schema_version: 1,
    profile_id: "default",
    name: "Organize only",
    mode: "organize_only",
    allow_embedded_metadata_edits: false,
    allow_repair: false,
    allow_conversion: false,
    allow_compression: false,
    preserve_filesystem_timestamps: true,
    derived_metadata: "report_only",
    authorization_origin: "default",
    acknowledged_at: null,
    requires_review: false,
  },
  optimization_profile: {
    schema_version: 1,
    profile_id: "optimization-disabled",
    name: "Optimization disabled",
    mode: "disabled",
    acknowledged_at: null,
    tool: null,
    tool_version: null,
    parameters: {},
    validation_contract: null,
    memory_limit_mib: 512,
    temporary_space_limit_bytes: null,
    retain_original: true,
  },
} as Config;

const [SAFE_SORT, CLEAN_SWEEP, ARCHIVE_CONVERT, FIND_DUPLICATES_ONLY, SCRATCH] = CONFIG_RECIPES;

describe("built-in configuration recipes", () => {
  it("pins every default a recipe relies on", () => {
    const defaults = Object.assign({}, ...Object.values(SECTION_DEFAULTS));
    expect(defaults).toMatchObject({
      sort: true,
      sort_criteria: ["year"],
      copy_instead_of_move: false,
      remove_duplicates: true,
      duplicate_exact_enabled: true,
      duplicate_perceptual_enabled: true,
      convert_images: false,
      image_format: "jpeg",
      convert_videos: false,
      video_format: "mp4",
      repair_enabled: true,
    });
  });

  it("offers the five cards the recipe grid draws, in order", () => {
    expect(CONFIG_RECIPES.map((recipe) => recipe.id)).toEqual([
      "safe_sort",
      "clean_sweep",
      "archive_convert",
      "find_duplicates_only",
      "scratch",
    ]);
    expect(SAFE_SORT.recommended).toBe(true);
    expect(SCRATCH.outline).toBe(true);
  });

  it("reaches the deduplicate-only run mode, which no other recipe can", () => {
    const patch = applyRecipe(base, FIND_DUPLICATES_ONLY);

    expect(patch.run_mode).toBe("deduplicate_only");
    expect(patch.remove_duplicates).toBe(true);
    // Junk filtering and conversion are off: this run is only about duplicates.
    expect(patch.junk_filter_enabled).toBe(false);
    expect(patch.convert_images).toBe(false);
    expect(FIND_DUPLICATES_ONLY.irreversible).toBe(false);
  });

  it("shows as selected once its settings are in force", () => {
    const applied = { ...base, ...applyRecipe(base, FIND_DUPLICATES_ONLY) } as Config;

    expect(activeRecipeId(applied, CONFIG_RECIPES)).toBe("find_duplicates_only");
  });

  it("keeps every other recipe organising", () => {
    for (const recipe of [SAFE_SORT, CLEAN_SWEEP, ARCHIVE_CONVERT]) {
      expect(applyRecipe(base, recipe).run_mode, recipe.id).toBe("organize");
    }
  });

  it("keeps Safe Sort genuinely reversible", () => {
    const patch = applyRecipe(base, SAFE_SORT);

    expect(patch).toMatchObject({
      copy_instead_of_move: true,
      remove_duplicates: true,
      convert_images: false,
      convert_videos: false,
      repair_enabled: false,
    });
    expect(patch.preservation_profile?.mode).toBe("organize_only");
    expect(SAFE_SORT.irreversible).toBe(false);
  });

  it("marks the two recipes that touch originals or bytes", () => {
    expect(CLEAN_SWEEP.irreversible).toBe(true);
    expect(ARCHIVE_CONVERT.irreversible).toBe(true);
    expect(applyRecipe(base, CLEAN_SWEEP).copy_instead_of_move).toBe(false);
  });

  it("only authorizes mutation for the recipe that rewrites files", () => {
    expect(applyRecipe(base, ARCHIVE_CONVERT).preservation_profile?.mode).toBe("explicit_mutation");
    expect(applyRecipe(base, ARCHIVE_CONVERT).optimization_profile?.mode).toBe("visually_lossless");
    for (const recipe of [SAFE_SORT, CLEAN_SWEEP, SCRATCH]) {
      expect(applyRecipe(base, recipe).preservation_profile?.mode).toBe("organize_only");
      expect(applyRecipe(base, recipe).optimization_profile?.mode).toBe("disabled");
    }
  });

  it("turns everything off when starting from scratch", () => {
    expect(applyRecipe(base, SCRATCH)).toMatchObject({
      sort: false,
      remove_duplicates: false,
      duplicate_exact_enabled: false,
      duplicate_perceptual_enabled: false,
      junk_filter_enabled: false,
      rules_enabled: false,
      ai_tagging_enabled: false,
    });
  });

  it("keeps each recipe's field set explicit and reviewable", () => {
    for (const recipe of CONFIG_RECIPES) {
      const keys = Object.keys(applyRecipe(base, recipe));
      expect(keys.length, recipe.id).toBeGreaterThan(0);
      // A recipe must never reach into a folder, a credential or a vocabulary.
      expect(keys, recipe.id).not.toContain("source_directory");
      expect(keys, recipe.id).not.toContain("target_directory");
      expect(keys, recipe.id).not.toContain("ai_tagging_api_key");
      expect(keys, recipe.id).not.toContain("ai_tagging_labels");
    }
  });

  it("reports only fields that the one-shot write changes", () => {
    const patch = applyRecipe(base, SAFE_SORT);
    const changes = recipeChanges(base, patch);

    expect(changes.map((change) => change.key)).not.toContain("duplicate_exact_enabled");
    expect(changes.map((change) => change.key)).toContain("copy_instead_of_move");
  });

  it("recognises the recipe a configuration currently corresponds to", () => {
    const applied = { ...base, ...applyRecipe(base, SAFE_SORT) };

    expect(matchesRecipe(applied, SAFE_SORT)).toBe(true);
    expect(activeRecipeId(applied, CONFIG_RECIPES)).toBe("safe_sort");
    expect(activeRecipeId({ ...applied, copy_instead_of_move: false }, [SAFE_SORT])).toBeNull();
  });

  it("captures only the reusable slice when saving a recipe", () => {
    const settings = captureRecipeSettings(base);

    expect(settings.copy_instead_of_move).toBe(base.copy_instead_of_move);
    expect(settings).not.toHaveProperty("source_directory");
    expect(settings).not.toHaveProperty("ai_tagging_api_key");
  });
});
