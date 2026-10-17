// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { OperationCenter } from "@/components/OperationCenter";
import { I18nProvider } from "@/i18n/I18nContext";
import type { OperationSummary } from "@/lib/operationCenter";

const finished: OperationSummary = {
  operationId: "op-1",
  kind: "sort",
  startedAt: "2026-10-11T10:00:00Z",
  finishedAt: "2026-10-11T10:05:00Z",
  outcome: "partial",
  counts: {
    verified_success: 12,
    warnings: 0,
    skipped: 0,
    quarantined: 2,
    failed: 1,
    unresolved: 0,
  },
  bytesWritten: null,
  reportId: "op-1",
  recoveryState: "none",
};

afterEach(cleanup);

describe("OperationCenter in German (MS-05, MS-06, NEW-2)", () => {
  it("translates report facts, offers one History action and invents no byte total", () => {
    const onOpen = vi.fn();
    render(
      <I18nProvider initialLocale="de">
        <OperationCenter operations={[finished]} onOpen={onOpen} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { expanded: false }));

    expect(screen.getByText(/Teilweise abgeschlossen/)).toBeTruthy();
    expect(screen.getByText("Einsortiert: 12")).toBeTruthy();
    expect(screen.getByText("Beiseitegelegt: 2")).toBeTruthy();
    expect(screen.queryByText(/geschrieben/)).toBeNull();
    for (const raw of ["report", "quarantine", "logs", "recovery", "Organized", "Failed"]) {
      expect(screen.queryByText(raw, { exact: false })).toBeNull();
    }

    fireEvent.click(screen.getByRole("button", { name: "Im Verlauf öffnen" }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
