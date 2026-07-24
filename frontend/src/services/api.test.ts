import { AxiosError } from "axios";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const post = vi.fn();
  const get = vi.fn();
  return {
    post,
    get,
    fakeHttp: {
      post,
      get,
      defaults: { baseURL: "" },
      interceptors: { response: { use: vi.fn() } },
    },
  };
});

vi.mock("axios", async (importOriginal) => {
  const original = await importOriginal<typeof import("axios")>();
  return {
    ...original,
    default: {
      ...original.default,
      create: () => mocks.fakeHttp,
      isAxiosError: original.default.isAxiosError,
    },
  };
});

vi.mock("@tauri-apps/api/tauri", () => ({
  invoke: vi.fn().mockRejectedValue(new Error("browser mode")),
}));

import { MediaSorterApiClient, isLoaderActive, subscribeLoader } from "@/services/api";

describe("task transport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.post.mockReset();
    mocks.get.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses one caller key across bounded transient start retries", async () => {
    mocks.post
      .mockRejectedValueOnce(new AxiosError("timeout", "ECONNABORTED"))
      .mockResolvedValueOnce({ data: { task_id: "one" } });
    const client = new MediaSorterApiClient();
    const pending = client.startPreview("stable-key");
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toBe("one");

    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[0][1].idempotency_key).toBe("stable-key");
    expect(mocks.post.mock.calls[1][1].idempotency_key).toBe("stable-key");
    expect(mocks.post.mock.calls[1][2].headers).toMatchObject({
      "X-MediaSorter-Retry-Attempt": "1",
      "X-MediaSorter-Transport-Event": "timeout",
    });
  });

  it("recovers a status timeout from the last event sequence without restarting", async () => {
    mocks.get
      .mockRejectedValueOnce(new AxiosError("timeout", "ECONNABORTED"))
      .mockResolvedValueOnce({ data: { task_id: "one", status: "running" } });
    const client = new MediaSorterApiClient();
    const pending = client.getPreviewStatus("one", 41);
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toMatchObject({ task_id: "one" });

    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.get).toHaveBeenCalledTimes(2);
    expect(mocks.get.mock.calls[1][1].params.after_sequence).toBe(41);
  });

  it("retries cancellation without starting another operation", async () => {
    mocks.post
      .mockRejectedValueOnce(new AxiosError("timeout", "ETIMEDOUT"))
      .mockResolvedValueOnce({ data: { cancellation_requested: true } });
    const client = new MediaSorterApiClient();
    const pending = client.cancelPreview("one");
    await vi.advanceTimersByTimeAsync(250);
    await expect(pending).resolves.toBeUndefined();

    expect(mocks.post).toHaveBeenCalledTimes(2);
    expect(mocks.post.mock.calls[0][0]).toBe("/api/preview/one/cancel");
    expect(mocks.post.mock.calls[1][2].headers).toMatchObject({
      "X-MediaSorter-Retry-Attempt": "1",
      "X-MediaSorter-Transport-Event": "timeout",
    });
  });

  it("does not retry a terminal validation response", async () => {
    const validation = new AxiosError("invalid", "ERR_BAD_REQUEST", undefined, undefined, {
      status: 422,
    } as never);
    mocks.post.mockRejectedValue(validation);
    const client = new MediaSorterApiClient();
    await expect(client.startAnalysis("invalid")).rejects.toBe(validation);
    expect(mocks.post).toHaveBeenCalledTimes(1);
  });

  it("keeps the global loader active until the operation hook releases it", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeLoader(listener);
    const client = new MediaSorterApiClient();
    const release = client.beginOperation();
    expect(isLoaderActive()).toBe(true);
    release();
    release();
    expect(isLoaderActive()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
});
