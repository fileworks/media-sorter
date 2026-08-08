// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

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

function renderTree(outOfScopeSets: number) {
  render(
    <I18nProvider initialLocale="en">
      <DestinationTree
        root={EMPTY_TREE}
        selectedPath={null}
        onSelect={() => undefined}
        outOfScopeSets={outOfScopeSets}
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
});
