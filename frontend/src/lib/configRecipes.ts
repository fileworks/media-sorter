import type { Config } from "@/types/api";
import { diffConfig } from "@/lib/configDiff";

export type RecipeId = "duplicates_only" | "full_cleanup" | "copy_cleanup";

export interface ConfigRecipe {
  id: RecipeId;
  labelKey: string;
  descriptionKey: string;
  consequenceKey: string;
  irreversible: boolean;
  fields: (current: Config) => Partial<Config>;
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

export const CONFIG_RECIPES: readonly ConfigRecipe[] = [
  {
    id: "duplicates_only",
    labelKey: "recipes.duplicates.label",
    descriptionKey: "recipes.duplicates.description",
    consequenceKey: "recipes.duplicates.consequence",
    irreversible: false,
    fields: (current) => ({
      sort: false,
      copy_instead_of_move: true,
      remove_duplicates: true,
      duplicate_exact_enabled: true,
      duplicate_perceptual_enabled: true,
      convert_images: false,
      convert_videos: false,
      repair_enabled: false,
      preservation_profile: {
        ...current.preservation_profile,
        mode: "organize_only",
        allow_repair: false,
        allow_conversion: false,
        authorization_origin: "run_override",
        requires_review: false,
      },
    }),
  },
  {
    id: "full_cleanup",
    labelKey: "recipes.full.label",
    descriptionKey: "recipes.full.description",
    consequenceKey: "recipes.full.consequence",
    irreversible: true,
    fields: (current) => ({
      sort: true,
      sort_criteria: ["year"],
      copy_instead_of_move: false,
      remove_duplicates: true,
      duplicate_exact_enabled: true,
      duplicate_perceptual_enabled: true,
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
    id: "copy_cleanup",
    labelKey: "recipes.copy.label",
    descriptionKey: "recipes.copy.description",
    consequenceKey: "recipes.copy.consequence",
    irreversible: true,
    fields: (current) => ({
      sort: true,
      sort_criteria: ["year"],
      copy_instead_of_move: true,
      remove_duplicates: true,
      duplicate_exact_enabled: true,
      duplicate_perceptual_enabled: true,
      convert_images: true,
      image_format: "jpeg",
      convert_videos: true,
      video_format: "mp4",
      repair_enabled: true,
      preservation_profile: mutationProfile(current),
      optimization_profile: optimizationProfile(current),
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
