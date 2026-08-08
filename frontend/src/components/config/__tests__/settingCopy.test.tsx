// @vitest-environment jsdom

/**
 * The description beside a setting is a fixed fact about that setting.
 *
 * It used to double as the place per-value guidance and the reason a row was
 * unavailable were shown, which meant the sentence a reader had started
 * reading could be replaced by a different one because they moved a dropdown —
 * or because a disk probe landed. Anything that follows from the value now has
 * its own line, and these tests pin the description in place across exactly the
 * events that used to move it.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { CleanGroup } from "@/components/config/groups/CleanGroup";
import { SettingRow } from "@/components/ui/setting-row";
import { I18nProvider, translate } from "@/i18n/I18nContext";
import { TEST_CONFIG } from "@/lib/__tests__/configFixture";
import { INVENTED_SAMPLES } from "@/lib/configSummary";
import type { Config } from "@/types/api";

afterEach(cleanup);

function renderClean(overrides: Partial<Config>) {
  return render(
    <I18nProvider initialLocale="en">
      <CleanGroup
        config={{ ...TEST_CONFIG, ...overrides }}
        updateConfig={() => undefined}
        fieldErrors={new Map()}
        samples={INVENTED_SAMPLES}
      />
    </I18nProvider>,
  );
}

/** The row's own block, so a query cannot pick up a neighbour's text. */
function rowFor(label: string): HTMLElement {
  const heading = screen.getByText(label);
  const row = heading.closest("div.px-5");
  expect(row).not.toBeNull();
  return row as HTMLElement;
}

describe("a description does not change under the reader", () => {
  it("keeps the keep-rule description while the selected rule changes", () => {
    const label = translate("en", "config.duplicates.keepRule");
    const description = translate("en", "config.duplicates.keepRuleHelp");

    renderClean({ remove_duplicates: true, duplicate_keeper_policy: "largest" });
    expect(rowFor(label).textContent).toContain(description);
    expect(rowFor(label).textContent).toContain(translate("en", "config.keeper.largest.help"));

    cleanup();
    renderClean({ remove_duplicates: true, duplicate_keeper_policy: "oldest" });
    expect(rowFor(label).textContent).toContain(description);
    // The guidance moved; the description did not.
    expect(rowFor(label).textContent).toContain(translate("en", "config.keeper.oldest.help"));
    expect(rowFor(label).textContent).not.toContain(translate("en", "config.keeper.largest.help"));
  });

  it("keeps the description when a row becomes unavailable, and adds the reason", () => {
    const description = "What this setting is.";
    const reason = "Off while something else is on.";

    const { rerender } = render(
      <I18nProvider initialLocale="en">
        <SettingRow label="A setting" description={description} disabledReason={reason}>
          <span>control</span>
        </SettingRow>
      </I18nProvider>,
    );
    expect(screen.getByText(description)).toBeTruthy();
    expect(screen.queryByText(reason)).toBeNull();

    rerender(
      <I18nProvider initialLocale="en">
        <SettingRow label="A setting" description={description} disabled disabledReason={reason}>
          <span>control</span>
        </SettingRow>
      </I18nProvider>,
    );

    // Both, not one instead of the other — which is what it used to do.
    expect(screen.getByText(description)).toBeTruthy();
    expect(screen.getByText(reason)).toBeTruthy();
  });
});

describe("revealed sub-settings render as their own block", () => {
  it("gives each reveal a label of its own rather than the parent's row", () => {
    renderClean({ burst_detection_enabled: true });

    const row = rowFor(translate("en", "config.bursts.detect"));
    expect(row.textContent).toContain(translate("en", "config.bursts.window"));
    expect(row.textContent).toContain(translate("en", "config.bursts.distance"));

    // The revealed inputs are labelled, so they are reachable by name rather
    // than only by the aria-label they used to carry inside the parent's
    // control container.
    expect(screen.getByLabelText(translate("en", "config.bursts.window"))).toBeTruthy();
    expect(screen.getByLabelText(translate("en", "config.bursts.distance"))).toBeTruthy();
  });

  it("shows no sub-block while the parent is off", () => {
    renderClean({ burst_detection_enabled: false });

    expect(screen.queryByLabelText(translate("en", "config.bursts.window"))).toBeNull();
  });
});
