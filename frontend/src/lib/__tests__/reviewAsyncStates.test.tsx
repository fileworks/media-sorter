// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

const media = vi.hoisted(() => ({
  queued: {
    objectUrl: null as string | null,
    loading: false,
    waiting: false,
    errored: false,
    unavailable: false,
  },
  authorized: {
    objectUrl: null as string | null,
    loading: false,
    errored: false,
    unavailable: false,
  },
}));

vi.mock("@/lib/thumbnailQueue", () => ({
  useQueuedThumbnail: () => media.queued,
  useAuthorizedMedia: () => media.authorized,
}));

import { MediaViewer } from "@/components/screens/review/MediaViewer";
import { MediaImage } from "@/components/ui/media-image";
import { Thumbnail } from "@/components/ui/thumbnail";
import { I18nProvider, translate } from "@/i18n/I18nContext";
import { de, en } from "@/i18n/messages";

const enText = (key: string) => translate("en", key);

function renderLocalized(node: React.ReactNode) {
  return render(<I18nProvider initialLocale="en">{node}</I18nProvider>);
}

function resetMedia() {
  Object.assign(media.queued, {
    objectUrl: null,
    loading: false,
    waiting: false,
    errored: false,
    unavailable: false,
  });
  Object.assign(media.authorized, {
    objectUrl: null,
    loading: false,
    errored: false,
    unavailable: false,
  });
}

beforeEach(resetMedia);
afterEach(cleanup);

/**
 * The asynchronous-source register for Review.
 *
 * A Review decision is deliberately absent: keeper choices, keep-all, and
 * run-scoped exclusions are synchronous local state. No decision endpoint is
 * called, so inventing a saving state would make the interface claim work that
 * does not exist. If a decision ever does acquire an async boundary, it belongs
 * in this table and in the rendered-state tests beside it.
 */
const ASYNC_PRESENTATIONS = [
  {
    source: "duplicate catalog",
    loading: "review.catalog.loading",
    error: "review.stacksFailed",
    empty: "review.band.noSets",
  },
  {
    source: "outcome lookup",
    loading: "review.detail.provenanceLoading",
    error: "review.detail.provenanceFailed",
    empty: "review.detail.provenanceUnavailable",
  },
  {
    source: "media info",
    loading: "review.detail.infoLoading",
    error: "review.detail.infoFailed",
    empty: "review.detail.unknown",
  },
  {
    source: "thumbnail queue",
    loading: "preview.thumbnailLoading",
    error: "preview.thumbnailFailed",
    empty: "preview.noThumbnail",
  },
  {
    source: "full-screen viewer image",
    loading: "preview.thumbnailLoading",
    error: "preview.thumbnailFailed",
    empty: "preview.noThumbnail",
  },
  {
    source: "difference image",
    loading: "preview.thumbnailLoading",
    error: "preview.thumbnailFailed",
    empty: "review.compare.diffUnavailable",
  },
] as const;

describe("the Review async-state register", () => {
  it.each(ASYNC_PRESENTATIONS)(
    "$source has different loading, error, and settled-empty messages in both locales",
    ({ loading, error, empty }) => {
      expect(loading).not.toBe(error);
      expect(error).not.toBe(empty);
      expect(loading).not.toBe(empty);
      for (const catalogue of [en, de]) {
        expect(catalogue).toHaveProperty(loading);
        expect(catalogue).toHaveProperty(error);
        expect(catalogue).toHaveProperty(empty);
      }
    },
  );

  it("keeps the source register aligned with every async primitive used on Review", () => {
    const sources = import.meta.glob(
      "../../components/{screens/ReviewScreen.tsx,screens/review/*.tsx,ui/{thumbnail,media-image}.tsx}",
      {
        query: "?raw",
        import: "default",
        eager: true,
      },
    ) as Record<string, string>;
    const joined = Object.values(sources).join("\n");

    expect(joined).toContain("useReviewGroups");
    expect(joined).toContain("useReviewOutcome");
    expect(joined).toContain("useMediaInfo");
    expect(joined).toContain("<Thumbnail");
    expect(joined).toContain("useQueuedThumbnail");
    expect(joined).toContain("<MediaImage");
    expect(ASYNC_PRESENTATIONS.map(({ source }) => source)).toEqual([
      "duplicate catalog",
      "outcome lookup",
      "media info",
      "thumbnail queue",
      "full-screen viewer image",
      "difference image",
    ]);
  });

  it("gives every Review spinner an accessible status rather than rendering it bare", () => {
    const sources = import.meta.glob(
      "../../components/{screens/ReviewScreen.tsx,screens/review/*.tsx,ui/{thumbnail,media-image}.tsx}",
      {
        query: "?raw",
        import: "default",
        eager: true,
      },
    ) as Record<string, string>;

    for (const [path, source] of Object.entries(sources)) {
      for (const match of source.matchAll(/animate-spin/g)) {
        const context = source.slice(Math.max(0, (match.index ?? 0) - 400), match.index);
        expect(context, `${path} has a bare spinner`).toMatch(/role="status"|aria-busy/);
      }
    }
  });

  it("routes query failures through the shared safe error extractor", () => {
    const sources = import.meta.glob(
      "../../components/{screens/ReviewScreen.tsx,screens/review/*.tsx}",
      {
        query: "?raw",
        import: "default",
        eager: true,
      },
    ) as Record<string, string>;
    const joined = Object.values(sources).join("\n");

    expect(joined).toContain("extractErrorMessage");
    expect(joined).not.toMatch(/\{\s*(?:groups|info|outcome)\.error(?:\.message)?\s*\}/);
    expect(joined).not.toMatch(/String\(\s*(?:groups|info|outcome)\.error\s*\)/);
  });
});

