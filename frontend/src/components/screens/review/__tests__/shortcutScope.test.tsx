// @vitest-environment jsdom

/**
 * P-13 / WCAG 2.1.4 Character Key Shortcuts (Level A).
 *
 * `ResolveQueue` bound `1`-`9` to `window`, so a digit typed while focus sat on
 * any button anywhere on the screen changed which file the queue would keep.
 * The criterion offers three remedies — switch it off, remap it, or make it
 * active only on focus — and this takes the third.
 *
 * The assertion is deliberately about the **visible draft state**, not about
 * `onKeep`. `chooseByNumber` only calls `setDraftSource`/`setEditingDecision`;
 * it never invokes `onKeep`, so a test that asserted `onKeep` was not called
 * would have passed before the fix and proved nothing.
 */

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ResolveQueue } from "@/components/screens/review/ResolveQueue";
import { I18nProvider } from "@/i18n/I18nContext";
import type { SetEntry } from "@/lib/reviewBrowse";
import type { ReviewRow } from "@/lib/reviewRows";

function row(id: string, source: string, index: number, size: number): ReviewRow {
  const name = source.split("/").pop() ?? source;
  return {
    source,
    name,
    folder: source.slice(0, -(name.length + 1)),
    destination: `/out/${name}`,
    wouldBeDestination: `/out/${name}`,
    status: index === 0 ? "organize" : "duplicate",
    flags: [],
    sizeBytes: 1000 + index,
    date: null,
    dateSource: "none",
    category: null,
    tags: [],
    unitId: null,
    unitPrimary: true,
    companionCount: 0,
    provenance: null,
    stack: {
      id,
      kind: "exact",
      memberId: `${id}:${index}`,
      size,
      isKeeper: index === 0,
      keptInstead: index === 0 ? null : null,
      hasBaseline: false,
      origin: "catalog",
      decisionState: "undecided",
      decisionKind: null,
      isProposedKeeper: false,
      proposalPolicy: null,
    },
    reason: { key: "review.reason.duplicateUndecided", params: { count: size } },
    undated: true,
    suspiciousDate: false,
    futureDate: false,
    setAsideCategory: null,
  };
}

function entry(id = "set-1"): SetEntry {
  const sources = [`/a/${id}.jpg`, `/b/${id}.jpg`];
  const rows = sources.map((source, index) => row(id, source, index, sources.length));
  return {
    kind: "set",
    key: `set:${id}`,
    id,
    setKind: "exact",
    origin: "catalog",
    rows,
    keeper: rows[0],
    hasBaseline: false,
    decisionState: "undecided",
    decisionKind: null,
    proposedKeeper: null,
    proposalPolicy: null,
    similarity: 100,
    folder: "_stays/undecided",
  };
}

function renderQueue() {
  const set = entry();
  return render(
    <I18nProvider initialLocale="en">
      <button type="button">outside the queue</button>
      <ResolveQueue
        queue={[set]}
        allSets={[set]}
        current={set}
        index={0}
        onGo={() => undefined}
        onOpenSet={() => undefined}
        onKeep={() => undefined}
        onKeepAll={() => undefined}
        onAcceptProposal={() => undefined}
        onCompare={() => undefined}
        onOpenDetail={() => undefined}
        onBackToBrowse={() => undefined}
        rule="largest"
        onRule={() => undefined}
        proposalCount={0}
        onAcceptAllProposals={() => undefined}
        selectedSetIds={new Set()}
        onToggleSetSelection={() => undefined}
        onSelectSets={() => undefined}
        onClearSetSelection={() => undefined}
        keepSourceByRule={() => null}
        individualOnly={{ perceptual: 0, unmeasured: 0 }}
        destinationRoot="/out"
        sort="name"
        onSort={() => undefined}
      />
    </I18nProvider>,
  );
}

/**
 * The visible draft state: with no draft the confirm control is disabled and
 * the summary says nothing is selected. Both flip the moment a digit lands.
 *
 * This is the assertion the criterion needs. `chooseByNumber` only sets draft
 * state — it never calls `onKeep` — so a test that asserted `onKeep` was not
 * invoked would have passed before the fix and proved nothing.
 */
