// @vitest-environment jsdom

/**
 * A calculated plan makes the stages behind it readable, not editable.
 *
 * The old answer was a dialog per settings patch: six edits meant six identical
 * questions, and the plan was destroyed on the first answer, so the remaining
 * five asked about a plan that was already gone. The lock asks once, at the
 * moment the intent to edit appears — and until then, walking back through the
 * flow costs nothing and warns about nothing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { StageShell } from "@/components/StageShell";
import { I18nProvider, translate } from "@/i18n/I18nContext";
import { isStageLocked, type StageInputs, type StageKey } from "@/lib/stageModel";

const PLANNED: StageInputs = {
  rootsReady: true,
  rootsReason: null,
  scanned: true,
  planned: true,
  plannedReason: null,
  duplicateReviewReady: true,
  duplicateReviewReason: null,
  reviewStateDurable: true,
  executionActive: false,
  blocked: false,
  blockedReason: null,
};

const PLAN_KEY: StageKey = {
  profileId: "p1",
  catalogGeneration: 1,
  planVersion: 1,
  taskId: null,
};

afterEach(cleanup);

function renderShell({
  planExists = true,
  onUnlock = vi.fn(),
}: { planExists?: boolean; onUnlock?: () => void } = {}) {
  render(
    <I18nProvider initialLocale="en">
      <StageShell
        inputs={PLANNED}
        stageKey={PLAN_KEY}
        titleBar={<div />}
        planExists={planExists}
        onUnlock={onUnlock}
      >
        {(state, _nav, locked) => (
          <div>
            <p data-testid="stage">{state.stage}</p>
            <p data-testid="locked">{String(locked)}</p>
            <button type="button">A setting</button>
          </div>
        )}
      </StageShell>
    </I18nProvider>,
  );
  return onUnlock;
}

/** Walk the stepper to a stage by its accessible name. */
function goToStage(stage: string) {
  fireEvent.click(screen.getByRole("button", { name: translate("en", `stage.${stage}.label`) }));
}

describe("which stages a plan locks", () => {
  it("locks the two that fed the plan and neither of the two that read it", () => {
    expect(isStageLocked("sources", true)).toBe(true);
    expect(isStageLocked("configure", true)).toBe(true);
    expect(isStageLocked("review", true)).toBe(false);
    expect(isStageLocked("execute", true)).toBe(false);
  });

  it("locks nothing at all without a plan", () => {
    for (const stage of ["sources", "configure", "review", "execute"] as const) {
      expect(isStageLocked(stage, false)).toBe(false);
    }
  });
});

describe("the lock", () => {
  it("disables every control and says so, with the way out beside it", () => {
    renderShell();

    expect(screen.getByTestId("locked").textContent).toBe("true");
    expect(screen.getByText(translate("en", "stage.locked.title"))).toBeTruthy();

    // The settings sit inside a disabled fieldset; the banner's action does not.
    const setting = screen.getByRole("button", { name: "A setting" });
    const boundary = setting.closest("fieldset[disabled]");
    expect(boundary).not.toBeNull();
    // `button.disabled` reflects the attribute only; the inherited state is
    // what `:disabled` matches, and it is what stops the click and the focus.
    expect(setting.matches(":disabled")).toBe(true);

    const unlock = screen.getByRole("button", { name: translate("en", "stage.locked.action") });
    expect(boundary?.contains(unlock)).toBe(false);
    expect(unlock.matches(":disabled")).toBe(false);
  });

  it("leaves the text selectable, because a locked screen is one you are reading", () => {
    renderShell();

    // `inert` would have been the shorter way to block the region and it also
    // makes everything inside it unselectable — which takes away the one
    // interaction a read-only screen exists for. Nothing here may reintroduce
    // it, by attribute or by `user-select`.
    const setting = screen.getByRole("button", { name: "A setting" });
    expect(setting.closest("[inert]")).toBeNull();

    const boundary = setting.closest("fieldset[disabled]") as HTMLElement;
    expect(boundary.className).toContain("read-only-region");
    expect(boundary.style.userSelect).toBe("");
    expect(screen.getByText(translate("en", "stage.locked.selectable"))).toBeTruthy();
  });

  it("asks once before discarding, and only then unlocks", () => {
    const onUnlock = renderShell();

    fireEvent.click(screen.getByRole("button", { name: translate("en", "stage.locked.action") }));

    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(translate("en", "stage.locked.confirm.title"))).toBeTruthy();
    expect(onUnlock).not.toHaveBeenCalled();

    fireEvent.click(
      within(dialog).getByRole("button", { name: translate("en", "stage.locked.confirm.action") }),
    );
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });

  it("cancelling the confirmation changes nothing", () => {
    const onUnlock = renderShell();

    fireEvent.click(screen.getByRole("button", { name: translate("en", "stage.locked.action") }));
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: translate("en", "common.cancel"),
      }),
    );

    expect(onUnlock).not.toHaveBeenCalled();
    expect(screen.getByTestId("locked").textContent).toBe("true");
  });

  it("renders no banner and no inert region once the plan is gone", () => {
    renderShell({ planExists: false });

    expect(screen.getByTestId("locked").textContent).toBe("false");
    expect(screen.queryByText(translate("en", "stage.locked.title"))).toBeNull();
    expect(screen.getByRole("button", { name: "A setting" }).closest("[inert]")).toBeNull();
  });
});

describe("walking back through locked stages", () => {
  it("raises no dialog and keeps the plan", () => {
    const onUnlock = renderShell();

    for (const stage of ["review", "configure", "sources"]) {
      goToStage(stage);
      expect(screen.getByTestId("stage").textContent).toBe(stage);
      // No confirmation, no warning banner: nothing was lost by looking.
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.queryByText(translate("en", "stage.invalidated.settings"))).toBeNull();
    }

    expect(onUnlock).not.toHaveBeenCalled();
  });
});
