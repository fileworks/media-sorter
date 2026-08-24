// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReportPanel } from "@/components/ReportPanel";
import { I18nProvider, translate } from "@/i18n/I18nContext";
import type { OperationReport } from "@/types/api";

const REPORT: OperationReport = {
  operation_id: "operation-1",
  execution_date: "2026-08-08T12:00:00Z",
  started_at: "2026-08-08T11:59:00Z",
  finished_at: "2026-08-08T12:00:00Z",
  outcome: "completed",
  run_mode: "organize",
  transfer_mode: "copy",
  source_path: "/library/phone",
  source_roots: [
    {
      root_id: "phone",
      role: "input",
      path: "/library/phone",
      display_name: "Phone",
    },
    {
      root_id: "archive",
      role: "reference",
      path: "/library/archive",
      display_name: null,
    },
  ],
  dest_path: "/library/sorted",
  excluded_roots: ["/library/camera"],
  duration_seconds: 0,
  summary: {
    total: 0,
    sorted: 0,
    failed: 0,
    skipped: 0,
    remaining: 0,
    duplicates: 0,
    future_dates: 0,
    unknown_dates: 0,
    corrupted: 0,
  },
  files: [],
};

afterEach(cleanup);

describe("run scope in reports", () => {
  it("names every root that the completed operation deliberately skipped", () => {
    render(
      <I18nProvider initialLocale="en">
        <ReportPanel report={REPORT} />
      </I18nProvider>,
    );

    expect(screen.getByText(translate("en", "report.excludedRoots", { count: 1 }))).toBeTruthy();
    expect(screen.getByText("/library/camera")).toBeTruthy();
  });

  it("shows outcome, actual sources, run mode, and terminal counts without calling partial success", () => {
    const partial: OperationReport = {
      ...REPORT,
      outcome: "partial",
      summary: {
        ...REPORT.summary,
        sorted: 4,
        failed: 1,
        skipped: 2,
        remaining: 3,
        incomplete_units: 1,
        unmatched_companions: 1,
      },
    };

    render(
      <I18nProvider initialLocale="en">
        <ReportPanel report={partial} />
      </I18nProvider>,
    );

    expect(screen.getByText(translate("en", "report.outcome.partial"))).toBeTruthy();
    expect(screen.getByText("Phone")).toBeTruthy();
    expect(screen.getByText("/library/archive")).toBeTruthy();
    expect(screen.getByText(translate("en", "report.runMode.organize"))).toBeTruthy();
    expect(screen.getByText(translate("en", "report.summary.skipped"))).toBeTruthy();
    expect(screen.getByText(translate("en", "report.summary.remaining"))).toBeTruthy();
  });

  it("keeps companion membership, role, placement, warning, and result visible", () => {
    const withCompanion: OperationReport = {
      ...REPORT,
      outcome: "partial",
      summary: {
        ...REPORT.summary,
        total: 2,
        sorted: 1,
        failed: 1,
        companions: 1,
        incomplete_units: 1,
      },
      files: [
        {
          id: "primary",
          operation_id: REPORT.operation_id,
          source_path: "/library/phone/IMG_0001.jpg",
          dest_path: "/library/sorted/2026/IMG_0001.jpg",
          extracted_date: "2026-08-08",
          metadata_source: "exif",
          action: "copy",
          status: "success",
          error_message: null,
          file_size: 100,
          file_type: ".jpg",
          tags: [],
          unit_id: "unit-1",
          companion_role: null,
          unit_primary_path: "/library/phone/IMG_0001.jpg",
        },
        {
          id: "sidecar",
          operation_id: REPORT.operation_id,
          source_path: "/library/phone/IMG_0001.xmp",
          dest_path: "/library/sorted/2026/IMG_0001.xmp",
          extracted_date: null,
          metadata_source: null,
          action: "copy",
          status: "incomplete_unit",
          error_message: "The primary changed; this sidecar was retained.",
          file_size: 20,
          file_type: ".xmp",
          tags: [],
          unit_id: "unit-1",
          companion_role: "xmp_sidecar",
          unit_primary_path: "/library/phone/IMG_0001.jpg",
        },
      ],
    };

    render(
      <I18nProvider initialLocale="en">
        <ReportPanel report={withCompanion} />
      </I18nProvider>,
    );

    expect(screen.getByText(translate("en", "report.unit.primary"))).toBeTruthy();
    expect(
      screen.getByText(
        translate("en", "report.unit.companion", {
          role: "Unknown companion role (xmp_sidecar)",
        }),
      ),
    ).toBeTruthy();
    expect(screen.getAllByText(/Primary: IMG_0001\.jpg/)).toHaveLength(2);
    expect(screen.getByText("The primary changed; this sidecar was retained.")).toBeTruthy();
    expect(screen.getByText("/library/sorted/2026/IMG_0001.xmp")).toBeTruthy();
    expect(screen.getByText(translate("en", "report.status.incompleteUnit"))).toBeTruthy();
  });
});
