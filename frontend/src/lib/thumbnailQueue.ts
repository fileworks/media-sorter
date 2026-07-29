import { useEffect, useRef, useState, type RefObject } from "react";

type QueueEntry = {
  key: string;
  url: string;
  priority: () => number;
  controller: AbortController;
  resolve: (blob: Blob) => void;
  reject: (error: Error) => void;
  state: "queued" | "running";
};

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
          if (!response.ok) throw new Error(`thumbnail HTTP ${response.status}`);
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

const queue = new ThumbnailRequestQueue();
const negativeUntil = new Map<string, number>();
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

export function useQueuedThumbnail(
  url: string,
  elementRef: RefObject<HTMLElement | null>,
): { objectUrl: string | null; loading: boolean; errored: boolean } {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "loaded" | "error">("loading");
  const requestId = useRef(0);

  useEffect(() => {
    installListeners();
    const id = ++requestId.current;
    setObjectUrl(null);
    if ((negativeUntil.get(url) ?? 0) > Date.now()) {
      setState("error");
      return;
    }
    setState("loading");
    const request = queue.enqueue(
      `${url}:${++requestSequence}`,
      url,
      () => viewportPriority(elementRef.current),
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
        if (error instanceof DOMException && error.name === "AbortError") return;
        negativeUntil.set(url, Date.now() + 5_000);
        if (requestId.current === id) setState("error");
      });
    return () => {
      request.cancel();
      if (created) URL.revokeObjectURL(created);
    };
  }, [elementRef, url]);

  return { objectUrl, loading: state === "loading", errored: state === "error" };
}
