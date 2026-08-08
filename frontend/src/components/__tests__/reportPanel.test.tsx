// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { ReportPanel } from "@/components/ReportPanel";
import { I18nProvider, translate } from "@/i18n/I18nContext";
import type { OperationReport } from "@/types/api";

const REPORT: OperationReport = {
  operation_id: "operation-1",
  execution_date: "2026-08-08T12:00:00Z",
  source_path: "/library/phone",
  dest_path: "/library/sorted",
  excluded_roots: ["/library/camera"],
  duration_seconds: 0,
  summary: {
    total: 0,
    sorted: 0,
    failed: 0,
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
});
