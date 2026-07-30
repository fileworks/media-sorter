"""The durable review plan: decisions in, concrete outcomes out.

A plan holds what the user decided, never what the system measured. Resolution
turns those decisions into outcomes that name a real destination and admit when
they change an input file. Drift detection then re-checks the world before any
of it runs, and an execution snapshot freezes the result so a later edit creates
a new version instead of reaching into work already in flight.

Two invariants are enforced here rather than trusted:

* a reference member never receives an action, at any layer, however the request
  was constructed;
* an exact group that quarantines anything has exactly one canonical keeper.
"""

from __future__ import annotations

import json
import uuid
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from app.core.duplicate_plans import (
    BulkImpact,
    BulkScopeId,
    Decision,
    DecisionAction,
    DriftFinding,
    DuplicateGroup,
    GroupMember,
    GroupPlan,
    PlanSnapshot,
    ResolvedOutcome,
    utc_now,
)
from app.core.logging_config import get_logger

logger = get_logger(__name__)

PLANS_DIRECTORY_NAME = "review-plans"
TransferMode = Literal["copy", "move"]


#: A callable that applies one policy to one group, returning whether it decided.
PolicyApplier = Callable[["ReviewPlan", DuplicateGroup], bool]


class PlanError(RuntimeError):
    """A plan edit or execution request was refused."""


class ReferenceImmutableError(PlanError):
    """Something tried to give a comparison-only member an action."""


# --------------------------------------------------------------------------- #
# Editing                                                                      #
# --------------------------------------------------------------------------- #


