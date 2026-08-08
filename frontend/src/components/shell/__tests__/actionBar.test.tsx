// @vitest-environment jsdom

/**
 * The footer's sentence survives the longest reason the app can put beside it.
 *
 * The reason for a disabled primary action used to sit unbounded in the actions
 * cluster, so a two-sentence German conflict message squeezed the footer message
 * to a word and a half and pushed the buttons off their usual place. It is now
 * clamped and width-bounded, the message is guaranteed half the row, and the
 * full text stays reachable.
 *
 * jsdom has no layout, so the guarantee is asserted where it is actually
 * expressed — the classes and the DOM order — rather than through a measured
 * width that would be zero either way.
 */

import { describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import { ActionBar } from "@/components/shell/ActionBar";
import { de } from "@/i18n/messages";

/**
 * The families the footer's `disabledReason` is built from: a folder conflict,
 * a preflight refusal, a stage gate, or the busy note. Taking the longest of
 * them keeps this test honest as the catalogue grows, instead of pinning one
 * string that some later edit makes no longer the worst case.
 */
const REASON_PREFIXES = ["sources.conflict.", "preflight.", "stage.gate.", "footer.busy"];

const LONGEST_GERMAN_REASON = Object.entries(de)
  .filter(([key]) => REASON_PREFIXES.some((prefix) => key.startsWith(prefix)))
  .map(([, value]) => value)
  .sort((a, b) => b.length - a.length)[0];

function renderBar(reason: string) {
  cleanup();
  return render(
    <ActionBar
      message="Nichts wird gelöscht — Duplikate werden zur Prüfung beiseitegelegt."
      back={{ label: "Zurück", onClick: () => undefined }}
      primary={{
        label: "Änderungen ansehen",
        onClick: () => undefined,
        disabled: true,
        disabledReason: reason,
      }}
    />,
  );
}

describe("the footer keeps its message readable", () => {
  it("has a longest German reason worth bounding", () => {
    expect(LONGEST_GERMAN_REASON.length).toBeGreaterThan(60);
  });

  it("clamps the longest German reason and keeps its full text reachable", () => {
    renderBar(LONGEST_GERMAN_REASON);

    const reason = document.getElementById("action-bar-reason");
    expect(reason).not.toBeNull();
    const node = reason as HTMLElement;

    // Two lines at most, and never wider than a bounded share of the rail.
    expect(node.className).toContain("line-clamp-2");
    expect(node.className).toMatch(/max-w-\[[\d.]+rem\]/);
    // Hover and focus both reveal the rest; the title is the hover half.
    expect(node.getAttribute("title")).toBe(LONGEST_GERMAN_REASON);
    expect(node.className).toContain("hover:line-clamp-none");
    expect(node.className).toContain("group-focus-within/footer:line-clamp-none");
  });

  it("guarantees the message half the row and puts the reason before the actions", () => {
    renderBar(LONGEST_GERMAN_REASON);

    const message = screen.getByText(/Nichts wird gelöscht/).closest("p") as HTMLElement;
    expect(message.className).toContain("basis-1/2");
    expect(message.className).toContain("flex-1");

    // Its own element between the message and the actions cluster: at the
    // column breakpoint that is a line of its own above the buttons, rather
    // than an item competing with them inside their row.
    const reason = document.getElementById("action-bar-reason") as HTMLElement;
    const actions = screen.getByRole("button", { name: /Änderungen ansehen/ })
      .parentElement as HTMLElement;
    expect(reason.parentElement).toBe(actions.parentElement);
    expect(reason.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("still describes the disabled action to assistive technology", () => {
    renderBar(LONGEST_GERMAN_REASON);

    const primary = screen.getByRole("button", { name: /Änderungen ansehen/ });
    expect(primary.getAttribute("aria-describedby")).toBe("action-bar-reason");
  });

  it("renders no reason element while the action is enabled", () => {
    cleanup();
    render(
      <ActionBar
        message="Bereit."
        primary={{ label: "Weiter", onClick: () => undefined, disabledReason: "ungenutzt" }}
      />,
    );

    expect(document.getElementById("action-bar-reason")).toBeNull();
  });
});
