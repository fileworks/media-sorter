import { describe, expect, it } from "vitest";

import {
  coalesce,
  livenessMessage,
  progressView,
  resumeFrom,
  type ProgressSnapshot,
} from "@/lib/progressTransport";

function snapshot(overrides: Partial<ProgressSnapshot> = {}): ProgressSnapshot {
  return {
    phase: "sorting",
    total: 100,
    current: 25,
    sequence: 5,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("progressView", () => {
  it("shows a live count instead of a false percentage while discovering", () => {
    const view = progressView(snapshot({ total: null, current: 1204, phase: "discovering" }), 1_000);

    expect(view.determinate).toBe(false);
    expect(view.percentage).toBeNull();
    expect(view.countLabel).toMatch(/1,204 found so far/);
  });

  it("reports a stall as still-working rather than freezing", () => {
    const view = progressView(snapshot({ updatedAt: 0 }), 9_000);

    expect(view.live).toBe(false);
    expect(view.stalledForSeconds).toBe(9);
  });

  it("withholds an ETA until there is enough progress to extrapolate", () => {
    expect(progressView(snapshot({ current: 5 }), 1_000).etaConfidence).toBe("low");
    expect(progressView(snapshot({ current: 50 }), 1_000).etaConfidence).toBe("high");
    expect(progressView(snapshot({ total: null }), 1_000).etaConfidence).toBe("none");
  });

  it("separates a requested cancellation from an observed one", () => {
    expect(progressView(snapshot({ cancellationRequested: true }), 1_000).cancelState).toBe(
      "requested",
    );
    expect(
      progressView(snapshot({ cancellationRequested: true, cancellationObserved: true }), 1_000)
        .cancelState,
    ).toBe("observed");
  });

  it("reports bytes when they are known and stays silent when they are not", () => {
    expect(progressView(snapshot(), 1_000).byteLabel).toBeNull();
    expect(
      progressView(snapshot({ bytesProcessed: 500, bytesTotal: 2_000 }), 1_000).byteLabel,
    ).toBe("500 of 2,000 bytes");
  });
});

describe("coalesce", () => {
  it("drops frames that arrive faster than the render budget", () => {
    const previous = snapshot({ sequence: 1 });

    expect(coalesce(previous, snapshot({ sequence: 2 }), 1_000, 1_050)).toBeNull();
    expect(coalesce(previous, snapshot({ sequence: 2 }), 1_000, 1_200)).not.toBeNull();
  });

  it("never drops a phase change or an observed cancellation", () => {
    const previous = snapshot({ sequence: 1 });

    expect(coalesce(previous, snapshot({ sequence: 2, phase: "verifying" }), 1_000, 1_001))
      .not.toBeNull();
    expect(
      coalesce(previous, snapshot({ sequence: 2, cancellationObserved: true }), 1_000, 1_001),
    ).not.toBeNull();
  });

  it("never drops the frame that reaches the total", () => {
    const previous = snapshot({ sequence: 1, current: 99 });

    expect(coalesce(previous, snapshot({ sequence: 2, current: 100 }), 1_000, 1_001)).not.toBeNull();
  });

  it("ignores frames that arrive out of order", () => {
    const previous = snapshot({ sequence: 9 });

    expect(coalesce(previous, snapshot({ sequence: 8 }), 0, 10_000)).toBeNull();
  });

  it("always renders the first frame", () => {
    expect(coalesce(null, snapshot({ sequence: 1 }), 0, 0)).not.toBeNull();
  });
});

describe("resumeFrom", () => {
  it("reconnects at the last sequence rather than replaying the run", () => {
    expect(resumeFrom(snapshot({ sequence: 42 }))).toBe(42);
    expect(resumeFrom(null)).toBe(0);
  });
});

describe("livenessMessage", () => {
  it("names the active path when a slow filesystem stalls", () => {
    const view = progressView(snapshot({ updatedAt: 0 }), 8_000);

    const message = livenessMessage(view, "//nas/photos/2019");

    expect(message.indeterminate).toBe(true);
    expect(message.message).toContain("//nas/photos/2019");
  });

  it("says it is stopping once cancellation is requested", () => {
    const view = progressView(snapshot({ cancellationRequested: true }), 1_000);

    expect(livenessMessage(view, null).message).toMatch(/stopping/i);
  });
});
