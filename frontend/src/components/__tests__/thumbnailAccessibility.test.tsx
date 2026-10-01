// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { Thumbnail } from "@/components/ui/thumbnail";
import { I18nProvider } from "@/i18n/I18nContext";
import { useQueuedThumbnail } from "@/lib/thumbnailQueue";

vi.mock("@/lib/thumbnailQueue", () => ({ useQueuedThumbnail: vi.fn() }));
afterEach(cleanup);

it.each(["errored", "unavailable"] as const)(
  "keeps the thumbnail action name when its preview is %s",
  (state) => {
    vi.mocked(useQueuedThumbnail).mockReturnValue({
      objectUrl: null,
      loading: false,
      waiting: false,
      errored: state === "errored",
      unavailable: state === "unavailable",
    });
    const open = vi.fn();
    render(
      <I18nProvider initialLocale="en">
        <Thumbnail path="/tmp/synthetic.jpg" openLabel="Inspect synthetic.jpg" onOpen={open} />
      </I18nProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Inspect synthetic.jpg" }));
    expect(open).toHaveBeenCalledOnce();
  },
);
