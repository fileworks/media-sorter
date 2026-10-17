// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { RecoveryBanner } from "@/components/RecoveryBanner";
import { I18nProvider } from "@/i18n/I18nContext";
import type { RecoveryOperation } from "@/lib/startupRecovery";

const interrupted: RecoveryOperation = {
  operation_id: "op1",
  started_at: "2026-10-11T10:00:00Z",
  state: "reconciliation_required",
  artifacts: [
    { action_id: "a1", kind: "stage", path: "/t/a", verified: false, redundant: true },
    { action_id: "a2", kind: "stage", path: "/t/b", verified: false, redundant: true },
    { action_id: "a3", kind: "result", path: "/t/c", verified: false, redundant: false },
  ],
};

afterEach(cleanup);

describe("RecoveryBanner in German (MS-06)", () => {
  it("words counts, guidance and actions in the active locale", () => {
    render(
      <I18nProvider initialLocale="de">
        <RecoveryBanner operation={interrupted} onDecide={() => {}} onOpenReport={() => {}} />
      </I18nProvider>,
    );

    expect(
      screen.getByText("1 Element aus einem unterbrochenen Lauf braucht deine Entscheidung"),
    ).toBeTruthy();
    expect(screen.getByText("2 Reste wurden automatisch aufgelöst.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Behalten" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bericht öffnen" })).toBeTruthy();
    expect(screen.queryByText(/leftover|Keep|Discard/)).toBeNull();
  });
});
