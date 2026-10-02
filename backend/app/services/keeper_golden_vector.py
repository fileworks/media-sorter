"""The keeper-selection golden vector, built from the Python implementation.

`A-02`: two implementations choose the keeper — `services/keeper_policies.py`
and `lib/reviewWorkbench.ts::keeperByPolicy` — and a user who picks a rule in
Review must get the same copy the backend would place from Configure. Mirroring
the tie-breaks by hand is how they drift.

So one side is the source. This module builds the cases and asks the real
`apply_policy` what it chooses; a generator freezes that into
`contracts/keeper-golden-vector.json`, exactly as the review-status contract is
frozen, and both suites read the artifact instead of restating the rules.

The cases carry the serialized group, not a shorthand: the frontend receives
`DuplicateGroup` JSON from the API, so the fixture is the shape it actually
consumes rather than a second description of it.
"""

from __future__ import annotations

from typing import Any

from app.core.duplicate_plans import (
    DuplicateGroup,
    FactValue,
    GroupMember,
    KeeperPolicyId,
    MemberEvidence,
    MemberFacts,
)
from app.services.keeper_policies import PolicySettings, apply_policy

#: Every id in `KeeperPolicyId`. A new policy that nobody adds a case for is a
#: policy the two implementations may already disagree about.
GOLDEN_POLICIES: tuple[KeeperPolicyId, ...] = (
    "smart",
    "best_quality",
    "largest",
    "smallest",
    "newest",
    "oldest",
    "highest_resolution",
    "longest_filename",
    "shortest_filename",
    "preferred_root",
    "protected_reference",
    "manual",
)


def _member(
    member_id: str,
    *,
    root_id: str = "input",
    role: str = "input",
    relative_path: str | None = None,
    size: int = 1_000,
    modified: int | None = 1_000,
    width: int | None = 100,
    height: int | None = 100,
) -> GroupMember:
    path = relative_path or f"{member_id}.jpg"
    return GroupMember(
        member_id=member_id,
        root_id=root_id,
        role=role,  # type: ignore[arg-type]
        relative_path=path,
        observed_path=f"/{root_id}/{path}",
        facts=MemberFacts(
            size_bytes=size,
            modified_at=FactValue.of(modified)
            if modified is not None
            else FactValue.unknown("no mtime"),
            width=FactValue.of(width) if width is not None else FactValue.unknown("unreadable"),
            height=FactValue.of(height) if height is not None else FactValue.unknown("unreadable"),
            media_kind="image",
        ),
        evidence=MemberEvidence(algorithm="sha256", confidence="high"),
    )


def _group(*members: GroupMember) -> DuplicateGroup:
    return DuplicateGroup(
        group_id="golden",
        kind="exact",
        catalog_generation=1,
        rule_version="golden",
        member_count=len(members),
        total_bytes=sum(member.facts.size_bytes for member in members),
        anchor_member_id=members[0].member_id,
        members=members,
        evidence_summary="golden vector",
    )


