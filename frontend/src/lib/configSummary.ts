/**
 * One line per setting, describing what it is currently set to.
 *
 * These strings are what the Configure rail shows under each entry, and they
 * are the reason the rail is worth having: "Copy · verified", "Year / Month",
 * "3 filters active" answers the question the user actually has, which is not
 * "where is the transfer setting" but "what is this run going to do".
 *
 * Pure, so it can be tested without rendering anything.
 */

import { renderPattern } from "@/lib/renamePattern";
import type { Config } from "@/types/api";

/** The date every example on the Configure screen is drawn against. */
export const EXAMPLE_MOMENT = new Date(2025, 6, 14, 18, 32, 0);

export type Translate = (
  key: string,
  params?: Record<string, string | number>,
  fallback?: string,
) => string;

const CRITERION_KEY: Record<string, string> = {
  year: "config.criteria.year",
  month: "config.criteria.month",
  day: "config.criteria.day",
};

/** How many junk rules are currently doing something. */
export function activeJunkFilterCount(config: Config): number {
  if (!config.junk_filter_enabled) return 0;
  let count = 0;
  if ((config.junk_min_file_size_kb ?? 0) > 0) count += 1;
  if ((config.junk_min_image_dimension ?? 0) > 0) count += 1;
  if ((config.junk_filename_patterns ?? []).length > 0) count += 1;
  return count;
}

/** How many scan restrictions are narrowing what gets read. */
export function activeScanFilterCount(config: Config): number {
  let count = 0;
  if (!config.recursive_scan) count += 1;
  if (config.min_file_size_kb !== null && config.min_file_size_kb > 0) count += 1;
  if (config.max_file_size_mb !== null && config.max_file_size_mb > 0) count += 1;
  if ((config.exclude_patterns ?? []).length > 0) count += 1;
  return count;
}

export function folderStructureSummary(config: Config, t: Translate): string {
  if (!config.sort) return t("config.summary.noFolders");
  const criteria = (config.sort_criteria ?? ["year"]).map((c) =>
    t(CRITERION_KEY[c] ?? c, undefined, c),
  );
  const extras: string[] = [];
  if (config.camera_subfolder_enabled) extras.push(t("config.summary.camera"));
  if (config.categorize_enabled) extras.push(t("config.summary.categories"));
  if (config.preserve_subfolders) extras.push(t("config.summary.preserved"));
  const base = criteria.join(" / ");
  return extras.length > 0 ? `${base} · ${extras.join(" · ")}` : base;
}

/**
 * The path one example photo would land at under the current settings.
 *
 * A worked example is worth more than any amount of prose about folder
 * structure: it is the only form of the answer that cannot be misread.
 */
export function examplePath(config: Config, t: Translate, locale = "en"): string {
  const segments: string[] = [t("config.example.destination")];
  if (config.sort) {
    const criteria = config.sort_criteria ?? ["year"];
    if (criteria.includes("year")) segments.push(String(EXAMPLE_MOMENT.getFullYear()));
    if (criteria.includes("month")) {
      const month = String(EXAMPLE_MOMENT.getMonth() + 1).padStart(2, "0");
      const name = new Intl.DateTimeFormat(locale, { month: "long" }).format(EXAMPLE_MOMENT);
      segments.push(`${month} — ${name}`);
    }
    if (criteria.includes("day")) {
      segments.push(String(EXAMPLE_MOMENT.getDate()).padStart(2, "0"));
    }
  }
  if (config.camera_subfolder_enabled) segments.push(t("config.example.camera"));
  if (config.categorize_enabled) segments.push(t("config.example.category"));

  const filename = config.rename
    ? renderPattern(config.rename_pattern, EXAMPLE_MOMENT, "IMG_4382", ".jpg", "IMG")
    : "IMG_4382.jpg";
  return [...segments, filename].join(" / ");
}

export function summariesFor(config: Config, t: Translate): Record<string, string> {
  const conversions: string[] = [];
  if (config.convert_images) {
    conversions.push(t("config.summary.toFormat", { format: config.image_format.toUpperCase() }));
  }
  if (config.convert_videos) {
    conversions.push(t("config.summary.toFormat", { format: config.video_format.toUpperCase() }));
  }

  const ruleCount =
    (config.rule_set?.tag_rules?.length ?? 0) + (config.rule_set?.route_rules?.length ?? 0);

  const maintenance: string[] = [];
  if (config.override_metadata) maintenance.push(t("config.summary.fixDates"));
  if (config.repair_enabled) maintenance.push(t("config.summary.repair"));

  return {
    "setting-transfer": [
      t(config.copy_instead_of_move ? "config.copy" : "config.move"),
      t("config.summary.verified"),
    ].join(" · "),

    "setting-structure": folderStructureSummary(config, t),

    "setting-naming": config.rename ? t("config.summary.renameOn") : t("config.summary.renameOff"),

    "setting-duplicates": !config.remove_duplicates
      ? t("config.summary.off")
      : t(`config.keeper.${config.duplicate_keeper_policy}.short`),

    "setting-junk": config.junk_filter_enabled
      ? t("config.summary.filtersActive", { count: activeJunkFilterCount(config) })
      : t("config.summary.off"),

    "setting-scan": (() => {
      const count = activeScanFilterCount(config);
      return count === 0
        ? t("config.summary.everything")
        : t("config.summary.filtersActive", { count });
    })(),

    "setting-conversion":
      conversions.length > 0 ? conversions.join(" · ") : t("config.summary.keepFormats"),

    "setting-ai": config.ai_tagging_enabled
      ? t(
          config.ai_tagging_provider === "local"
            ? "config.summary.aiOffline"
            : "config.summary.aiCloud",
        )
      : t("config.summary.off"),

    "setting-rules": config.rules_enabled
      ? ruleCount === 0
        ? t("config.summary.noRules")
        : t("config.summary.ruleCount", { count: ruleCount })
      : t("config.summary.off"),

    "setting-maintenance":
      maintenance.length > 0 ? maintenance.join(" · ") : t("config.summary.off"),
  };
}
