// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { PlanScreen } from "@/components/screens/PlanScreen";
import { I18nProvider } from "@/i18n/I18nContext";
import type { PreviewResult } from "@/types/api";

function result(overrides: {
  duplicates: number;
  pending: number;
  unresolved: number;
}): PreviewResult {
  return {
    config_fingerprint: "test",
    plan_id: "plan_test",
    impact: {
      actionable_groups: 10,
      copy_count: 10,
      move_count: 0,
      quarantine_count: 0,
      quarantine_bytes: 0,
      skip_count: 0,
      source_mutations: 0,
      required_bytes: 0,
      conversion_without_originals: 0,
      companions_left_in_place: 0,
      embedded_tag_count: 0,
      unresolved_count: overrides.unresolved,
    },
    items: [],
    stats: {
      total: 20,
      will_sort: 10,
      will_fail: 0,
      will_quarantine_unknown: 0,
      will_quarantine_future: 0,
      will_skip_duplicate: overrides.duplicates,
      duplicate_unknown: overrides.pending,
      will_quarantine_junk: 0,
      will_skip_already_in_destination: 0,
      uncategorized: 0,
    },
    partial: false,
    issues: [],
  } as unknown as PreviewResult;
}

afterEach(cleanup);

describe("PlanScreen duplicate summary (MS-02)", () => {
  it("counts duplicate files from the dry run, never the unresolved counter as sets", () => {
    render(
      <I18nProvider initialLocale="en">
        <PlanScreen
          result={result({ duplicates: 3, pending: 1, unresolved: 9 })}
          inputCount={1}
          referenceCount={0}
          onRecalculate={() => {}}
          onOpenReview={() => {}}
        />
      </I18nProvider>,
    );

    expect(
      screen.getByText("4 files look like duplicates and are shown in the review workspace."),
    ).toBeTruthy();
    expect(screen.queryByText(/duplicate sets/)).toBeNull();
  });
});
