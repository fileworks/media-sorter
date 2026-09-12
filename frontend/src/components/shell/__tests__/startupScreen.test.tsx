// @vitest-environment jsdom

/**
 * Starting is a sequence, and the screen has to read like one.
 *
 * The value of naming the steps is entirely in their ordering: at most one may
 * claim to be running, nothing may claim to be running behind a failure, and a
 * step whose precondition has not been met is `pending` rather than silently
 * looking finished.
 */

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { StartupScreen } from "@/components/shell/StartupScreen";
import { startupSteps } from "@/lib/startupProgress";
import { I18nProvider, translate } from "@/i18n/I18nContext";

const en = (key: string) => translate("en", key);

const nothing = {
  sessionReady: false,
  sessionFailed: false,
  backendReady: false,
  backendFailed: false,
  configReady: false,
  configFailed: false,
};

afterEach(cleanup);

describe("startup step sequencing", () => {
  it("runs the first step and holds the rest until it finishes", () => {
    const steps = startupSteps(nothing, en);

    expect(steps.map((step) => step.state)).toEqual(["running", "pending", "pending"]);
  });

  it("advances exactly one step at a time", () => {
    expect(startupSteps({ ...nothing, sessionReady: true }, en).map((s) => s.state)).toEqual([
      "done",
      "running",
      "pending",
    ]);
    expect(
      startupSteps({ ...nothing, sessionReady: true, backendReady: true }, en).map((s) => s.state),
    ).toEqual(["done", "done", "running"]);
    expect(
      startupSteps(
        { ...nothing, sessionReady: true, backendReady: true, configReady: true },
        en,
      ).map((s) => s.state),
    ).toEqual(["done", "done", "done"]);
  });

  it("never shows work in progress behind a failure", () => {
    // The engine answered nothing, so "loading your settings" is not merely
    // unfinished — it has not been attempted, and must not spin as if it had.
    const steps = startupSteps({ ...nothing, sessionReady: true, backendFailed: true }, en);

    expect(steps.map((step) => step.state)).toEqual(["done", "failed", "pending"]);
    expect(steps.filter((step) => step.state === "running")).toEqual([]);
  });

  it("reports a failure at the very first step without inventing progress", () => {
    const steps = startupSteps({ ...nothing, sessionFailed: true }, en);

    expect(steps.map((step) => step.state)).toEqual(["failed", "pending", "pending"]);
  });
});

describe("StartupScreen", () => {
  it("names every step and marks the one in progress", () => {
    render(
      <I18nProvider initialLocale="en">
        <StartupScreen
          steps={startupSteps({ ...nothing, sessionReady: true }, en)}
          failure={null}
          onRetry={() => undefined}
        />
      </I18nProvider>,
    );

    const list = screen.getByRole("list", { name: en("startup.title") });
    for (const key of ["startup.step.session", "startup.step.backend", "startup.step.config"]) {
      expect(within(list).getByText(en(key))).toBeTruthy();
    }
    const current = within(list)
      .getAllByRole("listitem")
      .filter((item) => item.getAttribute("aria-current") === "step");
    expect(current).toHaveLength(1);
    expect(current[0].textContent).toContain(en("startup.step.backend"));
  });

  it("offers a way out when the start cannot continue, and stops claiming progress", () => {
    render(
      <I18nProvider initialLocale="en">
        <StartupScreen
          steps={startupSteps({ ...nothing, sessionFailed: true }, en)}
          failure="The backend session could not be resolved."
          onRetry={() => undefined}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("alert").textContent).toContain("could not be resolved");
    expect(screen.getByRole("button", { name: en("app.reload") })).toBeTruthy();
    expect(screen.getByText(en("startup.failedTitle"))).toBeTruthy();
  });
});
