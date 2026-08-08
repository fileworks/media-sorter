// @vitest-environment jsdom

/**
 * The Recipe stage does not move while it is being read.
 *
 * The difference panel used to be inserted as a sibling of the grid when a card
 * was chosen, so picking one pushed the whole screen down — under the pointer
 * that had just picked it. The region is now permanent, and the mark that says
 * "this is the card you are reading" is a ring rather than a border, so it costs
 * no layout either.
 *
 * jsdom has no layout, so "nothing moved" is asserted structurally: the same
 * elements, in the same order, with the same containers, before and after.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { RecipeScreen } from "@/components/screens/RecipeScreen";
import { I18nProvider, translate } from "@/i18n/I18nContext";
import { TEST_CONFIG } from "@/lib/__tests__/configFixture";
import { CONFIG_RECIPES, applyRecipe } from "@/lib/configRecipes";
import type { Config } from "@/types/api";

afterEach(cleanup);

function renderRecipes(
  config: Config = TEST_CONFIG,
  onApply = vi.fn(),
  defaults: Partial<Config> | undefined = undefined,
) {
  render(
    <I18nProvider initialLocale="en">
      <RecipeScreen
        config={config}
        savedRecipes={[]}
        onApply={onApply}
        onDelete={() => undefined}
        defaults={defaults}
      />
    </I18nProvider>,
  );
  return onApply;
}

/** The cards, in document order, as the shape the grid occupies. */
function cardNames(): string[] {
  return screen
    .getAllByRole("button", { pressed: false })
    .concat(screen.queryAllByRole("button", { pressed: true }))
    .map((button) => button.textContent ?? "");
}

describe("choosing a recipe moves nothing", () => {
  it("keeps every card in the same place and the region in the same container", () => {
    renderRecipes();

    const before = cardNames();
    const regionBefore = document.getElementById("recipe-difference")?.closest("section");
    const regionParentBefore = regionBefore?.parentElement;

    const target = CONFIG_RECIPES.find((recipe) => !recipe.recommended);
    expect(target).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(translate("en", target?.labelKey ?? "")) }),
    );

    expect(cardNames()).toEqual(before);
    const regionAfter = document.getElementById("recipe-difference")?.closest("section");
    expect(regionAfter).toBe(regionBefore);
    expect(regionAfter?.parentElement).toBe(regionParentBefore);
  });

  it("opens on the recommended recipe rather than on nothing", () => {
    renderRecipes();

    const recommended = CONFIG_RECIPES.find((recipe) => recipe.recommended);
    expect(recommended).toBeDefined();
    expect(document.getElementById("recipe-difference")?.textContent).toBe(
      translate("en", recommended?.labelKey ?? ""),
    );
  });

  it("says a recipe already in force would change nothing, and cannot be applied", () => {
    const safeSort = CONFIG_RECIPES.find((recipe) => recipe.id === "safe_sort");
    expect(safeSort).toBeDefined();
    const applied: Config = {
      ...TEST_CONFIG,
      ...applyRecipe(TEST_CONFIG, safeSort as (typeof CONFIG_RECIPES)[number]),
    };

    renderRecipes(applied);

    expect(screen.getByText(translate("en", "recipes.inForce"))).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: translate("en", "recipes.apply") })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("applies the patch the panel showed, and only on the apply control", () => {
    const onApply = renderRecipes();

    // Chosen because its patch is deterministic: the two profile builders that
    // stamp `new Date()` would never compare equal across two calls.
    const target = CONFIG_RECIPES.find((recipe) => recipe.id === "clean_sweep");
    expect(target).toBeDefined();
    fireEvent.click(
      screen.getByRole("button", { name: new RegExp(translate("en", target?.labelKey ?? "")) }),
    );
    // Selecting a card is reading, not writing.
    expect(onApply).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: translate("en", "recipes.apply") }));
    expect(onApply).toHaveBeenCalledWith(
      applyRecipe(TEST_CONFIG, target as (typeof CONFIG_RECIPES)[number]),
    );
  });

  it("keeps the same rows while the wider reset reveals and emphasises its column", () => {
    const current = {
      ...TEST_CONFIG,
      min_file_size_kb: (TEST_CONFIG.min_file_size_kb ?? 0) + 64,
    };
    renderRecipes(current, vi.fn(), TEST_CONFIG);

    const table = screen.getByRole("table");
    const before = [...table.querySelectorAll("tbody tr")].map(
      (row) => row.querySelector("th, td")?.textContent,
    );
    expect(screen.getByRole("columnheader", { name: /after the recipe/i })).toBeTruthy();
    expect(screen.queryByRole("columnheader", { name: /after the full reset/i })).toBeNull();

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: new RegExp(`^${translate("en", "recipes.resetOthers")}`),
      }),
    );

    const after = [...table.querySelectorAll("tbody tr")].map(
      (row) => row.querySelector("th, td")?.textContent,
    );
    expect(after).toEqual(before);
    expect(
      screen
        .getByRole("columnheader", { name: /after the full reset/i })
        .getAttribute("aria-current"),
    ).toBe("true");
    expect(screen.getAllByText(translate("en", "config.reset.unchanged")).length).toBeGreaterThan(
      0,
    );
  });

  it("enables the wider action when the recipe itself is already in force", () => {
    const safeSort = CONFIG_RECIPES.find((recipe) => recipe.id === "safe_sort");
    expect(safeSort).toBeDefined();
    const applied = {
      ...TEST_CONFIG,
      ...applyRecipe(TEST_CONFIG, safeSort as (typeof CONFIG_RECIPES)[number]),
      rename: true,
      rename_pattern: "{name}-custom",
    };
    const onApply = vi.fn();
    renderRecipes(applied, onApply, TEST_CONFIG);

    const apply = screen.getByRole("button", { name: translate("en", "recipes.apply") });
    expect(apply.hasAttribute("disabled")).toBe(true);

    fireEvent.click(
      screen.getByRole("checkbox", {
        name: new RegExp(`^${translate("en", "recipes.resetOthers")}`),
      }),
    );
    expect(apply.hasAttribute("disabled")).toBe(false);
    fireEvent.click(apply);
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({
        rename: TEST_CONFIG.rename,
        rename_pattern: TEST_CONFIG.rename_pattern,
      }),
    );
  });
});
