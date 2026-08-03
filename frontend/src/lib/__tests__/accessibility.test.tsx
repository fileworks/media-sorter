// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import axe from "axe-core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import type { PreviewResult } from "@/types/api";
import type { GroupMember } from "@/lib/reviewWorkbench";

import { CompareModal } from "@/components/screens/review/CompareModal";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ConfigureScreen } from "@/components/screens/ConfigureScreen";
import { FolderBrowserDialog } from "@/components/FolderBrowserDialog";
import { ResetDialog } from "@/components/config/ResetDialog";
import { ReviewScreen } from "@/components/screens/ReviewScreen";
import { ExecutePreflight } from "@/components/OperationCenter";
import { ExecuteScreen } from "@/components/screens/ExecuteScreen";
import { RunLog } from "@/components/screens/RunLog";
import { DestinationTree } from "@/components/screens/review/DestinationTree";
import { PlanSummary } from "@/components/screens/review/PlanSummary";
import { destinationTree, type PlanTotals } from "@/lib/reviewPlan";
import { RecipeGrid } from "@/components/screens/RecipeGrid";
import { SourcesScreen } from "@/components/screens/SourcesScreen";
import { StageShell } from "@/components/StageShell";
import { StateView } from "@/components/StateView";
import { TEST_CONFIG } from "@/lib/__tests__/configFixture";
import { I18nProvider, translate, type Locale } from "@/i18n/I18nContext";
import { type StageState } from "@/lib/stageModel";
import { api } from "@/services/api";

const ACCESSIBILITY_CONFIG = TEST_CONFIG;

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

/**
 * Both themes, for real: the palette is a `dark` class on the document root, so
 * a component that hard-codes a colour instead of using a token renders
 * identically in both and a component that branches on the theme renders twice.
 * jsdom computes no colour, so axe's contrast rule stays off and the token
 * palette is what carries that guarantee; what this sweep does catch is a
 * theme-conditional branch that produces broken markup in one of the two.
 */
