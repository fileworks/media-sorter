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

import re
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

#: Sorts after every real timestamp, so a member whose modification time could
#: not be read loses the "oldest" comparison instead of winning it by being
#: treated as zero. An unknown fact must never look like the best fact.
_UNDATED = float("inf")


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


def _filename(member: GroupMember) -> str:
    return member.relative_path.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]


def _identity(member: GroupMember) -> str:
    """The final tie-break: stable, total, and independent of scan order."""
    return f"{member.root_id}:{member.relative_path}:{member.member_id}"


#: Suffixes and prefixes the desktop, phone and file managers add when they
#: write a second copy of a file that already exists. Matched against the stem
#: (the filename without its extension), lower-cased. Ordered longest-first so
#: " - copy (2)" is recognised before " - copy".
_COPY_MARKERS: tuple[str, ...] = (
    " - copy",
    " - kopie",
    " copy",
    " kopie",
    "-copy",
    "_copy",
    " (copy)",
    " (kopie)",
)

_COPY_PREFIXES: tuple[str, ...] = ("copy of ", "kopie von ", "duplicate of ")

#: A *bracketed* trailing counter — "IMG_0421 (1)", "IMG_0421 [2]". Brackets are
#: required: a bare trailing number is how cameras name files, so counting
#: "DSC_0002" as a copy of "DSC_0001" would treat half a memory card as
#: duplicates. Anchored with a non-digit lookbehind so "0421" is not read as the
#: counter "421".
_BRACKETED_COUNTER = re.compile(r"[ _-]*[(\[]\d{1,3}[)\]]$")

#: A counter attached to the copy word itself — "IMG_0421 copy 2". Here the
#: number is unambiguous, because a copy marker precedes it.
_COPY_COUNTER = re.compile(r"(?:copy|kopie)[ _-]*\d{1,3}$")


def _stem(member: GroupMember) -> str:
    name = _filename(member)
    head, dot, _ = name.rpartition(".")
    return (head if dot else name).lower()


def _copy_marks(member: GroupMember) -> int:
    """How many signs there are that this name was machine-generated.

    Byte-identical copies are indistinguishable by content, so the *name* is the
    best evidence of which one a person made and which one a file manager did.
    "IMG_0421.jpg" is the original; "IMG_0421 copy 2.jpg" is not. Counting marks
    rather than returning a boolean lets a doubly-marked name lose to a singly
    marked one, which is the right order when every candidate is a copy.
    """
    stem = _stem(member).rstrip()
    marks = 0
    if any(stem.startswith(prefix) for prefix in _COPY_PREFIXES):
        marks += 1
    if any(marker in stem for marker in _COPY_MARKERS):
        marks += 1
    # Both counter forms are read from the *original* stem rather than from a
    # partially stripped one, so the result cannot depend on which marker
    # happened to be removed first.
    if _BRACKETED_COUNTER.search(stem):
        marks += 1
    if _COPY_COUNTER.search(stem):
        marks += 1
    return marks