describe("thumbnail presentations", () => {
  it("distinguishes waiting, loading, unavailable, and failed", () => {
    media.queued.loading = true;
    const loading = renderLocalized(<Thumbnail path="/photo.jpg" />);
    expect(screen.getByRole("status", { name: enText("preview.thumbnailLoading") })).toBeTruthy();
    loading.unmount();

    resetMedia();
    media.queued.waiting = true;
    const waiting = renderLocalized(<Thumbnail path="/photo.jpg" />);
    expect(screen.getByRole("status", { name: enText("preview.thumbnailWaiting") })).toBeTruthy();
    waiting.unmount();

    resetMedia();
    media.queued.unavailable = true;
    const unavailable = renderLocalized(<Thumbnail path="/photo.jpg" />);
    expect(screen.getByText(enText("preview.noThumbnail"))).toBeTruthy();
    unavailable.unmount();

    resetMedia();
    media.queued.errored = true;
    renderLocalized(<Thumbnail path="/photo.jpg" />);
    expect(screen.getByText(enText("preview.thumbnailFailed"))).toBeTruthy();
  });
});

describe("always-visible media presentations", () => {
  it("distinguishes a difference image's loading, unsupported, and failed states", () => {
    media.authorized.loading = true;
    const loading = renderLocalized(
      <MediaImage src="/difference" alt="Difference" fallback={<p>Unsupported difference</p>} />,
    );
    expect(screen.getByRole("status", { name: enText("preview.thumbnailLoading") })).toBeTruthy();
    loading.unmount();

    resetMedia();
    media.authorized.unavailable = true;
    const unavailable = renderLocalized(
      <MediaImage src="/difference" alt="Difference" fallback={<p>Unsupported difference</p>} />,
    );
    expect(screen.getByText("Unsupported difference")).toBeTruthy();
    unavailable.unmount();

    resetMedia();
    media.authorized.errored = true;
    renderLocalized(
      <MediaImage src="/difference" alt="Difference" fallback={<p>Unsupported difference</p>} />,
    );
    expect(screen.getByRole("alert").textContent).toBe(enText("preview.thumbnailFailed"));
  });

  it("distinguishes a viewer image's loading, unsupported, and failed states", () => {
    const viewer = () => (
      <MediaViewer
        path="/photo.jpg"
        name="photo.jpg"
        destination="/out/photo.jpg"
        position={null}
        onPrevious={null}
        onNext={null}
        onClose={() => undefined}
      />
    );

    media.queued.loading = true;
    const loading = renderLocalized(viewer());
    expect(screen.getByRole("status", { name: enText("preview.thumbnailLoading") })).toBeTruthy();
    loading.unmount();

    resetMedia();
    media.queued.unavailable = true;
    const unavailable = renderLocalized(viewer());
    expect(screen.getByText(enText("preview.noThumbnail"))).toBeTruthy();
    unavailable.unmount();

    resetMedia();
    media.queued.errored = true;
    renderLocalized(viewer());
    expect(screen.getByText(enText("preview.thumbnailFailed"))).toBeTruthy();
  });
});
