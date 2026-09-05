// @vitest-environment jsdom

import { StrictMode, type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useLogs } from "@/hooks/useLogs";

vi.mock("@/services/api", () => ({
  api: {
    whenReady: () => Promise.resolve(),
    getWebSocketUrl: () => "ws://127.0.0.1:8000/ws/logs",
    getWebSocketProtocol: () => "mediasorter.test",
  },
}));

class Socket {
  static instances: Socket[] = [];
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  close = vi.fn();

  constructor() {
    Socket.instances.push(this);
  }
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  Socket.instances = [];
});

it("opens one log stream after StrictMode replays setup while readiness is pending", async () => {
  vi.stubGlobal("WebSocket", Socket);
  renderHook(useLogs, {
    wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
  });
  await act(async () => {
    await Promise.resolve();
  });
  expect(Socket.instances).toHaveLength(1);
});

it("ignores messages and repeated close events from a replaced socket", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", Socket);
  const { result } = renderHook(useLogs);
  await act(async () => {
    await Promise.resolve();
  });
  const old = Socket.instances[0];
  act(() => old.onclose?.());
  act(() => vi.advanceTimersByTime(3000));
  const current = Socket.instances[1];
  act(() => current.onopen?.());
  act(() => {
    old.onmessage?.({ data: JSON.stringify({ message: "stale log" }) });
    old.onclose?.();
  });
  expect(result.current.logs).toEqual([]);
  expect(result.current.isConnected).toBe(true);
  act(() => current.onmessage?.({ data: JSON.stringify({ message: "current log" }) }));
  expect(result.current.logs).toEqual([{ message: "current log" }]);
});
