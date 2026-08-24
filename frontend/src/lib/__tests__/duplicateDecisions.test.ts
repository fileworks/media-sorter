import { describe, expect, it } from "vitest";

import { keeperRationale } from "@/lib/duplicateDecisions";
import type { DuplicateGroup, GroupMember } from "@/lib/reviewWorkbench";

function member(
  id: string,
  options: {
    path?: string;
    size?: number;
    modified?: number | null;
    dimensions?: [number, number] | null;
  } = {},
): GroupMember {
  const dimensions = options.dimensions === undefined ? [100, 100] : options.dimensions;
  return {
    member_id: id,
    root_id: "input",
    role: "input",
    relative_path: options.path ?? `${id}.jpg`,
    observed_path: `/input/${options.path ?? `${id}.jpg`}`,
    facts: {
      size_bytes: options.size ?? 100,
      modified_at:
        options.modified === null
          ? { known: false, value: null, issue: "not readable" }
          : { known: true, value: options.modified ?? 1000, issue: null },
      captured_at: { known: false, value: null, issue: null },
      width:
        dimensions === null
          ? { known: false, value: null, issue: "not readable" }
          : { known: true, value: dimensions[0], issue: null },
      height:
        dimensions === null
          ? { known: false, value: null, issue: "not readable" }
          : { known: true, value: dimensions[1], issue: null },
      duration_seconds: { known: false, value: null, issue: "not a video" },
      codec: { known: false, value: null, issue: "not a video" },
      media_kind: "image",
    },
    evidence: {
      algorithm: "sha256",
      sha256: null,
      signature: null,
      distance: null,
      threshold: null,
      confidence: "high",
      extraction_issues: [],
    },
  };
}

function group(...members: GroupMember[]): DuplicateGroup {
  return {
    group_id: "group",
    kind: "exact",
    catalog_generation: 1,
    rule_version: "v1",
    member_count: members.length,
    total_bytes: members.reduce((sum, item) => sum + item.facts.size_bytes, 0),
    anchor_member_id: members[0]?.member_id ?? null,
    evidence_summary: "synthetic exact group",
    members,
  };
}

describe("keeper proposal rationale", () => {
  it("names only the rung that actually separated the winning file", () => {
    const rationale = keeperRationale(
      group(member("winner", { size: 200 }), member("other", { size: 100 })),
      "largest",
      "winner",
    );

    expect(rationale.winningRung.key).toBe("review.resolve.rationale.rung.largestSize");
    expect(rationale.tieBreak).toBeNull();
  });

  it("reports the real secondary rung without pretending identity broke the tie", () => {
    const rationale = keeperRationale(
      group(
        member("winner", { size: 100, modified: 2000 }),
        member("other", { size: 100, modified: 1000 }),
      ),
      "largest",
      "winner",
    );

    expect(rationale.winningRung.key).toBe("review.resolve.rationale.rung.newestDate");
    expect(rationale.tieBreak).toBeNull();
  });

  it("discloses stable identity only when it was the decisive tie-break", () => {
    const first = member("a", { path: "same.jpg", size: 100, modified: 1000 });
    const second = { ...member("b", { path: "same.jpg", size: 100, modified: 1000 }) };
    second.root_id = "z";
    const rationale = keeperRationale(group(first, second), "largest", "a");

    expect(rationale.winningRung.key).toBe("review.resolve.rationale.rung.stableIdentity");
    expect(rationale.tieBreak?.key).toBe("review.resolve.rationale.tie.stableIdentity");
  });

  it("shows the exact unknown members and the policy limitation", () => {
    const rationale = keeperRationale(
      group(
        member("winner", { path: "winner.jpg", dimensions: [400, 300] }),
        member("unknown", { path: "unreadable.raw", dimensions: null }),
      ),
      "best_quality",
      "winner",
    );

    expect(rationale.unknownFacts).toContainEqual({
      key: "review.resolve.rationale.unknown.dimensions",
      params: { members: "unreadable.raw" },
    });
    expect(rationale.limitation?.key).toBe("review.resolve.rationale.limitation.unmeasuredQuality");
  });

  it("reports copy markers as the smart rule's winner when later rungs were unused", () => {
    const rationale = keeperRationale(
      group(
        member("winner", { path: "IMG_0001.jpg" }),
        member("copy", { path: "IMG_0001 copy.jpg" }),
      ),
      "smart",
      "winner",
    );

    expect(rationale.winningRung.key).toBe("review.resolve.rationale.rung.copyMarkers");
    expect(rationale.tieBreak).toBeNull();
  });
});
