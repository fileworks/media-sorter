import { describe, expect, it } from "vitest";

import {
  decisionState,
  keeperProposals,
  keeperRecommendations,
  keeperRationale,
} from "@/lib/duplicateDecisions";
import type { DuplicateDecision } from "@/lib/duplicateDecisions";
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
    expect(rationale.primaryRung.key).toBe("review.resolve.rationale.rung.largestSize");
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

    expect(rationale.primaryRung.key).toBe("review.resolve.rationale.rung.largestSize");
    expect(rationale.winningRung.key).toBe("review.resolve.rationale.rung.newestDate");
    expect(rationale.tieBreak?.key).toBe("review.resolve.rationale.rung.newestDate");
    expect(rationale.comparisons).toEqual([
      expect.objectContaining({ member: "winner.jpg", selected: true }),
      expect.objectContaining({ member: "other.jpg", selected: false }),
    ]);
  });

  it("discloses stable identity only when it was the decisive tie-break", () => {
    const first = member("a", { path: "same.jpg", size: 100, modified: 1000 });
    const second = { ...member("b", { path: "same.jpg", size: 100, modified: 1000 }) };
    second.root_id = "z";
    const rationale = keeperRationale(group(first, second), "largest", "a");

    expect(rationale.winningRung.key).toBe("review.resolve.rationale.rung.stableIdentity");
    expect(rationale.primaryRung.key).toBe("review.resolve.rationale.rung.largestSize");
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

describe("a recommendation outlives the decision it produced", () => {
  const sets = group(member("winner", { size: 200 }), member("other", { size: 100 }));
  const accepted = new Map<string, DuplicateDecision>([
    ["group", { kind: "keeper", memberId: "winner" }],
  ]);

  it("still names the ranked copy after the recommendation has been accepted", () => {
    // The bug: accepting the recommendations decided every set, the map was
    // rebuilt for undecided sets only, and every surface then reported that
    // there was no recommendation — for the sets it had just applied one to.
    const recommendations = keeperRecommendations([sets], "largest");

    expect(recommendations.get("group")?.memberId).toBe("winner");
    expect(keeperRecommendations([sets], "largest").get("group")?.memberId).toBe("winner");
  });

  it("stops offering it as an outstanding proposal once it has been answered", () => {
    expect(keeperProposals([sets], "largest", new Map()).has("group")).toBe(true);
    expect(keeperProposals([sets], "largest", accepted).has("group")).toBe(false);
  });

  it("reports a decided set as decided even while it carries a recommendation", () => {
    const recommendations = keeperRecommendations([sets], "largest");

    expect(decisionState("group", accepted, recommendations)).toBe("decided");
    expect(decisionState("group", new Map(), recommendations)).toBe("proposed");
  });

  it("never recommends for a set the library contract already answers", () => {
    const reference = member("baseline");
    const protectedGroup = group({ ...reference, role: "reference" }, member("copy"));

    expect(keeperRecommendations([protectedGroup], "largest").size).toBe(0);
  });
});