function useTheme(theme: "light" | "dark") {
  beforeEach(() => {
    document.documentElement.classList.toggle("dark", theme === "dark");
  });
  afterEach(() => {
    document.documentElement.classList.remove("dark");
  });
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

/** A dry run with one ordinary file, one duplicate stack and one warning. */
const PREVIEW_RESULT = {
  config_fingerprint: "fp",
  plan_id: "plan-1",
  impact: {
    actionable_groups: 2,
    copy_count: 2,
    move_count: 0,
    quarantine_count: 1,
    quarantine_bytes: 1_000,
    skip_count: 0,
    source_mutations: 0,
    required_bytes: 3_000,
    conversion_without_originals: 0,
    companions_left_in_place: 0,
    embedded_tag_count: 0,
    unresolved_count: 0,
  },
  items: [
    {
      source: "/in/IMG_0001.jpg",
      destination: "/out/2025/07/IMG_0001.jpg",
      extracted_date: "2025-07-14",
      metadata_source: "exif",
      tags: [],
      status: "sort",
      file_size: 1_000,
    },
    {
      source: "/in/IMG_0002.jpg",
      destination: "/out/_duplicates/IMG_0002.jpg",
      extracted_date: "2025-07-14",
      metadata_source: "exif",
      tags: [],
      status: "duplicate",
      file_size: 1_000,
    },
    {
      source: "/in/broken.jpg",
      destination: null,
      extracted_date: null,
      metadata_source: "none",
      tags: [],
      status: "unknown_date",
      file_size: 1_000,
    },
  ],
  stats: {
    total: 3,
    will_sort: 1,
    will_fail: 0,
    will_quarantine_unknown: 1,
    will_quarantine_future: 0,
    will_skip_duplicate: 1,
    will_quarantine_junk: 0,
    will_skip_already_in_destination: 0,
    uncategorized: 0,
  },
} as unknown as PreviewResult;

const COMPARE_MEMBER = (id: string, name: string) =>
  ({
    member_id: id,
    root_id: "input-a",
    role: "input" as const,
    relative_path: name,
    observed_path: `/in/${name}`,
    facts: {
      size_bytes: 1_000,
      modified_at: { known: true, value: 1 },
      captured_at: { known: true, value: "2025-07-14T10:00:00" },
      width: { known: true, value: 4032 },
      height: { known: true, value: 3024 },
      duration_seconds: { known: false, value: null },
      codec: { known: false, value: null },
      media_kind: "image",
    },
    evidence: { confidence: "high" as const },
  }) as unknown as GroupMember;

/**
 * Every dialog the application can open, so axe sees each one rather than only
 * the screens that open them. A dialog is where the focus trap, the labelling
 * and the escape route all live, which makes it the part most worth checking.
 */
const DIALOG_CASES: ReadonlyArray<readonly [string, () => ReactElement]> = [
  [
    "confirmation",
    () => (
      <ConfirmDialog
        open
        title="Go back?"
        description="The computed plan will be discarded."
        confirmLabel="Go back"
        cancelLabel="Cancel"
        onClose={() => undefined}
        onConfirm={() => undefined}
      />
    ),
  ],
  [
    "reset",
    () => (
      <ResetDialog
        open
        title="Reset Sort to defaults"
        rows={[{ setting: "Copy instead of move", current: "On", default: "Off" }]}
        onClose={() => undefined}
        onConfirm={() => undefined}
      />
    ),
  ],
  [
    "folder browser",
    () => (
      <FolderBrowserDialog
        open
        initialPath="/"
        requireWritable={false}
        onSelect={() => undefined}
        onClose={() => undefined}
      />
    ),
  ],
  [
    "compare",
    () => (
      <CompareModal
        a={COMPARE_MEMBER("m1", "a.jpg")}
        b={COMPARE_MEMBER("m2", "b.jpg")}
        keeperId="m1"
        onKeep={() => undefined}
        onKeepBoth={() => undefined}
        onClose={() => undefined}
      />
    ),
  ],
];

const PANEL_CASES: ReadonlyArray<readonly [string, () => ReactElement]> = [
  ["Sources", () => <SourcesScreen {...SOURCES_PROPS} />],
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

describe.each(["light", "dark"] as const)("in the %s theme", (theme) => {
  useTheme(theme);

  describe.each(["en", "de"] as const)("every dialog in %s", (locale) => {
    it.each(DIALOG_CASES)("%s has no automated violations", async (_name, makeDialog) => {
      const rendered = renderWithProviders(makeDialog(), locale);
      // A dialog is portalled to the body, so the render container is empty and
      // the sweep has to look at the document.
      await expectNoViolations(document.body);
      rendered.unmount();
    });
  });

  it("covers the Review surface, the one screen every dialog is opened from", async () => {
    const rendered = renderWithProviders(
      <ReviewScreen
        result={PREVIEW_RESULT}
        config={ACCESSIBILITY_CONFIG}
        view="overview"
        onSelectView={() => undefined}
        onOpenSetting={() => undefined}
        onRerunPreview={() => undefined}
      />,
      "en",
    );

    await within(rendered.container).findByRole("group", {
      name: translate("en", "review.items"),
    });
    await expectNoViolations(rendered.container);
  });

  it("gives every screen at most one primary action", async () => {
    // The primary is the one thing a screen exists for. Two of them is two
    // answers to "what do I do here", which is none.
    for (const makeScreen of [
      () => <SourcesScreen {...SOURCES_PROPS} />,
      () => (
        <ReviewScreen
          result={PREVIEW_RESULT}
          config={ACCESSIBILITY_CONFIG}
          view="overview"
          onSelectView={() => undefined}
          onOpenSetting={() => undefined}
          onRerunPreview={() => undefined}
        />
      ),
    ]) {
      const rendered = renderWithProviders(makeScreen(), "en");
      const primaries = [...rendered.container.querySelectorAll("button")].filter((button) =>
        /(^|\s)bg-primary(\s|$)/.test(button.className),
      );
      expect(primaries.map((button) => button.textContent)).toHaveLength(
        primaries.length > 1 ? 1 : primaries.length,
      );
      rendered.unmount();
    }
  });
});

describe.each(["en", "de"] as const)("WCAG structure in %s", (locale) => {
  it("offers exactly one way to add a folder per empty section", () => {
    const rendered = renderWithProviders(<SourcesScreen {...SOURCES_PROPS} />, locale);

    // Two sections, not three: a baseline is a checkbox on an input folder, so
    // there is no separate reference column to add one to.
    for (const role of ["input", "destination"] as const) {
      expect(
        within(rendered.container).getAllByText(translate(locale, `sources.empty.${role}`)),
      ).toHaveLength(1);
    }
    expect(
      within(rendered.container).queryByText(translate(locale, "sources.empty.reference")),
    ).toBeNull();
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
      <ConfigureScreen
        onSaveConfig={() => undefined}
        onSaveRecipe={async () => undefined}
        savedRecipes={[]}
        onApplyConfig={() => undefined}
        onDeleteRecipe={() => undefined}
      />,
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