@dataclass
class ReviewPlan:
    """One profile's review state, editable and persistable."""

    plan_id: str
    catalog_generation: int = 0
    rule_version: str = "1"
    transfer_mode: TransferMode = "copy"
    version: int = 1
    groups: dict[str, GroupPlan] = field(default_factory=dict)
    #: The groups themselves, kept beside their plans so resolution and drift
    #: checks never have to guess what a member was.
    known_groups: dict[str, DuplicateGroup] = field(default_factory=dict)

    # -------------------------------------------------------------- #
    # Registration                                                    #
    # -------------------------------------------------------------- #

    def register(self, group: DuplicateGroup) -> GroupPlan:
        """Track a group, keeping any decisions already made about it."""
        self.known_groups[group.group_id] = group
        existing = self.groups.get(group.group_id)
        if existing is None:
            plan = GroupPlan(group_id=group.group_id, kind=group.kind)
            self.groups[group.group_id] = plan
            return plan
        return existing

    def group(self, group_id: str) -> DuplicateGroup:
        try:
            return self.known_groups[group_id]
        except KeyError:
            raise PlanError(f"Unknown group: {group_id!r}") from None

    def _member(self, group: DuplicateGroup, member_id: str) -> GroupMember:
        for member in group.members:
            if member.member_id == member_id:
                return member
        raise PlanError(f"{member_id!r} is not a member of {group.group_id!r}")

    # -------------------------------------------------------------- #
    # Commands                                                        #
    # -------------------------------------------------------------- #

    def decide(
        self,
        group_id: str,
        member_id: str,
        action: DecisionAction,
        *,
        source: Literal["policy", "user"] = "user",
        reason: str = "",
    ) -> GroupPlan:
        """Record one decision, refusing anything a reference member cannot have.

        This is the choke point every edit path goes through — including the API
        — so a handcrafted request cannot route around it.
        """
        group = self.group(group_id)
        member = self._member(group, member_id)
        if member.protected and action != "keep":
            raise ReferenceImmutableError("Reference folders are compared against, never changed.")
        if group.kind == "exact" and action == "keep_additional":
            raise PlanError("additional keeps are a similar-group concept")
        if group.kind == "similar" and action == "replace_keeper":
            raise PlanError("similar groups choose a representative, not a keeper")

        plan = self.groups.get(group_id) or self.register(group)
        decisions = tuple(item for item in plan.decisions if item.member_id != member_id) + (
            Decision(member_id=member_id, action=action, source=source, reason=reason),
        )

        keeper = plan.keeper_member_id
        additional = list(plan.additional_keeps)
        if action in {"keep", "replace_keeper"} and group.kind == "exact":
            keeper = member_id
            # Replacing the keeper recalculates the rest of the group: whatever
            # the previous keeper was, it is now an ordinary member again.
            decisions = _recalculated(decisions, group, keeper)
        elif action == "keep" and group.kind == "similar" or action == "keep_additional":
            if member_id not in additional:
                additional.append(member_id)
        elif action in {"quarantine", "skip"}:
            if member_id in additional:
                additional.remove(member_id)
            if keeper == member_id:
                keeper = None

        updated = GroupPlan(
            group_id=group_id,
            kind=group.kind,
            state="reviewed",
            decisions=decisions,
            outcomes=(),
            keeper_member_id=keeper,
            additional_keeps=tuple(additional) if group.kind == "similar" else (),
            updated_at=utc_now(),
        )
        self.groups[group_id] = self.resolve(updated)
        return self.groups[group_id]

    def quarantine_all_except(self, group_id: str, keep_member_ids: Sequence[str]) -> GroupPlan:
        """The explicit all-except command, previewed before it is applied.

        Protected references are never included, and every selected keep is
        retained — that is what makes this safe to offer at all.
        """
        group = self.group(group_id)
        keeps = set(keep_member_ids)
        for member in group.members:
            if member.protected:
                continue
            action: DecisionAction = "keep" if member.member_id in keeps else "quarantine"
            self.decide(group_id, member.member_id, action, reason="quarantine all except selected")
        return self.groups[group_id]

    def undo_last(self, group_id: str) -> GroupPlan:
        """Drop the most recent decision in a group and re-resolve."""
        plan = self.groups.get(group_id)
        if plan is None or not plan.decisions:
            raise PlanError("there is nothing to undo in this group")
        remaining = plan.decisions[:-1]
        rebuilt = GroupPlan(
            group_id=group_id,
            kind=plan.kind,
            state="reviewed" if remaining else "unresolved",
            decisions=remaining,
            keeper_member_id=_keeper_from(remaining, self.group(group_id)),
            additional_keeps=plan.additional_keeps if plan.kind == "similar" else (),
        )
        self.groups[group_id] = self.resolve(rebuilt)
        return self.groups[group_id]

    # -------------------------------------------------------------- #
    # Resolution                                                      #
    # -------------------------------------------------------------- #

    def resolve(self, plan: GroupPlan, *, destination_root: Path | None = None) -> GroupPlan:
        """Turn decisions into concrete, role- and mode-aware outcomes."""
        group = self.group(plan.group_id)
        outcomes: list[ResolvedOutcome] = []
        for member in group.members:
            decision = plan.decision_for(member.member_id)
            outcomes.append(
                _outcome_for(
                    member,
                    decision,
                    transfer_mode=self.transfer_mode,
                    is_keeper=member.member_id == plan.keeper_member_id,
                    destination_root=destination_root,
                )
            )
        return GroupPlan(
            group_id=plan.group_id,
            kind=plan.kind,
            state=plan.state,
            decisions=plan.decisions,
            outcomes=tuple(outcomes),
            keeper_member_id=plan.keeper_member_id,
            additional_keeps=plan.additional_keeps,
            stale_reason=plan.stale_reason,
            updated_at=plan.updated_at,
        )

    # -------------------------------------------------------------- #
    # Bulk                                                            #
    # -------------------------------------------------------------- #

    def scope_generation(self, filter_key: str = "") -> str:
        """Identity of the current result scope, for freezing a bulk preview."""
        return f"{self.catalog_generation}:{self.rule_version}:{self.version}:{filter_key}"

    def preview_bulk(
        self,
        scope: BulkScopeId,
        *,
        group_ids: Sequence[str] = (),
        filter_key: str = "",
    ) -> BulkImpact:
        """Compute what a bulk command would touch, without touching anything."""
        candidates = self._scope_groups(scope, group_ids)
        matched_groups = 0
        matched_members = 0
        skipped: list[str] = []
        source_mutations = 0
        quarantine_bytes = 0

        for group in candidates:
            if group.kind != "exact":
                skipped.append(f"{group.group_id}: similar groups are excluded from exact policies")
                continue
            mutable = group.mutable_members
            if len(mutable) < 2 and not group.has_protected_member:
                skipped.append(f"{group.group_id}: nothing to act on")
                continue
            matched_groups += 1
            # Everything except the eventual keeper is a candidate for quarantine.
            for member in mutable[1:]:
                matched_members += 1
                quarantine_bytes += member.facts.size_bytes
                if member.role == "input" and self.transfer_mode == "copy":
                    source_mutations += 1

        return BulkImpact(
            scope=scope,
            scope_generation=self.scope_generation(filter_key),
            matched_groups=matched_groups,
            matched_members=matched_members,
            skipped_groups=len(skipped),
            skipped_reasons=tuple(skipped),
            source_mutations=source_mutations,
            quarantine_bytes=quarantine_bytes,
        )

    def apply_bulk(
        self,
        impact: BulkImpact,
        policy_apply: PolicyApplier,
        *,
        group_ids: Sequence[str] = (),
        filter_key: str = "",
    ) -> int:
        """Apply a previewed bulk command, refusing a scope that has moved."""
        if not impact.matches(self.scope_generation(filter_key)):
            raise PlanError("the result scope changed since this preview; review the impact again")
        applied = 0
        for group in self._scope_groups(impact.scope, group_ids):
            if group.kind != "exact":
                continue
            if policy_apply(self, group):
                applied += 1
        return applied

    def _scope_groups(
        self,
        scope: BulkScopeId,
        group_ids: Sequence[str],
    ) -> list[DuplicateGroup]:
        if scope == "this_group" or scope == "selected_groups":
            return [self.group(group_id) for group_id in group_ids]
        if scope == "current_filtered_exact":
            return [
                group
                for group_id, group in self.known_groups.items()
                if group.kind == "exact" and (not group_ids or group_id in set(group_ids))
            ]
        return [
            group
            for group_id, group in self.known_groups.items()
            if group.kind == "exact"
            and self.groups.get(group_id, GroupPlan(group_id=group_id, kind="exact")).state
            == "unresolved"
        ]

    # -------------------------------------------------------------- #
    # Drift and snapshots                                             #
    # -------------------------------------------------------------- #

    def detect_drift(self, current: Iterable[DuplicateGroup]) -> tuple[DriftFinding, ...]:
        """Compare stored groups with what the catalog says now."""
        findings: list[DriftFinding] = []
        by_id = {group.group_id: group for group in current}
        for group_id, stored in self.known_groups.items():
            fresh = by_id.get(group_id)
            if fresh is None:
                findings.append(
                    DriftFinding(
                        group_id=group_id,
                        kind="identity",
                        detail="this group no longer exists in the current results",
                    )
                )
                continue
            if fresh.rule_version != stored.rule_version:
                findings.append(
                    DriftFinding(
                        group_id=group_id,
                        kind="rules",
                        detail="the detection rules changed since this was reviewed",
                    )
                )
            stored_members = {member.member_id: member for member in stored.members}
            fresh_members = {member.member_id: member for member in fresh.members}
            for member_id, before in stored_members.items():
                after = fresh_members.get(member_id)
                if after is None:
                    findings.append(
                        DriftFinding(
                            group_id=group_id,
                            member_id=member_id,
                            kind="identity",
                            detail="this file is no longer part of the group",
                        )
                    )
                    continue
                if before.evidence.sha256 != after.evidence.sha256:
                    findings.append(
                        DriftFinding(
                            group_id=group_id,
                            member_id=member_id,
                            kind="content",
                            detail="the file's content changed after it was reviewed",
                        )
                    )
                if before.role != after.role:
                    findings.append(
                        DriftFinding(
                            group_id=group_id,
                            member_id=member_id,
                            kind="role",
                            detail="the folder's role changed after it was reviewed",
                        )
                    )
                if before.relative_path != after.relative_path:
                    findings.append(
                        DriftFinding(
                            group_id=group_id,
                            member_id=member_id,
                            kind="path",
                            detail="the file moved after it was reviewed",
                        )
                    )
                if before.facts.size_bytes != after.facts.size_bytes:
                    findings.append(
                        DriftFinding(
                            group_id=group_id,
                            member_id=member_id,
                            kind="facts",
                            detail="the file's size changed after it was reviewed",
                        )
                    )
        return tuple(findings)

    def mark_stale(self, findings: Sequence[DriftFinding]) -> set[str]:
        """Send every drifted group back to review. Nothing in them may run."""
        affected: set[str] = set()
        for finding in findings:
            plan = self.groups.get(finding.group_id)
            if plan is None:
                continue
            affected.add(finding.group_id)
            self.groups[finding.group_id] = GroupPlan(
                group_id=plan.group_id,
                kind=plan.kind,
                state="stale",
                decisions=plan.decisions,
                outcomes=plan.outcomes,
                keeper_member_id=plan.keeper_member_id,
                additional_keeps=plan.additional_keeps,
                stale_reason=finding.detail,
            )
        return affected

    def snapshot(self, *, acknowledge_source_mutations: bool = False) -> PlanSnapshot:
        """Freeze the executable part of the plan. Stale groups are excluded."""
        executable = tuple(
            plan for plan in self.groups.values() if plan.state == "reviewed" and plan.outcomes
        )
        self.version += 1
        return PlanSnapshot(
            snapshot_id=f"snap_{uuid.uuid4().hex[:16]}",
            plan_id=self.plan_id,
            version=self.version,
            catalog_generation=self.catalog_generation,
            rule_version=self.rule_version,
            transfer_mode=self.transfer_mode,
            groups=executable,
            acknowledged_source_mutations=acknowledge_source_mutations,
        )

    # -------------------------------------------------------------- #
    # Persistence                                                     #
    # -------------------------------------------------------------- #

    def save(self, directory: Path) -> Path:
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / f"{self.plan_id}.json"
        payload = {
            "plan_id": self.plan_id,
            "catalog_generation": self.catalog_generation,
            "rule_version": self.rule_version,
            "transfer_mode": self.transfer_mode,
            "version": self.version,
            "groups": {key: plan.model_dump(mode="json") for key, plan in self.groups.items()},
            "known_groups": {
                key: group.model_dump(mode="json") for key, group in self.known_groups.items()
            },
        }
        path.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        return path

    @classmethod
    def load(cls, path: Path) -> ReviewPlan:
        payload = json.loads(path.read_text(encoding="utf-8"))
        plan = cls(
            plan_id=str(payload["plan_id"]),
            catalog_generation=int(payload.get("catalog_generation", 0)),
            rule_version=str(payload.get("rule_version", "1")),
            transfer_mode=payload.get("transfer_mode", "copy"),
            version=int(payload.get("version", 1)),
        )
        plan.known_groups = {
            key: DuplicateGroup.model_validate(value)
            for key, value in payload.get("known_groups", {}).items()
        }
        plan.groups = {
            key: GroupPlan.model_validate(value) for key, value in payload.get("groups", {}).items()
        }
        return plan


