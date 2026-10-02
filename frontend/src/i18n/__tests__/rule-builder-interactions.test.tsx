// @vitest-environment jsdom

import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { RuleBuilderInline } from "@/components/RuleBuilder";
import { I18nProvider, type Locale } from "@/i18n/I18nContext";
import type { Config, RuleSet } from "@/types/api";

const emptyRuleSet: RuleSet = { version: 1, tag_rules: [], route_rules: [] };

function Harness({
  initial = emptyRuleSet,
  locale = "en",
}: {
  initial?: RuleSet;
  locale?: Locale;
}) {
  const [config, setConfig] = useState({
    rules_enabled: true,
    rule_set: initial,
  } as Config);

  return (
    <I18nProvider initialLocale={locale}>
      <RuleBuilderInline
        config={config}
        updateConfig={(patch) => setConfig((current) => ({ ...current, ...patch }))}
      />
      <output data-testid="rule-set">{JSON.stringify(config.rule_set)}</output>
    </I18nProvider>
  );
}

function currentRuleSet(): RuleSet {
  return JSON.parse(screen.getByTestId("rule-set").textContent ?? "{}") as RuleSet;
}

function openNewRule(): void {
  fireEvent.click(screen.getByRole("button", { name: /add rule/i }));
}

afterEach(cleanup);

describe("typed rule editor interactions", () => {
  it("creates tag and route rules with condition-specific controls", () => {
    render(<Harness />);

    openNewRule();
    fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "JPEG files" } });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: ".JPG" } });
    fireEvent.change(screen.getByLabelText("Tag"), { target: { value: "Family" } });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));

    expect(currentRuleSet().tag_rules[0]).toMatchObject({
      name: "JPEG files",
      condition: { type: "extension", value: "jpg" },
      tag: "Family",
    });

    openNewRule();
    fireEvent.change(screen.getByLabelText("Rule kind"), { target: { value: "route" } });
    fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "Screenshots" } });
    fireEvent.change(screen.getByLabelText("Condition"), {
      target: { value: "filename_contains" },
    });
    fireEvent.change(screen.getByLabelText("Value"), { target: { value: "ScreenShot" } });
    fireEvent.change(screen.getByLabelText("Relative route suffix"), {
      target: { value: "screenshots/mobile" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));

    expect(currentRuleSet().route_rules[0]).toMatchObject({
      name: "Screenshots",
      condition: { type: "filename_contains", value: "ScreenShot" },
      relative_folder: "screenshots/mobile",
    });

    openNewRule();
    fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "resolution" } });
    expect(screen.getByLabelText("Width")).toBeTruthy();
    expect(screen.getByLabelText("Height")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Condition"), { target: { value: "size" } });
    expect(screen.getByLabelText("Operator")).toBeTruthy();
  });

  it("validates required values and unsafe routes before persistence", () => {
    render(<Harness />);
    openNewRule();
    fireEvent.change(screen.getByLabelText("Rule kind"), { target: { value: "route" } });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));

    expect(screen.getByText("Rule name is required")).toBeTruthy();
    expect(screen.getByText("Enter a value to match")).toBeTruthy();
    expect(screen.getByText("An action value is required")).toBeTruthy();
    expect(currentRuleSet()).toEqual(emptyRuleSet);

    fireEvent.change(screen.getByLabelText("Relative route suffix"), {
      target: { value: "../escape" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect(screen.getByText(/safe relative path/)).toBeTruthy();
  });

  it("edits without changing identity, toggles, reorders equal priorities, and deletes", () => {
    const initial: RuleSet = {
      version: 1,
      tag_rules: [
        {
          id: "first",
          name: "First",
          enabled: true,
          priority: 5,
          condition: { type: "extension", value: "jpg" },
          tag: "Family",
        },
        {
          id: "second",
          name: "Second",
          enabled: true,
          priority: 5,
          condition: { type: "extension", value: "png" },
          tag: "Screenshot",
        },
      ],
      route_rules: [],
    };
    render(<Harness initial={initial} />);

    fireEvent.click(screen.getByRole("switch", { name: "Rule enabled: First" }));
    expect(currentRuleSet().tag_rules[0].enabled).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Move rule down: First" }));
    expect(currentRuleSet().tag_rules.map((rule) => rule.id)).toEqual(["second", "first"]);

    fireEvent.click(screen.getAllByRole("button", { name: "Edit" })[1]);
    fireEvent.change(screen.getByLabelText("Rule name"), { target: { value: "First edited" } });
    fireEvent.change(screen.getByLabelText("Priority"), { target: { value: "8" } });
    fireEvent.click(screen.getByRole("button", { name: "Save rule" }));

    expect(currentRuleSet().tag_rules[1]).toMatchObject({
      id: "first",
      name: "First edited",
      priority: 8,
    });

    fireEvent.click(screen.getAllByRole("button", { name: "Delete" })[0]);
    expect(currentRuleSet().tag_rules.map((rule) => rule.id)).toEqual(["first"]);

    fireEvent.click(screen.getByRole("switch", { name: "Enable rules" }));
    expect(screen.queryByText("First edited")).toBeNull();
  });

  it("renders German accessible names and controls at a narrow viewport", () => {
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
    render(<Harness locale="de" />);

    expect(screen.getByRole("switch", { name: "Regeln aktivieren" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /regel hinzufügen/i }));
    expect(screen.getByLabelText("Regelart")).toBeTruthy();
    expect(screen.getByLabelText("Regelname")).toBeTruthy();
  });
});
