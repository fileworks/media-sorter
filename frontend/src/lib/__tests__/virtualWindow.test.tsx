// @vitest-environment jsdom

import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fixedWindow, useVirtualWindow } from "@/hooks/useVirtualWindow";

interface HarnessProps {
  ids: string[];
  estimateSize: number;
  maxHeight: number;
  selectedId: string;
}

function WindowHarness({ ids, estimateSize, maxHeight, selectedId }: HarnessProps) {
  const [selected, setSelected] = useState(selectedId);
  const windowing = useVirtualWindow({
    count: ids.length,
    estimateSize,
    maxHeight,
    anchorKey: selected,
  });

  return (
    <div
      ref={windowing.scrollRef}
      data-testid="viewport"
      onScroll={windowing.onScroll}
      style={{ height: maxHeight, overflow: "auto" }}
    >
      <div style={{ height: windowing.totalSize, position: "relative" }}>
        {windowing.virtualItems.map((item) => {
          const id = ids[item.index];
          return (
            <button
              key={id}
              type="button"
              aria-pressed={selected === id}
              onClick={() => setSelected(id)}
              style={{ position: "absolute", top: item.start, height: item.size }}
            >
              {id}
            </button>
          );
        })}
      </div>
    </div>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each([
  ["thumbnail grid", 190, 560],
  ["preview tree", 36, 520],
  ["duplicate groups", 64, 520],
] as const)("%s shared window", (_name, estimateSize, maxHeight) => {
  it("preserves scroll, selection, and focus across filtering and refresh", () => {
    const ids = Array.from({ length: 100 }, (_, index) => `item-${index}`);
    const selectedId = "item-8";
    const rendered = render(
      <WindowHarness
        ids={ids}
        estimateSize={estimateSize}
        maxHeight={maxHeight}
        selectedId={selectedId}
      />,
    );
    const viewport = rendered.getByTestId("viewport");
    const selected = within(viewport).getByRole("button", { name: selectedId });
    fireEvent.click(selected);
    selected.focus();
    viewport.scrollTop = estimateSize * 2;
    fireEvent.scroll(viewport);

    const filtered = ids.filter((id) => id !== "item-2" && id !== "item-70");
    rendered.rerender(
      <WindowHarness
        ids={filtered}
        estimateSize={estimateSize}
        maxHeight={maxHeight}
        selectedId={selectedId}
      />,
    );
    expect(viewport.scrollTop).toBe(estimateSize * 2);
    expect(document.activeElement?.textContent).toBe(selectedId);
    expect(document.activeElement?.getAttribute("aria-pressed")).toBe("true");

    rendered.rerender(
      <WindowHarness
        ids={[...filtered]}
        estimateSize={estimateSize}
        maxHeight={maxHeight}
        selectedId={selectedId}
      />,
    );
    expect(viewport.scrollTop).toBe(estimateSize * 2);
    expect(document.activeElement?.textContent).toBe(selectedId);
    expect(document.activeElement?.getAttribute("aria-pressed")).toBe("true");
  });
});

/**
 * The mixed list — set headers, files, expanded copies — is three heights, and
 * an estimate applied to all three drifts a little further with every entry the
 * list scrolls past. Measuring is what stops the last item in a long list
 * sitting a screenful away from where its offset claims.
 */
describe("measured rows in a mixed-height list", () => {
  interface Row {
    id: string;
    height: number;
  }

  function MeasuredHarness({ rows, estimateSize }: { rows: Row[]; estimateSize: number }) {
    const windowing = useVirtualWindow({
      count: rows.length,
      estimateSize,
      maxHeight: 400,
      overscan: 40,
    });
    return (
      <div ref={windowing.scrollRef} data-testid="viewport" onScroll={windowing.onScroll}>
        <div data-testid="spacer" style={{ height: windowing.totalSize, position: "relative" }}>
          {windowing.virtualItems.map((item) => (
            <div
              key={rows[item.index].id}
              data-virtual-index={item.index}
              data-start={item.start}
              ref={windowing.measureElement}
              style={{ position: "absolute", top: 0, transform: `translateY(${item.start}px)` }}
            >
              {rows[item.index].id}
            </div>
          ))}
        </div>
      </div>
    );
  }

  it("accumulates no offset drift across headers of a different height", () => {
    // One header every fourth entry, 24px against 56px rows. Estimated, the
    // last entry would start 32px × 10 too far down.
    const rows: Row[] = Array.from({ length: 40 }, (_, index) => ({
      id: index % 4 === 0 ? `header-${index}` : `row-${index}`,
      height: index % 4 === 0 ? 24 : 56,
    }));
    const byId = new Map(rows.map((row) => [row.id, row.height]));

    // jsdom reports every box as 0×0, so the measured height is supplied here —
    // which is the only part of the mechanism jsdom cannot provide itself.
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function rect(this: HTMLElement) {
      const height = byId.get(this.textContent ?? "") ?? 0;
      return { height, width: 0, top: 0, left: 0, right: 0, bottom: height, x: 0, y: 0 } as DOMRect;
    };

    try {
      const rendered = render(<MeasuredHarness rows={rows} estimateSize={56} />);
      const spacer = rendered.getByTestId("spacer");

      const total = rows.reduce((sum, row) => sum + row.height, 0);
      expect(Number.parseInt(spacer.style.height, 10)).toBe(total);

      // Every rendered offset is exactly the sum of the heights above it.
      let expected = 0;
      for (const row of rows) {
        const element = within(spacer).queryByText(row.id);
        if (element !== null) {
          expect(Number(element.getAttribute("data-start"))).toBe(expected);
        }
        expected += row.height;
      }
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });
});

it("keeps all three two-million-item ranges bounded within their previous budgets", () => {
  const tiers = [
    // The previous grid mounted roughly one viewport plus two rows each side.
    { name: "thumbnail grid", count: Math.ceil(2_000_000 / 8), row: 190, view: 560, budget: 8 },
    // The previous PreviewList used eight rows of overscan on both sides.
    { name: "preview tree", count: 2_000_000, row: 36, view: 520, budget: 32 },
    // The pre-migration group helper's checked-in regression budget was < 40.
    { name: "duplicate groups", count: 2_000_000, row: 64, view: 520, budget: 40 },
  ] as const;

  // Violations are collected rather than asserted inside the loop. The timed
  // section previously contained 60,000 `expect()` calls, so it measured the
  // assertion library far more than it measured `fixedWindow` — which is why
  // upgrading vitest pushed it from under budget to 1042ms without anything
  // about the windowing changing. What is timed is now only the thing under
  // test.
  const overBudget: string[] = [];
  const wrongHeight: string[] = [];

  const started = performance.now();
  for (let iteration = 0; iteration < 10_000; iteration += 1) {
    for (const tier of tiers) {
      const scrollTop = ((iteration * 7919) % (tier.count - 1)) * tier.row;
      const range = fixedWindow(tier.count, scrollTop, tier.view, tier.row, 2);
      if (range.end - range.start > tier.budget) {
        overBudget.push(`${tier.name}: ${range.end - range.start} > ${tier.budget}`);
      }
      if (range.totalHeight !== tier.count * tier.row) {
        wrongHeight.push(`${tier.name}: ${range.totalHeight}`);
      }
    }
  }
  const elapsed = performance.now() - started;

  // The bounds are the point of the test and are exact, not timing-dependent.
  expect(overBudget).toEqual([]);
  expect(wrongHeight).toEqual([]);
  // The budget stays a guard against an algorithmic regression — 30,000 windows
  // over two-million-item lists must not creep into linear work — with enough
  // headroom that a loaded shared runner is not a failure.
  expect(elapsed).toBeLessThan(1_000);
});
