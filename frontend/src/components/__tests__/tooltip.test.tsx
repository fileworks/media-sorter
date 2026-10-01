// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Tooltip } from "@/components/ui/tooltip";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("useful, accessible tooltip interactions", () => {
  it("preserves the visible action name when its hint explains the consequence", () => {
    render(
      <Tooltip label="Copies the selected files and retains the originals.">
        <button>Copy files</button>
      </Tooltip>,
    );
    expect(screen.getByRole("button", { name: "Copy files" })).toBeDefined();
  });

  it("adds explanatory text without replacing the existing accessible description", () => {
    render(
      <>
        <p id="existing-help">Only selected files.</p>
        <Tooltip label="Original files remain available.">
          <button aria-label="Copy files" aria-describedby="existing-help">
            Copy files
          </button>
        </Tooltip>
      </>,
    );
    const ids = screen
      .getByRole("button", { name: "Copy files" })
      .getAttribute("aria-describedby")
      ?.split(" ");
    expect(ids).toContain("existing-help");
    expect(ids?.map((id) => document.getElementById(id)?.textContent).join(" ")).toContain(
      "Original files remain available.",
    );
  });

  it("still names an otherwise unnamed icon action without repeating its name as a description", () => {
    render(
      <Tooltip label="Open details">
        <button>
          <svg aria-hidden="true" />
        </button>
      </Tooltip>,
    );
    expect(
      screen.getByRole("button", { name: "Open details" }).getAttribute("aria-describedby"),
    ).toBeNull();
  });

  it("does not repeat an explanation already included in an explicit action name", () => {
    render(
      <Tooltip label="Original files remain available.">
        <button aria-label="Copy files — Original files remain available.">Copy files</button>
      </Tooltip>,
    );
    expect(
      screen
        .getByRole("button", { name: "Copy files — Original files remain available." })
        .getAttribute("aria-describedby"),
    ).toBeNull();
  });

  it("lets the pointer enter the hint after its trigger loses focus", () => {
    render(
      <Tooltip label="Readable help">
        <button aria-label="Help">Help</button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "Help" });
    fireEvent.focus(button);
    const bubble = document.querySelector<HTMLElement>("[data-tooltip]");
    expect(bubble).not.toBeNull();
    fireEvent.blur(button);
    fireEvent.pointerOver(bubble!);
    act(() => vi.advanceTimersByTime(1000));
    expect(document.querySelector("[data-tooltip]")).not.toBeNull();
    fireEvent.pointerOut(bubble!);
    act(() => vi.advanceTimersByTime(1000));
    expect(document.querySelector("[data-tooltip]")).toBeNull();
  });

  it("dismisses its hint before Escape can dismiss the surrounding dialog", () => {
    const parentEscape = vi.fn();
    render(
      <section onKeyDown={parentEscape}>
        <Tooltip label="Readable help">
          <button aria-label="Help">Help</button>
        </Tooltip>
      </section>,
    );
    const button = screen.getByRole("button", { name: "Help" });
    fireEvent.focus(button);
    expect(document.querySelector("[data-tooltip]")).not.toBeNull();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(document.querySelector("[data-tooltip]")).toBeNull();
    expect(parentEscape).not.toHaveBeenCalled();
    fireEvent.keyDown(button, { key: "Escape" });
    expect(parentEscape).toHaveBeenCalledOnce();
  });

  it("removes the previous hint immediately when keyboard focus reaches another control", () => {
    render(
      <>
        <Tooltip label="Readable help">
          <button aria-label="Help">Help</button>
        </Tooltip>
        <input aria-label="Next control" />
      </>,
    );
    const button = screen.getByRole("button", { name: "Help" });
    fireEvent.focus(button);
    fireEvent.blur(button);
    fireEvent.focus(screen.getByRole("textbox", { name: "Next control" }));
    expect(document.querySelector("[data-tooltip]")).toBeNull();
  });

  it("does not reopen from the focus caused by activating its trigger", () => {
    render(
      <Tooltip label="Readable help">
        <button aria-label="Help">Help</button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "Help" });
    fireEvent.pointerDown(button);
    fireEvent.focus(button);
    expect(document.querySelector("[data-tooltip]")).toBeNull();
    fireEvent.blur(button);
    fireEvent.focus(button);
    expect(document.querySelector("[data-tooltip]")).not.toBeNull();
  });
});
