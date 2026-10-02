// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { CompanionEvidencePanel } from "@/components/CompanionEvidencePanel";
import { I18nProvider } from "@/i18n/I18nContext";
import type { PreviewItem } from "@/types/api";

const ITEM = {
  source: "/input/IMG_0001.jpg",
  destination: "/sorted/2026/IMG_0001.jpg",
  extracted_date: "2026-08-21",
  metadata_source: "exif",
  tags: [],
  status: "sort",
  unit_id: "unit-1",
  unit_primary: true,
  companions: [
    {
      source: "/input/IMG_0001.xmp",
      destination: "/sorted/2026/IMG_0001.xmp",
      role: "edit_sidecar",
      status: "attached",
      warning: "Sidecar parser reported an unknown namespace.",
    },
  ],
  unit_warnings: ["Review this media unit after execution."],
} satisfies PreviewItem;

afterEach(cleanup);

describe("companion evidence shared by Plan, preflight, and Execute", () => {
  it("never lists a file that belongs to no unit, or names the unit 'null'", () => {
    // JSON carries an absent unit as `null` as readily as it omits the key, and
    // `null !== undefined` is true — so the strict filter admitted every file
    // with no unit at all and then rendered "Primary in unit null".
    const orphan = {
      ...ITEM,
      source: "/input/IMG_9999.jpg",
      unit_id: null,
      companions: [],
      unit_warnings: [],
    } as unknown as PreviewItem;

    const { container } = render(
      <I18nProvider initialLocale="en">
        <CompanionEvidencePanel items={[orphan]} />
      </I18nProvider>,
    );

    expect(container.textContent ?? "").not.toContain("null");
    expect(screen.queryByText("/input/IMG_9999.jpg")).toBeNull();
  });

  it("renders role, membership, destination, warning, and outcome in English", () => {
    render(
      <I18nProvider initialLocale="en">
        <CompanionEvidencePanel items={[ITEM]} />
      </I18nProvider>,
    );

    expect(screen.getByText("Primary in unit unit-1")).toBeTruthy();
    expect(screen.getByText(/Result: Will be organized.*IMG_0001\.jpg/)).toBeTruthy();
    expect(
      screen.getByText(
        /IMG_0001\.xmp.*Edit sidecar.*Planned with the primary file.*unknown namespace/,
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Review this media unit after execution/)).toBeTruthy();
  });

  it("localizes the evidence framing in German without changing source facts", () => {
    render(
      <I18nProvider initialLocale="de">
        <CompanionEvidencePanel items={[ITEM]} />
      </I18nProvider>,
    );

    expect(screen.getByText("Primärdatei in Einheit unit-1")).toBeTruthy();
    expect(screen.getByText(/Ergebnis: Wird einsortiert.*Ziel:.*IMG_0001\.jpg/)).toBeTruthy();
    expect(
      screen.getByText(/Rolle: Bearbeitungs-Sidecar.*Warnung:.*unknown namespace/),
    ).toBeTruthy();
  });
});
