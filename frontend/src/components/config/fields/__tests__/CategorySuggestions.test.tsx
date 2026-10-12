// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CategorySuggestions } from "@/components/config/fields/CategorySuggestions";
import { I18nProvider } from "@/i18n/I18nContext";
import { api } from "@/services/api";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function renderSuggestions(props: { categories?: string[]; hasSource?: boolean } = {}) {
  const onAdd = vi.fn();
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">
        <CategorySuggestions
          categories={props.categories ?? ["food"]}
          hasSource={props.hasSource ?? true}
          onAdd={onAdd}
        />
      </I18nProvider>
    </QueryClientProvider>,
  );
  return { view, onAdd };
}

describe("CategorySuggestions", () => {
  it("offers names from the user's photos as one-click additions", async () => {
    vi.spyOn(api, "suggestCategories").mockResolvedValue({
      suggestions: ["beach", "Food", "hiking"],
    });
    const { view, onAdd } = renderSuggestions();

    fireEvent.click(view.getByRole("button", { name: "Suggest from my photos" }));
    const add = await view.findByRole("button", { name: "Add beach as a category" });

    // "Food" is already a category, whatever its case.
    expect(view.queryByRole("button", { name: "Add Food as a category" })).toBeNull();
    fireEvent.click(add);
    expect(onAdd).toHaveBeenCalledWith("beach");
  });

  it("explains why it cannot run without an input folder", () => {
    const suggest = vi.spyOn(api, "suggestCategories");
    const { view } = renderSuggestions({ hasSource: false });

    const button = view.getByRole("button", {
      name: "Suggest from my photos",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(view.getByText(/Choose an input folder first/)).toBeTruthy();
    expect(suggest).not.toHaveBeenCalled();
  });

  it("states a failure instead of showing nothing", async () => {
    vi.spyOn(api, "suggestCategories").mockRejectedValue({
      response: {
        data: { error: "Install the selected local AI model before using suggestions." },
      },
    });
    const { view } = renderSuggestions();

    fireEvent.click(view.getByRole("button", { name: "Suggest from my photos" }));

    expect(await view.findByRole("alert")).toBeTruthy();
    expect(view.getByText(/Install the selected local AI model/)).toBeTruthy();
  });
});
