import { describe, expect, it } from "vitest";

import {
  CONFIG_RECIPES,
  activeRecipeId,
  applyRecipe,
  blankRecipe,
  captureRecipeSettings,
  matchesRecipe,
  recipeChanges,
  toConfigRecipe,
  unclaimedDefaults,
} from "@/lib/configRecipes";
import { requestedCapabilities, unauthorizedCapabilities } from "@/lib/configGates";
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

describe("blank (defaults)", () => {
  const defaults = { ...base, sort: true, remove_duplicates: true, rename: false };

  it("restores the shipped defaults rather than switching everything off", () => {
    const experimented = { ...base, remove_duplicates: false, rename: true, sort: false } as Config;
    const patch = applyRecipe(experimented, blankRecipe(defaults));

    expect(patch.remove_duplicates).toBe(true);
    expect(patch.sort).toBe(true);
    expect(patch.rename).toBe(false);
  });

  it("is not the same card as From scratch, which turns duplicate detection off", () => {
    const scratch = CONFIG_RECIPES.find((recipe) => recipe.id === "scratch");
    expect(scratch).toBeDefined();
    expect(applyRecipe(base, scratch!).remove_duplicates).toBe(false);
    expect(applyRecipe(base, blankRecipe(defaults)).remove_duplicates).toBe(true);
  });

  it("writes only recipe-scoped fields, never a folder or a credential", () => {
    const patch = applyRecipe(base, blankRecipe({ ...defaults, source_directory: "/elsewhere" }));

    expect(patch).not.toHaveProperty("source_directory");
    expect(patch).not.toHaveProperty("ai_tagging_api_key");
  });

  it("shows as selected once the configuration matches it again", () => {
    const applied = { ...base, ...applyRecipe(base, blankRecipe(defaults)) };

    expect(matchesRecipe(applied, blankRecipe(defaults))).toBe(true);
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

  it.each(CONFIG_RECIPES.filter((recipe) => recipe.id !== "archive_convert"))(
    "$id leaves nothing requesting a rewrite it did not authorize",
    (recipe) => {
      const applied = { ...mutating, ...recipe.fields(mutating) } as Config;

      expect(applied.preservation_profile.mode).toBe("organize_only");
      expect(applied.preservation_profile.allow_embedded_metadata_edits).toBe(false);
      expect(unauthorizedCapabilities(applied)).toEqual([]);
    },
  );

  it("archive & convert authorizes exactly what it turns on", () => {
    const applied = { ...mutating, ...ARCHIVE_CONVERT.fields(mutating) } as Config;

    // The one recipe that does rewrite bytes, so it declares the profile that
    // permits it rather than switching the settings back off.
    expect(applied.preservation_profile.mode).toBe("explicit_mutation");
    expect(applied.preservation_profile.allow_embedded_metadata_edits).toBe(true);
    expect(unauthorizedCapabilities(applied)).toEqual([]);
  });

  it("blank (defaults) is held to the same rule", () => {
    // The defaults it is given carry no `repair_enabled`, which is exactly how
    // this card used to leave repair on under a profile that forbids it: it
    // writes only keys the backend's defaults happen to contain.
    const recipe = blankRecipe({ ...base, sort: true, remove_duplicates: true } as Partial<Config>);
    const applied = { ...mutating, ...recipe.fields(mutating) } as Config;

    expect(applied.repair_enabled).toBe(false);
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

  const safeSort = CONFIG_RECIPES.find((recipe) => recipe.id === "safe_sort");

  it("writes nothing extra while the wider scope is not chosen", () => {
    // The narrow rule is the default, and this is the assertion that keeps it
    // that way: the patch has to stay byte-identical to what shipped.
    expect(applyRecipe(base, safeSort!)).toEqual(safeSort!.fields(base));
  });

  it("returns a setting the recipe does not name to its default", () => {
    // `rename` is nobody's recipe field, and this configuration has it on.
    const moved = { ...base, rename: true, rename_pattern: "{name}-custom" } as Config;
    const wider = unclaimedDefaults(safeSort!, moved, defaults);

    expect(wider.rename).toBe(false);
    expect(wider.rename_pattern).toBe("{date}_{name}");
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

    const narrow = applyRecipe(moved, safeSort!);
    const wider = unclaimedDefaults(safeSort!, moved, defaults);

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
    const claimed = new Set(Object.keys(safeSort!.fields(base)));
    const wider = Object.keys(unclaimedDefaults(safeSort!, base, defaults));

    expect(wider.filter((key) => claimed.has(key))).toEqual([]);
  });

  it("leaves both profiles to the recipe", () => {
    // A recipe's posture is its own. Reopening it from a reset of the settings
    // around it would let the wider scope quietly contradict the card.
    const wider = unclaimedDefaults(safeSort!, base, defaults);

    expect(wider).not.toHaveProperty("preservation_profile");
    expect(wider).not.toHaveProperty("optimization_profile");
  });

  it("writes nothing at all before the defaults have loaded", () => {
    expect(unclaimedDefaults(safeSort!, base, undefined)).toEqual({});
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
      ...applyRecipe(messy, safeSort!),
      ...unclaimedDefaults(safeSort!, messy, defaults),
    } as Config;

    // The baseline Configure measures against is the recipe over the defaults;
    // matching it is what makes the markers disappear.
    expect(matchesRecipe(applied, safeSort!)).toBe(true);
    for (const [key, value] of Object.entries(defaults)) {
      const claimed = key in safeSort!.fields(messy);
      if (!claimed) expect(applied[key as keyof Config], key).toEqual(value);
    }
  });
});
