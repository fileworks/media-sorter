// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { PreviewProgressCard } from "@/components/PreviewProgressCard";
import { I18nProvider, translate } from "@/i18n/I18nContext";

afterEach(cleanup);

it("presents plan computation on Review with progress and a stop action", () => {
  const onCancel = vi.fn();
  render(
    <I18nProvider initialLocale="en">
      <PreviewProgressCard
        operation="analysis"
        progress={{ current: 12, total: 40, percentage: 30, phase: "scanning_source" }}
        elapsed={2}
        onCancel={onCancel}
      />
    </I18nProvider>,
  );

  expect(
    screen.getByRole("heading", { name: translate("en", "stage.review.computing") }),
  ).toBeTruthy();
  expect(screen.getByText(translate("en", "progress.scanningSource"))).toBeTruthy();
  expect(
    screen.getByRole("progressbar", { name: translate("en", "progress.scanningSource") }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: translate("en", "common.stop") }));
  expect(onCancel).toHaveBeenCalledTimes(1);
});
