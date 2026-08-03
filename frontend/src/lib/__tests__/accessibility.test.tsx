// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import axe from "axe-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";

import { ConfigureScreen } from "@/components/screens/ConfigureScreen";
import { ExecutePreflight } from "@/components/OperationCenter";
import { ExecuteScreen } from "@/components/screens/ExecuteScreen";
import { RunLog } from "@/components/screens/RunLog";
import { DestinationTree } from "@/components/screens/review/DestinationTree";
import { PlanSummary } from "@/components/screens/review/PlanSummary";
import { WarningsTab } from "@/components/screens/review/WarningsTab";
import { destinationTree, type PlanTotals } from "@/lib/reviewPlan";
import { PreviewPanel } from "@/components/PreviewPanel";
import { RecipeGrid } from "@/components/screens/RecipeGrid";
import { SourcesScreen } from "@/components/screens/SourcesScreen";
import { StageShell } from "@/components/StageShell";
import { StateView } from "@/components/StateView";
import { SECTION_DEFAULTS } from "@/components/config/constants";
import { I18nProvider, translate, type Locale } from "@/i18n/I18nContext";
import { type StageState } from "@/lib/stageModel";
import { api } from "@/services/api";
import type { Config } from "@/types/api";

// The section defaults cover the flat fields; the nested profiles and the
// newer scalar settings are spelled out because the screens read them directly
// and a missing profile throws rather than degrading.
const ACCESSIBILITY_CONFIG = {
  ...Object.assign({}, ...Object.values(SECTION_DEFAULTS)),
  source_directory: "",
  target_directory: "",
  duplicate_keeper_policy: "newest",
  image_quality: 90,
  video_quality: "medium",
  saved_recipes: [],
  ai_model_tier: "auto",
  ai_allow_gpu: true,
  library_profile: {
    schema_version: 1,
    profile_id: "accessibility",
    name: "Accessibility fixture",
    roots: [],
    transfer_mode: "copy",
    catalog: { mode: "application_data", relative_path: null },
    resources: { mode: "auto", memory_limit_mib: null, io_workers: null, cpu_workers: null },
  },
  preservation_profile: {
    schema_version: 1,
    profile_id: "default",
    name: "Organize only",
    mode: "organize_only",
    allow_embedded_metadata_edits: false,
    allow_repair: false,
    allow_conversion: false,
    allow_compression: false,
    preserve_filesystem_timestamps: true,
    derived_metadata: "report_only",
    authorization_origin: "default",
    acknowledged_at: null,
    requires_review: false,
  },
  optimization_profile: {
    schema_version: 1,
    profile_id: "optimization-disabled",
    name: "Optimization disabled",
    mode: "disabled",
    acknowledged_at: null,
    tool: null,
    tool_version: null,
    parameters: {},
    validation_contract: null,
    memory_limit_mib: 512,
    temporary_space_limit_bytes: null,
    retain_original: true,
  },
} as Config;

const SOURCES_PROPS = {
  cards: [],
  excludedForRun: [],
  analysis: null,
  config: ACCESSIBILITY_CONFIG,
  savedRecipes: [],
  onChange: () => undefined,
  onExcludeForRun: () => undefined,
  onAddFolder: () => undefined,
  onChangeFolder: () => undefined,
  onRemove: () => undefined,
  onApplyConfig: () => undefined,
  onDeleteRecipe: () => undefined,
};

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
        planned: true,
        plannedReason: null,
        blocked: false,
        blockedReason: null,
      }}
      stageKey={{
        profileId: "accessibility",
        catalogGeneration: 1,
        planVersion: 1,
        taskId: null,
      }}
      titleBar={<div />}
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

const PLAN_TOTALS: PlanTotals = {
  scanned: 1000,
  ready: 900,
  duplicates: 80,
  duplicatesResolved: 50,
  duplicatesUnresolved: 30,
  junk: 20,
  warnings: 3,
  share: { ready: 90, duplicates: 8, junk: 2 },
};

