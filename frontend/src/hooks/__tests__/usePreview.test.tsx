// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePreview } from "@/hooks/usePreview";
import { I18nProvider, useI18n } from "@/i18n/I18nContext";
import {
  api,
  type PlanRecoveryResponse,
  type PreviewResult,
  type PreviewStatus,
} from "@/services/api";
import type { AnalysisResult } from "@/types/api";

const STORAGE_KEY = "mediasort_completed_plan";

function preview(planId = "plan-current", configFingerprint = "config-current"): PreviewResult {
  return {
    plan_id: planId,
    config_fingerprint: configFingerprint,
    impact: {
      actionable_groups: 0,
      copy_count: 0,
      move_count: 0,
      quarantine_count: 0,
      quarantine_bytes: 0,
      skip_count: 0,
      source_mutations: 0,
      required_bytes: 0,
      conversion_without_originals: 0,
      companions_left_in_place: 0,
      embedded_tag_count: 0,
      unresolved_count: 0,
    },
    items: [],
    stats: {
      total: 0,
      will_sort: 0,
      will_fail: 0,
      will_quarantine_unknown: 0,
      will_quarantine_future: 0,
      will_skip_duplicate: 0,
      will_quarantine_junk: 0,
      will_skip_already_in_destination: 0,
      uncategorized: 0,
    },
    partial: false,
    issues: [],
  };
}

function recovery(
  planId = "plan-current",
  configFingerprint = "config-current",
  result = preview(planId, configFingerprint),
): PlanRecoveryResponse {
  return {
    plan_id: planId,
    config_fingerprint: configFingerprint,
    destination_fingerprint: "destination-current",
    source_fingerprints: { "/input/photo.jpg": "source-current" },
    reviewed_sets: [],
    preview_result: result,
    review_state: null,
  };
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale="en">{children}</I18nProvider>
    </QueryClientProvider>
  );
}

function scanResult(total = 6): AnalysisResult {
  return {
    total_files: total,
    total_size_bytes: 18_874_368,
    by_type: { image: total },
    date_range: { earliest: null, latest: null, no_date_estimate: 0 },
    disk_space: {
      source_size_bytes: 18_874_368,
      destination_free_bytes: 64_000_000_000,
      sufficient: true,
      mode: "copy",
    },
    excluded_files: 0,
    estimated_duration_seconds: 120,
    warnings: [],
    partial: false,
    issues: [],
  };
}

function store(
  result: PreviewResult,
  planId = result.plan_id,
  analysis: AnalysisResult | null = null,
) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      schemaVersion: 3,
      planId,
      configFingerprint: result.config_fingerprint,
      analysis,
    }),
  );
}

let browserStorage: Map<string, string>;

