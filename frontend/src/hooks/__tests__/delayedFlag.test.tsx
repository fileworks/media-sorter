// @vitest-environment jsdom

/**
 * A status nobody could read is not information.
 *
 * The review surface saves on every durable change, and which dialog is open
 * is durable — so opening a detail or compare dialog started a save that
 * finished in a handful of milliseconds. Reported honestly, that put a
 * "Saving…" row on screen and took it off again inside a frame or two, shoving
 * the workbench down and back up and briefly giving the page a scrollbar.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";

import { useDelayedFlag } from "@/hooks/useDelayedFlag";

function Probe({ active, delayMs }: { active: boolean; delayMs?: number }) {
  return <span data-testid="flag">{String(useDelayedFlag(active, delayMs))}</span>;
}

function flag(): string {
  return screen.getByTestId("flag").textContent ?? "";
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a flag that waits before it speaks", () => {
  it("says nothing about a save that is over before the delay", () => {
    const { rerender } = render(<Probe active={false} delayMs={600} />);

    rerender(<Probe active delayMs={600} />);
    act(() => void vi.advanceTimersByTime(120));
    expect(flag()).toBe("false");

    // The save lands. Nothing was ever shown, so nothing has to be taken back.
    rerender(<Probe active={false} delayMs={600} />);
    act(() => void vi.advanceTimersByTime(2000));
    expect(flag()).toBe("false");
  });

  it("reports a save that is genuinely taking time", () => {
    const { rerender } = render(<Probe active={false} delayMs={600} />);

    rerender(<Probe active delayMs={600} />);
    act(() => void vi.advanceTimersByTime(600));
    expect(flag()).toBe("true");
  });

  it("clears at once when the slow save finishes", () => {
    const { rerender } = render(<Probe active delayMs={600} />);
    act(() => void vi.advanceTimersByTime(600));
    expect(flag()).toBe("true");

    rerender(<Probe active={false} delayMs={600} />);
    expect(flag()).toBe("false");
  });

  it("restarts the wait for each new save", () => {
    const { rerender } = render(<Probe active delayMs={600} />);
    act(() => void vi.advanceTimersByTime(500));
    rerender(<Probe active={false} delayMs={600} />);
    rerender(<Probe active delayMs={600} />);

    // The second save gets its own 600ms, not the 100ms left of the first's.
    act(() => void vi.advanceTimersByTime(500));
    expect(flag()).toBe("false");
    act(() => void vi.advanceTimersByTime(100));
    expect(flag()).toBe("true");
  });
});