const PANEL_CASES: ReadonlyArray<readonly [string, () => ReactElement]> = [
  ["Sources", () => <SourcesScreen {...SOURCES_PROPS} />],
  ["organization", () => <PreviewPanel result={null} loading={false} error={null} />],
  [
    "plan summary",
    () => (
      <PlanSummary
        totals={PLAN_TOTALS}
        sizeLabel="68.4 GB"
        rootCount={3}
        onOpen={() => undefined}
      />
    ),
  ],
  [
    "destination tree",
    () => (
      <DestinationTree
        root={destinationTree(
          [
            {
              source: "/in/a.jpg",
              destination: "/out/2025/07/a.jpg",
              extracted_date: null,
              metadata_source: "exif",
              tags: [],
              status: "sort",
            },
          ],
          "Sorted",
          { rootPath: "/out" },
        )}
      />
    ),
  ],
  [
    "warnings",
    () => (
      <WarningsTab
        warnings={[
          { id: "unreadable", count: 2, severity: "error", statuses: ["failed"] },
          { id: "no_date", count: 9, severity: "warning", statuses: ["unknown_date"] },
        ]}
        onShowFiles={() => undefined}
        onOpenSetting={() => undefined}
      />
    ),
  ],
  [
    "run in progress",
    () => (
      <ExecuteScreen
        status="running"
        progress={{
          current: 7172,
          total: 11206,
          percentage: 64,
          phase: "sorting",
          estimated_time_remaining_seconds: 540,
          outcomes: { sorted: 7172, duplicate: 964, junk: 312, name_collision: 3 },
        }}
        outcomes={{ sorted: 7172, duplicate: 964, junk: 312, name_collision: 3 }}
        error={null}
        config={ACCESSIBILITY_CONFIG}
        reportPath="Sorted/_Reports/run.html"
        onCancel={() => undefined}
        onRetry={() => undefined}
      >
        <RunLog
          entries={[
            {
              timestamp: "2026-08-02T18:42:07Z",
              level: "info",
              message: "Camera/IMG_7204.heic → 2025/07/…jpg · verified",
            },
          ]}
          running
        />
      </ExecuteScreen>
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
  it("offers exactly one way to add a folder per empty role column", () => {
    const rendered = renderWithProviders(<SourcesScreen {...SOURCES_PROPS} />, locale);

    for (const role of ["input", "reference", "destination"] as const) {
      expect(
        within(rendered.container).getAllByText(translate(locale, `sources.empty.${role}`)),
      ).toHaveLength(1);
    }
  });

  it("has no automated violations in the navigation shell", async () => {
    const rendered = renderShell(locale);
    await expectNoViolations(rendered.container);

    for (const stage of ["configure", "review", "execute"] as const) {
      fireEvent.click(
        within(rendered.container).getByRole("button", {
          name: new RegExp(`^${translate(locale, `stage.${stage}.label`)}`),
        }),
      );
      await expectNoViolations(rendered.container);
    }
  });

  it("has no automated violations in the recipe grid", async () => {
    const rendered = renderWithProviders(
      <RecipeGrid
        config={ACCESSIBILITY_CONFIG}
        savedRecipes={[]}
        onApply={() => undefined}
        onDelete={() => undefined}
      />,
      locale,
    );

    await expectNoViolations(rendered.container);
  });

  it("covers the configuration surface, rail and all three groups", async () => {
    const rendered = renderWithProviders(
      <ConfigureScreen onSaveConfig={() => undefined} onSaveRecipe={async () => undefined} />,
      locale,
    );

    // Every group renders at once, so one pass covers all of them.
    for (const group of ["sort", "clean", "enrich"] as const) {
      await within(rendered.container).findByRole("heading", {
        name: translate(locale, `config.group.${group}.label`),
      });
    }
    await expectNoViolations(rendered.container);
  });

  describe.each(PANEL_CASES)("%s panel", (_name, makePanel) => {
    it("has no automated violations", async () => {
      const rendered = renderWithProviders(makePanel(), locale);
      await expectNoViolations(rendered.container);
    });
  });
});
