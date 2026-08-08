"""Versioned contracts for duplicate review: evidence, decisions, and outcomes.

Three separations are load-bearing here and are enforced by the models rather
than by convention:

*Evidence is not action.* What the system measured about a file lives in
:class:`MemberEvidence`; what a user decided about it lives in
:class:`Decision`. Neither can be derived from the other, so a recomputed
signature never silently changes somebody's choice.

*Exact is not similar.* An exact group planning any quarantine has exactly one
canonical keeper. A similar group may keep several members and its
*representative* is a comparison anchor, not a retention decision.

*Reference is not input.* A reference member carries no action field that could
be populated. It cannot be handed to an executor because the type it would need
to be does not exist for it.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

DUPLICATE_PLAN_SCHEMA_VERSION: Literal[1] = 1

#: A burst is a third *kind* of stack, not a second concept: same members, same
#: decisions, same keeper policies. Only the evidence differs — a burst is
#: grouped by capture time and camera as well as by visual signature.
GroupKind = Literal["exact", "similar", "burst"]
RootRole = Literal["input", "reference", "destination"]

#: What a user may decide about one member. There is deliberately no
#: `permanently_delete`: normal duplicate execution never offers it, and the
#: separate cleanup task carries its own acknowledgement.
DecisionAction = Literal[
    "keep",
    "quarantine",
    "skip",
    "replace_keeper",
    "keep_additional",
]

#: What a decision actually becomes once role and Copy/Move mode are known.
OutcomeKind = Literal[
    "copy_to_destination",
    "move_to_destination",
    "quarantine",
    "skip",
    "no_action_reference",
    "blocked",
]

KeeperPolicyId = Literal[
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
]

#: The policies a person may choose, in Configure or as a per-run override in
#: Review. Exported from one place so the two cannot offer different sets.
#:
#: `protected_reference` is absent deliberately: it is automatic and always
#: wins, so offering it as a choice would imply it could be turned off.
#: `preferred_root` is absent because the root order it depended on is no longer
#: something the interface lets anyone set.
SELECTABLE_KEEPER_POLICIES: tuple[KeeperPolicyId, ...] = (
    "best_quality",
    "largest",
    "smallest",
    "newest",
    "oldest",
    "highest_resolution",
    "longest_filename",
    "shortest_filename",
    "manual",
)

BulkScopeId = Literal[
    "this_group",
    "selected_groups",
    "current_filtered_exact",
    "all_unresolved_exact",
]

ReviewState = Literal["unresolved", "reviewed", "stale", "executed"]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


class FactValue(BaseModel):
    """One media fact that is either known, or explicitly not.

    An unknown dimension is never rendered as zero. A fabricated zero would make
    "keep highest resolution" quietly discard the only good copy.
    """

    model_config = ConfigDict(frozen=True)

    known: bool = False
    value: JsonValue = None
    #: Why it is unknown — an extractor failure, an unsupported container, a
    #: file that could not be read.
    issue: str | None = None

    @classmethod
    def of(cls, value: JsonValue) -> FactValue:
        return cls(known=value is not None, value=value)

    @classmethod
    def unknown(cls, issue: str) -> FactValue:
        return cls(known=False, value=None, issue=issue)

    @model_validator(mode="after")
    def unknown_facts_carry_no_value(self) -> FactValue:
        if not self.known and self.value is not None:
            raise ValueError("an unknown fact cannot also carry a value")
        return self


class MemberFacts(BaseModel):
    """The normalized facts a person compares two copies by."""

    model_config = ConfigDict(frozen=True)

    size_bytes: int = Field(ge=0)
    modified_at: FactValue = Field(default_factory=FactValue)
    captured_at: FactValue = Field(default_factory=FactValue)
    width: FactValue = Field(default_factory=FactValue)
    height: FactValue = Field(default_factory=FactValue)
    duration_seconds: FactValue = Field(default_factory=FactValue)
    codec: FactValue = Field(default_factory=FactValue)
    media_kind: str = "unknown"

    @property
    def pixels(self) -> int | None:
        if not (self.width.known and self.height.known):
            return None
        try:
            return int(self.width.value or 0) * int(self.height.value or 0)  # type: ignore[arg-type]
        except (TypeError, ValueError):  # pragma: no cover - defensive
            return None


class MemberEvidence(BaseModel):
    """Why this member is in this group, and how much that is worth."""

    model_config = ConfigDict(frozen=True)

    algorithm: str = "sha256"
    algorithm_version: str = "1"
    sha256: str | None = None
    signature: str | None = None
    distance: int | None = Field(default=None, ge=0)
    threshold: int | None = Field(default=None, ge=0)
    #: `high` for verified identical bytes, `medium` for a signature well inside
    #: the threshold, `low` at its edge, `unknown` when extraction failed.
    confidence: Literal["high", "medium", "low", "unknown"] = "unknown"
    extraction_issues: tuple[str, ...] = ()


class GroupMember(BaseModel):
    """One file in a group, with everything needed to judge and act on it."""

    model_config = ConfigDict(frozen=True)

    member_id: str = Field(min_length=1, max_length=200)
    root_id: str = Field(min_length=1, max_length=128)
    role: RootRole
    relative_path: str = Field(min_length=1)
    observed_path: str = Field(min_length=1)
    facts: MemberFacts
    evidence: MemberEvidence

    @property
    def protected(self) -> bool:
        """Reference members are comparison-only, always, everywhere."""
        return self.role == "reference"

    @property
    def mutable(self) -> bool:
        return not self.protected


class DuplicateGroup(BaseModel):
    """A stable, catalog-backed group. Members are paged, never required whole."""

    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = DUPLICATE_PLAN_SCHEMA_VERSION
    group_id: str = Field(min_length=1, max_length=200)
    kind: GroupKind
    catalog_generation: int = Field(ge=0)
    rule_version: str = "1"
    member_count: int = Field(ge=2)
    total_bytes: int = Field(ge=0)
    #: The exact group's canonical keeper, or the similar group's comparison
    #: representative. They are different things and are never merged.
    anchor_member_id: str | None = None
    members: tuple[GroupMember, ...] = ()
    evidence_summary: str = ""

    @model_validator(mode="after")
    def anchor_belongs_to_the_group(self) -> DuplicateGroup:
        if self.anchor_member_id is None or not self.members:
            return self
        if all(member.member_id != self.anchor_member_id for member in self.members):
            raise ValueError("the anchor must be one of the loaded members")
        return self

    @property
    def mutable_members(self) -> tuple[GroupMember, ...]:
        return tuple(member for member in self.members if member.mutable)

    @property
    def has_protected_member(self) -> bool:
        return any(member.protected for member in self.members)


class Decision(BaseModel):
    """One recorded choice about one member. Never inferred from evidence."""

    model_config = ConfigDict(frozen=True)

    member_id: str = Field(min_length=1, max_length=200)
    action: DecisionAction
    #: `policy` decisions may be overwritten by a rerun; `user` decisions never are.
    source: Literal["policy", "user"] = "user"
    policy_id: KeeperPolicyId | None = None
    reason: str = ""
    decided_at: datetime = Field(default_factory=utc_now)


class ResolvedOutcome(BaseModel):
    """What a decision concretely does, once role and transfer mode are known."""

    model_config = ConfigDict(frozen=True)

    member_id: str
    kind: OutcomeKind
    expected_sha256: str | None = Field(default=None, pattern=r"^[0-9a-f]{64}$")
    destination_path: str | None = None
    quarantine_reason: str | None = None
    #: True when the action changes the *input* — which a Copy-mode user did not
    #: ask for by choosing Copy, so it needs its own acknowledgement.
    mutates_source: bool = False
    requires_acknowledgement: bool = False
    blocked_reason: str | None = None
    explanation: str = ""

    @model_validator(mode="after")
    def a_protected_member_can_only_be_left_alone(self) -> ResolvedOutcome:
        if self.kind == "no_action_reference" and self.mutates_source:
            raise ValueError("a reference member can never mutate a source")
        return self


class GroupPlan(BaseModel):
    """The stored review state of one group: decisions plus their resolution."""

    model_config = ConfigDict(frozen=True)

    group_id: str
    kind: GroupKind
    state: ReviewState = "unresolved"
    decisions: tuple[Decision, ...] = ()
    outcomes: tuple[ResolvedOutcome, ...] = ()
    keeper_member_id: str | None = None
    additional_keeps: tuple[str, ...] = ()
    stale_reason: str | None = None
    updated_at: datetime = Field(default_factory=utc_now)

    @model_validator(mode="after")
    def exact_groups_keep_exactly_one(self) -> GroupPlan:
        if self.kind != "exact":
            return self
        quarantining = any(outcome.kind == "quarantine" for outcome in self.outcomes)
        if quarantining and self.keeper_member_id is None:
            raise ValueError("an exact group that quarantines anything needs one keeper")
        if self.additional_keeps:
            raise ValueError("additional keeps are a similar-group concept")
        return self

    def decision_for(self, member_id: str) -> Decision | None:
        latest: Decision | None = None
        for decision in self.decisions:
            if decision.member_id == member_id:
                latest = decision
        return latest


class BulkImpact(BaseModel):
    """What a bulk command would do, computed against a frozen scope."""

    model_config = ConfigDict(frozen=True)

    scope: BulkScopeId
    #: The generation the preview was computed against. A changed filter or
    #: catalog generation invalidates it rather than applying to an unseen set.
    scope_generation: str = Field(min_length=1)
    matched_groups: int = Field(default=0, ge=0)
    matched_members: int = Field(default=0, ge=0)
    skipped_groups: int = Field(default=0, ge=0)
    skipped_reasons: tuple[str, ...] = ()
    source_mutations: int = Field(default=0, ge=0)
    quarantine_bytes: int = Field(default=0, ge=0)
    similar_groups_excluded: bool = True
    computed_at: datetime = Field(default_factory=utc_now)

    def matches(self, generation: str) -> bool:
        return self.scope_generation == generation


class DriftFinding(BaseModel):
    """One reason a stored decision may no longer be acted on."""

    model_config = ConfigDict(frozen=True)

    group_id: str
    member_id: str | None = None
    kind: Literal["identity", "content", "role", "facts", "rules", "path", "scope"]
    detail: str


class PlanSnapshot(BaseModel):
    """An immutable copy of a plan, taken at the moment execution is authorized.

    Later review edits create a new version; they cannot reach into work that is
    already running.
    """

    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = DUPLICATE_PLAN_SCHEMA_VERSION
    snapshot_id: str = Field(min_length=1, max_length=128)
    plan_id: str = Field(min_length=1, max_length=128)
    version: int = Field(ge=1)
    catalog_generation: int = Field(ge=0)
    rule_version: str = "1"
    transfer_mode: Literal["copy", "move"] = "copy"
    groups: tuple[GroupPlan, ...] = ()
    acknowledged_source_mutations: bool = False
    created_at: datetime = Field(default_factory=utc_now)

    @property
    def quarantine_count(self) -> int:
        return sum(
            1 for group in self.groups for outcome in group.outcomes if outcome.kind == "quarantine"
        )

    @property
    def requires_acknowledgement(self) -> bool:
        return any(
            outcome.requires_acknowledgement for group in self.groups for outcome in group.outcomes
        )

    @model_validator(mode="after")
    def acknowledged_when_required(self) -> PlanSnapshot:
        if self.requires_acknowledgement and not self.acknowledged_source_mutations:
            raise ValueError("this plan changes input files and needs an explicit acknowledgement")
        return self


class ValidationFinding(BaseModel):
    """One library problem a validator found, with what it is sure of."""

    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = DUPLICATE_PLAN_SCHEMA_VERSION
    finding_id: str = Field(min_length=1, max_length=200)
    category: Literal[
        "misplaced",
        "inconsistent_name",
        "exact_duplicate",
        "similar_media",
        "unreadable",
        "missing_sidecar",
        "catalog_stale",
    ]
    severity: Literal["info", "warning", "error"] = "warning"
    state: Literal["failed", "passed", "disabled", "not_evaluated", "unknown"] = "failed"
    root_id: str | None = None
    relative_path: str | None = None
    current_path: str | None = None
    expected_path: str | None = None
    evidence: str = ""
    confidence: Literal["high", "medium", "low", "unknown"] = "medium"
    rule_version: str = "1"
    catalog_generation: int = Field(default=0, ge=0)
    #: True when this finding can be turned into an ordinary review action.
    actionable: bool = False


class ValidationReport(BaseModel):
    """A validation run, including honestly what it did not look at."""

    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = DUPLICATE_PLAN_SCHEMA_VERSION
    report_id: str = Field(min_length=1, max_length=128)
    profile_id: str
    catalog_generation: int = Field(ge=0)
    started_at: datetime
    finished_at: datetime
    findings: tuple[ValidationFinding, ...] = ()
    #: Roots or subtrees that could not be read. Their presence is why a report
    #: may never certify a whole library.
    unreachable_scopes: tuple[str, ...] = ()
    disabled_categories: tuple[str, ...] = ()

    @property
    def partial(self) -> bool:
        return bool(self.unreachable_scopes)

    @property
    def certifies_whole_library(self) -> bool:
        return not self.partial

    def by_category(self, category: str) -> tuple[ValidationFinding, ...]:
        return tuple(item for item in self.findings if item.category == category)
