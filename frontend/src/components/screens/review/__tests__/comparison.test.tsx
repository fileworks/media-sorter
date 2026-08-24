// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { CompareModal } from "@/components/screens/review/CompareModal";
import { I18nProvider, translate } from "@/i18n/I18nContext";
import { REVIEW_FACT_LABELS, REVIEW_FACT_ORDER } from "@/lib/reviewFacts";
import compareSource from "@/components/screens/review/CompareModal.tsx?raw";
import detailSource from "@/components/screens/review/DetailView.tsx?raw";
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
  it("keeps the rule recommendation separate from the explicitly confirmed choice", () => {
    const onKeep = vi.fn();
    const a = file("a", facts({ width: 2000, height: 3000 }));
    const b = file("b", facts({ width: 1000, height: 1500 }));
    render(
      <I18nProvider initialLocale="en">
        <CompareModal
          a={a}
          b={b}
          keeperId={null}
          setId="set-1"
          recommendedId="a"
          recommendedLabel="a.jpg"
          recommendationReason="Suggested by quality; it is not selected automatically."
          onKeep={onKeep}
          onKeepBoth={() => undefined}
          onClose={() => undefined}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Recommended: a.jpg")).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: /B.*b\.jpg/ }));
    expect(onKeep).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm selection" }));
    expect(onKeep).toHaveBeenCalledWith("b");
  });

  it("names set navigation buttons even when their visible labels are hidden", () => {
    render(
      <I18nProvider initialLocale="en">
        <CompareModal
          a={file("a", facts({ width: 2000, height: 3000 }))}
          b={file("b", facts({ width: 1000, height: 1500 }))}
          keeperId={null}
          setId="set-1"
          onKeep={() => undefined}
          onKeepBoth={() => undefined}
          onClose={() => undefined}
          onPreviousSet={() => undefined}
          onNextSet={() => undefined}
        />
      </I18nProvider>,
    );

    expect(screen.getByRole("button", { name: "Previous set" }).getAttribute("aria-label")).toBe(
      "Previous set",
    );
    expect(screen.getByRole("button", { name: "Next set" }).getAttribute("aria-label")).toBe(
      "Next set",
    );
  });

  it("cycles every other copy in a set without leaving comparison", () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();
    render(
      <I18nProvider initialLocale="en">
        <CompareModal
          a={file("a", facts({ width: 2000, height: 3000 }))}
          b={file("b", facts({ width: 1000, height: 1500 }))}
          keeperId={null}
          setId="set-1"
          onKeep={() => undefined}
          onKeepBoth={() => undefined}
          onClose={() => undefined}
          comparisonPosition={{ index: 1, total: 3, onPrevious, onNext }}
        />
      </I18nProvider>,
    );

    expect(screen.getByText("Copy 2 of 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Previous copy" }));
    fireEvent.click(screen.getByRole("button", { name: "Next copy" }));
    expect(onPrevious).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();
  });

  it("uses the portrait aspect ratio throughout all three viewport-scaled modes", () => {
    renderComparison(
      file("a", facts({ width: 2000, height: 3000 })),
      file("b", facts({ width: 1000, height: 1500 })),
    );

    expect(screen.getByTestId("comparison-frame").getAttribute("data-aspect-ratio")).toBe("1.3333");
    expect(screen.getByTestId("comparison-frame").parentElement?.className).toContain("38dvh");
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

  it("gives mode guidance and zoom their own rows at phone widths", () => {
    renderComparison(
      file("a", facts({ width: 2000, height: 3000 })),
      file("b", facts({ width: 1000, height: 1500 })),
    );

    expect(
      screen.getByRole("group", { name: "Comparison mode" }).parentElement?.className,
    ).toContain("w-full");
    expect(
      screen.getByText("Both files at the same size, next to each other.").className,
    ).toContain("w-full");
    expect(screen.getByText("Zoom").className).toContain("w-full");
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

  it("shows duration and codec whenever video evidence is relevant", () => {
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
    expect(screen.getByText("Video codec")).not.toBeNull();
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

  it("keeps mixed image/video facts honest instead of hiding one side", () => {
    renderComparison(
      file("still", facts({ width: 1000, height: 1500, kind: "image" })),
      file(
        "clip",
        facts({ width: 1920, height: 1080, kind: "video", duration: 65, codec: "h264" }),
      ),
    );

    expect(screen.getByText("File type")).toBeTruthy();
    expect(screen.getByText("Duration")).toBeTruthy();
    expect(screen.getByText("Video codec")).toBeTruthy();
    expect(screen.getAllByText("Not applicable")).toHaveLength(2);
    expect(screen.getByText("1m 5s")).toBeTruthy();
    expect(screen.getByText("h264")).toBeTruthy();
  });

  it("states the full set scope when keeping every member", () => {
    render(
      <I18nProvider initialLocale="en">
        <CompareModal
          a={file("a", facts({ width: 2000, height: 3000 }))}
          b={file("b", facts({ width: 1000, height: 1500 }))}
          keeperId={null}
          setId="set-1"
          setMemberCount={3}
          onKeep={() => undefined}
          onKeepBoth={() => undefined}
          onClose={() => undefined}
        />
      </I18nProvider>,
    );

    expect(
      screen.getByRole("button", {
        name: "Keep all 3 as separate files — these are not duplicates",
      }),
    ).toBeTruthy();
  });

  it("shows companion membership, role, destination, warning, and planned result", () => {
    const primary: ComparableFile = {
      ...file("primary", facts({ width: 2000, height: 3000 })),
      unitId: "unit-1",
      unitPrimary: true,
      companions: [
        {
          source: "/source/primary.xmp",
          destination: "/sorted/2026/primary.xmp",
          role: "edit_sidecar",
          status: "attached",
          warning: "Sidecar metadata was unreadable.",
        },
      ],
      unitWarnings: ["One companion needs review."],
      destination: "/sorted/2026/primary.jpg",
      plannedStatus: "organize",
    };
    const standalone: ComparableFile = {
      ...file("standalone", facts({ width: 1000, height: 1500 })),
      unitId: null,
      unitPrimary: null,
      companions: [],
      unitWarnings: [],
      destination: null,
      plannedStatus: "keep_in_place",
    };

    renderComparison(primary, standalone);

    expect(screen.getByText("Primary in unit unit-1")).toBeTruthy();
    expect(screen.getByText("Standalone file")).toBeTruthy();
    expect(
      screen.getByText(
        /Edit sidecar.*Planned with the primary file.*primary\.xmp.*metadata was unreadable/,
      ),
    ).toBeTruthy();
    expect(screen.getByText("/sorted/2026/primary.jpg")).toBeTruthy();
    expect(screen.getByText("One companion needs review.")).toBeTruthy();
    expect(screen.getByText("Will be organized")).toBeTruthy();
    expect(screen.getByText("Will remain in place")).toBeTruthy();
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

describe("one fact order everywhere", () => {
  /**
   * Both surfaces render from `REVIEW_FACT_ORDER`, so a test that only reads
   * the rendered order cannot fail — reordering the list reorders the output
   * with it. What can still diverge is a row added *beside* the ordered list,
   * which is how the two orders drifted apart in the first place. Each surface
   * therefore has exactly one place that renders a fact.
   */
  it("renders every fact from the one ordered list, on both surfaces", () => {
    expect(compareSource.match(/<FactRow/g)).toHaveLength(1);
    expect(detailSource.match(/<Fact\b/g)).toHaveLength(1);
    // And the label of that single row comes from the shared table.
    expect(compareSource).toContain("label={t(REVIEW_FACT_LABELS[fact.id])}");
    expect(detailSource).toContain("label={t(REVIEW_FACT_LABELS[fact.id])}");
  });

  it("reads the comparison table in the catalogue's canonical order", () => {
    renderComparison(
      file("a", facts({ width: 2000, height: 3000 })),
      file("b", facts({ width: 1000, height: 1500 })),
    );

    // The row labels, in the order the table renders them.
    const shown = screen
      .getAllByTestId("fact-row-label")
      .map((element) => element.textContent?.trim() ?? "");
    const canonical = REVIEW_FACT_ORDER.map((id) => translate("en", REVIEW_FACT_LABELS[id])).filter(
      (label) => shown.includes(label),
    );

    expect(shown).toEqual(canonical);
  });
});
