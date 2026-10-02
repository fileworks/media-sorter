// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SetupScreen } from "@/components/screens/SetupScreen";
import { I18nProvider } from "@/i18n/I18nContext";

afterEach(cleanup);

it("keeps adjustments optional and navigable while a plan locks recipe changes", () => {
  function Harness() {
    const [adjusting, setAdjusting] = useState(false);
    return (
      <SetupScreen
        locked
        adjusting={adjusting}
        onAdjustingChange={setAdjusting}
        recipe={<button>Apply recipe</button>}
        settings={(back) => (
          <button data-open-recipes onClick={back}>
            Back to recipes
          </button>
        )}
      />
    );
  }
  render(
    <I18nProvider initialLocale="en">
      <Harness />
    </I18nProvider>,
  );
  expect(screen.getByRole("button", { name: "Apply recipe" }).matches(":disabled")).toBe(true);
  expect(screen.queryByRole("button", { name: "Back to recipes" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Adjust settings (optional)" }));
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Back to recipes" }));
  fireEvent.click(screen.getByRole("button", { name: "Back to recipes" }));
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Adjust settings (optional)" }),
  );
  expect(screen.getByRole("button", { name: "Apply recipe" }).matches(":disabled")).toBe(true);
});

it("opens adjustments immediately for a setting deep link", () => {
  render(
    <I18nProvider initialLocale="en">
      <SetupScreen
        locked={false}
        adjusting
        onAdjustingChange={() => {}}
        recipe={<p>Recipes</p>}
        settings={() => <p>Requested setting</p>}
      />
    </I18nProvider>,
  );
  expect(screen.getByText("Requested setting")).toBeTruthy();
  expect(screen.queryByText("Recipes")).toBeNull();
});
