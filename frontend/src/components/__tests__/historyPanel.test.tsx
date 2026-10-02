// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HistoryPanel } from "@/components/HistoryPanel";
import { I18nProvider, translate } from "@/i18n/I18nContext";

const historyState = vi.hoisted(() => ({
  current: {
    operations: [] as Record<string, unknown>[],
    total: 0,
    isLoading: false,
    error: null as Error | null,
    refetch: vi.fn(),
  },
}));

vi.mock("@/hooks/useReportHistory", () => ({
  useReportHistory: () => historyState.current,
}));

function renderHistory() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <HistoryPanel />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  historyState.current = {
    operations: [],
    total: 0,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  };
});

afterEach(cleanup);

describe("history lifecycle presentation", () => {
  it("keeps outcome, sources, and terminal counts consistent with the report contract", () => {
    historyState.current.operations = [
      {
        id: "sort-1",
        execution_date: "2026-08-09T10:01:00Z",
        started_at: "2026-08-09T10:00:00Z",
        finished_at: "2026-08-09T10:01:00Z",
        outcome: "partial",
        run_mode: "organize",
        transfer_mode: "copy",
        source_path: "/phone",
        source_roots: [
          {
            root_id: "phone",
            role: "input",
            path: "/phone",
            display_name: "Phone",
          },
        ],
        dest_path: "/sorted",
        total_files: 12,
        files_sorted: 4,
        files_failed: 1,
        files_skipped: 2,
        duplicates_found: 1,
        future_dates: 0,
        unknown_dates: 1,
        corrupted_files: 0,
        junk_files: 0,
        already_in_destination: 1,
        incomplete_units: 1,
        unmatched_companions: 0,
        remaining_files: 3,
        duration_seconds: 60,
      },
    ];
    historyState.current.total = 1;

    renderHistory();

    expect(screen.getByText(/Phone → \/sorted/)).toBeTruthy();
    expect(screen.getByText(translate("en", "report.outcome.partial"))).toBeTruthy();
    expect(screen.getByText(/6 changed · 3 skipped · 2 need attention · 3 remaining/)).toBeTruthy();
  });

  it("surfaces list failures with a retry instead of an empty-history claim", () => {
    historyState.current.error = new Error("offline");

    renderHistory();

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(translate("en", "history.listFailed"))).toBeTruthy();
    expect(screen.queryByText(translate("en", "history.empty"))).toBeNull();
  });
});
