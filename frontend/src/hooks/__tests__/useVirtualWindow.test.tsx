// @vitest-environment jsdom

/**
 * Measured row heights, and what happens to them when rows move.
 *
 * Browse inserts a row into the middle of its list whenever a duplicate set is
 * expanded. Keyed by index, every stored height below that point then described
 * the wrong row, so the whole map had to be discarded — and the list fell back
 * to its 56px estimate for every row at once, re-laid itself out, and snapped
 * back a frame later when the observers caught up. That is the jump.
 *
 * jsdom performs no layout, so the heights here are stubbed onto the elements
 * the hook is handed. That is exactly the part under test: what the hook *does*
 * with a measurement, not whether a browser produced it.
 */

import { act, useEffect } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";

import { useVirtualWindow } from "@/hooks/useVirtualWindow";

interface HarnessProps {
  keys: string[];
  keyed: boolean;
}

/**
 * The hook's live return value, published through a ref.
 *
 * A module-level assignment from inside the component body is a render side
 * effect, which is the thing this codebase's lint rules exist to catch. The
 * ref is mutated in an effect instead, after the render it belongs to.
 */
const current: { value: ReturnType<typeof useVirtualWindow> | null } = { value: null };

function Harness({ keys, keyed }: HarnessProps) {
  const window = useVirtualWindow({
    count: keys.length,
    estimateSize: 56,
    maxHeight: 400,
    ...(keyed
      ? { keyForIndex: (index: number) => keys[index] ?? String(index) }
      : { measurementKey: keys }),
  });
  useEffect(() => {
    current.value = window;
  });
  return null;
}

function latest(): ReturnType<typeof useVirtualWindow> {
  if (current.value === null) throw new Error("the harness has not rendered");
  return current.value;
}

/** An element shaped like the row the hook measures, with a stubbed height. */
function row(index: number, height: number): HTMLElement {
  const element = document.createElement("div");
  element.dataset.virtualIndex = String(index);
  element.getBoundingClientRect = () => ({ height }) as DOMRect;
  return element;
}

/** The height the list is currently laying each row out at. */
const sizes = () => latest().virtualItems.map((virtual) => virtual.size);

afterEach(cleanup);

describe("measured row heights", () => {
  it("keeps a row's height when a new row is inserted above it", () => {
    const keys = ["a", "b", "c"];
    const { rerender } = render(<Harness keys={keys} keyed />);

    // Two tall rows and one short one, nothing like the 56px estimate.
    act(() => {
      latest().measureElement(row(0, 300));
      latest().measureElement(row(1, 20));
      latest().measureElement(row(2, 300));
    });
    expect(sizes()).toEqual([300, 20, 300]);

    // Expanding a set inserts a row: every index below it shifts by one.
    const expanded = ["a", "a:body", "b", "c"];
    rerender(<Harness keys={expanded} keyed />);

    // Each height stays with the row it was measured on, and only the new row
    // is estimated. The total alone would not catch this: reading the same
    // heights back positionally sums to exactly the same number while putting
    // every one of them on the wrong row.
    expect(sizes()).toEqual([300, 56, 20, 300]);
  });

  it("still discards them for a caller that has no stable key", () => {
    // The fallback is honest about what it can do: without an identity per row
    // an index-keyed height is a guess the moment anything moves.
    const { rerender } = render(<Harness keys={["a", "b", "c"]} keyed={false} />);

    act(() => {
      latest().measureElement(row(0, 300));
      latest().measureElement(row(1, 20));
      latest().measureElement(row(2, 300));
    });
    expect(sizes()).toEqual([300, 20, 300]);

    rerender(<Harness keys={["a", "a:body", "b", "c"]} keyed={false} />);

    expect(sizes()).toEqual([56, 56, 56, 56]);
  });
});