def _depth(member: GroupMember) -> int:
    """How deeply buried the copy is.

    A file sitting in `Photos/2019/` is more likely the one a person keeps than
    the same bytes under `Photos/2019/old/backup-2021/`. Depth is a weaker
    signal than the filename, so it is compared after it.
    """
    return member.relative_path.replace("\\", "/").count("/")


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

    if policy == "smart":
        # Every member of an exact group is byte-identical, so no criterion about
        # the *content* can separate them — "keep the best quality" is a tie by
        # construction, and falling through to an identity string means the copy
        # that survives is chosen by luck. What actually differs between two
        # identical files is where they live and what they are called, so that is
        # what this ranks:
        #
        #   1. fewest copy marks in the name  (IMG_0421 beats IMG_0421 copy 2)
        #   2. shallowest path                (a library folder beats a backup)
        #   3. oldest modification time       (the original predates the copy)
        #   4. largest, then identity         (total and stable)
        #
        # Nothing here needs configuring, which is the point: the common case
        # should not require a person to have an opinion about keeper policies.
        ranked = sorted(
            members,
            key=lambda m: (
                _copy_marks(m),
                _depth(m),
                _modified(m) if _modified(m) is not None else _UNDATED,
                -_size(m),
                _identity(m),
            ),
        )
        keeper = ranked[0]
        return keeper, _smart_reason(keeper, members)

    if policy == "best_quality":
        # The default, and the one most people mean by "keep the good one":
        # most pixels, then most bytes. Unlike `highest_resolution` it does not
        # refuse a group whose dimensions could not all be read — it falls back
        # to size for those, because a photo library is full of files whose
        # dimensions no library can parse, and refusing them all would leave the
        # common case undecided.
        ranked = sorted(
            members,
            key=lambda m: (-(m.facts.pixels or 0), -_size(m), -(_modified(m) or 0), _identity(m)),
        )
        # The ranking above is the decision; what changes here is only whether
        # the reason admits how much of it pixels actually decided. Claiming
        # "most pixels" for a group where none were readable is the silent half
        # of a silent degradation.
        measured_count = sum(1 for member in members if member.facts.pixels is not None)
        if measured_count == 0:
            return ranked[0], "no member's dimensions could be read; decided by size"
        if measured_count != len(members):
            return ranked[0], (
                f"best quality (most pixels, then largest); "
                f"{len(members) - measured_count} of {len(members)} had unreadable dimensions"
            )
        return ranked[0], "best quality (most pixels, then largest)"

    if policy in {"longest_filename", "shortest_filename"}:
        # "IMG_0421 final edit.jpg" over "IMG_0421.jpg", or the reverse for
        # somebody whose exports gained " (1)" suffixes. Length is compared
        # before identity so the result cannot depend on scan order.
        longest = policy == "longest_filename"
        ranked = sorted(
            members,
            key=lambda m: (
                -len(_filename(m)) if longest else len(_filename(m)),
                -_size(m),
                _identity(m),
            ),
        )
        return ranked[0], f"{'longest' if longest else 'shortest'} filename"

    if policy == "largest":
        # Ties fall through to newest, then to identity.
        ranked = sorted(members, key=lambda m: (-_size(m), -(_modified(m) or 0), _identity(m)))
        return ranked[0], f"largest copy ({ranked[0].facts.size_bytes} bytes)"

    if policy == "smallest":
        # For someone reclaiming space from re-saves of the same shot, the
        # smallest copy is the wanted one. Ties resolve the same way as
        # `largest` — newest first, then identity — so the two are mirror
        # images rather than two differently-behaved policies.
        ranked = sorted(members, key=lambda m: (_size(m), -(_modified(m) or 0), _identity(m)))
        return ranked[0], f"smallest copy ({ranked[0].facts.size_bytes} bytes)"

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
    elif any(member.facts.pixels is None for member in group.members):
        # With the same-dimensions requirement relaxed, resolution is what picks
        # the copy to keep — so a member whose dimensions could not be read is
        # not a member this rule can rank. Treating it as zero pixels is how the
        # only good copy gets proposed for quarantine, so the group goes to a
        # person instead, exactly as `highest_resolution` refuses an exact group
        # it cannot fully measure.
        return SimilarProposal(
            group.group_id,
            False,
            reason="a member's dimensions could not be read, and resolution decides here",
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
        reason=(
            f"every member matched within {rule.max_distance} bits at high confidence; "
            "kept the highest resolution"
        ),
    )


def _representative(group: DuplicateGroup) -> GroupMember:
    """The copy worth keeping out of a *similar* group.

    This is the one place a resolution criterion can genuinely decide something.
    Members of an exact group are byte-identical, so `highest_resolution` and
    `best_quality` tie there by construction; members of a similar group are the
    same picture at different sizes, which is exactly the case those names
    describe. So the ranking is most pixels, then most bytes, then identity.

    Callers guarantee every member has readable dimensions before they get here
    (see `propose_similar`), so no unknown pixel count is ever compared as zero.
    """
    protected = [member for member in group.members if member.protected]
    pool = protected or list(group.members)
    return sorted(pool, key=lambda m: (-(m.facts.pixels or 0), -_size(m), _identity(m)))[0]


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


def _smart_reason(keeper: GroupMember, members: Sequence[GroupMember]) -> str:
    """Say which of the smart criteria actually decided, not just that one did.

    A reason that always reads the same teaches a user nothing about why this
    copy survived, and makes a wrong choice impossible to argue with.
    """
    others = [m for m in members if m.member_id != keeper.member_id]
    if not others:
        return "the only copy that could be kept"
    if all(_copy_marks(keeper) < _copy_marks(m) for m in others):
        return "its name has no copy marker, so it looks like the original"
    if all(_depth(keeper) < _depth(m) for m in others):
        return "it is the least deeply buried copy"
    keeper_time = _modified(keeper)
    if keeper_time is not None and all(
        (other_time := _modified(m)) is None or keeper_time < other_time for m in others
    ):
        return "it is the oldest copy, so it predates the others"
    return "every copy is identical; kept the first by a stable, repeatable order"
