// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DestinationTree } from "@/components/screens/review/DestinationTree";
import { I18nProvider, translate } from "@/i18n/I18nContext";
import type { TreeNode } from "@/lib/reviewPlan";

const EMPTY_TREE: TreeNode = {
  path: "",
  name: "Destination",
  count: 0,
  children: [],
  isNew: false,
  isReview: false,
};

afterEach(cleanup);

function renderTree(outOfScopeSets: number, onOpenSources?: () => void) {
  render(
    <I18nProvider initialLocale="en">
      <DestinationTree
        root={EMPTY_TREE}
        selectedPath={null}
        onSelect={() => undefined}
        outOfScopeSets={outOfScopeSets}
        onOpenSources={onOpenSources}
      />
    </I18nProvider>,
  );
}

describe("out-of-scope duplicate disclosure", () => {
  it("omits the disclosure when the truthful count is zero", () => {
    renderTree(0);

    expect(
      screen.queryByText(translate("en", "review.browse.alsoInLibrary", { count: 0 })),
    ).toBeNull();
  });

  it("states the remaining count when another configured scope is missing", () => {
    renderTree(2);

    expect(
      screen.getByText(translate("en", "review.browse.alsoInLibrary", { count: 2 })),
    ).toBeTruthy();
  });

  it("explains the actual exclusion and provides a keyboard-operable path to Sources", () => {
    const onOpenSources = vi.fn();
    renderTree(2, onOpenSources);

    fireEvent.click(
      screen.getByRole("button", {
        name: translate("en", "review.browse.alsoInLibrary", { count: 2 }),
      }),
    );

    expect(screen.getByText(translate("en", "review.browse.alsoInLibrary.rule"))).toBeTruthy();
    const action = screen.getByRole("button", {
      name: translate("en", "review.browse.openSources"),
    });
    action.focus();
    fireEvent.keyDown(action, { key: "Enter" });
    fireEvent.click(action);
    expect(onOpenSources).toHaveBeenCalledOnce();
  });
});
