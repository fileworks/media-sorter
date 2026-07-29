import { describe, expect, it } from "vitest";

import {
  comparableSamples,
  confidenceTone,
  formatBytesShort,
  isEstimate,
  modeDisclosure,
  projectedSize,
  recommendationView,
  samplePresentation,
  savingSummary,
  spaceRequirement,
} from "@/lib/optimizationProjection";
import type { ItemProjection, OptimizationProjection, SampleEncode } from "@/services/api";

function item(overrides: Partial<ItemProjection> = {}): ItemProjection {
  return {
    path: "/library/photo.png",
    current_bytes: 1_000_000,
    projected_low_bytes: 600_000,
    projected_high_bytes: 800_000,
    estimated_saving_bytes: 300_000,
    confidence: "sampled",
    estimate_only: true,
    output_container: "png",
    output_codec: "png",
    quality_setting: "compress_level=9, optimize=True",
    validation_method: "decoded_pixels_identical equals True",
    compatibility_warnings: ["Recompressed PNGs are byte-different"],
    temporary_space_bytes: 1_800_000,
    quarantine_space_bytes: 1_000_000,
    recommendation: "optimize",
    reason: "projected from representative encodes of this library",
    sample_source_path: null,
    ...overrides,
  };
}

function sample(overrides: Partial<SampleEncode> = {}): SampleEncode {
  return {
    source_path: "/library/photo.png",
    candidate_path: "/state/preview/sample0.png",
    source_bytes: 1_000_000,
    candidate_bytes: 700_000,
    size_reduction_ratio: 0.3,
    sampling_scope: "whole file",
    passed: true,
    measurements: { size_reduction_ratio: 0.3 },
    thresholds: { size_reduction_ratio: 0.02 },
    warnings: [],
    comparable: true,
    ...overrides,
  };
}

function projection(overrides: Partial<OptimizationProjection> = {}): OptimizationProjection {
  return {
    contract_id: "image-png-lossless-v1",
    mode: "lossless",
    output_container: "png",
    output_codec: "png",
    item_count: 3,
    current_bytes: 3_000_000,
    projected_low_bytes: 1_800_000,
    projected_high_bytes: 2_400_000,
    estimated_saving_bytes: 900_000,
    confidence: "sampled",
    estimate_only: false,
    recommended_count: 3,
    skipped_count: 0,
    blocked_count: 0,
    temporary_space_bytes: 1_800_000,
    quarantine_space_bytes: 3_000_000,
    samples: [sample()],
    items: [item()],
    warnings: [],
    compatibility_warnings: [],
    failures: [],
    ...overrides,
  };
}

describe("projectedSize", () => {
  it("shows one number only when that number was measured", () => {
    const view = projectedSize(item({ projected_low_bytes: 700_000, projected_high_bytes: 700_000 }));

    expect(view.isRange).toBe(false);
    expect(view.label).toBe("684 KB");
  });

  it("keeps a sampled projection as a range", () => {
    const view = projectedSize(item());

    expect(view.isRange).toBe(true);
    expect(view.label).toContain("–");
  });

  it("returns the reason instead of a number when nothing could be projected", () => {
    const view = projectedSize(
      item({
        projected_low_bytes: null,
        projected_high_bytes: null,
        reason: "no representative encode succeeded",
      }),
    );

    expect(view.label).toBeNull();
    expect(view.reason).toBe("no representative encode succeeded");
  });
});

describe("confidence", () => {
  it("separates measured from estimated and unknown", () => {
    expect(confidenceTone("measured")).toBe("measured");
    expect(confidenceTone("sampled")).toBe("estimated");
    expect(confidenceTone("estimated")).toBe("estimated");
    expect(confidenceTone("unknown")).toBe("unknown");
  });

  it("labels anything that was not itself encoded as an estimate", () => {
    expect(isEstimate(item({ confidence: "measured" }))).toBe(false);
    expect(isEstimate(item({ confidence: "sampled" }))).toBe(true);
  });
});

describe("recommendationView", () => {
  it("recommends skipping a projected size increase and demands an override", () => {
    const view = recommendationView(
      item({ recommendation: "skip", reason: "optimization is projected to make this file larger" }),
    );

    expect(view.tone).toBe("skip");
    expect(view.requiresOverride).toBe(true);
    expect(view.detail).toContain("larger");
  });

  it("never offers an override for a blocked item", () => {
    const view = recommendationView(item({ recommendation: "blocked" }));

    expect(view.tone).toBe("blocked");
    expect(view.requiresOverride).toBe(false);
  });
});

describe("savingSummary", () => {
  it("reports the saving as bytes and a percentage", () => {
    const summary = savingSummary(projection());

    expect(summary.label).toBe("879 KB");
    expect(summary.percentLabel).toBe("30%");
    expect(summary.positive).toBe(true);
  });

  it("refuses to invent a figure when none was projected", () => {
    const summary = savingSummary(
      projection({ estimated_saving_bytes: null, warnings: ["No representative encode"] }),
    );

    expect(summary.label).toBeNull();
    expect(summary.reason).toBe("No representative encode");
  });
});

describe("modeDisclosure", () => {
  it("says plainly that a visually lossless profile is not identical", () => {
    const text = modeDisclosure("visually_lossless");

    expect(text).toMatch(/not identical/i);
    expect(text).toMatch(/quarantine/i);
  });

  it("does not describe a lossless rewrite as lossy", () => {
    expect(modeDisclosure("lossless")).toMatch(/without changing/i);
  });
});

describe("samplePresentation", () => {
  it("offers comparison only when a candidate actually exists", () => {
    expect(samplePresentation(sample()).canCompare).toBe(true);
    expect(
      samplePresentation(sample({ comparable: false, candidate_path: null })).canCompare,
    ).toBe(false);
  });

  it("always carries the caveat that a sample is not batch approval", () => {
    expect(samplePresentation(sample()).batchCaveat).toMatch(/validated again/i);
  });

  it("distinguishes an unproven sample from a failed one", () => {
    expect(samplePresentation(sample({ passed: null })).outcome).toBe("unproven");
    expect(samplePresentation(sample({ passed: false })).outcome).toBe("failed");
  });
});

describe("comparableSamples", () => {
  it("drops samples whose candidates were not retained", () => {
    const estimateOnly = projection({
      samples: [sample({ comparable: false, candidate_path: null })],
      estimate_only: true,
    });

    expect(comparableSamples(estimateOnly)).toHaveLength(0);
  });
});

describe("spaceRequirement", () => {
  it("states that quarantine space is not reclaimed", () => {
    const requirement = spaceRequirement(projection());

    expect(requirement.quarantineLabel).toBe("2.9 MB");
    expect(requirement.note).toMatch(/not reclaimed/i);
  });
});

describe("formatBytesShort", () => {
  it("keeps small numbers readable and large ones short", () => {
    expect(formatBytesShort(512)).toBe("512 B");
    expect(formatBytesShort(1536)).toBe("1.5 KB");
    expect(formatBytesShort(5 * 1024 * 1024 * 1024)).toBe("5 GB");
  });
});
