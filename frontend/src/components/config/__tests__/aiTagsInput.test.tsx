// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { AiTagsInput } from "@/components/config/fields/AiTagsInput";
import { I18nProvider } from "@/i18n/I18nContext";

afterEach(cleanup);

it.each(["en", "de"] as const)("preserves custom label spelling in %s", (locale) => {
  const onCommit = vi.fn();
  render(
    <I18nProvider initialLocale={locale}>
      <AiTagsInput labels={[]} onCommit={onCommit} />
    </I18nProvider>,
  );
  const input = screen.getByRole("textbox");
  fireEvent.change(input, { target: { value: "  Family ÄÖ  " } });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onCommit).toHaveBeenCalledWith(["Family ÄÖ"]);
});

it("still rejects a case-insensitive duplicate without changing the existing label", () => {
  const onCommit = vi.fn();
  render(
    <I18nProvider initialLocale="en">
      <AiTagsInput labels={["Family"]} onCommit={onCommit} />
    </I18nProvider>,
  );
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "family" } });
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "," });
  expect(onCommit).not.toHaveBeenCalled();
  expect(screen.getByText("Family")).toBeTruthy();
});
