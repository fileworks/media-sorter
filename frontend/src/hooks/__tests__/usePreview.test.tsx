// @vitest-environment jsdom

import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { usePreview } from "@/hooks/usePreview";
import { I18nProvider } from "@/i18n/I18nContext";
import { api, type PlanRecoveryResponse, type PreviewResult } from "@/services/api";
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
): PlanRecoveryResponse {
  return {
    plan_id: planId,
    config_fingerprint: configFingerprint,
    destination_fingerprint: "destination-current",
    source_fingerprints: { "/input/photo.jpg": "source-current" },
    reviewed_sets: [],
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
  evidence: PlanRecoveryResponse,
  planId = result.plan_id,
  analysis: AnalysisResult | null = null,
) {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      schemaVersion: 2,
      planId,
      result,
      recovery: evidence,
      analysis,
    }),
  );
}

describe("completed preview recovery", () => {
  beforeEach(() => {
    const stored = new Map<string, string>();
    // Faithful down to `length`/`key`, because dropping a plan enumerates the
    // store to find that plan's Review snapshots.
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
      clear: () => stored.clear(),
      key: (index: number) => [...stored.keys()][index] ?? null,
      get length() {
        return stored.size;
      },
    });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("rejects a local snapshot whose pointer and rendered plan identity disagree", async () => {
    store(preview("plan-rendered"), recovery("plan-pointer"), "plan-pointer");
    const recover = vi.spyOn(api, "recoverSortPlan").mockResolvedValue(recovery("plan-pointer"));

    const { result } = renderHook(() => usePreview(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.rehydrated).toBe(true));
    expect(result.current.result).toBeNull();
    expect(result.current.recovered).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(recover).not.toHaveBeenCalled();
  });

  it("brings the plan's scan back with it, so nothing reads as unscanned", async () => {
    const evidence = recovery();
    store(preview(), evidence, "plan-current", scanResult(6));
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
    store(preview(), recovery());
    localStorage.setItem("mediasort_review_state:plan-current", "{}");
    localStorage.setItem("mediasort_review_stop:plan-current", "review");
    vi.spyOn(api, "recoverSortPlan").mockResolvedValue({
      ...recovery(),
      destination_fingerprint: "destination-rewritten",
    });

    const { result } = renderHook(() => usePreview(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.rehydrated).toBe(true));
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem("mediasort_review_state:plan-current")).toBeNull();
    expect(localStorage.getItem("mediasort_review_stop:plan-current")).toBeNull();
  });

  it("rejects backend evidence that differs from the durable reviewed fingerprints", async () => {
    store(preview(), recovery());
    vi.spyOn(api, "recoverSortPlan").mockResolvedValue({
      ...recovery(),
      destination_fingerprint: "destination-rewritten",
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
    store(resultFixture, evidence);
    vi.spyOn(api, "recoverSortPlan").mockResolvedValue(evidence);

    const { result } = renderHook(() => usePreview(), { wrapper: wrapper() });

    await waitFor(() => expect(result.current.result?.plan_id).toBe("plan-current"));
    await waitFor(() => expect(result.current.rehydrated).toBe(true));
    expect(result.current.recovered).toBe(true);
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as {
      recovery?: PlanRecoveryResponse;
    };
    expect(persisted.recovery).toEqual(evidence);
  });
});
