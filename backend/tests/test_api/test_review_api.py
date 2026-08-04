"""The API must enforce the same refusals the UI shows — including for a
handcrafted request that never went near the interface."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.api.routes import review as review_routes
from app.core.duplicate_plans import (
    DuplicateGroup,
    FactValue,
    GroupMember,
    MemberEvidence,
    MemberFacts,
)
from app.services.review_plan import ReviewPlan


def _member(member_id: str, *, role: str = "input", size: int = 100) -> GroupMember:
    return GroupMember(
        member_id=member_id,
        root_id="library" if role == "reference" else "input-a",
        role=role,  # type: ignore[arg-type]
        relative_path=f"{member_id}.jpg",
        observed_path=f"/library/{member_id}.jpg",
        facts=MemberFacts(size_bytes=size, modified_at=FactValue.of(1_000)),
        evidence=MemberEvidence(sha256="a" * 64, confidence="high"),
    )


@pytest.fixture()
def seeded_plan(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[ReviewPlan]:
    """A plan with one group, wired in so the routes do not need a real catalog."""
    monkeypatch.setattr(review_routes, "_plans_directory", lambda: tmp_path / "plans")
    # The routes now resolve a plan against the live catalog generation, and the
    # catalog is shared for the session. Pin the generation to the seeded one so
    # this fixture keeps its promise of not needing a real catalog.
    monkeypatch.setattr(review_routes, "_live_generation", lambda _container: 1)
    plan = ReviewPlan(plan_id="test-plan", transfer_mode="copy", catalog_generation=1)
    plan.register(
        DuplicateGroup(
            group_id="g1",
            kind="exact",
            catalog_generation=1,
            member_count=3,
            total_bytes=300,
            members=(
                _member("a", size=300),
                _member("b", size=100),
                _member("ref", role="reference", size=100),
            ),
        )
    )
    review_routes._PLANS["test-plan"] = plan
    yield plan
    review_routes._PLANS.pop("test-plan", None)


def _decide(client: TestClient, member_id: str, action: str) -> object:
    return client.post(
        "/api/review/decide",
        json={
            "plan_id": "test-plan",
            "group_id": "g1",
            "member_id": member_id,
            "action": action,
        },
    )


class TestReferenceProtection:
    def test_a_handcrafted_request_cannot_quarantine_a_reference(
        self, client: TestClient, seeded_plan: ReviewPlan
    ) -> None:
        response = _decide(client, "ref", "quarantine")

        assert response.status_code == 409
        assert "compared against" in response.json()["detail"]

    def test_a_reference_still_resolves_to_no_action(
        self, client: TestClient, seeded_plan: ReviewPlan
    ) -> None:
        _decide(client, "a", "keep")

        body = _decide(client, "b", "quarantine").json()

        reference = next(o for o in body["outcomes"] if o["member_id"] == "ref")
        assert reference["kind"] == "no_action_reference"
        assert reference["mutates_source"] is False

    def test_an_unknown_member_is_a_client_error(
        self, client: TestClient, seeded_plan: ReviewPlan
    ) -> None:
        assert _decide(client, "not-a-member", "keep").status_code == 400


class TestDecisions:
    def test_a_keep_under_copy_says_it_will_be_copied(
        self, client: TestClient, seeded_plan: ReviewPlan
    ) -> None:
        body = _decide(client, "a", "keep").json()

        outcome = next(o for o in body["outcomes"] if o["member_id"] == "a")
        assert outcome["kind"] == "copy_to_destination"
        assert body["keeper_member_id"] == "a"

    def test_quarantine_under_copy_flags_the_source_mutation(
        self, client: TestClient, seeded_plan: ReviewPlan
    ) -> None:
        _decide(client, "a", "keep")

        body = _decide(client, "b", "quarantine").json()

        outcome = next(o for o in body["outcomes"] if o["member_id"] == "b")
        assert outcome["mutates_source"] is True
        assert outcome["requires_acknowledgement"] is True

    def test_undo_removes_the_last_decision(
        self, client: TestClient, seeded_plan: ReviewPlan
    ) -> None:
        _decide(client, "a", "keep")
        _decide(client, "b", "quarantine")

        body = client.post(
            "/api/review/undo", json={"plan_id": "test-plan", "group_id": "g1"}
        ).json()

        assert all(d["member_id"] != "b" for d in body["decisions"])

    def test_undo_on_an_untouched_group_is_refused(
        self, client: TestClient, seeded_plan: ReviewPlan
    ) -> None:
        response = client.post("/api/review/undo", json={"plan_id": "test-plan", "group_id": "g1"})

        assert response.status_code == 400

    def test_quarantine_all_except_never_touches_the_reference(
        self, client: TestClient, seeded_plan: ReviewPlan
    ) -> None:
        body = client.post(
            "/api/review/quarantine-all-except",
            json={"plan_id": "test-plan", "group_id": "g1", "keep_member_ids": ["a"]},
        ).json()

        quarantined = {o["member_id"] for o in body["outcomes"] if o["kind"] == "quarantine"}
        assert quarantined == {"b"}


class TestSnapshot:
    def test_a_plan_that_mutates_sources_needs_an_acknowledgement(
        self, client: TestClient, seeded_plan: ReviewPlan, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            review_routes, "_current_groups", lambda _c: list(seeded_plan.known_groups.values())
        )
        _decide(client, "a", "keep")
        _decide(client, "b", "quarantine")

        refused = client.post("/api/review/snapshot", json={"plan_id": "test-plan"})

        assert refused.status_code == 409
        assert "acknowledgement" in refused.json()["detail"]

    def test_an_acknowledged_plan_freezes(
        self, client: TestClient, seeded_plan: ReviewPlan, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            review_routes, "_current_groups", lambda _c: list(seeded_plan.known_groups.values())
        )
        _decide(client, "a", "keep")
        _decide(client, "b", "quarantine")

        body = client.post(
            "/api/review/snapshot",
            json={"plan_id": "test-plan", "acknowledge_source_mutations": True},
        ).json()

        assert body["snapshot"]["version"] >= 2
        assert body["stale_groups"] == []

    def test_drift_sends_the_group_back_to_review(
        self, client: TestClient, seeded_plan: ReviewPlan, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        _decide(client, "a", "keep")
        _decide(client, "b", "quarantine")
        changed = DuplicateGroup(
            group_id="g1",
            kind="exact",
            catalog_generation=1,
            member_count=3,
            total_bytes=300,
            members=(
                _member("a", size=999),  # size changed after review
                _member("b"),
                _member("ref", role="reference"),
            ),
        )
        monkeypatch.setattr(review_routes, "_current_groups", lambda _c: [changed])

        body = client.post(
            "/api/review/snapshot",
            json={"plan_id": "test-plan", "acknowledge_source_mutations": True},
        ).json()

        assert body["stale_groups"] == ["g1"]
        assert body["snapshot"]["groups"] == []


class TestQuarantineCleanup:
    def test_cleanup_without_acknowledgement_is_refused(self, client: TestClient) -> None:
        response = client.post(
            "/api/quarantine/cleanup",
            json={"record_ids": ["qtn_missing"], "acknowledge_permanent_deletion": False},
        )

        assert response.status_code == 400
        assert "acknowledgement" in response.json()["detail"]

    def test_the_preview_states_that_it_cannot_be_undone(self, client: TestClient) -> None:
        body = client.post(
            "/api/quarantine/cleanup/preview", json={"record_ids": ["qtn_missing"]}
        ).json()

        assert "cannot be undone" in body["acknowledgement_text"]
        assert body["item_count"] == 0
