// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CONFIG_RAIL,
  PROVENANCE_DECISIONS_WITHOUT_SETTING,
  provenanceDecisionCoverage,
} from "@/components/config/groups";
import { DestinationExplanation } from "@/components/screens/review/DestinationExplanation";
import { I18nProvider, translate } from "@/i18n/I18nContext";
import type { OutcomeProvenance } from "@/types/api";

const provenance: OutcomeProvenance = {
  date: {
    resolved_date: "2024-03-02",
    winning_source: "filename",
    candidates: [
      { source: "exif", value: null, accepted: false, rejection_reason: "absent" },
      {
        source: "filename",
        value: "2024-03-02",
        accepted: true,
        rejection_reason: null,
      },
    ],
  },
  categorization: {
    enabled: true,
    label: "travel",
    confidence: 0.81,
    threshold: 0.55,
    passed: true,
  },
  rules: {
    matched_tags: [{ name: "Camera JPEG", priority: 2, saved_order: 1 }],
    matched_routes: [
      { name: "Trips", priority: 4, saved_order: 0 },
      { name: "Archive", priority: 9, saved_order: 1 },
    ],
    winning_route: { name: "Trips", priority: 4, saved_order: 0 },
    route_folder: "trip",
  },
  duplicate: {
    evaluated: true,
    status: "unique",
    match_kind: null,
    matched_path: null,
    perceptual_distance: null,
  },
  unit: { unit_id: "unit-1", role: "primary", members: ["/in/IMG_1.jpg"] },
  path: [
    { segment: "2024", decision: "date", detail: "year from filename" },
    { segment: "03", decision: "date", detail: "month from filename" },
    {
      segment: "travel",
      decision: "category",
      detail: "classifier passed its confidence threshold",
    },
    { segment: "trip", decision: "route", detail: "winning route rule" },
    { segment: ".png", decision: "conversion", detail: "conversion changes .jpg to .png" },
    {
      segment: "2024_IMG_1.png",
      decision: "rename",
      detail: "rename pattern 'YYYY_NAME' applied to original stem 'IMG_1'",
    },
    {
      segment: "2024_IMG_1_001.png",
      decision: "collision",
      detail: "reserved after collision with 2024_IMG_1.png",
    },
  ],
};

const en = (key: string, params?: Record<string, string | number>) => translate("en", key, params);

afterEach(cleanup);

describe("destination provenance ownership", () => {
  it("maps every backend decision to an existing Configure anchor or an explicit no-setting case", () => {
    const anchors = new Set(CONFIG_RAIL.map((entry) => entry.id));
    const coverage = provenanceDecisionCoverage();

    expect(coverage).toHaveLength(10);
    expect(new Set(coverage.map(({ decision }) => decision)).size).toBe(10);
    for (const { decision, anchor } of coverage) {
      if (PROVENANCE_DECISIONS_WITHOUT_SETTING.has(decision)) {
        expect(anchor, `${decision} must remain an automatic outcome`).toBeNull();
      } else {
        expect(anchor, `${decision} has no Configure owner`).not.toBeNull();
        expect(anchors.has(anchor as string), `${decision} points outside CONFIG_RAIL`).toBe(true);
      }
    }
  });
});

describe("DestinationExplanation", () => {
  it("draws the whole destination, one control per part, each naming its reason", () => {
    render(
      <I18nProvider initialLocale="en">
        <DestinationExplanation provenance={provenance} onOpenSetting={() => undefined} />
      </I18nProvider>,
    );

    // Every recorded part is on the path line, and carries its decision and
    // detail in its accessible name rather than in a card of its own.
    for (const part of provenance.path) {
      const control = screen.getByRole("button", {
        name: `${en(`review.detail.decision.${part.decision}`)} — ${part.detail}`,
      });
      expect(control.textContent).toBe(part.segment);
    }
    expect(screen.getByText(en("review.detail.settingCost"))).toBeTruthy();
    // Nothing is explained until something is asked.
    expect(screen.getByText(en("review.detail.pickSegment"))).toBeTruthy();
  });

  it("explains the part being read, and offers the setting that decided it", () => {
    const onOpenSetting = vi.fn();
    render(
      <I18nProvider initialLocale="en">
        <DestinationExplanation provenance={provenance} onOpenSetting={onOpenSetting} />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: `${en("review.detail.decision.date")} — year from filename`,
      }),
    );
    expect(screen.getByText("year from filename")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", {
        name: en("review.detail.openSettingFor", {
          decision: en("review.detail.decision.date"),
        }),
      }),
    );
    expect(onOpenSetting).toHaveBeenCalledWith("setting-structure");
  });

  it("offers no setting for a part no setting decided", () => {
    render(
      <I18nProvider initialLocale="en">
        <DestinationExplanation provenance={provenance} onOpenSetting={() => undefined} />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: `${en("review.detail.decision.collision")} — reserved after collision with 2024_IMG_1.png`,
      }),
    );
    expect(screen.getByText(en("review.detail.noSetting"))).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: en("review.detail.openSettingFor", {
          decision: en("review.detail.decision.collision"),
        }),
      }),
    ).toBeNull();
  });

  it("keeps every losing candidate in the folded evidence", () => {
    render(
      <I18nProvider initialLocale="en">
        <DestinationExplanation provenance={provenance} onOpenSetting={() => undefined} />
      </I18nProvider>,
    );

    expect(screen.getByText(/Archive.*priority 9/i)).toBeTruthy();
    expect(screen.getByText(/travel passed at 81%.*55%/i)).toBeTruthy();
    expect(screen.getByText(/Camera JPEG/)).toBeTruthy();
    expect(screen.getByText("/in/IMG_1.jpg")).toBeTruthy();
  });

  it("says nothing about a media unit when the file belongs to none", () => {
    render(
      <I18nProvider initialLocale="en">
        <DestinationExplanation
          provenance={{ ...provenance, unit: null }}
          onOpenSetting={() => undefined}
        />
      </I18nProvider>,
    );

    expect(screen.queryByText(en("review.detail.evidence.unit"))).toBeNull();
  });

  it("shows a below-threshold category without inventing a folder", () => {
    render(
      <I18nProvider initialLocale="en">
        <DestinationExplanation
          provenance={{
            ...provenance,
            categorization: {
              enabled: true,
              label: null,
              confidence: 0.42,
              threshold: 0.55,
              passed: false,
            },
            path: provenance.path.filter((part) => part.decision !== "category"),
          }}
          onOpenSetting={() => undefined}
        />
      </I18nProvider>,
    );

    expect(screen.getByText(/42%.*55%/)).toBeTruthy();
    expect(screen.queryByText("_uncategorized")).toBeNull();
  });
});
