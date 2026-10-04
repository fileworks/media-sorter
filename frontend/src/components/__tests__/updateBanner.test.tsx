// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { UpdateBanner } from "@/components/UpdateBanner";
import { I18nProvider } from "@/i18n/I18nContext";
import type { UpdateInfo } from "@/services/api";

const info: UpdateInfo = {
  current_version: "1.0.0",
  latest_version: "1.1.0",
  update_available: true,
  release_url: "https://github.com/fileworks/media-sorter/releases/tag/v1.1.0",
  release_notes: null,
  published_at: null,
  checked_at: "2026-10-04",
  asset_url: null,
};

beforeEach(() => localStorage.clear());

it("dismisses only that release and shows a later release without restarting", () => {
  const view = (update: UpdateInfo) => (
    <I18nProvider initialLocale="en">
      <UpdateBanner info={update} />
    </I18nProvider>
  );
  const { rerender } = render(view(info));
  fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));
  expect(screen.queryByRole("status")).toBeNull();
  rerender(view({ ...info, latest_version: "1.2.0" }));
  expect(screen.getByRole("status").textContent).toContain("1.2.0");
});
