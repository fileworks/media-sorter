/**
 * Turning a projection into something honest on screen.
 *
 * The backend already refuses to overstate what it measured; this module's job
 * is to keep that intact in the UI. A range stays a range, an unknown stays a
 * blank with a reason, and a lossy profile is never described with the same
 * words as moving a file.
 */

import type { ItemProjection, OptimizationProjection, SampleEncode } from "@/services/api";

export type ConfidenceTone = "measured" | "estimated" | "unknown";

export interface ProjectedSize {
  /** Pre-formatted label, or `null` when no number may be claimed. */
  label: string | null;
  /** True when the label is a band rather than a single number. */
  isRange: boolean;
  /** Why there is no number, when there is no number. */
  reason: string | null;
}

/** Bytes → a short label. Kept local so this module stays dependency-free. */
export function formatBytesShort(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Number(value.toFixed(1));
  return `${bytes < 0 ? "-" : ""}${rounded} ${units[unit]}`;
}

/**
 * How a projected output size may be written.
 *
 * A `measured` item was itself encoded, so it gets one number. Anything else
 * gets the band the sampling actually supports — collapsing that band to its
 * midpoint would invent precision the encode never produced.
 */
export function projectedSize(item: ItemProjection): ProjectedSize {
  if (item.projected_low_bytes === null || item.projected_high_bytes === null) {
    return { label: null, isRange: false, reason: item.reason };
  }
  if (item.projected_low_bytes === item.projected_high_bytes) {
    return { label: formatBytesShort(item.projected_low_bytes), isRange: false, reason: null };
  }
  return {
    label: `${formatBytesShort(item.projected_low_bytes)} – ${formatBytesShort(
      item.projected_high_bytes,
    )}`,
    isRange: true,
    reason: null,
  };
}

export function confidenceTone(confidence: ItemProjection["confidence"]): ConfidenceTone {
  if (confidence === "measured") return "measured";
  if (confidence === "unknown") return "unknown";
  return "estimated";
}

/** Every non-measured figure must be labelled as an estimate, not a result. */
export function isEstimate(item: ItemProjection): boolean {
  return item.confidence !== "measured";
}

export interface SavingSummary {
  label: string | null;
  percentLabel: string | null;
  positive: boolean;
  reason: string | null;
}

export function savingSummary(projection: OptimizationProjection): SavingSummary {
  if (projection.estimated_saving_bytes === null || projection.current_bytes <= 0) {
    return {
      label: null,
      percentLabel: null,
      positive: false,
      reason: projection.warnings[0] ?? "No saving could be projected",
    };
  }
  const saving = projection.estimated_saving_bytes;
  const percent = (saving / projection.current_bytes) * 100;
  return {
    label: formatBytesShort(saving),
    percentLabel: `${percent >= 10 ? Math.round(percent) : Number(percent.toFixed(1))}%`,
    positive: saving > 0,
    reason: null,
  };
}

export type RecommendationTone = "recommended" | "skip" | "blocked";

export interface RecommendationView {
  tone: RecommendationTone;
  /** Plain language, never a mechanism name. */
  headline: string;
  detail: string;
  /** True when proceeding needs a deliberate override. */
  requiresOverride: boolean;
}

export function recommendationView(item: ItemProjection): RecommendationView {
  if (item.recommendation === "blocked") {
    return {
      tone: "blocked",
      headline: "Cannot be optimized",
      detail: item.reason,
      requiresOverride: false,
    };
  }
  if (item.recommendation === "skip") {
    return {
      tone: "skip",
      headline: "Skip recommended",
      detail: item.reason,
      requiresOverride: true,
    };
  }
  return {
    tone: "recommended",
    headline: "Worth optimizing",
    detail: item.reason,
    requiresOverride: false,
  };
}

/**
 * The one sentence that must appear wherever a lossy profile is offered.
 *
 * Optimization is never presented as ordinary movement, so the copy is derived
 * from the mode rather than written per screen.
 */
export function modeDisclosure(mode: OptimizationProjection["mode"]): string {
  if (mode === "visually_lossless") {
    return "This re-encodes your media. The result is not identical to the original — only measured to stay within the declared thresholds. Originals are kept in quarantine.";
  }
  if (mode === "lossless") {
    return "This rewrites the file without changing a single decoded pixel or sample. The bytes change, so external checksums will not match.";
  }
  return "Optimization is disabled. Files are organized without being re-encoded.";
}

export interface SamplePresentation {
  /** True when a real candidate exists to compare against the original. */
  canCompare: boolean;
  /** What was actually encoded, for the modal's header. */
  scope: string;
  outcome: "passed" | "failed" | "unproven";
  warnings: string[];
  /** The caveat shown whenever a passing sample is displayed. */
  batchCaveat: string;
}

export function samplePresentation(sample: SampleEncode): SamplePresentation {
  const outcome = sample.passed === true ? "passed" : sample.passed === false ? "failed" : "unproven";
  return {
    canCompare: sample.comparable && sample.candidate_path !== null,
    scope: sample.sampling_scope,
    outcome,
    warnings: sample.warnings,
    batchCaveat:
      "This is one representative encode. Every file is validated again during execution — a good sample is not approval for the batch.",
  };
}

/** Estimate-only previews must not offer a comparison that does not exist. */
export function comparableSamples(projection: OptimizationProjection): SampleEncode[] {
  return projection.samples.filter((sample) => sample.comparable && sample.candidate_path !== null);
}

export interface SpaceRequirement {
  temporaryLabel: string;
  quarantineLabel: string;
  note: string;
}

export function spaceRequirement(projection: OptimizationProjection): SpaceRequirement {
  return {
    temporaryLabel: formatBytesShort(projection.temporary_space_bytes),
    quarantineLabel: formatBytesShort(projection.quarantine_space_bytes),
    note: "Originals are moved to quarantine rather than deleted, so the space they use is not reclaimed by this operation.",
  };
}
