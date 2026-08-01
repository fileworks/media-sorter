// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import axe from "axe-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { BurstReviewPanel } from "@/components/BurstReviewPanel";
import { CatalogPanel } from "@/components/CatalogPanel";
import { ConfigPanel } from "@/components/ConfigPanel";
import { DestinationReconciliationPanel } from "@/components/DestinationReconciliationPanel";
import { ExecutePreflight } from "@/components/OperationCenter";
import { PreviewPanel } from "@/components/PreviewPanel";
import { QuarantineManager } from "@/components/QuarantineManager";
import { RecipeChooser } from "@/components/RecipeChooser";
import { ReviewWorkbench } from "@/components/ReviewWorkbench";
import { SourcesPanel } from "@/components/SourcesPanel";
import { StageShell } from "@/components/StageShell";
import { StateView } from "@/components/StateView";
import { ValidationPanel } from "@/components/ValidationPanel";
import { SECTION_DEFAULTS } from "@/components/config/constants";
import { I18nProvider, translate, type Locale } from "@/i18n/I18nContext";
import { VIEWS_BY_STAGE, type StageState } from "@/lib/stageModel";
import { api } from "@/services/api";
import type { Config } from "@/types/api";

const ACCESSIBILITY_CONFIG = {
  ...Object.assign({}, ...Object.values(SECTION_DEFAULTS)),
  source_directory: "",
  target_directory: "",
} as Config;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(api, "listReviewGroups").mockResolvedValue({
    groups: [],
    next_cursor: null,
    kind: "exact",
  });
  vi.spyOn(api, "catalogDiagnostics").mockResolvedValue({
    path: "/state/catalog.sqlite3",
    schema_version: 1,
    size_bytes: 0,
    soft_limit_bytes: 1,
    over_soft_limit: false,
    mode: "application_data",
    roots: 0,
    files: 0,
    hashed_files: 0,
    missing_files: 0,
    generations: 0,
    open_generations: 0,
    freshness: [],
  });
  vi.spyOn(api, "listQuarantine").mockResolvedValue([]);
  vi.spyOn(api, "quarantineSummary").mockResolvedValue({
    record_count: 0,
    retained_count: 0,
    restored_count: 0,
    retained_bytes: 0,
    oldest_age_days: 0,
    by_reason: {},
  });
  vi.spyOn(api, "getConfig").mockResolvedValue(ACCESSIBILITY_CONFIG);
  vi.spyOn(api, "validateConfig").mockResolvedValue({
    valid: true,
    errors: [],
    warnings: [],
  });
  vi.spyOn(api, "getConfigSections").mockResolvedValue([]);
  vi.spyOn(api, "getConfigDefaults").mockResolvedValue(ACCESSIBILITY_CONFIG);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function expectNoViolations(container: HTMLElement): Promise<void> {
  const result = await axe.run(container, {
    rules: {
      // jsdom does not implement layout/canvas, so contrast is verified by the
      // semantic token palette rather than pretending this rule ran.
      "color-contrast": { enabled: false },
    },
  });
  expect(
    result.violations.map((violation) => ({
      id: violation.id,
      targets: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
  expectKeyboardReachable(container);
}

function expectKeyboardReachable(container: HTMLElement): void {
  const controls = [
    ...container.querySelectorAll<HTMLElement>(
      "button, input, select, textarea, a[href], [tabindex], [role='option']",
    ),
  ].filter(
    (element) =>
      !element.matches(":disabled") &&
      element.getAttribute("aria-hidden") !== "true" &&
      element.tabIndex >= 0,
  );

  for (const control of controls) {
    control.focus();
    expect(document.activeElement).toBe(control);

    // Native controls keep the browser outline. Any component that suppresses
    // it must provide an explicit Tailwind focus/focus-visible replacement.
    const classes = control.className;
    if (typeof classes === "string" && classes.includes("outline-none")) {
      expect(classes).toMatch(/focus(?:-visible)?:/);
    }
  }
}

function renderWithProviders(element: ReactElement, locale: Locale) {
  const queryClient = new QueryClient({
    // Do not leave React Query's five-minute cache timer alive after the
    // accessibility fixture has been unmounted.
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initialLocale={locale}>{element}</I18nProvider>
    </QueryClientProvider>,
  );
}

function renderShell(locale: Locale) {
  return renderWithProviders(
    <StageShell
      inputs={{
        rootsReady: true,
        rootsReason: null,
        scanned: true,
        reviewed: true,
        reviewedReason: null,
        blocked: false,
        blockedReason: null,
      }}
      stageKey={{
        profileId: "accessibility",
        catalogGeneration: 1,
        planVersion: 1,
        taskId: null,
      }}
    >
      {(state: StageState) => (
        <StateView
          variant="empty"
          title={`${translate(locale, `stage.${state.stage}.label`)} · ${translate(
            locale,
            `view.${state.view}`,
          )}`}
        />
      )}
    </StageShell>,
    locale,
  );
}

const PANEL_CASES: ReadonlyArray<readonly [string, () => ReactElement]> = [
  ["Sources", () => <SourcesPanel cards={[]} onChange={() => undefined} />],
  ["organization", () => <PreviewPanel result={null} loading={false} error={null} />],
  ["exact review", () => <ReviewWorkbench kindFilter="exact" />],
  ["similar review", () => <ReviewWorkbench kindFilter="similar" />],
  ["burst review", () => <BurstReviewPanel root="/library" items={[]} enabled={false} />],
  ["reconciliation", () => <DestinationReconciliationPanel />],
  ["validation", () => <ValidationPanel rootId="" />],
  [
    "issues",
    () => (
      <div>
        <CatalogPanel />
        <QuarantineManager />
      </div>
    ),
  ],
  [
    "execute preflight",
    () => (
      <ExecutePreflight
        input={{
          actionableGroups: 1,
          quarantineCount: 0,
          quarantineBytes: 0,
          copyCount: 1,
          moveCount: 0,
          skipCount: 0,
          referenceCount: 0,
          sourceMutations: 0,
          acknowledgedSourceMutations: false,
          staleGroups: 0,
          unresolvedGroups: 0,
          freeBytes: null,
          requiredBytes: 1,
          quarantineWritable: true,
          conversionWithoutOriginals: 0,
          companionsLeftInPlace: 0,
          embeddedTagCount: 0,
        }}
        onAcknowledge={() => undefined}
        onExecute={() => undefined}
      />
    ),
  ],
];

describe.each(["en", "de"] as const)("WCAG structure in %s", (locale) => {
  it("uses one authoritative empty-source message", () => {
    const rendered = renderWithProviders(
      <SourcesPanel cards={[]} onChange={() => undefined} />,
      locale,
    );

    expect(
      within(rendered.container).getAllByText(translate(locale, "sources.empty")),
    ).toHaveLength(1);
    expect(within(rendered.container).queryByRole("alert")).toBeNull();
  });

  it("has no automated violations in the navigation shell", async () => {
    const rendered = renderShell(locale);
    await expectNoViolations(rendered.container);

    fireEvent.click(
      within(rendered.container).getByRole("button", {
        name: new RegExp(`^${translate(locale, "stage.review.label")}`),
      }),
    );
    for (const view of VIEWS_BY_STAGE.review) {
      fireEvent.click(
        within(rendered.container).getByRole("button", {
          name: translate(locale, `view.${view}`),
        }),
      );
      await expectNoViolations(rendered.container);
    }

    fireEvent.click(
      within(rendered.container).getByRole("button", {
        name: new RegExp(`^${translate(locale, "stage.execute.label")}`),
      }),
    );
    await expectNoViolations(rendered.container);
  });

  it("has no automated violations in the recipe chooser", async () => {
    const rendered = renderWithProviders(
      <RecipeChooser config={{} as Config} onApply={() => undefined} />,
      locale,
    );

    await expectNoViolations(rendered.container);
  });

  it("covers the configuration surface and search states", async () => {
    const rendered = renderWithProviders(<ConfigPanel />, locale);
    const search = await within(rendered.container).findByRole("searchbox");
    await expectNoViolations(rendered.container);

    fireEvent.change(search, { target: { value: "__no_setting_matches__" } });
    await expectNoViolations(rendered.container);

    fireEvent.change(search, { target: { value: "video" } });
    fireEvent.click(
      within(rendered.container).getByRole("button", {
        name: translate(locale, "config.section.conversion.label"),
      }),
    );
    await within(rendered.container).findByRole("heading", {
      name: translate(locale, "config.section.conversion.label"),
    });
    await expectNoViolations(rendered.container);
  });

  it("covers the expanded shortcut reference", async () => {
    const rendered = renderWithProviders(<ReviewWorkbench kindFilter="exact" />, locale);
    fireEvent.click(
      within(rendered.container).getByRole("button", {
        name: new RegExp(translate(locale, "review.shortcuts")),
      }),
    );
    await expectNoViolations(rendered.container);
  });

  describe.each(PANEL_CASES)("%s panel", (_name, makePanel) => {
    it("has no automated violations", async () => {
      const rendered = renderWithProviders(makePanel(), locale);
      await expectNoViolations(rendered.container);
    });
  });
});
