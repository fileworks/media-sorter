import { describe, expect, it } from "vitest";

import {
  CONFIG_RECIPES,
  activeRecipeId,
  applyRecipe,
  captureRecipeSettings,
  matchesRecipe,
  recipeChanges,
  toConfigRecipe,
  unclaimedDefaults,
} from "@/lib/configRecipes";
import { TEST_CONFIG } from "@/lib/__tests__/configFixture";
import { requestedCapabilities, unauthorizedCapabilities } from "@/lib/configGates";
import type { Config } from "@/types/api";

const base = {
  ...TEST_CONFIG,
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
} as Config;

const [CONSOLIDATE, TIDY_LIBRARY, ARCHIVE_NORMALIZE, SCRATCH] = CONFIG_RECIPES;

describe("built-in configuration recipes", () => {
  it("reads defaults from the backend-generated contract", () => {
    expect(TEST_CONFIG).toMatchObject({
      sort: true,
      sort_criteria: ["year"],
      copy_instead_of_move: true,
      remove_duplicates: true,
      duplicate_exact_enabled: true,
      duplicate_perceptual_enabled: true,
      convert_images: false,
      image_format: "jpeg",
      convert_videos: false,
      video_format: "mp4",
      repair_enabled: false,
    });
  });

  it("offers one card per job, in the order the grid draws them", () => {
    expect(CONFIG_RECIPES.map((recipe) => recipe.id)).toEqual([
      "consolidate",
      "tidy_library",
      "archive_normalize",
      "scratch",
    ]);
    // Exactly one recommendation, and it is the one that cannot lose anything.
    expect(CONFIG_RECIPES.filter((recipe) => recipe.recommended).map((r) => r.id)).toEqual([
      "consolidate",
    ]);
    expect(SCRATCH.outline).toBe(true);
  });

  it("reaches the deduplicate-only run mode, which no other recipe can", () => {
    const patch = applyRecipe(base, TIDY_LIBRARY);

    expect(patch.run_mode).toBe("deduplicate_only");
    expect(patch.remove_duplicates).toBe(true);
    // Nothing is placed by date in this mode, so nothing is renamed either.
    expect(patch.rename).toBe(false);
    expect(patch.convert_images).toBe(false);
    expect(patch.copy_instead_of_move).toBe(false);
    expect(TIDY_LIBRARY.irreversible).toBe(true);
  });

  it("shows as selected once its settings are in force", () => {
    const applied = { ...base, ...applyRecipe(base, TIDY_LIBRARY) } as Config;

    expect(activeRecipeId(applied, CONFIG_RECIPES)).toBe("tidy_library");
  });

  it("keeps every other recipe organising", () => {
    for (const recipe of [CONSOLIDATE, ARCHIVE_NORMALIZE, SCRATCH]) {
      expect(applyRecipe(base, recipe).run_mode, recipe.id).toBe("organize");
    }
  });

  it("keeps the recommended card genuinely reversible", () => {
    const patch = applyRecipe(base, CONSOLIDATE);

    expect(patch).toMatchObject({
      copy_instead_of_move: true,
      remove_duplicates: true,
      convert_images: false,
      convert_videos: false,
      repair_enabled: false,
    });
    expect(patch.preservation_profile?.mode).toBe("organize_only");
    expect(CONSOLIDATE.irreversible).toBe(false);
  });

  it("copies when organizing, with an explicit move-only cleanup exception", () => {
    for (const recipe of [CONSOLIDATE, ARCHIVE_NORMALIZE, SCRATCH]) {
      expect(applyRecipe(base, recipe).copy_instead_of_move, recipe.id).toBe(true);
    }
    expect(ARCHIVE_NORMALIZE.irreversible).toBe(true);
    // And nothing else claims to be irreversible.
    expect(CONFIG_RECIPES.filter((recipe) => recipe.irreversible).map((r) => r.id)).toEqual([
      "tidy_library",
      "archive_normalize",
    ]);
  });

  it("only authorizes mutation for the recipe that rewrites files", () => {
    expect(applyRecipe(base, ARCHIVE_NORMALIZE).preservation_profile?.mode).toBe(
      "explicit_mutation",
    );
    expect(applyRecipe(base, ARCHIVE_NORMALIZE).optimization_profile?.mode).toBe(
      "visually_lossless",
    );
    for (const recipe of [CONSOLIDATE, TIDY_LIBRARY, SCRATCH]) {
      expect(applyRecipe(base, recipe).preservation_profile?.mode, recipe.id).toBe("organize_only");
      expect(applyRecipe(base, recipe).optimization_profile?.mode, recipe.id).toBe("disabled");
    }
  });

  it("organizes and imports by date with renaming left optional", () => {
    expect(applyRecipe(base, CONSOLIDATE).rename).toBe(false);
    expect(applyRecipe(base, ARCHIVE_NORMALIZE).rename).toBe(true);
    for (const recipe of [CONSOLIDATE, ARCHIVE_NORMALIZE]) {
      const patch = applyRecipe(base, recipe);
      expect(patch.rename_pattern, recipe.id).toBe("YYYY-MM-DD_NAME");
      expect(patch.sort_criteria, recipe.id).toEqual(["year", "month"]);
    }
    // The two that place nothing under a date leave the names alone.
    expect(applyRecipe(base, TIDY_LIBRARY).rename).toBe(false);
    expect(applyRecipe(base, SCRATCH).rename).toBe(false);
  });

  it("never switches on the one capability a card cannot promise", () => {
    // Local tagging needs a downloaded model and a hardware tier, so a recipe
    // that turned it on would describe a run some machines cannot perform.
    for (const recipe of CONFIG_RECIPES) {
      expect(applyRecipe(base, recipe).ai_tagging_enabled, recipe.id).toBe(false);
      expect(applyRecipe(base, recipe).categorize_enabled ?? false, recipe.id).toBe(false);
    }
  });

  it("starts from a floor that still does something, not from nothing", () => {
    expect(applyRecipe(base, SCRATCH)).toMatchObject({
      sort: true,
      sort_criteria: ["year"],
      copy_instead_of_move: true,
      remove_duplicates: true,
      duplicate_exact_enabled: true,
      // The expensive half, and the half that needs an answer per set.
      duplicate_perceptual_enabled: false,
      junk_filter_enabled: false,
      rules_enabled: false,
      ai_tagging_enabled: false,
      repair_enabled: false,
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
    const patch = applyRecipe(base, CONSOLIDATE);
    const changes = recipeChanges(base, patch);

    expect(changes.map((change) => change.key)).not.toContain("duplicate_exact_enabled");
    expect(changes.map((change) => change.key)).toContain("copy_instead_of_move");
  });

  it("recognises the recipe a configuration currently corresponds to", () => {
    const applied = { ...base, ...applyRecipe(base, CONSOLIDATE) };

    expect(matchesRecipe(applied, CONSOLIDATE)).toBe(true);
    expect(activeRecipeId(applied, CONFIG_RECIPES)).toBe("consolidate");
    expect(activeRecipeId({ ...applied, copy_instead_of_move: false }, [CONSOLIDATE])).toBeNull();
  });

  it("captures only the reusable slice when saving a recipe", () => {
    const configured = {
      ...base,
      run_mode: "deduplicate_only",
      override_metadata: true,
      recursive_scan: false,
      exclude_patterns: ["*.tmp"],
      min_file_size_kb: 64,
      junk_min_file_size_kb: 32,
    } as Config;
    const settings = captureRecipeSettings(configured);

    expect(settings.copy_instead_of_move).toBe(base.copy_instead_of_move);
    expect(settings.run_mode).toBe("deduplicate_only");
    expect(settings.override_metadata).toBe(true);
    expect(settings.recursive_scan).toBe(false);
    expect(settings.exclude_patterns).toEqual(["*.tmp"]);
    expect(settings.min_file_size_kb).toBe(64);
    expect(settings.junk_min_file_size_kb).toBe(32);
    expect(settings).not.toHaveProperty("source_directory");
    expect(settings).not.toHaveProperty("ai_tagging_api_key");
  });
});

describe("a recipe always leaves a configuration the backend will accept", () => {
  // The state the bug needed: every byte-rewriting switch on, then a recipe
  // applied over it. Applying one used to disable "Preview changes" and name
  // four settings the user had never touched, with no way forward on screen.
  const mutating = {
    ...base,
    ai_tagging_enabled: true,
    embed_tags_in_files: true,
    override_metadata: true,
    repair_enabled: true,
  } as Config;

  it.each(CONFIG_RECIPES.filter((recipe) => recipe.id !== "archive_normalize"))(
    "$id leaves nothing requesting a rewrite it did not authorize",
    (recipe) => {
      const applied = { ...mutating, ...recipe.fields(mutating) } as Config;

      expect(applied.preservation_profile.mode).toBe("organize_only");
      expect(applied.preservation_profile.allow_embedded_metadata_edits).toBe(false);
      expect(unauthorizedCapabilities(applied)).toEqual([]);
    },
  );

  it("archive and normalise authorizes exactly what it turns on", () => {
    const applied = { ...mutating, ...ARCHIVE_NORMALIZE.fields(mutating) } as Config;

    // The one recipe that does rewrite bytes, so it declares the profile that
    // permits it rather than switching the settings back off.
    expect(applied.preservation_profile.mode).toBe("explicit_mutation");
    expect(applied.preservation_profile.allow_embedded_metadata_edits).toBe(true);
    expect(unauthorizedCapabilities(applied)).toEqual([]);
  });
});

describe("requestedCapabilities mirrors the backend rule", () => {
  // The table the two implementations are held to. Each row is a configuration
  // and what `integrity_policy._requested_capabilities` returns for it.
  const table: [string, Partial<Config>, string[]][] = [
    ["nothing on", {}, []],
    ["metadata overwriting alone", { override_metadata: true }, ["embedded_metadata"]],
    ["tagging without embedding", { ai_tagging_enabled: true }, []],
    ["embedding without tagging", { embed_tags_in_files: true }, []],
    [
      "tagging and embedding together",
      { ai_tagging_enabled: true, embed_tags_in_files: true },
      ["embedded_metadata"],
    ],
    ["repair", { repair_enabled: true }, ["repair"]],
    ["image conversion", { convert_images: true }, ["conversion", "compression"]],
    ["video conversion", { convert_videos: true }, ["conversion", "compression"]],
    [
      "everything",
      {
        override_metadata: true,
        repair_enabled: true,
        convert_images: true,
      },
      ["embedded_metadata", "repair", "conversion", "compression"],
    ],
  ];

  it.each(table)("%s", (_name, overrides, expected) => {
    expect(requestedCapabilities({ ...base, ...overrides } as Config)).toEqual(expected);
  });
});

describe("a saved recipe round-trips its rewriting settings", () => {
  it("captures metadata overwriting, which no recipe used to claim", () => {
    const captured = captureRecipeSettings({ ...base, override_metadata: true } as Config);

    expect(captured.override_metadata).toBe(true);
  });

  it("restores a saved recipe with a profile that permits what it asks for", () => {
    const saved = {
      schema_version: 1 as const,
      recipe_id: "custom-1",
      name: "Mine",
      created_at: "2026-01-01T00:00:00Z",
      settings: captureRecipeSettings({ ...base, override_metadata: true } as Config),
    };

    const applied = { ...base, ...toConfigRecipe(saved).fields(base) } as Config;

    // Reading conversion alone declared Organize Only here, which the backend
    // then refused — a card the user had every reason to trust.
    expect(applied.preservation_profile.mode).toBe("explicit_mutation");
    expect(unauthorizedCapabilities(applied)).toEqual([]);
  });

  it("leaves a recipe saved before the field existed asking for nothing", () => {
    const saved = {
      schema_version: 1 as const,
      recipe_id: "old",
      name: "Old",
      created_at: "2026-01-01T00:00:00Z",
      settings: { ...captureRecipeSettings(base), override_metadata: undefined },
    };

    const applied = { ...base, ...toConfigRecipe(saved).fields(base) } as Config;

    expect(applied.preservation_profile.mode).toBe("organize_only");
    expect(unauthorizedCapabilities(applied)).toEqual([]);
  });
});

describe("applying a recipe as a clean starting point", () => {
  /**
   * The backend's own defaults, reduced to the recipe-scoped fields these
   * assertions turn on. `unclaimedDefaults` only ever reads keys it is given,
   * so a partial stands in for the real payload without pretending to be it.
   */
  const defaults: Partial<Config> = {
    junk_filter_enabled: false,
    duplicate_perceptual_threshold: 8,
    duplicate_keeper_policy: "largest",
    rename: false,
    rename_pattern: "{date}_{name}",
    ai_tagging_enabled: false,
    categorize_enabled: false,
    ai_model_tier: "off",
    image_quality: 90,
    video_quality: "medium",
    junk_min_file_size_kb: 8,
    junk_min_image_dimension: 200,
    junk_filename_patterns: ["Thumbs.db"],
    exclude_patterns: [".DS_Store"],
    min_file_size_kb: null,
    max_file_size_mb: null,
  };

  const consolidate = CONFIG_RECIPES.find((recipe) => recipe.id === "consolidate");

  it("writes nothing extra while the wider scope is not chosen", () => {
    // The narrow rule is the default, and this is the assertion that keeps it
    // that way: the patch has to stay byte-identical to what shipped.
    expect(applyRecipe(base, consolidate!)).toEqual(consolidate!.fields(base));
  });

  it("returns a setting the recipe does not name to its default", () => {
    // The keeper rule and the similarity threshold are nobody's recipe field,
    // and this configuration has both moved.
    const moved = {
      ...base,
      duplicate_keeper_policy: "oldest",
      duplicate_perceptual_threshold: 42,
    } as Config;
    const wider = unclaimedDefaults(consolidate!, moved, defaults);

    expect(wider.duplicate_keeper_policy).toBe("largest");
    expect(wider.duplicate_perceptual_threshold).toBe(8);
  });

  it("resets filters and junk thresholds only in the explicitly wider scope", () => {
    const moved = {
      ...base,
      junk_min_file_size_kb: 64,
      junk_min_image_dimension: 600,
      junk_filename_patterns: ["*.cache"],
      exclude_patterns: ["*.tmp"],
      min_file_size_kb: 128,
      max_file_size_mb: 8,
    } as Config;

    const narrow = applyRecipe(moved, consolidate!);
    const wider = unclaimedDefaults(consolidate!, moved, defaults);

    expect(narrow).not.toHaveProperty("exclude_patterns");
    expect(narrow).not.toHaveProperty("min_file_size_kb");
    expect(narrow).not.toHaveProperty("junk_min_file_size_kb");
    expect(wider.exclude_patterns).toEqual([".DS_Store"]);
    expect(wider.min_file_size_kb).toBeNull();
    expect(wider.max_file_size_mb).toBeNull();
    expect(wider.junk_min_file_size_kb).toBe(8);
    expect(wider.junk_min_image_dimension).toBe(200);
    expect(wider.junk_filename_patterns).toEqual(["Thumbs.db"]);
  });

  it("never writes a field the recipe itself claims", () => {
    const claimed = new Set(Object.keys(consolidate!.fields(base)));
    const wider = Object.keys(unclaimedDefaults(consolidate!, base, defaults));

    expect(wider.filter((key) => claimed.has(key))).toEqual([]);
  });

  it("leaves both profiles to the recipe", () => {
    // A recipe's posture is its own. Reopening it from a reset of the settings
    // around it would let the wider scope quietly contradict the card.
    const wider = unclaimedDefaults(consolidate!, base, defaults);

    expect(wider).not.toHaveProperty("preservation_profile");
    expect(wider).not.toHaveProperty("optimization_profile");
  });

  it("writes nothing at all before the defaults have loaded", () => {
    expect(unclaimedDefaults(consolidate!, base, undefined)).toEqual({});
  });

  it("leaves every recipe's widened result one the flow accepts", () => {
    // The narrow result is asserted valid elsewhere; the wider one is a second
    // configuration the user can reach, so it needs the same guarantee.
    const messy = {
      ...base,
      ai_tagging_enabled: true,
      embed_tags_in_files: true,
      override_metadata: true,
      rename: true,
    } as Config;

    for (const recipe of CONFIG_RECIPES) {
      const applied = {
        ...messy,
        ...applyRecipe(messy, recipe),
        ...unclaimedDefaults(recipe, messy, defaults),
      } as Config;
      expect(unauthorizedCapabilities(applied), recipe.id).toEqual([]);
    }
  });

  it("leaves no setting deviating from the recipe once it is applied wide", () => {
    const messy = { ...base, rename: true, junk_filter_enabled: true } as Config;
    const applied = {
      ...messy,
      ...applyRecipe(messy, consolidate!),
      ...unclaimedDefaults(consolidate!, messy, defaults),
    } as Config;

    // The baseline Configure measures against is the recipe over the defaults;
    // matching it is what makes the markers disappear.
    expect(matchesRecipe(applied, consolidate!)).toBe(true);
    for (const [key, value] of Object.entries(defaults)) {
      const claimed = key in consolidate!.fields(messy);
      if (!claimed) expect(applied[key as keyof Config], key).toEqual(value);
    }
  });
});

/**
 * Hiding the burst control (`W0-UI-001`) must not quietly drop the setting.
 *
 * A recipe that stopped capturing `burst_detection_enabled` would reset it to
 * the shipped default the next time the user applied one, and `P2-DEDUP-D9`
 * would then restore a control whose value had already been thrown away. The
 * value survives because nothing was removed here — this test is what says so.
 */
describe("burst settings survive the hidden control", () => {
  const burstKeys = [
    "burst_detection_enabled",
    "burst_time_window_seconds",
    "burst_perceptual_distance",
    "burst_require_camera_identity",
  ] as const;

  it("still captures every burst field into a saved recipe", () => {
    const captured = captureRecipeSettings({
      ...(base as unknown as Config),
      burst_detection_enabled: true,
      burst_time_window_seconds: 2.5,
      burst_perceptual_distance: 7,
      burst_require_camera_identity: false,
    });

    for (const key of burstKeys) {
      expect(captured).toHaveProperty(key);
    }
    expect(captured.burst_detection_enabled).toBe(true);
    expect(captured.burst_time_window_seconds).toBe(2.5);
    expect(captured.burst_perceptual_distance).toBe(7);
    expect(captured.burst_require_camera_identity).toBe(false);
  });

  it("has no shipped recipe that turns burst detection off behind the user", () => {
    for (const recipe of CONFIG_RECIPES) {
      const patch = recipe.fields({
        ...(base as unknown as Config),
        burst_detection_enabled: true,
      });
      expect(Object.keys(patch)).not.toContain("burst_detection_enabled");
    }
  });
});
