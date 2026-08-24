import { describe, expect, it } from "vitest";

import {
  REPORT_FILTER_TABS,
  UNFILTERED_RECORD_STATUSES,
  reportTabForStatus,
} from "@/lib/reportStatuses";
import contract from "../../../../contracts/review-statuses.json";
// Read as text, not imported as a module: `support.ts` pulls in Playwright.
import supportSource from "../../../e2e/support.ts?raw";

/**
 * The report's filter tabs, pinned against the executor's own vocabulary.
 *
 * A record status is not a preview status: the first says what happened to a
 * file, the second says where it would go. Only the second had a contract, so
 * the filters drifted — `companion_left_in_place` and `kept_in_place` were
 * written by the executor and matched by no tab, so they were counted in "All"
 * and reachable from nowhere, while `unmatched_companion` was filtered for and
 * never written at all.
 *
 * The artifact is imported rather than restated. Restating it here would make
 * these pass by construction, which is the failure they exist to catch.
 */

const declared: readonly string[] = contract.operation_record_statuses;

describe("report filter parity with the executor", () => {
  it("reads a contract in the shape this test was written against", () => {
    expect(contract.format_version).toBe(2);
    expect(declared.length).toBeGreaterThan(0);
  });

  it("gives every status the executor writes a tab, or states that it has none", () => {
    const unreachable = declared.filter(
      (status) =>
        reportTabForStatus(status) === null && !UNFILTERED_RECORD_STATUSES.includes(status),
    );

    expect(
      unreachable,
      "these are counted in All and reachable from no tab; add them to a tab or to UNFILTERED_RECORD_STATUSES",
    ).toEqual([]);
  });

  it("never filters for a status the executor cannot write", () => {
    const known = new Set(declared);
    const phantom = REPORT_FILTER_TABS.flatMap((tab) => tab.statuses ?? []).filter(
      (status) => !known.has(status),
    );

    expect(phantom, "these can never match a row, so their tab silently under-counts").toEqual([]);
  });

  it("puts each status in at most one tab", () => {
    const seen = new Map<string, string>();
    for (const tab of REPORT_FILTER_TABS) {
      for (const status of tab.statuses ?? []) {
        expect(seen.has(status), `${status} is in both ${seen.get(status)} and ${tab.id}`).toBe(
          false,
        );
        seen.set(status, tab.id);
      }
    }
  });

  it("keeps the deliberate non-moves out of Sorted and out of Failed", () => {
    for (const status of UNFILTERED_RECORD_STATUSES) {
      expect(declared).toContain(status);
      expect(reportTabForStatus(status)).toBeNull();
    }
  });
});

describe("the browser fixture speaks the executor's vocabulary", () => {
  it("never invents a record status the backend cannot write", () => {
    // The fixture defaulted every file to "sorted", which no backend emits, so
    // the whole e2e report exercised statuses that fell outside every filter —
    // the Sorted tab read (0) beside a tile reading 6 and the suite was happy.
    const support: string = supportSource;
    // Only the report literal and the helper that builds its rows. Elsewhere in
    // the fixture `status` belongs to tasks and probes, a different vocabulary.
    const reportStart = support.indexOf("E2E_OPERATION_REPORT");
    const reportEnd = support.indexOf("export ", reportStart + 10);
    const helperStart = support.indexOf("function operationFile(");
    const helperEnd = support.indexOf("\n}", helperStart);
    const section = support.slice(reportStart, reportEnd) + support.slice(helperStart, helperEnd);
    // Every quoted token on a `status:` line, not just the first — the helper
    // picks between two of them with a ternary on one line.
    const used = new Set(
      section
        .split("\n")
        .filter((line: string) => /(^|\s)status:/.test(line))
        .flatMap((line: string) => [...line.matchAll(/"([a-z_]+)"/g)].map((m) => m[1] as string)),
    );
    const known = new Set(declared);

    expect([...used].filter((status) => !known.has(status))).toEqual([]);
  });
});