function draftState(): { confirmDisabled: boolean; clearDisabled: boolean } {
  const confirm = screen.getByRole("button", { name: /confirm selection/i });
  const clear = screen.getByRole("button", { name: /clear selection/i });
  return {
    confirmDisabled: (confirm as HTMLButtonElement).disabled,
    clearDisabled: (clear as HTMLButtonElement).disabled,
  };
}

afterEach(cleanup);

describe("the queue's digit shortcuts are scoped to its own focus", () => {
  it("ignores a digit typed while focus is outside the queue", () => {
    renderQueue();
    const outside = screen.getByRole("button", { name: "outside the queue" });
    outside.focus();
    expect(document.activeElement).toBe(outside);

    const before = draftState();
    expect(before.confirmDisabled).toBe(true);

    // `1` indexes a real row of this set — a digit past the end would be a
    // no-op with or without the fix, and would pass vacuously.
    fireEvent.keyDown(outside, { key: "1" });
    fireEvent.keyDown(window, { key: "1" });

    expect(draftState()).toEqual(before);
  });

  it("still responds to a digit from a focused descendant of the queue", () => {
    const { container } = renderQueue();
    const queueRoot = container.querySelector<HTMLElement>("div[tabindex='-1']");
    expect(queueRoot).not.toBeNull();
    expect(draftState().confirmDisabled).toBe(true);

    queueRoot?.focus();
    expect(queueRoot?.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(window, { key: "1" });

    expect(draftState().confirmDisabled).toBe(false);
  });
});

/**
 * Acceptance (2): no unmodified single-character shortcut may be registered on
 * `window` without either a focus scope or a reviewed entry below.
 *
 * A grep rather than a behavioural assertion, because the defect is a *shape*.
 * The next `window.addEventListener("keydown", …)` should have to justify
 * itself here rather than rely on a review that may not happen.
 */
const REVIEWED_WINDOW_KEYDOWN_LISTENERS: Record<string, string> = {
  "src/components/ui/modal.tsx":
    "Escape only. Escape is not a character key, so WCAG 2.1.4 does not apply; " +
    "the modal also owns a focus trap, so nothing outside it can be focused.",
  "src/components/screens/ReviewScreen.tsx":
    "Escape (not a character key) and Cmd/Ctrl-A (modified). 2.1.4 exempts both.",
  "src/components/screens/review/MediaViewer.tsx":
    "+ / = / - / 0 are unmodified character keys, but the viewer only ever " +
    "renders inside <Modal>, which traps focus — so they are already active " +
    "only while it holds focus, which is the 2.1.4 remedy this codebase uses.",
};

/** The guard that makes a listener focus-scoped rather than global. */
const FOCUS_SCOPE = "contains(document.activeElement)";

describe("no global unmodified character shortcuts", () => {
  const sources = import.meta.glob("/src/**/*.{ts,tsx}", {
    query: "?raw",
    import: "default",
    eager: true,
  }) as Record<string, string>;

  it("every window keydown listener is focus-scoped or explicitly reviewed", () => {
    const unreviewed: string[] = [];

    for (const [path, source] of Object.entries(sources)) {
      if (path.includes("/__tests__/")) continue;
      if (!source.includes('window.addEventListener("keydown"')) continue;

      const relative = path.replace(/^\//, "");
      const reviewed = REVIEWED_WINDOW_KEYDOWN_LISTENERS[relative];
      if (reviewed !== undefined) {
        expect(reviewed.length).toBeGreaterThan(40);
        continue;
      }
      if (source.includes(FOCUS_SCOPE)) continue;
      unreviewed.push(relative);
    }

    expect(unreviewed).toEqual([]);
  });

  it("the digit listener is focus-scoped rather than merely tag-excluded", () => {
    const queue = sources["/src/components/screens/review/ResolveQueue.tsx"];

    expect(queue).toBeDefined();
    expect(queue).toContain(FOCUS_SCOPE);
    // Not on the allowlist: this one had to be fixed, not justified.
    expect(
      REVIEWED_WINDOW_KEYDOWN_LISTENERS["src/components/screens/review/ResolveQueue.tsx"],
    ).toBeUndefined();
  });

  it("the allowlist names every file it claims to, and no stale ones", () => {
    for (const relative of Object.keys(REVIEWED_WINDOW_KEYDOWN_LISTENERS)) {
      const source = sources[`/${relative}`];
      expect(source, `${relative} is allowlisted but does not exist`).toBeDefined();
      expect(source).toContain('window.addEventListener("keydown"');
    }
  });
});
