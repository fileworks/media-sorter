// @vitest-environment jsdom

/**
 * P-09: the states a feature can be in, and how each one is announced.
 *
 * `StateViewVariant` had seven members, so three real states had nowhere to go.
 * A cancelled stage was rendered as `blocked` with different words — painted
 * amber and announced as a warning, when nothing had gone wrong and nothing was
 * standing in the way.
 *
 * The `role` / `aria-live` mapping is the accessibility contract, not a detail
 * of it: `alert` interrupts a screen reader mid-sentence and is reserved for the
 * one variant that reports something broken. These tests pin that mapping per
 * variant, because it is invisible on screen and silently regresses.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { StateView, type StateViewVariant } from "@/components/StateView";
import { I18nProvider, translate } from "@/i18n/I18nContext";

afterEach(cleanup);

/** The rendered label, taken from the catalogue rather than guessed at. */
const RETRY = translate("en", "state.retry");

function renderView(props: Partial<React.ComponentProps<typeof StateView>> = {}) {
  return render(
    <I18nProvider initialLocale="en">
      <StateView variant="info" title="A title" {...props} />
    </I18nProvider>,
  );
}

const ALL_VARIANTS: StateViewVariant[] = [
  "empty",
  "loading",
  "error",
  "blocked",
  "success",
  "info",
  "warning",
  "partial",
  "stale-derived",
  "cancelled",
];

describe("the variant vocabulary", () => {
  it.each(ALL_VARIANTS)("%s renders with a severity", (variant) => {
    const { container } = renderView({ variant });

    const panel = container.querySelector("[data-severity]");
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("data-severity")).toBeTruthy();
  });

  it("agrees with presentOutcome about the outcomes they both name", () => {
    // Two tables describing the same words is how one screen ends up amber and
    // another blue for the same run.
    const { container: partial } = renderView({ variant: "partial" });
    const { container: cancelled } = renderView({ variant: "cancelled" });

    expect(partial.querySelector("[data-severity]")?.getAttribute("data-severity")).toBe("warning");
    expect(cancelled.querySelector("[data-severity]")?.getAttribute("data-severity")).toBe("info");
  });
});

describe("the accessibility contract", () => {
  it("reserves the assertive role for error", () => {
    renderView({ variant: "error", title: "It broke" });

    expect(screen.getByRole("alert")).toBeTruthy();
  });

  it.each<[StateViewVariant, "polite" | null]>([
    ["loading", "polite"],
    ["partial", "polite"],
    ["stale-derived", "polite"],
    ["cancelled", "polite"],
    ["empty", null],
    ["success", null],
    ["blocked", null],
    ["info", null],
    ["warning", null],
  ])("%s announces politely: %s", (variant, expected) => {
    const { container } = renderView({ variant });

    const panel = container.querySelector("[data-severity]");
    expect(panel?.getAttribute("aria-live")).toBe(expected);
  });

  it.each<StateViewVariant>(["partial", "stale-derived", "cancelled"])(
    "%s uses the status role, not alert",
    (variant) => {
      const { container } = renderView({ variant });

      expect(container.querySelector("[data-severity]")?.getAttribute("role")).toBe("status");
    },
  );

  it("marks only loading as busy", () => {
    const { container: loading } = renderView({ variant: "loading" });
    const { container: cancelled } = renderView({ variant: "cancelled" });

    expect(loading.querySelector("[data-severity]")?.getAttribute("aria-busy")).toBe("true");
    expect(cancelled.querySelector("[data-severity]")?.getAttribute("aria-busy")).toBeNull();
  });
});

describe("recoverable is orthogonal to the variant", () => {
  it("offers a retry for a recoverable error", () => {
    renderView({ variant: "error", onRetry: vi.fn(), recoverable: true });

    expect(screen.getByRole("button", { name: RETRY })).toBeTruthy();
  });

  it("offers no retry for a terminal error, even with a handler", () => {
    renderView({ variant: "error", onRetry: vi.fn(), recoverable: false });

    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
  });

  it("still shows a retry when recoverability was not stated", () => {
    // The existing callers pass no `recoverable`, and must keep working.
    renderView({ variant: "error", onRetry: vi.fn() });

    expect(screen.getByRole("button", { name: RETRY })).toBeTruthy();
  });

  it("applies to any variant, not only error", () => {
    renderView({ variant: "partial", onRetry: vi.fn(), recoverable: false });

    expect(screen.queryByRole("button", { name: RETRY })).toBeNull();
  });
});
