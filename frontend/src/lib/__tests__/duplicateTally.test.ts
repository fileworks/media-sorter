/**
 * One duplicate number, and it is checkable by counting.
 *
 * Three surfaces used to answer this and gave three answers: the summary tile
 * counted what the dry run would skip, the chip counted rows, and the workbench
 * summed group sizes. None of them was what the run would do — the reported
 * symptom was a screen reading 14 beside five visible sets.
 */

import { describe, expect, it } from "vitest";

import { duplicateTally, type TallyGroup } from "@/lib/reviewPlan";

function group(
  id: string,
  paths: string[],
  kind: TallyGroup["kind"] = "exact",
  decided = false,
): TallyGroup {
  return { id, kind, memberPaths: paths, decided };
}

/** Five sets of three, all in the run. */
const FIVE_OF_THREE = Array.from({ length: 5 }, (_, index) =>
  group(`g${index}`, [`/in/${index}a.jpg`, `/in/${index}b.jpg`, `/in/${index}c.jpg`]),
);

const ALL_FIFTEEN = new Set(FIVE_OF_THREE.flatMap((item) => item.memberPaths));

describe("duplicateTally", () => {
  it("reports sets and copies, never the sum of group sizes", () => {
    const tally = duplicateTally(FIVE_OF_THREE, ALL_FIFTEEN);

    expect(tally.sets).toBe(5);
    // Two copies per set are set aside; the third stays. Fifteen was the old
    // number, and it answered neither question anybody asks here.
    expect(tally.copies).toBe(10);
  });

  it("counts a set the run does not act on separately, rather than hiding it", () => {
    const groups = [...FIVE_OF_THREE, group("dest", ["/dest/x.jpg", "/dest/y.jpg"])];

    const tally = duplicateTally(groups, ALL_FIFTEEN);

    expect(tally.sets).toBe(5);
    expect(tally.copies).toBe(10);
    expect(tally.outOfScope).toBe(1);
  });

  it("needs two members in the run before a set is a set", () => {
    const groups = [group("half", ["/in/only.jpg", "/elsewhere/other.jpg"])];

    const tally = duplicateTally(groups, new Set(["/in/only.jpg"]));

    expect(tally.sets).toBe(0);
    expect(tally.outOfScope).toBe(1);
  });

  it("does not call a set out of scope when its other copy is under a skipped root", () => {
    const groups = [group("skipped", ["/phone/only.jpg", "/camera/other.jpg"])];

    const tally = duplicateTally(groups, new Set(["/phone/only.jpg"]), ["/camera"]);

    expect(tally.sets).toBe(0);
    expect(tally.outOfScope).toBe(0);
  });

  it("still reports a copy outside every configured and skipped root", () => {
    const groups = [group("elsewhere", ["/phone/only.jpg", "/archive/other.jpg"])];

    const tally = duplicateTally(groups, new Set(["/phone/only.jpg"]), ["/camera"]);

    expect(tally.outOfScope).toBe(1);
  });

  it("counts a file in both an exact and a similar set once", () => {
    const shared = ["/in/a.jpg", "/in/b.jpg"];
    const groups = [
      group("exact", shared, "exact"),
      group("similar", [...shared, "/in/c.jpg"], "similar"),
    ];

    const tally = duplicateTally(groups, new Set([...shared, "/in/c.jpg"]));

    // The similar set adds only `c`, which alone is not a second copy of
    // anything the exact set did not already claim.
    expect(tally.sets).toBe(1);
    expect(tally.copies).toBe(1);
  });

  it("attributes an overlap to the stronger evidence", () => {
    const shared = ["/in/a.jpg", "/in/b.jpg"];
    const groups = [group("similar", shared, "similar"), group("exact", shared, "exact", true)];

    const tally = duplicateTally(groups, new Set(shared));

    // The exact set is decided, the similar one is not. Ordering by evidence
    // rather than by arrival means the answer does not depend on which of three
    // independent queries resolved first.
    expect(tally.sets).toBe(1);
    expect(tally.resolved).toBe(1);
    expect(tally.unresolved).toBe(0);
  });

  it("treats only a user's own choice as a decision", () => {
    const decided = duplicateTally(
      [group("g", ["/in/a.jpg", "/in/b.jpg"], "exact", true)],
      new Set(["/in/a.jpg", "/in/b.jpg"]),
    );
    const undecided = duplicateTally(
      [group("g", ["/in/a.jpg", "/in/b.jpg"], "exact", false)],
      new Set(["/in/a.jpg", "/in/b.jpg"]),
    );

    expect(decided.resolved).toBe(1);
    // An anchor the run would fall back to is not a decision anybody made, and
    // an undecided set is one the run skips.
    expect(undecided.unresolved).toBe(1);
  });

  it("is empty rather than undefined when nothing was found", () => {
    expect(duplicateTally([], new Set())).toEqual({
      sets: 0,
      copies: 0,
      resolved: 0,
      unresolved: 0,
      outOfScope: 0,
    });
  });
});
