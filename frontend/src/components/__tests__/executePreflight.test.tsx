// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ExecutePreflight } from "@/components/OperationCenter";
import { I18nProvider, translate } from "@/i18n/I18nContext";
import type { PreflightInput } from "@/lib/operationCenter";

afterEach(cleanup);

const input: PreflightInput = {
  impactState: "ready",
  actionableGroups: 1,
  quarantineCount: 0,
  quarantineBytes: 0,
  copyCount: 1,
  moveCount: 0,
  skipCount: 0,
  referenceCount: 0,
  sourceMutations: 0,
  acknowledgedSourceMutations: true,
  staleGroups: 0,
  unresolvedGroups: 0,
  freeBytes: 1,
  requiredBytes: 2048,
  quarantineWritable: true,
  conversionWithoutOriginals: 0,
  companionsLeftInPlace: 0,
  embeddedTagCount: 0,
};

describe("preflight blocker presentation", () => {
  it.each(["en", "de"] as const)("shows the actual capacity blocker in %s", (locale) => {
    render(
      <I18nProvider initialLocale={locale}>
        <ExecutePreflight input={input} onAcknowledge={() => {}} onExecute={() => {}} />
      </I18nProvider>,
    );

    expect(screen.getByRole("alert").textContent).toContain(
      translate(locale, "preflight.blocking.space", { required: "2.0 KB", available: "1 B" }),
    );
    expect(
      screen.queryByText(/interrupted operation|Nothing was lost|timestamp precision/i),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: translate(locale, "preflight.execute") }),
    ).toHaveProperty("disabled", true);
  });
});