def _cases() -> list[tuple[str, KeeperPolicyId, DuplicateGroup, tuple[str, ...]]]:
    """Name, policy, group, preferred roots — one row per behaviour worth pinning."""
    measured = _group(
        _member("small", size=9_000, width=100, height=100),
        _member("big", size=1_000, width=400, height=400),
    )
    equal_pixels = _group(
        _member("light", size=1_000),
        _member("heavy", size=9_000),
    )
    mixed = _group(
        _member("unreadable", size=9_000, width=None, height=None),
        _member("readable", size=1_000, width=100, height=100),
    )
    undated = _group(
        _member("a", modified=None),
        _member("b", modified=None),
    )
    dated = _group(
        _member("older", modified=100),
        _member("newer", modified=900),
    )
    names = _group(
        _member("short", relative_path="a.jpg"),
        _member("long", relative_path="a-final-edit.jpg"),
    )
    roots = _group(
        _member("from-phone", root_id="phone"),
        _member("from-camera", root_id="camera"),
    )
    protected = _group(
        _member("mutable"),
        _member("reference", root_id="ref", role="reference"),
    )
    ties = _group(
        _member("b", relative_path="b.jpg"),
        _member("a", relative_path="a.jpg"),
    )
    # `smart` is the shipped default, and the only policy whose criteria can
    # actually separate byte-identical members. One case per rung of its ladder,
    # so a change to the order shows up as a changed artifact rather than as a
    # silently different keeper.
    copy_marked = _group(
        _member("copy", relative_path="IMG_0421 copy.jpg"),
        _member("original", relative_path="IMG_0421.jpg"),
    )
    counter_marked = _group(
        _member("counter", relative_path="IMG_0421 (1).jpg"),
        _member("original", relative_path="IMG_0421.jpg"),
    )
    buried = _group(
        _member("deep", relative_path="Photos/2019/old/backup/IMG_0421.jpg"),
        _member("shallow", relative_path="Photos/2019/IMG_0421.jpg"),
    )
    same_name_dated = _group(
        _member("newer", relative_path="Photos/IMG_0421.jpg", modified=900),
        _member("older", relative_path="Photos/IMG_0421.jpg", modified=100),
    )
    camera_names = _group(
        _member("second", relative_path="DSC_0002.jpg"),
        _member("first", relative_path="DSC_0001.jpg"),
    )
    # The case that caught a real mismatch: counting marks rather than returning
    # a boolean is what lets a doubly-marked name lose to a singly-marked one.
    both_marked = _group(
        _member("twice", relative_path="IMG_0421 copy (2).jpg"),
        _member("once", relative_path="IMG_0421 copy.jpg"),
    )
    # A leading dot is part of the name, not an extension. Python's `rpartition`
    # split collapsed such a name to the empty string and scored it unmarked,
    # while the TypeScript mirror read it in full and scored it marked — a
    # disagreement no case here reached.
    dot_leading_names = _group(
        _member("marked", relative_path=".IMG_0421 copy"),
        _member("plain", relative_path=".IMG_0421"),
    )

    return [
        ("smart keeps the name without a copy marker", "smart", copy_marked, ()),
        ("smart reads a parenthesised counter as a copy marker", "smart", counter_marked, ()),
        ("smart prefers the least deeply buried copy", "smart", buried, ()),
        ("smart falls to the oldest when name and depth tie", "smart", same_name_dated, ()),
        ("smart does not mistake a camera counter for a copy", "smart", camera_names, ()),
        ("smart prefers the less marked name when every copy is marked", "smart", both_marked, ()),
        ("smart reads a dot-leading name in full", "smart", dot_leading_names, ()),
        ("smart is total: identical names and depths still decide", "smart", ties, ()),
        ("best_quality prefers pixels over bytes", "best_quality", measured, ()),
        ("best_quality falls back to size between equal pixels", "best_quality", equal_pixels, ()),
        ("best_quality ranks a measured member above an unmeasured one", "best_quality", mixed, ()),
        ("largest wins on bytes", "largest", equal_pixels, ()),
        ("smallest is its mirror", "smallest", equal_pixels, ()),
        ("newest needs a modification time", "newest", undated, ()),
        ("newest picks the later one", "newest", dated, ()),
        ("oldest picks the earlier one", "oldest", dated, ()),
        (
            "highest_resolution decides when every member is measured",
            "highest_resolution",
            measured,
            (),
        ),
        ("highest_resolution refuses a partly measured set", "highest_resolution", mixed, ()),
        ("longest_filename counts the name, not the path", "longest_filename", names, ()),
        ("shortest_filename is its mirror", "shortest_filename", names, ()),
        ("preferred_root without a configured order decides nothing", "preferred_root", roots, ()),
        (
            "protected_reference is not a choice a policy makes",
            "protected_reference",
            protected,
            (),
        ),
        ("manual refuses by definition", "manual", ties, ()),
        ("identity is the last tie-break, so order never decides", "largest", ties, ()),
    ]


def vector_payload() -> dict[str, Any]:
    """The artifact, exactly as it is written to disk."""
    cases: list[dict[str, Any]] = []
    for name, policy, group, preferred_roots in _cases():
        result = apply_policy(
            group,
            PolicySettings(policy_id=policy, preferred_roots=preferred_roots, reference_wins=False),
        )
        cases.append(
            {
                "name": name,
                "policy": policy,
                "preferred_roots": list(preferred_roots),
                "group": group.model_dump(mode="json"),
                # `null` means "this policy declines to choose here", which both
                # implementations must agree on just as strongly as a keeper.
                "keeper": result.keeper_member_id,
                "outcome": result.outcome,
            }
        )
    covered = {case["policy"] for case in cases}
    missing = sorted(set(GOLDEN_POLICIES) - covered)
    if missing:  # pragma: no cover - guarded by a test
        raise AssertionError(f"golden vector covers no case for: {missing}")
    return {"version": 1, "policies": list(GOLDEN_POLICIES), "cases": cases}
