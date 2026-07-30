import { describe, expect, it } from "vitest";

import { CONFIG_RECIPES, applyRecipe, recipeChanges } from "@/lib/configRecipes";
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

  it("keeps each recipe field set explicit and reviewable", () => {
    expect(Object.keys(applyRecipe(base, CONFIG_RECIPES[0])).sort()).toEqual([
      "convert_images",
      "convert_videos",
      "copy_instead_of_move",
      "duplicate_exact_enabled",
      "duplicate_perceptual_enabled",
      "preservation_profile",
      "remove_duplicates",
      "repair_enabled",
      "sort",
    ]);
    expect(Object.keys(applyRecipe(base, CONFIG_RECIPES[1])).sort()).toEqual([
      "convert_images",
      "convert_videos",
      "copy_instead_of_move",
      "duplicate_exact_enabled",
      "duplicate_perceptual_enabled",
      "image_format",
      "optimization_profile",
      "preservation_profile",
      "remove_duplicates",
      "repair_enabled",
      "sort",
      "sort_criteria",
      "video_format",
    ]);
  });

  it("keeps the duplicate-only recipe non-mutating", () => {
    const patch = applyRecipe(base, CONFIG_RECIPES[0]);
    expect(patch).toMatchObject({
      sort: false,
      copy_instead_of_move: true,
      remove_duplicates: true,
      convert_images: false,
      convert_videos: false,
      repair_enabled: false,
    });
    expect(patch.preservation_profile?.mode).toBe("organize_only");
  });

  it("makes both cleanup recipes explicit and differs only in transfer posture", () => {
    const move = applyRecipe(base, CONFIG_RECIPES[1]);
    const copy = applyRecipe(base, CONFIG_RECIPES[2]);
    expect(move).toMatchObject({
      sort: true,
      sort_criteria: ["year"],
      copy_instead_of_move: false,
      remove_duplicates: true,
      convert_images: true,
      convert_videos: true,
      repair_enabled: true,
    });
    expect(copy).toMatchObject({
      sort: move.sort,
      sort_criteria: move.sort_criteria,
      copy_instead_of_move: true,
      remove_duplicates: move.remove_duplicates,
      convert_images: move.convert_images,
      convert_videos: move.convert_videos,
      repair_enabled: move.repair_enabled,
    });
    expect(move.preservation_profile?.mode).toBe("explicit_mutation");
    expect(move.preservation_profile?.requires_review).toBe(false);
    expect(move.preservation_profile?.allow_compression).toBe(true);
    expect(move.optimization_profile?.mode).toBe("visually_lossless");
  });

  it("reports only fields that the one-shot write changes", () => {
    const patch = applyRecipe(base, CONFIG_RECIPES[0]);
    const changes = recipeChanges(base, patch);
    expect(changes.map((change) => change.key)).not.toContain("duplicate_exact_enabled");
    expect(changes.map((change) => change.key)).toContain("sort");
  });
});
