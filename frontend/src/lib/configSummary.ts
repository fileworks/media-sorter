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
import { REVIEW_FOLDER_NAMES } from "@/lib/reviewPlan";
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
 * One file from the library, used to make the Configure previews concrete.
 *
 * Drawn from the last dry run where there has been one, so a user reads their
 * own filenames rather than an invented `IMG_4382.jpg` and has to trust that
 * the invention behaves like their files do.
 */
export interface SampleFile {
  /** Filename stem, without the extension. */
  stem: string;
  /** Extension including the dot, exactly as it is on disk — `.JPG`, not `.jpg`. */
  extension: string;
  date: Date | null;
  kind: "IMG" | "VID";
  /** True when this is the invented example rather than a real file. */
  invented: boolean;
}

const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".heic",
  ".heif",
  ".gif",
  ".webp",
  ".tif",
  ".tiff",
  ".bmp",
  ".dng",
  ".raw",
  ".cr2",
  ".nef",
  ".arw",
]);

/** The invented pair, used until a dry run has supplied real ones. */
export const INVENTED_SAMPLES: readonly SampleFile[] = [
  { stem: "IMG_4382", extension: ".JPG", date: EXAMPLE_MOMENT, kind: "IMG", invented: true },
  { stem: "VID_0042", extension: ".mp4", date: EXAMPLE_MOMENT, kind: "VID", invented: true },
];

function splitName(path: string): { stem: string; extension: string } {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0
    ? { stem: base.slice(0, dot), extension: base.slice(dot) }
    : { stem: base, extension: "" };
}

/**
 * Real files to draw the previews with, newest first, one video included where
 * the run has one — the rename preview says something about `TYPE` only if it
 * has both kinds to say it with.
 */
export function sampleFiles(
  sources: readonly { source: string; extracted_date: string | null }[],
): SampleFile[] {
  const files = sources.map((item) => {
    const { stem, extension } = splitName(item.source);
    const parsed = item.extracted_date ? new Date(item.extracted_date) : null;
    return {
      stem,
      extension,
      date: parsed && !Number.isNaN(parsed.getTime()) ? parsed : null,
      kind: IMAGE_EXTENSIONS.has(extension.toLowerCase()) ? ("IMG" as const) : ("VID" as const),
      invented: false,
    };
  });
  const image = files.find((file) => file.kind === "IMG");
  const video = files.find((file) => file.kind === "VID");
  const picked = [image, video].filter((file): file is SampleFile => file !== undefined);
  return picked.length > 0 ? picked : files.slice(0, 2);
}

/** The folder segments below the destination root, under the current settings. */
export function exampleSegments(config: Config, t: Translate, locale = "en"): string[] {
  const segments: string[] = [];
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
  // Categorization and preserved source subfolders are mutually exclusive —
  // `build_dest_dir` enforces that precedence — and the camera folder sits
  // innermost, after whichever of the two applied.
  if (config.categorize_enabled) segments.push(t("config.example.category"));
  else if (config.preserve_subfolders) segments.push(t("config.example.subfolder"));
  if (config.camera_subfolder_enabled) segments.push(t("config.example.camera"));
  return segments;
}

// Extensions already in each conversion target, and the extension each target
// writes. Mirrors `backend/app/services/conversion_service.py`, which is the
// only thing that decides whether a suffix changes.
const IMAGE_FORMAT_EXTENSIONS: Record<Config["image_format"], readonly string[]> = {
  jpeg: [".jpg", ".jpeg", ".jpe", ".jfif"],
  png: [".png"],
  webp: [".webp"],
  tiff: [".tif", ".tiff"],
};
const IMAGE_FORMAT_SUFFIX: Record<Config["image_format"], string> = {
  jpeg: ".jpg",
  png: ".png",
  webp: ".webp",
  tiff: ".tif",
};
const VIDEO_FORMAT_SUFFIX: Record<Config["video_format"], string> = {
  mp4: ".mp4",
  mkv: ".mkv",
  mov: ".mov",
  webm: ".webm",
  avi: ".avi",
};

/**
 * The extension the run would leave a file with.
 *
 * Conversion is the only thing that rewrites an extension, and it writes a
 * lowercase one — which is where a `.JPG` becomes a `.jpg`. A file that is
 * *not* converted keeps its extension exactly as it is, uppercase and all;
 * saying otherwise would promise a rename the product does not perform.
 */
export function predictedExtension(config: Config, sample: SampleFile): string {
  const lower = sample.extension.toLowerCase();
  if (sample.kind === "IMG" && config.convert_images) {
    return IMAGE_FORMAT_EXTENSIONS[config.image_format].includes(lower)
      ? sample.extension
      : IMAGE_FORMAT_SUFFIX[config.image_format];
  }
  if (sample.kind === "VID" && config.convert_videos) {
    return lower === VIDEO_FORMAT_SUFFIX[config.video_format]
      ? sample.extension
      : VIDEO_FORMAT_SUFFIX[config.video_format];
  }
  return sample.extension;
}

/** The filename a sample would carry after conversion and rename are applied. */
export function exampleFilename(config: Config, sample: SampleFile): string {
  const extension = predictedExtension(config, sample);
  if (!config.rename) return `${sample.stem}${extension}`;
  return renderPattern(
    config.rename_pattern,
    sample.date ?? EXAMPLE_MOMENT,
    sample.stem,
    extension,
    sample.kind,
  );
}

/**
 * The review folders the current settings can actually produce.
 *
 * Two of them are switched on and off by a setting; the rest describe things
 * that can happen to a *file* — no readable date, a date in the future, a read
 * that fails — and so are always possible while the run is placing files at
 * all. In `deduplicate_only` nothing is placed by date, so the date-related
 * folders and "already in destination" cannot arise.
 */
export function possibleReviewFolders(config: Config): string[] {
  const placing = config.run_mode !== "deduplicate_only";
  return REVIEW_FOLDER_NAMES.filter((folder) => {
    if (folder === "_duplicates") return config.remove_duplicates;
    if (folder === "_junk") return config.junk_filter_enabled;
    if (folder === "_unknown_dates" || folder === "_future_dates") return placing;
    if (folder === "_already_in_destination") return placing;
    return true; // _corrupted and _failed: a file can always defeat a read.
  });
}

export interface FolderPreviewNode {
  name: string;
  kind: "folder" | "review" | "file";
  children?: FolderPreviewNode[];
}

/**
 * The shape of the destination the current settings would build.
 *
 * A worked example beats any amount of prose about folder structure, and a
 * tree beats a single slash-separated line: the line could not show the review
 * folders sitting *beside* the date hierarchy rather than inside it, which is
 * the one thing about the layout that surprises people.
 *
 * Returns the children of the destination root; the root itself is the caller's
 * to name.
 */
export function folderPreviewTree(
  config: Config,
  t: Translate,
  locale: string,
  samples: readonly SampleFile[],
): FolderPreviewNode[] {
  const review: FolderPreviewNode[] = possibleReviewFolders(config).map((name) => ({
    name,
    kind: "review",
  }));

  // Nothing is placed in this mode, so there is no hierarchy to draw — only
  // the folders the run adds beside the library it leaves alone.
  if (config.run_mode === "deduplicate_only") return review;

  const files: FolderPreviewNode[] = samples.map((sample) => ({
    name: exampleFilename(config, sample),
    kind: "file",
  }));

  const nested = exampleSegments(config, t, locale).reduceRight<FolderPreviewNode[]>(
    (children, name) => [{ name, kind: "folder", children }],
    files,
  );

  return [...nested, ...review];
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
