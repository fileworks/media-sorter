import { describe, expect, it, vi } from "vitest";
import { ThumbnailRequestQueue } from "@/lib/thumbnailQueue";

function deferredResponse() {
  let finish!: () => void;
  const promise = new Promise<Response>((resolve) => {
    finish = () => resolve(new Response(new Blob(["jpeg"]), { status: 200 }));
  });
  return { promise, finish };
}

describe("ThumbnailRequestQueue", () => {
  it("bounds concurrency and dispatches the nearest visible request first", async () => {
    const pending = [deferredResponse(), deferredResponse(), deferredResponse()];
    const fetcher = vi.fn((url: string | URL | Request) => {
      void url;
      return pending[fetcher.mock.calls.length - 1].promise;
    });
    const queue = new ThumbnailRequestQueue(1, fetcher as typeof fetch);

    const first = queue.enqueue("far", "/far", () => 100);
    const near = queue.enqueue("near", "/near", () => 1);
    const middle = queue.enqueue("middle", "/middle", () => 20);
    expect(fetcher).toHaveBeenCalledTimes(1);
    pending[0].finish();
    await first.promise;
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1][0]).toBe("/near");
    pending[1].finish();
    await near.promise;
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher.mock.calls[2][0]).toBe("/middle");
    pending[2].finish();
    await middle.promise;
  });

  it("drops queued off-screen work and aborts discarded in-flight work", async () => {
    const pending = deferredResponse();
    const fetcher = vi.fn((url: string | URL | Request) => {
      void url;
      return pending.promise;
    });
    const queue = new ThumbnailRequestQueue(1, fetcher as typeof fetch);
    const running = queue.enqueue("running", "/running", () => 0);
    const offscreen = queue.enqueue("offscreen", "/offscreen", () => Number.POSITIVE_INFINITY);
    queue.reprioritize();

    await expect(offscreen.promise).rejects.toMatchObject({ name: "AbortError" });
    running.cancel();
    await expect(running.promise).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("recomputes priority at dispatch so a visible row is not starved", async () => {
    const pending = [deferredResponse(), deferredResponse(), deferredResponse()];
    const fetcher = vi.fn((url: string | URL | Request) => {
      void url;
      return pending[fetcher.mock.calls.length - 1].promise;
    });
    const queue = new ThumbnailRequestQueue(1, fetcher as typeof fetch);
    let changingPriority = 100;
    const first = queue.enqueue("first", "/first", () => 0);
    const changing = queue.enqueue("changing", "/changing", () => changingPriority);
    const other = queue.enqueue("other", "/other", () => 20);
    changingPriority = 1;
    pending[0].finish();
    await first.promise;
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(fetcher.mock.calls[1][0]).toBe("/changing");
    pending[1].finish();
    await changing.promise;
    pending[2].finish();
    await other.promise;
  });

  it("bounds a 1,000-row fast scroll and completes no discarded row", async () => {
    let completed = 0;
    const fetcher = vi.fn(
      (_url: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          const timer = setTimeout(() => {
            completed += 1;
            resolve(new Response(new Blob(["jpeg"]), { status: 200 }));
          }, 1_000);
          init?.signal?.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              reject(new DOMException("discarded", "AbortError"));
            },
            { once: true },
          );
        }),
    );
    const queue = new ThumbnailRequestQueue(6, fetcher as typeof fetch);
    const rows = Array.from({ length: 1_000 }, (_, index) =>
      queue.enqueue(`row-${index}`, `/row-${index}`, () =>
        index < 6 ? 0 : Number.POSITIVE_INFINITY,
      ),
    );

    queue.reprioritize();
    rows.slice(0, 6).forEach((request) => request.cancel());
    const outcomes = await Promise.allSettled(rows.map((request) => request.promise));

    expect(fetcher).toHaveBeenCalledTimes(6);
    expect(completed).toBe(0);
    expect(outcomes).toHaveLength(1_000);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(queue.inFlight).toBe(0);
    expect(queue.queued).toBe(0);
  });
});
