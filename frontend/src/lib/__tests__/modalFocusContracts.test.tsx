// @vitest-environment jsdom

import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import confirmDialogSource from "@/components/ConfirmDialog.tsx?raw";
import duplicateComparisonSource from "@/components/DuplicateComparison.tsx?raw";
import historyPanelSource from "@/components/HistoryPanel.tsx?raw";
import mediaModalSource from "@/components/MediaModal.tsx?raw";
import mediaPreviewModalSource from "@/components/MediaPreviewModal.tsx?raw";
import sampleComparisonModalSource from "@/components/SampleComparisonModal.tsx?raw";
import { useFocusTrap } from "@/hooks/useFocusTrap";

function TrapHarness({ active }: { active: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, active);
  return (
    <div ref={ref} tabIndex={-1} data-testid="panel">
      <button type="button">First</button>
      <button type="button">Last</button>
    </div>
  );
}

const originalOffsetParent = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetParent");

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "offsetParent", {
    configurable: true,
    get() {
      return this.parentElement;
    },
  });
});

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  if (originalOffsetParent) {
    Object.defineProperty(HTMLElement.prototype, "offsetParent", originalOffsetParent);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "offsetParent");
  }
});

it("traps focus, wraps Tab in both directions, and restores the origin", () => {
  const origin = document.createElement("button");
  document.body.append(origin);
  origin.focus();

  const rendered = render(<TrapHarness active />);
  const panel = rendered.getByTestId("panel");
  const [first, last] = within(panel).getAllByRole("button");
  expect(document.activeElement).toBe(panel);

  last.focus();
  fireEvent.keyDown(document, { key: "Tab" });
  expect(document.activeElement).toBe(first);

  first.focus();
  fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(last);

  rendered.rerender(<TrapHarness active={false} />);
  expect(document.activeElement).toBe(origin);
});

describe.each([
  ["ConfirmDialog.tsx", "open", confirmDialogSource],
  ["MediaModal.tsx", "true", mediaModalSource],
  ["MediaPreviewModal.tsx", "true", mediaPreviewModalSource],
  ["SampleComparisonModal.tsx", "true", sampleComparisonModalSource],
  ["DuplicateComparison.tsx", "true", duplicateComparisonSource],
  ["HistoryPanel.tsx", "true", historyPanelSource],
] as const)("%s", (file, activeExpression, source) => {
  it("uses the complete modal focus and dismissal contract", () => {
    expect(source).toContain(`useFocusTrap(panelRef, ${activeExpression})`);
    expect(source).toMatch(/ref=\{panelRef\}[\s\S]{0,100}tabIndex=\{-1\}/);
    expect(source).toMatch(
      file === "MediaModal.tsx" ? /keyAction\(event\.key\)/ : /key\s*===\s*["']Escape["']/,
    );
    expect(source).toMatch(/onClose|dismiss/);
  });
});
