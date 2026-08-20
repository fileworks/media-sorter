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
  // The burst row used to be this behaviour's vehicle. It is gated off until
  // the catalog can produce burst stacks (see the suite below), so the junk
  // filter — the other row that reveals labelled sub-settings — carries it now.
  it("gives each reveal a label of its own rather than the parent's row", () => {
    renderClean({ junk_filter_enabled: true });

    const row = rowFor(translate("en", "config.filters.junk"));
    expect(row.textContent).toContain(translate("en", "config.filters.junkSize"));
    expect(row.textContent).toContain(translate("en", "config.filters.resolution"));

    // The revealed inputs are labelled, so they are reachable by name rather
    // than only by the aria-label they used to carry inside the parent's
    // control container.
    expect(screen.getByLabelText(translate("en", "config.filters.junkSize"))).toBeTruthy();
    expect(screen.getByLabelText(translate("en", "config.filters.resolution"))).toBeTruthy();
  });

  it("shows no sub-block while the parent is off", () => {
    renderClean({ junk_filter_enabled: false });

    expect(screen.queryByLabelText(translate("en", "config.filters.junkSize"))).toBeNull();
  });
});

/**
 * The inverse of what this asserted under `W0-UI-001`, which hid the control
 * because a setting that cannot deliver its result is worse than an absent one.
 * `P2-DEDUP-D3` landed the producer, so the burst view can return groups and
 * the control is back — `P2-DEDUP-D9`.
 *
 * That the *feature* works is proven where it lives, against a real indexed
 * library, in `backend/tests/test_indexing_completeness.py`. What belongs here
 * is only that the control renders and still writes nothing on its own.
 */
describe("the burst control is back now that the catalog can produce bursts", () => {
  it("renders the burst row again", () => {
    renderClean({ burst_detection_enabled: true });

    expect(screen.queryByText(translate("en", "config.bursts.detect"))).not.toBeNull();
    expect(screen.queryByLabelText(translate("en", "config.bursts.window"))).not.toBeNull();
    expect(screen.queryByLabelText(translate("en", "config.bursts.distance"))).not.toBeNull();
  });

  it("keeps its sub-settings behind the parent switch", () => {
    renderClean({ burst_detection_enabled: false });

    expect(screen.queryByText(translate("en", "config.bursts.detect"))).not.toBeNull();
    expect(screen.queryByLabelText(translate("en", "config.bursts.window"))).toBeNull();
    expect(screen.queryByLabelText(translate("en", "config.bursts.distance"))).toBeNull();
  });

  it("never rewrites the stored value merely by rendering", () => {
    const writes: Partial<Config>[] = [];
    render(
      <I18nProvider initialLocale="en">
        <CleanGroup
          config={{ ...TEST_CONFIG, burst_detection_enabled: true }}
          updateConfig={(patch) => writes.push(patch)}
          fieldErrors={new Map()}
          samples={INVENTED_SAMPLES}
        />
      </I18nProvider>,
    );

    expect(writes).toEqual([]);
  });
});