describe("completed preview recovery", () => {
  beforeEach(() => {
    browserStorage = new Map<string, string>();
    // Faithful down to `length`/`key`, because dropping a plan enumerates the
    // store to find that plan's Review snapshots.
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => browserStorage.get(key) ?? null,
      setItem: (key: string, value: string) => browserStorage.set(key, value),
      removeItem: (key: string) => browserStorage.delete(key),
      clear: () => browserStorage.clear(),
      key: (index: number) => [...browserStorage.keys()][index] ?? null,
      get length() {
        return browserStorage.size;
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects a local pointer whose required identity is incomplete", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ schemaVersion: 3, planId: "plan-current" }));
    const recover = vi.spyOn(api, "recoverSortPlan").mockResolvedValue(recovery());

    const { result } = renderHook(() => usePreview(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.rehydrated).toBe(true));
    expect(result.current.result).toBeNull();
    expect(result.current.recovered).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(recover).not.toHaveBeenCalled();
  });

  it("brings the plan's scan back with it, so nothing reads as unscanned", async () => {
    const evidence = recovery();
    store(preview(), "plan-current", scanResult(6));
    vi.spyOn(api, "recoverSortPlan").mockResolvedValue(evidence);

    const { result } = renderHook(() => usePreview(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.result?.plan_id).toBe("plan-current"));
    expect(result.current.recoveredScan?.total_files).toBe(6);
  });

  it("refuses a snapshot written by an older schema", async () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 1,
        planId: "plan-current",
        result: preview(),
        recovery: recovery(),
      }),
    );
    const recover = vi.spyOn(api, "recoverSortPlan").mockResolvedValue(recovery());

    const { result } = renderHook(() => usePreview(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.rehydrated).toBe(true));
    expect(result.current.result).toBeNull();
    expect(recover).not.toHaveBeenCalled();
  });

  it("drops the Review snapshots of a plan it has just refused", async () => {
    store(preview());
    localStorage.setItem("mediasort_review_state:plan-current", "{}");
    localStorage.setItem("mediasort_review_stop:plan-current", "review");
    vi.spyOn(api, "recoverSortPlan").mockRejectedValue(new Error("destination changed"));

    const { result } = renderHook(() => usePreview(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.rehydrated).toBe(true));
    expect(result.current.persistenceState).toBe("error");
    expect(result.current.persistenceError).toMatch(/no longer recoverable/i);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem("mediasort_review_state:plan-current")).toBeNull();
    expect(localStorage.getItem("mediasort_review_stop:plan-current")).toBeNull();
  });

  it("does not re-run recovery when only the interface language changes", async () => {
    store(preview());
    const recover = vi.spyOn(api, "recoverSortPlan").mockResolvedValue(recovery());

    const { result } = renderHook(() => ({ preview: usePreview(), language: useI18n() }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.preview.persistenceState).toBe("saved"));

    act(() => result.current.language.setLocale("de"));
    await waitFor(() => expect(document.documentElement.lang).toBe("de"));
    expect(recover).toHaveBeenCalledTimes(1);
    expect(result.current.preview.result?.plan_id).toBe("plan-current");
  });

  it("rejects backend evidence that differs from the compact pointer", async () => {
    store(preview());
    vi.spyOn(api, "recoverSortPlan").mockResolvedValue({
      ...recovery("plan-current", "different-config"),
    });

    const { result } = renderHook(() => usePreview(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.rehydrated).toBe(true));
    expect(result.current.result).toBeNull();
    expect(result.current.recovered).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("rehydrates an exact reviewed snapshot and retains all durable fingerprints", async () => {
    const resultFixture = preview();
    const evidence = recovery();
    store(resultFixture);
    vi.spyOn(api, "recoverSortPlan").mockResolvedValue(evidence);

    const { result } = renderHook(() => usePreview(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.result?.plan_id).toBe("plan-current"));
    await waitFor(() => expect(result.current.rehydrated).toBe(true));
    expect(result.current.recovered).toBe(true);
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Record<
      string,
      unknown
    >;
    expect(persisted).toMatchObject({
      schemaVersion: 3,
      planId: "plan-current",
      configFingerprint: "config-current",
    });
    expect(persisted).not.toHaveProperty("result");
    expect(persisted).not.toHaveProperty("recovery");
    expect(result.current.recoveryEvidence).toEqual(evidence);
    expect(result.current.persistenceState).toBe("saved");
  });

  it("stores a small pointer even when the durable snapshot contains 20,000 items", async () => {
    const huge = {
      ...preview(),
      items: Array.from({ length: 20_000 }, (_, index) => ({
        source: `/input/${index}.jpg`,
        destination: `/output/${index}.jpg`,
        status: "sort",
      })),
    } as PreviewResult;
    store(huge);
    vi.spyOn(api, "recoverSortPlan").mockResolvedValue(recovery(undefined, undefined, huge));

    const { result } = renderHook(() => usePreview(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.result?.items).toHaveLength(20_000));
    await waitFor(() => expect(result.current.persistenceState).toBe("saved"));
    const raw = localStorage.getItem(STORAGE_KEY) ?? "";
    expect(raw.length).toBeLessThan(1_000);
    expect(raw).not.toContain("/input/19999.jpg");
  });

  it("surfaces pointer-storage failure instead of claiming restart recovery", async () => {
    const resultFixture = preview();
    browserStorage.set(
      STORAGE_KEY,
      JSON.stringify({
        schemaVersion: 3,
        planId: resultFixture.plan_id,
        configFingerprint: resultFixture.config_fingerprint,
        analysis: null,
      }),
    );
    vi.spyOn(api, "recoverSortPlan").mockResolvedValue(recovery());
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });

    const { result } = renderHook(() => usePreview(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.result?.plan_id).toBe("plan-current"));
    await waitFor(() => expect(result.current.persistenceState).toBe("error"));
    expect(result.current.persistenceError).toBeTruthy();
  });

  it("persists a newly completed preview without re-running destination freshness", async () => {
    const resultFixture = preview();
    const recover = vi.spyOn(api, "recoverSortPlan").mockResolvedValue(recovery());
    vi.spyOn(api, "beginOperation").mockReturnValue(() => undefined);
    vi.spyOn(api, "startPreview").mockResolvedValue("preview-task");
    vi.spyOn(api, "getPreviewStatus").mockResolvedValue({
      task_id: "preview-task",
      operation_kind: "preview",
      status: "completed",
      progress: { current: 1, total: 1, percentage: 100 },
      partial: false,
      issues: [],
      events: [],
      last_event_sequence: 1,
      error: null,
      failure: null,
      result: { ...resultFixture },
    } satisfies PreviewStatus);

    const { result } = renderHook(() => usePreview(scanResult(1)), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.rehydrated).toBe(true));

    let completion: Promise<PreviewResult | null>;
    act(() => {
      completion = result.current.generatePreview();
    });
    await waitFor(() => expect(result.current.result).toEqual(resultFixture));
    await waitFor(() => expect(result.current.persistenceState).toBe("saved"));
    await expect(completion!).resolves.toEqual(resultFixture);

    expect(recover).not.toHaveBeenCalled();
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null")).toMatchObject({
      schemaVersion: 3,
      planId: resultFixture.plan_id,
      configFingerprint: resultFixture.config_fingerprint,
    });
  });
});
