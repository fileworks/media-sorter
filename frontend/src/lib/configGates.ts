/**
 * Which stage owns a server-side validation error.
 *
 * `POST /config/validate` answers one question — "is the whole configuration
 * usable?" — but the flow asks two: Sources decides *where*, Configure decides
 * *how*, and they are separate gates. Gating Sources on whole-config validity
 * made an unrelated setting (a mutating option under Organize Only, a filter out
 * of range) report itself as a folder problem, on the one screen where the
 * folders were already correct and nothing could fix it.
 *
 * So an error is routed by the field it names: the three fields that describe
 * roots belong to Sources, everything else — including an error tied to no
 * single field — belongs to Configure.
 */

import type { Config, ConfigIssue } from "@/types/api";

/** The config fields the Sources stage is responsible for. */
export const ROOT_FIELDS: readonly string[] = [
  "source_directory",
  "target_directory",
  "library_profile",
];

export interface ValidationSplit {
  /** Problems with the folders themselves — these gate leaving Sources. */
  roots: ConfigIssue[];
  /** Everything else — these gate previewing, not navigating. */
  settings: ConfigIssue[];
}

export function isRootIssue(issue: ConfigIssue): boolean {
  return issue.field !== null && ROOT_FIELDS.includes(issue.field);
}

export function splitValidation(errors: readonly ConfigIssue[]): ValidationSplit {
  const roots: ConfigIssue[] = [];
  const settings: ConfigIssue[] = [];
  for (const issue of errors) (isRootIssue(issue) ? roots : settings).push(issue);
  return { roots, settings };
}

// ── What a configuration asks permission for ─────────────────────────────────

/**
 * The capabilities the backend will read out of this configuration.
 *
 * An exact mirror of `integrity_policy._requested_capabilities`. It exists so
 * the interface can answer, before asking the server, "would this configuration
 * be refused, and by which settings?" — because the failure it prevents is
 * specifically one the server states and the screen cannot: applying a recipe
 * left `override_metadata` on under an Organize Only profile, the validation
 * failed, and "Preview changes" went dead while naming four settings the user
 * never touched.
 *
 * Mirrored rather than fetched because it gates a card the user is about to
 * click. A round-trip per keystroke is not a thing this screen can afford, and
 * a warning that arrives after the click is not a warning.
 *
 * The two are held together by a table-driven test. If the backend rule changes
 * and this does not, that test fails rather than the product.
 */
export type MutationCapability = "embedded_metadata" | "repair" | "conversion" | "compression";

export function requestedCapabilities(config: Config): MutationCapability[] {
  const requested: MutationCapability[] = [];
  if (config.override_metadata || (config.ai_tagging_enabled && config.embed_tags_in_files)) {
    requested.push("embedded_metadata");
  }
  if (config.repair_enabled) requested.push("repair");
  // Conversion always requests both: the backend adds them together, because
  // re-encoding is a compression decision whether or not anyone called it one.
  if (config.convert_images || config.convert_videos) requested.push("conversion", "compression");
  return requested;
}

/** The settings responsible for each capability, for a message that can be acted on. */
export const CAPABILITY_FIELDS: Record<MutationCapability, readonly (keyof Config)[]> = {
  embedded_metadata: ["override_metadata", "ai_tagging_enabled", "embed_tags_in_files"],
  repair: ["repair_enabled"],
  conversion: ["convert_images", "convert_videos"],
  compression: ["convert_images", "convert_videos"],
};

/**
 * Whether this configuration would pass the backend's mutation policy.
 *
 * Organize Only permits nothing; an explicit-mutation profile permits what it
 * declares. The check is deliberately one-directional — it reports a refusal it
 * is sure of, and never claims a configuration is fine.
 */
export function unauthorizedCapabilities(config: Config): MutationCapability[] {
  const profile = config.preservation_profile;
  if (profile.mode !== "organize_only") {
    return requestedCapabilities(config).filter((capability) => {
      if (capability === "repair") return !profile.allow_repair;
      if (capability === "conversion") return !profile.allow_conversion;
      if (capability === "compression") return !profile.allow_compression;
      return false;
    });
  }
  return requestedCapabilities(config);
}
