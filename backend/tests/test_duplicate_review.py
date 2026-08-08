"""Grouping, keeper policies, and review plans.

The deterministic fixtures below are the contract: references, multiple inputs,
destination members, missing facts, ties, drift, huge groups, and conflicting
paths all appear here, because each one is a way a duplicate review can quietly
destroy the wrong copy.
"""

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api.routes import review as review_routes
from app.core.duplicate_plans import (
    SELECTABLE_KEEPER_POLICIES,
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
        assert impact.skipped_reasons[0] == (
            "sim: a similar group is not resolved by an exact-match policy"
        )

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


class TestGenerationLifecycle:
    """A plan describes one catalog generation and must not outlive it.

    Before this, ``_ensure_groups`` returned early whenever the plan held any
    group at all, so the first scan's group ids survived every later scan and
    every per-group route 404'd for the rest of the process's life.
    """

    @pytest.fixture(autouse=True)
    def _isolate_plan_cache(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        review_routes._PLANS.clear()
        monkeypatch.setattr(review_routes, "_plans_directory", lambda: tmp_path)

    def _stub_catalog(
        self,
        monkeypatch: pytest.MonkeyPatch,
        *,
        generation: int,
        groups: list[DuplicateGroup],
    ) -> None:
        monkeypatch.setattr(review_routes, "_live_generation", lambda _container: generation)
        monkeypatch.setattr(review_routes, "_current_groups", lambda _container: groups)

    async def test_a_new_generation_re_registers_groups(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plan = ReviewPlan(plan_id="default")
        first = group(member("a"), member("b"), group_id="old-group")
        self._stub_catalog(monkeypatch, generation=1, groups=[first])
        await review_routes._ensure_groups(plan, object())
        assert set(plan.known_groups) == {"old-group"}

        second = group(member("c"), member("d"), group_id="new-group")
        self._stub_catalog(monkeypatch, generation=2, groups=[second])
        await review_routes._ensure_groups(plan, object())

        assert set(plan.known_groups) == {"new-group"}
        assert plan.catalog_generation == 2

    async def test_decisions_about_vanished_groups_do_not_reach_a_snapshot(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plan = ReviewPlan(plan_id="default")
        self._stub_catalog(
            monkeypatch, generation=1, groups=[group(member("a"), member("b"), group_id="gone")]
        )
        await review_routes._ensure_groups(plan, object())
        plan.decide("gone", "a", "keep")
        plan.decide("gone", "b", "quarantine")

        self._stub_catalog(
            monkeypatch, generation=2, groups=[group(member("c"), member("d"), group_id="stays")]
        )
        await review_routes._ensure_groups(plan, object())

        assert "gone" not in plan.groups
        assert plan.snapshot().groups == ()

    async def test_the_same_generation_does_not_rebuild_the_groups(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        plan = ReviewPlan(plan_id="default")
        built = group(member("a"), member("b"))
        self._stub_catalog(monkeypatch, generation=3, groups=[built])
        await review_routes._ensure_groups(plan, object())

        calls: list[object] = []

        def _explode(container: object) -> list[DuplicateGroup]:
            calls.append(container)
            return [built]

        monkeypatch.setattr(review_routes, "_current_groups", _explode)
        await review_routes._ensure_groups(plan, object())

        assert calls == []

    def test_a_stored_plan_from_an_older_generation_is_discarded_on_load(
        self, tmp_path: Path
    ) -> None:
        stale = ReviewPlan(plan_id="default", catalog_generation=1)
        stale.register(group(member("a"), member("b"), group_id="old-group"))
        stale.decide("old-group", "a", "keep")
        stale.save(tmp_path)

        loaded = review_routes._plan("default", catalog_generation=2)

        assert loaded.known_groups == {}
        assert loaded.groups == {}
        assert loaded.catalog_generation == 2

    def test_a_stored_plan_of_the_current_generation_is_kept(self, tmp_path: Path) -> None:
        stored = ReviewPlan(plan_id="default", catalog_generation=7)
        stored.register(group(member("a"), member("b"), group_id="live-group"))
        stored.decide("live-group", "a", "keep")
        stored.save(tmp_path)

        loaded = review_routes._plan("default", catalog_generation=7)

        assert set(loaded.known_groups) == {"live-group"}
        assert loaded.groups["live-group"].keeper_member_id == "a"

    def test_a_cached_plan_is_dropped_when_the_generation_moves(self, tmp_path: Path) -> None:
        first = review_routes._plan("default", catalog_generation=1)
        first.register(group(member("a"), member("b"), group_id="old-group"))

        second = review_routes._plan("default", catalog_generation=2)

        assert second is not first
        assert second.known_groups == {}


class TestBurstStacks:
    """A burst is a third kind of stack, not a second concept.

    ``/api/review/bursts/*`` still exists and is unreferenced. What matters here
    is that a burst reaching Review through ``/api/review/groups`` resolves
    through exactly the same decide and policy routes as an exact or a similar
    one — otherwise the surface would render a stack whose buttons all 404.
    """

    @pytest.fixture(autouse=True)
    def _isolate_plan_cache(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        review_routes._PLANS.clear()
        monkeypatch.setattr(review_routes, "_plans_directory", lambda: tmp_path)

    @staticmethod
    def _serve(monkeypatch: pytest.MonkeyPatch, burst: DuplicateGroup) -> None:
        monkeypatch.setattr(review_routes, "_live_generation", lambda _container: 1)
        monkeypatch.setattr(review_routes, "_current_groups", lambda _container: [burst])

    @staticmethod
    def _burst() -> DuplicateGroup:
        return group(
            member("frame-1", distance=0, confidence="medium"),
            member("frame-2", distance=2, confidence="medium", sha256="b" * 64),
            member("frame-3", distance=3, confidence="medium", sha256="c" * 64),
            kind="burst",
            group_id="burst_stack",
        )

    def test_the_route_offers_burst_as_a_third_kind(self, client: TestClient) -> None:
        response = client.get("/api/review/groups", params={"kind": "burst"})

        assert response.status_code == 200
        assert response.json()["kind"] == "burst"

    def test_an_unknown_kind_is_still_refused(self, client: TestClient) -> None:
        assert client.get("/api/review/groups", params={"kind": "sideways"}).status_code == 422

    def test_a_burst_member_can_be_decided(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._serve(monkeypatch, self._burst())

        response = client.post(
            "/api/review/decide",
            json={"group_id": "burst_stack", "member_id": "frame-2", "action": "quarantine"},
        )

        assert response.status_code == 200

    def test_a_bulk_exact_policy_reaches_a_burst_and_declines_it_by_name(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A burst is not bulk-resolved, for the reason a similar group is not.

        A visual match is not proof of identity, so a perceptual stack waits for
        a person or for the explicitly consented high-confidence rule. What
        changed is that the refusal now names the kind: it used to tell a burst
        it was a "similar group".
        """
        self._serve(monkeypatch, self._burst())

        preview = client.post(
            "/api/review/policy/preview",
            json={
                "scope": "selected_groups",
                "group_ids": ["burst_stack"],
                "policy_id": "largest",
            },
        )

        assert preview.status_code == 200
        assert preview.json()["matched_groups"] == 0
        assert preview.json()["skipped_reasons"] == [
            "burst_stack: a burst group is not resolved by an exact-match policy"
        ]

    def test_an_unrecognised_scope_is_refused_readably_rather_than_500(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._serve(monkeypatch, self._burst())

        response = client.post(
            "/api/review/policy/preview",
            json={"scope": "everything", "policy_id": "largest"},
        )

        assert response.status_code == 422

    def test_the_keeper_a_burst_review_chose_reaches_the_run(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._serve(monkeypatch, self._burst())
        client.post(
            "/api/review/decide",
            json={"group_id": "burst_stack", "member_id": "frame-1", "action": "keep"},
        )
        client.post(
            "/api/review/quarantine-all-except",
            json={"group_id": "burst_stack", "keep_member_ids": ["frame-1"]},
        )

        plan = review_routes._plan("default", catalog_generation=1)
        actions = executable_members(plan.snapshot(acknowledge_source_mutations=True))

        # The kept frame is never quarantined; every other frame is.
        quarantined = {
            outcome.member_id for _group, outcome in actions if outcome.kind == "quarantine"
        }
        assert quarantined == {"frame-2", "frame-3"}


class TestTwoPreviewCyclesThroughTheRoutes:
    """Preview, act, preview again, act again — through the HTTP routes.

    The unit tests around `_ensure_groups` pin the generation logic. This pins
    the thing a person actually checks by hand: that the second cycle works.
    Before the lifecycle fix, the first scan's group ids survived every later
    scan, so every per-group route answered 404 for the rest of the process's
    life and the workbench looked permanently broken after one run.
    """

    @pytest.fixture(autouse=True)
    def _isolate_plan_cache(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
        review_routes._PLANS.clear()
        monkeypatch.setattr(review_routes, "_plans_directory", lambda: tmp_path)

    @staticmethod
    def _cycle(monkeypatch: pytest.MonkeyPatch, generation: int, group_id: str) -> None:
        """Stand in for a scan: a new catalog generation with its own groups."""
        built = group(member("a"), member("b"), group_id=group_id)
        monkeypatch.setattr(review_routes, "_live_generation", lambda _c: generation)
        monkeypatch.setattr(review_routes, "_current_groups", lambda _c: [built])

    def _act(self, client: TestClient, group_id: str) -> None:
        quarantine = client.post(
            "/api/review/quarantine-all-except",
            json={"group_id": group_id, "keep_member_ids": ["a"]},
        )
        assert quarantine.status_code == 200, quarantine.text

        policy = client.post(
            "/api/review/policy/preview",
            json={"scope": "selected_groups", "group_ids": [group_id], "policy_id": "largest"},
        )
        assert policy.status_code == 200, policy.text

    def test_acting_on_a_group_succeeds_in_both_cycles(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        self._cycle(monkeypatch, generation=1, group_id="first-run")
        self._act(client, "first-run")

        self._cycle(monkeypatch, generation=2, group_id="second-run")
        self._act(client, "second-run")

    def test_a_group_from_the_previous_cycle_is_refused_readably(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """404, not 500. The id is gone; saying so is the correct answer."""
        self._cycle(monkeypatch, generation=1, group_id="first-run")
        self._act(client, "first-run")
        self._cycle(monkeypatch, generation=2, group_id="second-run")

        stale = client.post(
            "/api/review/quarantine-all-except",
            json={"group_id": "first-run", "keep_member_ids": ["a"]},
        )

        assert stale.status_code == 404
        assert isinstance(stale.json().get("detail"), str)


class TestPolicyPreviewFailures:
    def test_an_unknown_group_id_returns_409_and_never_500(self, client: TestClient) -> None:
        response = client.post(
            "/api/review/policy/preview",
            json={
                "plan_id": "unknown-group-test",
                "scope": "selected_groups",
                "group_ids": ["no-such-group"],
            },
        )

        assert response.status_code == 409
        # Its sibling routes raise HTTPException, so the body is FastAPI's
        # ``detail`` shape rather than the MediaSortException envelope.
        assert "no-such-group" in response.json()["detail"]


class TestNewKeeperPolicies:
    """Each policy must be total, deterministic, and never beat a baseline."""

    def _settings(self, policy: str) -> PolicySettings:
        return PolicySettings(policy_id=policy)  # type: ignore[arg-type]

    def test_best_quality_prefers_pixels_then_bytes(self) -> None:
        result = apply_policy(
            group(
                member("small", width=100, height=100, size=9_000),
                member("big", width=400, height=400, size=1_000),
            ),
            self._settings("best_quality"),
        )

        assert result.decided
        assert result.keeper_member_id == "big"

    def test_best_quality_decides_where_highest_resolution_refuses(self) -> None:
        """The point of the default: an unreadable member does not stall the group.

        `highest_resolution` sends the whole group to a person when any member's
        dimensions cannot be read. A library is full of such files, so the
        default must still decide — preferring the member whose pixels are
        known, and falling back to size only between equals.
        """
        candidates = group(
            member("unreadable", width=None, height=None, size=9_000),
            member("readable", width=100, height=100, size=1_000),
        )

        assert apply_policy(candidates, self._settings("highest_resolution")).outcome == (
            "needs_review"
        )
        best = apply_policy(candidates, self._settings("best_quality"))
        assert best.decided
        assert best.keeper_member_id == "readable"

    def test_best_quality_falls_back_to_size_between_equal_pixels(self) -> None:
        result = apply_policy(
            group(
                member("small", width=100, height=100, size=1_000),
                member("large", width=100, height=100, size=9_000),
            ),
            self._settings("best_quality"),
        )

        assert result.keeper_member_id == "large"

    def test_filename_length_policies_are_mirror_images(self) -> None:
        members = (
            member("short", path="a.jpg"),
            member("long", path="a final edit.jpg"),
        )

        assert apply_policy(
            group(*members), self._settings("longest_filename")
        ).keeper_member_id == ("long")
        assert (
            apply_policy(group(*members), self._settings("shortest_filename")).keeper_member_id
            == "short"
        )

    @pytest.mark.parametrize("policy", ["best_quality", "longest_filename", "shortest_filename"])
    def test_each_policy_is_stable_across_scan_order(self, policy: str) -> None:
        members = [
            member("a", path="one.jpg", size=100, width=100, height=100),
            member("b", path="two words.jpg", size=200, width=200, height=200),
            member("c", path="three.jpg", size=300, width=150, height=150),
        ]
        forward = apply_policy(group(*members), self._settings(policy)).keeper_member_id
        backward = apply_policy(group(*reversed(members)), self._settings(policy)).keeper_member_id

        assert forward == backward

    @pytest.mark.parametrize(
        "policy",
        [
            "best_quality",
            "largest",
            "smallest",
            "newest",
            "oldest",
            "longest_filename",
            "shortest_filename",
            "highest_resolution",
        ],
    )
    def test_a_baseline_member_wins_under_every_policy(self, policy: str) -> None:
        result = apply_policy(
            group(
                member("input", size=9_999, width=999, height=999, path="a very long name.jpg"),
                member("ref", role="reference", root_id="library", size=1, path="r.jpg"),
            ),
            self._settings(policy),
        )

        assert result.keeper_member_id == "ref"

    def test_the_selectable_set_excludes_the_automatic_and_the_retired(self) -> None:
        assert "protected_reference" not in SELECTABLE_KEEPER_POLICIES
        assert "preferred_root" not in SELECTABLE_KEEPER_POLICIES
        assert SELECTABLE_KEEPER_POLICIES[0] == "best_quality"


class TestReviewedKeepersSurviveThePolicy:
    """Review's choice must beat the configured rule, or the review is theatre."""

    def test_a_decision_about_a_file_the_plan_never_saw_is_refused(self) -> None:
        """Half-applying a decision leaves a duplicate the user believes is resolved.

        The swap itself, and its agreement with what the run computes, is
        covered end-to-end in `test_reviewed_sets.py`; what belongs here is the
        refusal, because it is the case where review and plan have diverged.
        """
        from app.core.config import Config
        from app.core.exceptions import ConflictError
        from app.core.sort_plan import ReviewedSet, build_frozen_sort_plan

        plan = build_frozen_sort_plan([], Config())

        with pytest.raises(ConflictError) as raised:
            plan.with_reviewed_sets(
                [ReviewedSet(keep="/library/keep-this.jpg", demote=("/library/other.jpg",))],
                source_root="/library",
            )

        assert raised.value.details["source_path"] == "/library/keep-this.jpg"

    def test_an_empty_decision_list_leaves_the_plan_alone(self) -> None:
        from app.core.config import Config
        from app.core.sort_plan import build_frozen_sort_plan

        plan = build_frozen_sort_plan([], Config())

        assert plan.with_reviewed_sets([], source_root="/") is plan
        assert plan.reviewed_sets == ()

    def test_an_undecided_group_still_follows_the_policy(self) -> None:
        candidates = group(member("a", size=100), member("b", size=900))

        # No reviewed keeper for this content: the configured rule decides.
        assert apply_policy(candidates, PolicySettings("largest")).keeper_member_id == "b"

    def test_a_baseline_member_is_never_overridden(self) -> None:
        candidates = group(
            member("a", size=9_000),
            member("ref", role="reference", root_id="library", size=10),
        )

        # Protection is checked before any policy or reviewed choice runs.
        assert apply_policy(candidates, PolicySettings("largest")).keeper_member_id == "ref"