# --------------------------------------------------------------------------- #
# Helpers                                                                      #
# --------------------------------------------------------------------------- #


def _recalculated(
    decisions: Sequence[Decision],
    group: DuplicateGroup,
    keeper_id: str,
) -> tuple[Decision, ...]:
    """After a keeper change, no other member may still be marked kept."""
    rebuilt: list[Decision] = []
    for decision in decisions:
        if decision.member_id == keeper_id or decision.action != "keep":
            rebuilt.append(decision)
            continue
        member = next((m for m in group.members if m.member_id == decision.member_id), None)
        if member is None or member.protected:
            rebuilt.append(decision)
            continue
        rebuilt.append(
            Decision(
                member_id=decision.member_id,
                action="quarantine",
                source=decision.source,
                reason="recalculated after the keeper was replaced",
            )
        )
    return tuple(rebuilt)


def _keeper_from(decisions: Sequence[Decision], group: DuplicateGroup) -> str | None:
    for decision in reversed(decisions):
        if decision.action in {"keep", "replace_keeper"} and group.kind == "exact":
            return decision.member_id
    return None


def _outcome_for(
    member: GroupMember,
    decision: Decision | None,
    *,
    transfer_mode: TransferMode,
    is_keeper: bool,
    destination_root: Path | None,
) -> ResolvedOutcome:
    """The one place a decision becomes something the executor could perform."""
    expected_sha256 = member.evidence.sha256
    if member.protected:
        return ResolvedOutcome(
            member_id=member.member_id,
            kind="no_action_reference",
            expected_sha256=expected_sha256,
            explanation="Reference folders are compared against, never changed.",
        )
    if decision is None or decision.action == "skip":
        return ResolvedOutcome(
            member_id=member.member_id,
            kind="skip",
            expected_sha256=expected_sha256,
            explanation="Left where it is; nothing will touch this file.",
        )
    if decision.action == "quarantine":
        # Under Copy the user asked for their input to be left alone, so a
        # quarantine of an input file is a change they did not implicitly agree
        # to. It runs only with its own acknowledgement.
        mutates = member.role == "input" and transfer_mode == "copy"
        return ResolvedOutcome(
            member_id=member.member_id,
            kind="quarantine",
            expected_sha256=expected_sha256,
            quarantine_reason="duplicate",
            mutates_source=mutates,
            requires_acknowledgement=mutates,
            explanation=(
                "Moved to quarantine — recoverable, never deleted."
                + (" This changes your input folder." if mutates else "")
            ),
        )
    # keep / replace_keeper / keep_additional
    if member.role == "destination":
        return ResolvedOutcome(
            member_id=member.member_id,
            kind="skip",
            expected_sha256=expected_sha256,
            explanation="Already in the destination; it stays exactly where it is.",
        )
    destination = (
        str(destination_root / member.relative_path) if destination_root is not None else None
    )
    if transfer_mode == "copy":
        return ResolvedOutcome(
            member_id=member.member_id,
            kind="copy_to_destination",
            expected_sha256=expected_sha256,
            destination_path=destination,
            explanation="Copied to the destination and kept where it is now.",
        )
    return ResolvedOutcome(
        member_id=member.member_id,
        kind="move_to_destination",
        expected_sha256=expected_sha256,
        destination_path=destination,
        mutates_source=True,
        explanation="Moved to the destination after the copy is verified.",
    )


def executable_members(snapshot: PlanSnapshot) -> tuple[tuple[str, ResolvedOutcome], ...]:
    """Every action an executor may perform, with its group — references excluded.

    This is the last gate before the filesystem. Even if a decision for a
    reference member somehow existed, it could not appear here: only outcomes
    that name a mutating kind are returned.
    """
    actionable = {"copy_to_destination", "move_to_destination", "quarantine"}
    return tuple(
        (group.group_id, outcome)
        for group in snapshot.groups
        for outcome in group.outcomes
        if outcome.kind in actionable
    )
