import { describe, expect, it } from "vitest";

import {
  looksLikeStackTrace,
  presentOutcome,
  presentStatus,
  severityClass,
} from "@/lib/statusPresentation";

describe("presentStatus", () => {
  it("explains impact and safety in plain language for a known code", () => {
    const status = presentStatus({
      code: "destination_unavailable",
      safety: "source_retained",
      detail: "OSError: [Errno 5] Input/output error",
    });

    expect(status.headline).toMatch(/disconnected/i);
    expect(status.impact).toMatch(/last verified/i);
    expect(status.safety).toMatch(/untouched/i);
    expect(status.actions.map((action) => action.id)).toContain("reconnect");
  });

  it("keeps the raw detail out of the headline but available", () => {
    const status = presentStatus({
      code: "integrity_mismatch",
      detail: 'Traceback (most recent call last):\n  File "x.py", line 1',
    });

    expect(status.headline).not.toMatch(/Traceback/);
    expect(status.technicalDetail).toMatch(/Traceback/);
    expect(looksLikeStackTrace(status.technicalDetail ?? "")).toBe(true);
  });

  it("still produces something usable for an unrecognised code", () => {
    const status = presentStatus({ code: "totally_new_code" });

    expect(status.code).toBe("totally_new_code");
    expect(status.headline).toBeTruthy();
    expect(status.impact).toMatch(/nothing was removed/i);
  });

  it("mentions retries that already happened", () => {
    const status = presentStatus({ code: "destination_full", retriesPerformed: 2 });

    expect(status.impact).toMatch(/Retried automatically 2 times/);
  });

  it("announces errors assertively and warnings politely", () => {
    expect(presentStatus({ code: "integrity_mismatch" }).announcement.assertive).toBe(true);
    expect(presentStatus({ code: "metadata_limitation" }).announcement.assertive).toBe(false);
  });

  it("says which copy is authoritative when the state is ambiguous", () => {
    const status = presentStatus({ code: "reconciliation_required", safety: "ambiguous" });

    expect(status.safety).toMatch(/needs review/i);
    expect(status.actions.map((action) => action.id)).toContain("review_recovery");
  });

  it("never hands back an empty technical detail", () => {
    expect(presentStatus({ code: "encoder_failed", detail: "   " }).technicalDetail).toBeNull();
  });
});

describe("presentOutcome", () => {
  it("distinguishes success from success with warnings", () => {
    expect(presentOutcome("completed", 0).tone).toBe("success");

    const warned = presentOutcome("completed_with_warnings", 3);
    expect(warned.tone).toBe("warning");
    expect(warned.headline).toMatch(/3 warnings/);
    expect(warned.nextStep).toMatch(/report/i);
  });

  it("tells a cancelled run that finished work is still valid", () => {
    expect(presentOutcome("cancelled", 0).nextStep).toMatch(/complete and verified/i);
  });

  it("reassures that a failed run did not remove sources", () => {
    expect(presentOutcome("failed", 0).nextStep).toMatch(/not removed/i);
  });

  it("uses the singular for exactly one warning", () => {
    expect(presentOutcome("completed_with_warnings", 1).headline).toMatch(/1 warning\b/);
  });
});

describe("severity tokens", () => {
  it("gives states and notification banners one semantic token vocabulary", () => {
    expect(severityClass("info")).toContain("border-info");
    expect(severityClass("warning")).toContain("border-warning");
    expect(severityClass("error")).toContain("border-error");
    expect(severityClass("neutral")).toContain("border-border");
  });
});
