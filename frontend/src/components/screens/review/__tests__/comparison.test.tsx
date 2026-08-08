// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { CompareModal } from "@/components/screens/review/CompareModal";
import { I18nProvider } from "@/i18n/I18nContext";
import type { ComparableFile, FactValue, MemberFacts } from "@/lib/reviewWorkbench";

vi.mock("@/components/ui/thumbnail", () => ({
  Thumbnail: ({ path }: { path: string }) => <div data-testid={`thumbnail:${path}`} />,
}));

vi.mock("@/components/ui/media-image", () => ({
  MediaImage: ({ alt }: { alt: string }) => <div role="img" aria-label={alt} />,
}));

const known = (value: unknown): FactValue => ({ known: true, value, issue: null });
const unknown = (issue = "not recorded"): FactValue => ({ known: false, value: null, issue });

function facts({
  width,
  height,
  kind = "image",
  size = 4_000_000,
  date = "2024-01-02T03:04:05Z",
  duration = null,
  codec = null,
}: {
  width: number;
  height: number;
  kind?: string;
  size?: number;
  date?: string;
  duration?: number | null;
  codec?: string | null;
}): MemberFacts {
  return {
    size_bytes: size,
    modified_at: unknown(),
    captured_at: known(date),
    width: known(width),
    height: known(height),
    duration_seconds: duration === null ? unknown() : known(duration),
    codec: codec === null ? unknown() : known(codec),
    media_kind: kind,
  };
}

function file(id: string, memberFacts: MemberFacts | null): ComparableFile {
  return {
    id,
    path: `/source/${id}.jpg`,
    label: `portraits/${id}.jpg`,
    facts: memberFacts,
    capturedAtSource: memberFacts === null ? null : "exif",
    confidence: memberFacts === null ? null : "high",
  };
}

function renderComparison(a: ComparableFile, b: ComparableFile, onEnlarge = vi.fn()) {
  render(
    <I18nProvider initialLocale="en">
      <CompareModal
        a={a}
        b={b}
        keeperId={null}
        setId="set-1"
        onKeep={() => undefined}
        onKeepBoth={() => undefined}
        onClose={() => undefined}
        onEnlarge={onEnlarge}
      />
    </I18nProvider>,
  );
  return onEnlarge;
}

afterEach(cleanup);

describe("duplicate comparison", () => {
  it("uses the portrait aspect ratio throughout all three viewport-scaled modes", () => {
    renderComparison(
      file("a", facts({ width: 2000, height: 3000 })),
      file("b", facts({ width: 1000, height: 1500 })),
    );

    expect(screen.getByTestId("comparison-frame").getAttribute("data-aspect-ratio")).toBe("0.6667");
    expect(screen.getByTestId("comparison-frame").parentElement?.className).toContain("56dvh");

    fireEvent.click(screen.getByRole("radio", { name: "Side-by-side" }));
    expect(screen.getByTestId("comparison-frame").getAttribute("data-aspect-ratio")).toBe("1.3333");
    expect(screen.getByTestId("thumbnail:/source/a.jpg")).not.toBeNull();
    expect(screen.getByTestId("thumbnail:/source/b.jpg")).not.toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Difference" }));
    expect(screen.getByTestId("comparison-frame").getAttribute("data-aspect-ratio")).toBe("0.6667");
    expect(screen.getByRole("img", { name: /difference between a.jpg and b.jpg/i })).not.toBeNull();

    fireEvent.click(screen.getByRole("radio", { name: "Slide" }));
    fireEvent.change(screen.getByRole("slider", { name: "Slider position" }), {
      target: { value: "31" },
    });
    expect(
      (screen.getByRole("slider", { name: "Slider position" }) as HTMLInputElement).value,
    ).toBe("31");
  });

  it("shows resolution, megapixels and dated provenance and marks a real winner accessibly", () => {
    renderComparison(
      file("a", facts({ width: 4000, height: 6000, size: 9_000_000 })),
      file("b", facts({ width: 1000, height: 1500, size: 2_000_000 })),
    );

    expect(screen.getByText("4000 × 6000").className).toContain("font-semibold");
    expect(screen.getByText("4000 × 6000").className).toContain("text-success");
    expect(screen.getByText("4000 × 6000").textContent).toMatch(/more detail/i);
    expect(screen.getByText("24 MP").textContent).toMatch(/more detail/i);
    expect(screen.getAllByText(/2024-01-02T03:04:05Z, from EXIF/)).toHaveLength(2);
  });

  it("states absent plan-only facts as unknown without claiming a winner", () => {
    renderComparison(
      file("plan-only", null),
      file("catalog", facts({ width: 1920, height: 1080 })),
    );

    expect(screen.getAllByText("unknown").length).toBeGreaterThanOrEqual(3);
    expect(screen.queryByText(/more detail/i)).toBeNull();
    expect(screen.queryByText(/the larger file/i)).toBeNull();
  });

  it("shows duration and codec only for a pair of videos", () => {
    const { unmount } = render(
      <I18nProvider initialLocale="en">
        <CompareModal
          a={file(
            "a",
            facts({ width: 1920, height: 1080, kind: "video", duration: 61, codec: "h264" }),
          )}
          b={file(
            "b",
            facts({ width: 1920, height: 1080, kind: "video", duration: 59, codec: "hevc" }),
          )}
          keeperId={null}
          setId="set-1"
          onKeep={() => undefined}
          onKeepBoth={() => undefined}
          onClose={() => undefined}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Duration")).not.toBeNull();
    expect(screen.getByText("Codec")).not.toBeNull();
    expect(screen.getByText("h264")).not.toBeNull();
    expect(screen.getByText("hevc")).not.toBeNull();
    unmount();

    renderComparison(
      file("still-a", facts({ width: 1000, height: 1500 })),
      file("still-b", facts({ width: 1000, height: 1500 })),
    );
    expect(screen.queryByText("Duration")).toBeNull();
    expect(screen.queryByText("Codec")).toBeNull();
  });

  it("opens either side full screen without dismissing the comparison", () => {
    const onEnlarge = renderComparison(
      file("a", facts({ width: 1000, height: 1500 })),
      file("b", facts({ width: 1000, height: 1500 })),
    );

    fireEvent.click(screen.getByRole("button", { name: "Look at a.jpg full screen" }));
    fireEvent.click(screen.getByRole("button", { name: "Look at b.jpg full screen" }));
    expect(onEnlarge.mock.calls).toEqual([["/source/a.jpg"], ["/source/b.jpg"]]);
    expect(screen.getByRole("dialog", { name: "Compare copies" })).not.toBeNull();
  });
});
