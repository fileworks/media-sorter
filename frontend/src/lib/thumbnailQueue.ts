import { useEffect, useRef, useState, type RefObject } from "react";

import { api } from "@/services/api";

type QueueEntry = {
  key: string;
  url: string;
  priority: () => number;
  controller: AbortController;
  resolve: (blob: Blob) => void;
  reject: (error: Error) => void;
  state: "queued" | "running";
};

/**
 * A thumbnail the server answered but did not send.
 *
 * The status is the whole point: 415 is the backend saying there is no
 * thumbnail for this file and never will be, which is a different thing from a
 * request that failed and could succeed on the next try.
 */
export class ThumbnailHttpError extends Error {
  constructor(readonly status: number) {
    super(`thumbnail HTTP ${status}`);
    this.name = "ThumbnailHttpError";
  }
}

export class ThumbnailRequestQueue {
  private entries = new Map<string, QueueEntry>();

  constructor(
    private readonly concurrency = 6,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  enqueue(key: string, url: string, priority: () => number) {
    this.cancel(key);
    const controller = new AbortController();
    let resolve!: (blob: Blob) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<Blob>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    this.entries.set(key, {
      key,
      url,
      priority,
      controller,
      resolve,
      reject,
      state: "queued",
    });
    this.pump();
    return { promise, cancel: () => this.cancel(key) };
  }

  reprioritize() {
    for (const entry of this.entries.values()) {
      if (entry.state === "queued" && !Number.isFinite(entry.priority())) {
        this.entries.delete(entry.key);
        entry.reject(new DOMException("Left viewport before dispatch", "AbortError"));
      }
    }
    this.pump();
  }

  cancel(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    entry.controller.abort();
    entry.reject(new DOMException("Thumbnail request discarded", "AbortError"));
    this.pump();
  }

  get inFlight() {
    return [...this.entries.values()].filter((entry) => entry.state === "running").length;
  }

  get queued() {
    return [...this.entries.values()].filter((entry) => entry.state === "queued").length;
  }

  private pump() {
    while (this.inFlight < this.concurrency) {
      const next = [...this.entries.values()]
        .filter((entry) => entry.state === "queued")
        .map((entry) => ({ entry, priority: entry.priority() }))
        .filter(({ priority }) => Number.isFinite(priority))
        .sort((a, b) => a.priority - b.priority)[0]?.entry;
      if (!next) return;
      next.state = "running";
      void this.fetcher(next.url, { signal: next.controller.signal })
        .then((response) => {
          if (!response.ok) throw new ThumbnailHttpError(response.status);
          return response.blob();
        })
        .then((blob) => next.resolve(blob))
        .catch((error: unknown) =>
          next.reject(error instanceof Error ? error : new Error(String(error))),
        )
        .finally(() => {
          this.entries.delete(next.key);
          this.pump();
        });
    }
  }
}

// The live queue authenticates; the class keeps a plain `fetch` default so the
// unit tests can drive it with a stub.
const queue = new ThumbnailRequestQueue(6, api.mediaFetch);

/** What a failed URL failed with, and until when that answer stands. */
const negativeCache = new Map<string, { until: number; unavailable: boolean }>();
let listenersInstalled = false;
let requestSequence = 0;

function installListeners() {
  if (listenersInstalled || typeof window === "undefined") return;
  listenersInstalled = true;
  const reprioritize = () => queue.reprioritize();
  window.addEventListener("scroll", reprioritize, true);
  window.addEventListener("resize", reprioritize);
}

function viewportPriority(element: HTMLElement | null): number {
  if (!element || typeof window === "undefined") return 0;
  const rect = element.getBoundingClientRect();
  if (
    rect.bottom < 0 ||
    rect.top > window.innerHeight ||
    rect.right < 0 ||
    rect.left > window.innerWidth
  ) {
    return Number.POSITIVE_INFINITY;
  }
  return Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2);
}

