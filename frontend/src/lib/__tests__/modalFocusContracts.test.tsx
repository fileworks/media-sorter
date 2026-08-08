// @vitest-environment jsdom

/**
 * The modal contract, asserted once.
 *
 * This used to grep each dialog's source for `useFocusTrap(panelRef, …)`, which
 * proved that six files were spelled the same way rather than that any of them
 * behaved. Now every dialog is built on one `Modal`, so the contract is tested
 * where it lives — and any dialog that stops using the shell fails the second
 * suite, which is the thing worth catching.
 */

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import confirmDialogSource from "@/components/ConfirmDialog.tsx?raw";
import folderBrowserDialogSource from "@/components/FolderBrowserDialog.tsx?raw";
import historyPanelSource from "@/components/HistoryPanel.tsx?raw";
import compareModalSource from "@/components/screens/review/CompareModal.tsx?raw";
import { Modal, ModalBody, ModalFooter, ModalHeader } from "@/components/ui/modal";
import { useFocusTrap } from "@/hooks/useFocusTrap";
import { I18nProvider } from "@/i18n/I18nContext";

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

function renderModal(onClose: () => void) {
  return render(
    <I18nProvider>
      <Modal open onClose={onClose} title="Test dialog">
        <ModalHeader />
        <ModalBody>
          <button type="button">First</button>
          <button type="button">Last</button>
        </ModalBody>
        <ModalFooter>
          <button type="button">Act</button>
        </ModalFooter>
      </Modal>
    </I18nProvider>,
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
  document.body.style.overflow = "";
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

describe("Modal", () => {
  it("names the panel — not the backdrop — as the dialog", () => {
    renderModal(vi.fn());
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const heading = within(dialog).getByRole("heading", { level: 2 });
    expect(heading.textContent).toBe("Test dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBe(heading.id);
  });

  it("moves focus into the panel and traps Tab inside it", () => {
    renderModal(vi.fn());
    const dialog = screen.getByRole("dialog");
    expect(document.activeElement).toBe(dialog);

    const buttons = within(dialog).getAllByRole("button");
    const last = buttons[buttons.length - 1];
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  it("closes on Escape, on a backdrop press, and from the close button", () => {
    const onEscape = vi.fn();
    const escaped = renderModal(onEscape);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onEscape).toHaveBeenCalledTimes(1);
    escaped.unmount();

    const onBackdrop = vi.fn();
    const backdropped = renderModal(onBackdrop);
    const backdrop = screen.getByRole("dialog").parentElement!;
    fireEvent.mouseDown(backdrop);
    expect(onBackdrop).toHaveBeenCalledTimes(1);
    backdropped.unmount();

    const onButton = vi.fn();
    renderModal(onButton);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onButton).toHaveBeenCalledTimes(1);
  });

  it("ignores a press that starts inside the panel and ends on the backdrop", () => {
    const onClose = vi.fn();
    renderModal(onClose);
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("locks page scrolling until the last dialog closes", () => {
    const outer = renderModal(vi.fn());
    expect(document.body.style.overflow).toBe("hidden");
    const inner = renderModal(vi.fn());
    inner.unmount();
    expect(document.body.style.overflow).toBe("hidden");
    outer.unmount();
    expect(document.body.style.overflow).toBe("");
  });

  it("gives Escape to the topmost dialog only", () => {
    const onOuter = vi.fn();
    const onInner = vi.fn();
    renderModal(onOuter);
    renderModal(onInner);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onInner).toHaveBeenCalledTimes(1);
    expect(onOuter).not.toHaveBeenCalled();
  });
});

describe.each([
  ["ConfirmDialog.tsx", confirmDialogSource],
  ["FolderBrowserDialog.tsx", folderBrowserDialogSource],
  ["CompareModal.tsx", compareModalSource],
  ["HistoryPanel.tsx", historyPanelSource],
])("%s", (_file, source) => {
  it("gets its modal behaviour from the shared shell", () => {
    expect(source).toContain('from "@/components/ui/modal"');
    // No hand-rolled backdrop, portal, or focus trap alongside the shell.
    expect(source).not.toMatch(/fixed inset-0[^"]*z-\[?\d/);
    expect(source).not.toContain("useFocusTrap");
    expect(source).not.toContain("createPortal");
  });
});
