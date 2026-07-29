"""Choosing which copy to keep, the same way every time.

A policy that picks differently on a rerun is worse than no policy: it makes a
review the user already did meaningless. So every policy here sorts by its
criterion, then by documented tie-breakers, then by stable member identity —
which means the same group always produces the same keeper.

Two refusals matter more than the choices. An unknown fact is never treated as
the smallest value, so "keep the highest resolution" cannot discard the one copy
whose dimensions failed to read; that group goes to review instead. And nothing
here ever produces an action for a reference member.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Literal

from app.core.duplicate_plans import (
    Decision,
    DuplicateGroup,
    GroupMember,
    KeeperPolicyId,
)
from app.core.logging_config import get_logger

logger = get_logger(__name__)

PolicyOutcome = Literal["decided", "needs_review", "not_applicable"]


@dataclass(frozen=True)
class PolicySettings:
    """One configured policy, with everything it needs to be deterministic."""

    policy_id: KeeperPolicyId = "largest"
    #: Root ids in preference order, for `preferred_root`.
    preferred_roots: tuple[str, ...] = ()
    #: A protected reference in the group anchors the keeper, whatever else the
    #: policy would have chosen — it is the one copy that cannot be touched.
    reference_wins: bool = True


@dataclass(frozen=True)
class PolicyResult:
    """What a policy decided, and why a user should believe it."""

    outcome: PolicyOutcome
    keeper_member_id: str | None = None
    reason: str = ""
    decisions: tuple[Decision, ...] = ()

    @property
    def decided(self) -> bool:
        return self.outcome == "decided"


def _size(member: GroupMember) -> int:
    return member.facts.size_bytes


def _modified(member: GroupMember) -> int | None:
    value = member.facts.modified_at
    return int(value.value) if value.known and value.value is not None else None  # type: ignore[arg-type]


def _identity(member: GroupMember) -> str:
    """The final tie-break: stable, total, and independent of scan order."""
    return f"{member.root_id}:{member.relative_path}:{member.member_id}"


def apply_policy(
    group: DuplicateGroup,
    settings: PolicySettings,
) -> PolicyResult:
    """Pick a keeper for one exact group, or send it to review with a reason."""
    if group.kind != "exact":
        return PolicyResult("not_applicable", reason="policies apply to exact groups only")

    protected = [member for member in group.members if member.protected]
    mutable = list(group.mutable_members)
    if not mutable:
        return PolicyResult(
            "not_applicable",
            reason="every member is a protected reference, so there is nothing to act on",
        )

    if settings.reference_wins and protected:
        keeper = min(protected, key=_identity)
        return _result(
            group,
            keeper,
            settings,
            reason="a protected reference copy anchors this group",
        )

    chosen, refusal = _choose(mutable, settings)
    if chosen is None:
        return PolicyResult("needs_review", reason=refusal or "this policy could not decide")
    return _result(group, chosen, settings, reason=refusal or "")


def _choose(
    members: Sequence[GroupMember],
    settings: PolicySettings,
) -> tuple[GroupMember | None, str | None]:
    policy = settings.policy_id
    if policy == "manual":
        return None, "this group is set to manual review"

    if policy == "protected_reference":
        return None, "no protected reference is present in this group"

    if policy == "largest":
        # Ties fall through to newest, then to identity.
        ranked = sorted(members, key=lambda m: (-_size(m), -(_modified(m) or 0), _identity(m)))
        return ranked[0], f"largest copy ({ranked[0].facts.size_bytes} bytes)"

    if policy in {"newest", "oldest"}:
        dated = [member for member in members if _modified(member) is not None]
        if not dated:
            return None, "no member has a usable modification time"
        newest = policy == "newest"
        ranked = sorted(
            dated,
            key=lambda m: (
                -(_modified(m) or 0) if newest else (_modified(m) or 0),
                -_size(m),
                _identity(m),
            ),
        )
        return ranked[0], f"{policy} modification time"

    if policy == "highest_resolution":
        measured = [member for member in members if member.facts.pixels is not None]
        if not measured:
            return None, "no member has readable dimensions"
        if len(measured) != len(members):
            # Treating an unmeasured file as the smallest is how the only good
            # copy gets quarantined. The group goes to a person instead.
            return None, "at least one member's dimensions could not be read"
        ranked = sorted(
            measured,
            key=lambda m: (-(m.facts.pixels or 0), -_size(m), _identity(m)),
        )
        return ranked[0], "highest pixel count"

    if policy == "preferred_root":
        if not settings.preferred_roots:
            return None, "no root order has been configured"
        order = {root_id: index for index, root_id in enumerate(settings.preferred_roots)}
        ranked = sorted(
            members,
            key=lambda m: (order.get(m.root_id, len(order)), -_size(m), _identity(m)),
        )
        if order.get(ranked[0].root_id, len(order)) == len(order):
            return None, "no member is in a preferred root"
        return ranked[0], f"preferred root {ranked[0].root_id}"

    return None, f"unknown policy {policy!r}"  # pragma: no cover - Literal-guarded


def _result(
    group: DuplicateGroup,
    keeper: GroupMember,
    settings: PolicySettings,
    *,
    reason: str,
) -> PolicyResult:
    """Turn a keeper choice into decisions — for mutable members only."""
    decisions: list[Decision] = [
        Decision(
            member_id=keeper.member_id,
            action="keep",
            source="policy",
            policy_id=settings.policy_id,
            reason=reason,
        )
    ]
    for member in group.members:
        if member.member_id == keeper.member_id:
            continue
        if member.protected:
            # No decision is recorded at all: a reference member has nothing an
            # executor could be handed.
            continue
        decisions.append(
            Decision(
                member_id=member.member_id,
                action="quarantine",
                source="policy",
                policy_id=settings.policy_id,
                reason=f"duplicate of the kept copy ({reason})" if reason else "duplicate",
            )
        )
    return PolicyResult(
        "decided",
        keeper_member_id=keeper.member_id,
        reason=reason,
        decisions=tuple(decisions),
    )


# --------------------------------------------------------------------------- #
# Similar media                                                                #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class HighConfidenceRule:
    """The opt-in automatic rule for similar media. Off unless a user says so.

    It is versioned because consent is to *these* criteria: changing the
    threshold or the evidence scope invalidates the consent that was given.
    """

    enabled: bool = False
    version: str = "1"
    max_distance: int = 0
    require_same_dimensions: bool = True
    require_same_media_kind: bool = True
    consented_at: str | None = None

    @property
    def consented(self) -> bool:
        return self.enabled and self.consented_at is not None


@dataclass(frozen=True)
class SimilarProposal:
    """What the high-confidence rule would propose for one similar group."""

    group_id: str
    applies: bool
    representative_member_id: str | None = None
    quarantine_member_ids: tuple[str, ...] = ()
    reason: str = ""

    @property
    def affected_members(self) -> int:
        return len(self.quarantine_member_ids)


def propose_similar(group: DuplicateGroup, rule: HighConfidenceRule) -> SimilarProposal:
    """Propose quarantine for a similar group, only when it is unambiguous.

    Everything about this is conservative on purpose: the rule is disabled by
    default, it only ever proposes *quarantine* (never replacement, never
    deletion), and any ambiguity leaves the group for a person.
    """
    if group.kind != "similar":
        return SimilarProposal(group.group_id, False, reason="not a similar group")
    if not rule.consented:
        return SimilarProposal(
            group.group_id,
            False,
            reason="the high-confidence rule is off; this group waits for review",
        )

    mutable = list(group.mutable_members)
    if len(mutable) < 2:
        return SimilarProposal(group.group_id, False, reason="nothing mutable to act on")

    for member in group.members:
        distance = member.evidence.distance
        if member.evidence.confidence in {"low", "unknown"}:
            return SimilarProposal(
                group.group_id, False, reason="at least one match is not high confidence"
            )
        if distance is None or distance > rule.max_distance:
            return SimilarProposal(
                group.group_id, False, reason="a member is outside the configured distance"
            )

    if rule.require_same_media_kind and len({m.facts.media_kind for m in group.members}) != 1:
        return SimilarProposal(group.group_id, False, reason="the members are not the same kind")

    if rule.require_same_dimensions:
        pixels = {member.facts.pixels for member in group.members}
        if None in pixels or len(pixels) != 1:
            return SimilarProposal(
                group.group_id,
                False,
                reason="dimensions differ or could not be read for every member",
            )

    representative = _representative(group)
    quarantined = tuple(
        member.member_id for member in mutable if member.member_id != representative.member_id
    )
    return SimilarProposal(
        group.group_id,
        True,
        representative_member_id=representative.member_id,
        quarantine_member_ids=quarantined,
        reason=f"every member matched within {rule.max_distance} bits at high confidence",
    )


def _representative(group: DuplicateGroup) -> GroupMember:
    """The largest copy, tie-broken by identity — never an unknown fact."""
    protected = [member for member in group.members if member.protected]
    pool = protected or list(group.members)
    return sorted(pool, key=lambda m: (-_size(m), _identity(m)))[0]


def preview_rule(
    groups: Sequence[DuplicateGroup],
    rule: HighConfidenceRule,
) -> tuple[SimilarProposal, ...]:
    """What enabling the rule would affect, shown before consent is given."""
    consented = HighConfidenceRule(
        enabled=True,
        version=rule.version,
        max_distance=rule.max_distance,
        require_same_dimensions=rule.require_same_dimensions,
        require_same_media_kind=rule.require_same_media_kind,
        consented_at="preview",
    )
    return tuple(propose_similar(group, consented) for group in groups)