/**
 * One thumbnail, fetched through the shared queue.
 *
 * `waiting` is the state a tile returns to when its request was aborted for
 * leaving the viewport. It used to stay `loading` forever — the abort branch
 * returned without touching state — so a tile scrolled past mid-request kept a
 * spinner for the life of the screen and never asked again. A waiting tile is
 * quiet, not animated, and re-enqueues the moment it comes back into view.
 *
 * `unavailable` is not `errored`. A 415 is the backend's settled answer that
 * this file has no thumbnail; a broken pipe is a request that could work next
 * time. Drawing both as the same grey square told a user their library was
 * failing to load when in fact it had simply been asked to preview a file
 * format that has no preview.
 */
export function useQueuedThumbnail(
  url: string,
  elementRef: RefObject<HTMLElement | null>,
): {
  objectUrl: string | null;
  loading: boolean;
  waiting: boolean;
  errored: boolean;
  unavailable: boolean;
} {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "waiting" | "loaded" | "error" | "unavailable">(
    "loading",
  );
  const [attempt, setAttempt] = useState(0);
  const requestId = useRef(0);

  // A waiting tile is watching for its own re-entry. Nothing else re-triggers
  // it, so without this the abort above would be permanent.
  useEffect(() => {
    if (state !== "waiting") return;
    const element = elementRef.current;
    if (element === null || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setAttempt((value) => value + 1);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [elementRef, state]);

  useEffect(() => {
    installListeners();
    const id = ++requestId.current;
    setObjectUrl(null);
    const cached = negativeCache.get(url);
    if (cached !== undefined && cached.until > Date.now()) {
      setState(cached.unavailable ? "unavailable" : "error");
      return;
    }
    setState("loading");
    const request = queue.enqueue(`${url}:${++requestSequence}`, url, () =>
      viewportPriority(elementRef.current),
    );
    let created: string | null = null;
    void request.promise
      .then((blob) => {
        if (requestId.current !== id) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
        setState("loaded");
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          // Not a failure — the tile left the viewport before its turn. Park it
          // so it stops animating and can be asked for again.
          if (requestId.current === id) setState("waiting");
          return;
        }
        // A file that has no thumbnail will not grow one, so that answer is
        // cached for far longer than a transient failure is.
        const unavailable = error instanceof ThumbnailHttpError && error.status === 415;
        negativeCache.set(url, {
          until: Date.now() + (unavailable ? 600_000 : 5_000),
          unavailable,
        });
        if (requestId.current === id) setState(unavailable ? "unavailable" : "error");
      });
    return () => {
      request.cancel();
      if (created) URL.revokeObjectURL(created);
    };
  }, [attempt, elementRef, url]);

  return {
    objectUrl,
    loading: state === "loading",
    waiting: state === "waiting",
    errored: state === "error",
    unavailable: state === "unavailable",
  };
}

/**
 * One media URL as an object URL, fetched with the API capability attached.
 *
 * For the single large images — the preview hero, a difference map, the
 * lightbox — which are always on screen when they exist and so need neither
 * the viewport queue nor its prioritisation, but do need the header that an
 * `<img src>` cannot send.
 */
export function useAuthorizedMedia(url: string | null): {
  objectUrl: string | null;
  loading: boolean;
  errored: boolean;
  unavailable: boolean;
} {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "loaded" | "error" | "unavailable">("loading");

  useEffect(() => {
    if (!url) {
      setObjectUrl(null);
      setState("error");
      return;
    }
    let cancelled = false;
    let created: string | null = null;
    const controller = new AbortController();
    setObjectUrl(null);
    setState("loading");

    void api
      .mediaFetch(url, { signal: controller.signal })
      .then((response) => {
        if (!response.ok) throw new ThumbnailHttpError(response.status);
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        created = URL.createObjectURL(blob);
        setObjectUrl(created);
        setState("loaded");
      })
      .catch((error: unknown) => {
        if (cancelled || (error instanceof DOMException && error.name === "AbortError")) return;
        setState(
          error instanceof ThumbnailHttpError && error.status === 415 ? "unavailable" : "error",
        );
      });

    return () => {
      cancelled = true;
      controller.abort();
      if (created) URL.revokeObjectURL(created);
    };
  }, [url]);

  return {
    objectUrl,
    loading: state === "loading",
    errored: state === "error",
    unavailable: state === "unavailable",
  };
}
