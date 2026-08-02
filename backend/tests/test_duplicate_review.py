"""Grouping, keeper policies, and review plans.

The deterministic fixtures below are the contract: references, multiple inputs,
destination members, missing facts, ties, drift, huge groups, and conflicting
paths all appear here, because each one is a way a duplicate review can quietly
destroy the wrong copy.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.duplicate_plans import (
    Decision,
    DuplicateGroup,
    FactValue,
    GroupMember,
    GroupPlan,
    MemberEvidence,
    MemberFacts,
    PlanSnapshot,
    ResolvedOutcome,
)
from app.services.keeper_policies import (
    HighConfidenceRule,
    PolicySettings,
    apply_policy,
    preview_rule,
    propose_similar,
)
from app.services.review_plan import (
    PlanError,
    ReferenceImmutableError,
    ReviewPlan,
    executable_members,
)


def member(
    member_id: str,
    *,
    role: str = "input",
    root_id: str = "input-a",
    size: int = 1_000,
    mtime: int | None = 1_000,
    width: int | None = 100,
    height: int | None = 100,
    kind: str = "image",
    sha256: str | None = "a" * 64,
    distance: int | None = None,
    confidence: str = "high",
    path: str | None = None,
) -> GroupMember:
    return GroupMember(
        member_id=member_id,
        root_id=root_id,
        role=role,  # type: ignore[arg-type]
        relative_path=path or f"{member_id}.jpg",
        observed_path=f"/{root_id}/{path or member_id}.jpg",
        facts=MemberFacts(
            size_bytes=size,
            modified_at=FactValue.of(mtime) if mtime is not None else FactValue.unknown("no mtime"),
            width=FactValue.of(width) if width is not None else FactValue.unknown("unreadable"),
            height=FactValue.of(height) if height is not None else FactValue.unknown("unreadable"),
            media_kind=kind,
        ),
        evidence=MemberEvidence(
            sha256=sha256,
            distance=distance,
            threshold=4 if distance is not None else None,
            confidence=confidence,  # type: ignore[arg-type]
        ),
    )


def group(*members: GroupMember, kind: str = "exact", group_id: str = "g1") -> DuplicateGroup:
    return DuplicateGroup(
        group_id=group_id,
        kind=kind,  # type: ignore[arg-type]
        catalog_generation=1,
        member_count=len(members),
        total_bytes=sum(item.facts.size_bytes for item in members),
        members=members,
    )


def _plan(*members: GroupMember, kind: str = "exact", mode: str = "copy") -> ReviewPlan:
    plan = ReviewPlan(plan_id="plan-1", transfer_mode=mode)  # type: ignore[arg-type]
    plan.register(group(*members, kind=kind))
    return plan


class TestFacts:
    def test_an_unknown_fact_is_never_a_zero(self) -> None:
        facts = MemberFacts(size_bytes=10, width=FactValue.unknown("unreadable"))

        assert facts.width.known is False
        assert facts.width.value is None
        assert facts.pixels is None

    def test_an_unknown_fact_cannot_smuggle_a_value(self) -> None:
        with pytest.raises(ValueError):
            FactValue(known=False, value=42)


class TestKeeperPolicies:
    def test_largest_wins_and_ties_break_deterministically(self) -> None:
        first = group(
            member("a", size=500), member("b", size=500), member("c", size=100), group_id="g"
        )
        second = group(
            member("c", size=100), member("b", size=500), member("a", size=500), group_id="g"
        )

        assert (
            apply_policy(first, PolicySettings("largest")).keeper_member_id
            == apply_policy(second, PolicySettings("largest")).keeper_member_id
        )

    def test_smallest_is_the_mirror_of_largest(self) -> None:
        candidates = group(member("a", size=500), member("b", size=100), member("c", size=900))

        assert apply_policy(candidates, PolicySettings("smallest")).keeper_member_id == "b"
        assert apply_policy(candidates, PolicySettings("largest")).keeper_member_id == "c"

    def test_smallest_breaks_ties_the_same_way_largest_does(self) -> None:
        first = group(
            member("a", size=100, mtime=900),
            member("b", size=100, mtime=100),
            member("c", size=500),
            group_id="g",
        )
        second = group(
            member("c", size=500),
            member("b", size=100, mtime=100),
            member("a", size=100, mtime=900),
            group_id="g",
        )

        # Same members, different order, same answer — and the newer of the two
        # tied copies wins, exactly as `largest` resolves its own ties.
        assert apply_policy(first, PolicySettings("smallest")).keeper_member_id == "a"
        assert (
            apply_policy(first, PolicySettings("smallest")).keeper_member_id
            == apply_policy(second, PolicySettings("smallest")).keeper_member_id
        )

    def test_smallest_still_yields_to_a_protected_reference(self) -> None:
        candidates = group(
            member("a", size=100),
            member("b", size=900, role="reference", root_id="library"),
        )

        # The reference copy is larger and still wins: protection outranks the
        # rule, or "keep the smallest" would quarantine somebody's library.
        assert apply_policy(candidates, PolicySettings("smallest")).keeper_member_id == "b"

    def test_newest_and_oldest_pick_opposite_ends(self) -> None:
        candidates = group(member("a", mtime=100), member("b", mtime=900))

        assert apply_policy(candidates, PolicySettings("newest")).keeper_member_id == "b"
        assert apply_policy(candidates, PolicySettings("oldest")).keeper_member_id == "a"

    def test_unknown_resolution_sends_the_group_to_review(self) -> None:
        candidates = group(
            member("a", width=4000, height=3000),
            member("b", width=None, height=None),
        )

        result = apply_policy(candidates, PolicySettings("highest_resolution"))

        assert result.outcome == "needs_review"
        assert "could not be read" in result.reason

    def test_highest_resolution_decides_when_every_member_is_measured(self) -> None:
        candidates = group(
            member("a", width=4000, height=3000),
            member("b", width=800, height=600),
        )

        assert (
            apply_policy(candidates, PolicySettings("highest_resolution")).keeper_member_id == "a"
        )

    def test_preferred_root_order_is_honoured(self) -> None:
        candidates = group(
            member("a", root_id="scratch"),
            member("b", root_id="archive"),
        )

        result = apply_policy(
            candidates, PolicySettings("preferred_root", preferred_roots=("archive", "scratch"))
        )

        assert result.keeper_member_id == "b"

    def test_a_protected_reference_anchors_the_group(self) -> None:
        candidates = group(
            member("a", size=9_000),
            member("ref", role="reference", root_id="library", size=10),
        )

        result = apply_policy(candidates, PolicySettings("largest"))

        assert result.keeper_member_id == "ref"
        assert "reference" in result.reason

    def test_a_reference_anchors_the_group_without_receiving_an_action(self) -> None:
        candidates = group(
            member("a"), member("b"), member("ref", role="reference", root_id="library")
        )

        result = apply_policy(candidates, PolicySettings("largest"))

        # The reference may hold the `keep` that records why it is the anchor,
        # but nothing that would ever reach a filesystem.
        assert all(
            decision.action == "keep"
            for decision in result.decisions
            if decision.member_id == "ref"
        )
        assert all(
            decision.member_id != "ref"
            for decision in result.decisions
            if decision.action == "quarantine"
        )

    def test_a_group_of_only_references_produces_no_actions(self) -> None:
        candidates = group(
            member("r1", role="reference", root_id="library"),
            member("r2", role="reference", root_id="library"),
        )

        assert apply_policy(candidates, PolicySettings("largest")).outcome == "not_applicable"

    def test_policies_do_not_apply_to_similar_groups(self) -> None:
        candidates = group(member("a", distance=1), member("b", distance=2), kind="similar")

        assert apply_policy(candidates, PolicySettings("largest")).outcome == "not_applicable"

    def test_a_policy_decides_one_keeper_and_quarantines_the_rest(self) -> None:
        candidates = group(member("a", size=900), member("b", size=100), member("c", size=50))

        result = apply_policy(candidates, PolicySettings("largest"))

        keeps = [d for d in result.decisions if d.action == "keep"]
        quarantines = [d for d in result.decisions if d.action == "quarantine"]
        assert len(keeps) == 1
        assert len(quarantines) == 2


class TestSimilarConsent:
    def test_nothing_is_proposed_while_the_rule_is_off(self) -> None:
        candidates = group(member("a", distance=0), member("b", distance=1), kind="similar")

        proposal = propose_similar(candidates, HighConfidenceRule())

        assert proposal.applies is False
        assert "waits for review" in proposal.reason

    def test_a_consented_rule_proposes_quarantine_only(self) -> None:
        candidates = group(
            member("a", distance=0, size=900), member("b", distance=0, size=100), kind="similar"
        )
        rule = HighConfidenceRule(enabled=True, max_distance=0, consented_at="now")

        proposal = propose_similar(candidates, rule)

        assert proposal.applies is True
        assert proposal.representative_member_id == "a"
        assert proposal.quarantine_member_ids == ("b",)

    def test_an_ambiguous_group_is_left_for_a_person(self) -> None:
        candidates = group(
            member("a", distance=0),
            member("b", distance=3, confidence="low"),
            kind="similar",
        )
        rule = HighConfidenceRule(enabled=True, max_distance=3, consented_at="now")

        assert propose_similar(candidates, rule).applies is False

    def test_differing_dimensions_block_the_rule(self) -> None:
        candidates = group(
            member("a", distance=0, width=100, height=100),
            member("b", distance=0, width=200, height=200),
            kind="similar",
        )
        rule = HighConfidenceRule(enabled=True, max_distance=0, consented_at="now")

        assert propose_similar(candidates, rule).applies is False

    def test_the_preview_shows_affected_groups_before_consent(self) -> None:
        groups = [
            group(member("a", distance=0), member("b", distance=0), kind="similar", group_id="g1"),
            group(
                member("c", distance=0),
                member("d", distance=4, confidence="low"),
                kind="similar",
                group_id="g2",
            ),
        ]

        proposals = preview_rule(groups, HighConfidenceRule(max_distance=0))

        assert [proposal.applies for proposal in proposals] == [True, False]


class TestPlanEditing:
    def test_a_reference_member_cannot_be_quarantined(self) -> None:
        plan = _plan(member("a"), member("ref", role="reference", root_id="library"))

        with pytest.raises(ReferenceImmutableError):
            plan.decide("g1", "ref", "quarantine")

    def test_replacing_the_keeper_recalculates_the_group(self) -> None:
        plan = _plan(member("a"), member("b"), member("c"))
        plan.decide("g1", "a", "keep")
        plan.decide("g1", "b", "quarantine")

        result = plan.decide("g1", "b", "replace_keeper")

        assert result.keeper_member_id == "b"
        keeps = [d for d in result.decisions if d.action == "keep"]
        assert [d.member_id for d in keeps] == []  # 'a' was demoted
        assert result.decision_for("a") is not None
        assert (result.decision_for("a") or Decision(member_id="a", action="skip")).action == (
            "quarantine"
        )

    def test_an_exact_group_that_quarantines_has_exactly_one_keeper(self) -> None:
        plan = _plan(member("a"), member("b"))
        plan.decide("g1", "a", "keep")

        result = plan.decide("g1", "b", "quarantine")

        assert result.keeper_member_id == "a"

    def test_quarantining_without_a_keeper_is_refused_by_the_model(self) -> None:
        with pytest.raises(ValueError):
            GroupPlan(
                group_id="g1",
                kind="exact",
                outcomes=(ResolvedOutcome(member_id="a", kind="quarantine"),),
            )

    def test_similar_groups_keep_several_members(self) -> None:
        plan = _plan(
            member("a", distance=0),
            member("b", distance=1),
            member("c", distance=1),
            kind="similar",
        )
        plan.decide("g1", "a", "keep")

        result = plan.decide("g1", "b", "keep_additional")

        assert set(result.additional_keeps) == {"a", "b"}

    def test_keep_additional_is_refused_for_exact_groups(self) -> None:
        plan = _plan(member("a"), member("b"))

        with pytest.raises(PlanError):
            plan.decide("g1", "a", "keep_additional")

    def test_quarantine_all_except_retains_selection_and_references(self) -> None:
        plan = _plan(
            member("a"),
            member("b"),
            member("c"),
            member("ref", role="reference", root_id="library"),
            kind="similar",
        )

        result = plan.quarantine_all_except("g1", ["a"])

        quarantined = {o.member_id for o in result.outcomes if o.kind == "quarantine"}
        assert quarantined == {"b", "c"}
        assert any(o.kind == "no_action_reference" for o in result.outcomes)

    def test_undo_removes_the_last_decision_only(self) -> None:
        plan = _plan(member("a"), member("b"))
        plan.decide("g1", "a", "keep")
        plan.decide("g1", "b", "quarantine")

        result = plan.undo_last("g1")

        assert result.decision_for("b") is None
        assert result.decision_for("a") is not None

    def test_undo_on_an_untouched_group_is_refused(self) -> None:
        plan = _plan(member("a"), member("b"))

        with pytest.raises(PlanError):
            plan.undo_last("g1")


class TestResolution:
    def test_copy_mode_keeps_the_input_and_copies_it(self) -> None:
        plan = _plan(member("a"), member("b"), mode="copy")

        result = plan.decide("g1", "a", "keep")

        outcome = next(o for o in result.outcomes if o.member_id == "a")
        assert outcome.kind == "copy_to_destination"
        assert outcome.mutates_source is False

    def test_move_mode_says_the_file_will_move(self) -> None:
        plan = _plan(member("a"), member("b"), mode="move")

        result = plan.decide("g1", "a", "keep")

        outcome = next(o for o in result.outcomes if o.member_id == "a")
        assert outcome.kind == "move_to_destination"
        assert outcome.mutates_source is True

    def test_quarantine_under_copy_requires_acknowledgement(self) -> None:
        plan = _plan(member("a"), member("b"), mode="copy")
        plan.decide("g1", "a", "keep")

        result = plan.decide("g1", "b", "quarantine")

        outcome = next(o for o in result.outcomes if o.member_id == "b")
        assert outcome.mutates_source is True
        assert outcome.requires_acknowledgement is True
        assert "changes your input" in outcome.explanation

    def test_a_destination_member_that_is_kept_simply_stays(self) -> None:
        plan = _plan(member("a", role="destination", root_id="dest"), member("b"))

        result = plan.decide("g1", "a", "keep")

        assert next(o for o in result.outcomes if o.member_id == "a").kind == "skip"

    def test_an_undecided_member_is_explicitly_skipped(self) -> None:
        plan = _plan(member("a"), member("b"))

        result = plan.decide("g1", "a", "keep")

        assert next(o for o in result.outcomes if o.member_id == "b").kind == "skip"

    def test_a_reference_member_always_resolves_to_no_action(self) -> None:
        plan = _plan(member("a"), member("ref", role="reference", root_id="library"))

        result = plan.decide("g1", "a", "keep")

        outcome = next(o for o in result.outcomes if o.member_id == "ref")
        assert outcome.kind == "no_action_reference"
        assert outcome.mutates_source is False


class TestBulkScopes:
    def _many(self, count: int = 5) -> ReviewPlan:
        plan = ReviewPlan(plan_id="bulk", transfer_mode="copy")
        for index in range(count):
            plan.register(
                group(
                    member(f"a{index}", size=900),
                    member(f"b{index}", size=100),
                    group_id=f"g{index}",
                )
            )
        return plan

    def test_impact_counts_members_bytes_and_source_mutations(self) -> None:
        plan = self._many(3)

        impact = plan.preview_bulk("all_unresolved_exact")

        assert impact.matched_groups == 3
        assert impact.matched_members == 3
        assert impact.quarantine_bytes == 300
        assert impact.source_mutations == 3

    def test_similar_groups_are_excluded_and_the_reason_is_kept(self) -> None:
        plan = self._many(1)
        plan.register(
            group(
                member("s1", distance=0), member("s2", distance=1), kind="similar", group_id="sim"
            )
        )

        impact = plan.preview_bulk("selected_groups", group_ids=["g0", "sim"])

        assert impact.matched_groups == 1
        assert impact.skipped_groups == 1
        assert "similar groups are excluded" in impact.skipped_reasons[0]

    def test_a_changed_scope_invalidates_the_preview(self) -> None:
        plan = self._many(2)
        impact = plan.preview_bulk("all_unresolved_exact", filter_key="kind=image")

        with pytest.raises(PlanError, match="scope changed"):
            plan.apply_bulk(impact, lambda _plan, _group: True, filter_key="kind=video")

    def test_a_matching_scope_applies(self) -> None:
        plan = self._many(2)
        impact = plan.preview_bulk("all_unresolved_exact")

        applied = plan.apply_bulk(impact, lambda _plan, _group: True)

        assert applied == 2


class TestDriftAndSnapshots:
    def test_changed_content_marks_the_group_stale(self) -> None:
        plan = _plan(member("a"), member("b"))
        plan.decide("g1", "a", "keep")
        plan.decide("g1", "b", "quarantine")
        changed = group(member("a", sha256="b" * 64), member("b"))

        findings = plan.detect_drift([changed])
        affected = plan.mark_stale(findings)

        assert any(finding.kind == "content" for finding in findings)
        assert affected == {"g1"}
        assert plan.groups["g1"].state == "stale"

    def test_a_moved_file_is_drift(self) -> None:
        plan = _plan(member("a"), member("b"))
        moved = group(member("a", path="somewhere/else"), member("b"))

        assert any(finding.kind == "path" for finding in plan.detect_drift([moved]))

    def test_a_role_change_is_drift(self) -> None:
        plan = _plan(member("a"), member("b"))
        changed = group(member("a", role="reference", root_id="library"), member("b"))

        assert any(finding.kind == "role" for finding in plan.detect_drift([changed]))

    def test_a_vanished_group_is_drift(self) -> None:
        plan = _plan(member("a"), member("b"))

        assert any(finding.kind == "identity" for finding in plan.detect_drift([]))

    def test_a_stale_group_never_reaches_a_snapshot(self) -> None:
        plan = _plan(member("a"), member("b"), mode="move")
        plan.decide("g1", "a", "keep")
        plan.decide("g1", "b", "quarantine")
        plan.mark_stale(plan.detect_drift([group(member("a", sha256="c" * 64), member("b"))]))

        snapshot = plan.snapshot(acknowledge_source_mutations=True)

        assert snapshot.groups == ()

    def test_a_snapshot_freezes_the_plan_and_bumps_the_version(self) -> None:
        plan = _plan(member("a"), member("b"), mode="move")
        plan.decide("g1", "a", "keep")
        plan.decide("g1", "b", "quarantine")

        snapshot = plan.snapshot(acknowledge_source_mutations=True)
        plan.decide("g1", "b", "skip")

        assert snapshot.version == 2
        assert plan.version == 2
        assert any(o.kind == "quarantine" for g in snapshot.groups for o in g.outcomes)

    def test_a_plan_needing_acknowledgement_cannot_snapshot_without_one(self) -> None:
        plan = _plan(member("a"), member("b"), mode="copy")
        plan.decide("g1", "a", "keep")
        plan.decide("g1", "b", "quarantine")

        with pytest.raises(ValueError, match="acknowledgement"):
            plan.snapshot()

    def test_only_mutating_outcomes_reach_the_executor(self) -> None:
        plan = _plan(
            member("a"),
            member("b"),
            member("ref", role="reference", root_id="library"),
            mode="move",
        )
        plan.decide("g1", "a", "keep")
        plan.decide("g1", "b", "quarantine")
        snapshot = plan.snapshot(acknowledge_source_mutations=True)

        actions = executable_members(snapshot)

        assert all(outcome.kind != "no_action_reference" for _group, outcome in actions)
        assert all(outcome.member_id != "ref" for _group, outcome in actions)

    def test_an_empty_snapshot_is_valid(self) -> None:
        assert (
            PlanSnapshot(snapshot_id="s", plan_id="p", version=1, catalog_generation=0).groups == ()
        )


class TestPersistence:
    def test_a_plan_round_trips_with_its_decisions(self, tmp_path: Path) -> None:
        plan = _plan(member("a"), member("b"))
        plan.decide("g1", "a", "keep")

        path = plan.save(tmp_path)
        reloaded = ReviewPlan.load(path)

        assert reloaded.plan_id == plan.plan_id
        assert reloaded.groups["g1"].keeper_member_id == "a"
        assert reloaded.known_groups["g1"].member_count == 2
