"""Executing a plan: every boundary, and what survives a failure at each one.

The prerequisite contracts this change depends on — catalog, typed roots, cursor
paging, checkpoints, progress — are asserted here too, so enabling review can
never silently outrun the indexing work it is built on.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from app.core.duplicate_plans import (
    FactValue,
    GroupMember,
    GroupPlan,
    MemberEvidence,
    MemberFacts,
    PlanSnapshot,
    ResolvedOutcome,
)
from app.services.quarantine import QuarantineStore, store_for_state_root
from app.services.review_execution import (
    ExecutionRefused,
    execute_snapshot,
    reconcile,
    unresolved_actions,
)


@pytest.fixture()
def quarantine(tmp_path: Path) -> QuarantineStore:
    return store_for_state_root(tmp_path / "state")


def _file(path: Path, content: bytes = b"content") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


def _snapshot(*outcomes: ResolvedOutcome, acknowledged: bool = True) -> PlanSnapshot:
    return PlanSnapshot(
        snapshot_id="snap-1",
        plan_id="plan-1",
        version=1,
        catalog_generation=1,
        transfer_mode="move",
        groups=(
            GroupPlan(
                group_id="g1",
                kind="exact",
                state="reviewed",
                keeper_member_id="keep",
                outcomes=outcomes,
            ),
        ),
        acknowledged_source_mutations=acknowledged,
    )


class TestExecution:
    def test_a_quarantine_action_moves_the_file_and_records_it(
        self, tmp_path: Path, quarantine: QuarantineStore
    ) -> None:
        source = _file(tmp_path / "library" / "copy.jpg")
        snapshot = _snapshot(
            ResolvedOutcome(member_id="keep", kind="skip"),
            ResolvedOutcome(member_id="dupe", kind="quarantine"),
        )

        report = execute_snapshot(snapshot, quarantine=quarantine, source_for=lambda _id: source)

        assert report.code == "completed"
        assert not source.exists()
        assert len(quarantine.records()) == 1
        assert report.actions[0].quarantine_record_id is not None

    def test_a_skip_never_reaches_the_filesystem(
        self, tmp_path: Path, quarantine: QuarantineStore
    ) -> None:
        source = _file(tmp_path / "library" / "kept.jpg")
        snapshot = _snapshot(ResolvedOutcome(member_id="keep", kind="skip"))

        report = execute_snapshot(snapshot, quarantine=quarantine, source_for=lambda _id: source)

        assert report.actions == []
        assert source.is_file()

    def test_a_reference_outcome_can_never_be_performed(
        self, tmp_path: Path, quarantine: QuarantineStore
    ) -> None:
        source = _file(tmp_path / "library" / "reference.jpg")
        snapshot = _snapshot(ResolvedOutcome(member_id="ref", kind="no_action_reference"))

        report = execute_snapshot(snapshot, quarantine=quarantine, source_for=lambda _id: source)

        assert report.actions == []
        assert source.is_file()

    def test_a_move_lands_at_the_planned_destination(
        self, tmp_path: Path, quarantine: QuarantineStore
    ) -> None:
        source = _file(tmp_path / "input" / "photo.jpg", b"photo")
        destination = tmp_path / "dest" / "2019" / "photo.jpg"
        snapshot = _snapshot(
            ResolvedOutcome(
                member_id="keep",
                kind="move_to_destination",
                destination_path=str(destination),
                mutates_source=True,
            )
        )

        report = execute_snapshot(snapshot, quarantine=quarantine, source_for=lambda _id: source)

        assert report.code == "completed"
        assert destination.read_bytes() == b"photo"
        assert not source.exists()

    def test_a_copy_keeps_the_source(self, tmp_path: Path, quarantine: QuarantineStore) -> None:
        source = _file(tmp_path / "input" / "photo.jpg", b"photo")
        destination = tmp_path / "dest" / "photo.jpg"
        snapshot = _snapshot(
            ResolvedOutcome(
                member_id="keep",
                kind="copy_to_destination",
                destination_path=str(destination),
            )
        )

        execute_snapshot(snapshot, quarantine=quarantine, source_for=lambda _id: source)

        assert source.is_file()
        assert destination.read_bytes() == b"photo"


class TestRefusals:
    def test_exact_group_is_blocked_when_keeper_or_duplicate_bytes_drift(
        self, tmp_path: Path, quarantine: QuarantineStore
    ) -> None:
        keeper = _file(tmp_path / "library" / "keeper.jpg", b"same")
        duplicate = _file(tmp_path / "library" / "duplicate.jpg", b"same")
        reviewed = hashlib.sha256(b"same").hexdigest()
        snapshot = _snapshot(
            ResolvedOutcome(
                member_id="keep",
                kind="skip",
                expected_sha256=reviewed,
            ),
            ResolvedOutcome(
                member_id="dupe",
                kind="quarantine",
                expected_sha256=reviewed,
            ),
        )
        duplicate.write_bytes(b"evil")

        report = execute_snapshot(
            snapshot,
            quarantine=quarantine,
            source_for=lambda member: {"keep": keeper, "dupe": duplicate}[member],
        )

        assert report.code == "failed"
        assert "full-content validation failed" in (report.actions[0].detail or "")
        assert keeper.read_bytes() == b"same"
        assert duplicate.read_bytes() == b"evil"
        assert quarantine.records() == ()

    def test_an_unacknowledged_source_mutation_is_refused_before_anything_runs(
        self, tmp_path: Path, quarantine: QuarantineStore
    ) -> None:
        source = _file(tmp_path / "input" / "photo.jpg")
        # The model itself refuses to build this snapshot, which is the point:
        # an unacknowledged plan cannot even be represented.
        with pytest.raises(ValueError, match="acknowledgement"):
            _snapshot(
                ResolvedOutcome(
                    member_id="dupe",
                    kind="quarantine",
                    mutates_source=True,
                    requires_acknowledgement=True,
                ),
                acknowledged=False,
            )
        assert source.is_file()

    def test_execution_refuses_a_snapshot_whose_acknowledgement_was_stripped(
        self, tmp_path: Path, quarantine: QuarantineStore
    ) -> None:
        source = _file(tmp_path / "input" / "photo.jpg")
        snapshot = _snapshot(
            ResolvedOutcome(
                member_id="dupe",
                kind="quarantine",
                mutates_source=True,
                requires_acknowledgement=True,
            )
        )
        tampered = snapshot.model_copy(update={"acknowledged_source_mutations": False})

        with pytest.raises(ExecutionRefused):
            execute_snapshot(tampered, quarantine=quarantine, source_for=lambda _id: source)
        assert source.is_file()


class TestFailureInjection:
    def test_a_vanished_file_fails_only_its_own_action(
        self, tmp_path: Path, quarantine: QuarantineStore
    ) -> None:
        present = _file(tmp_path / "library" / "here.jpg")
        missing = tmp_path / "library" / "gone.jpg"
        snapshot = _snapshot(
            ResolvedOutcome(member_id="gone", kind="quarantine"),
            ResolvedOutcome(member_id="here", kind="quarantine"),
        )
        paths = {"gone": missing, "here": present}

        report = execute_snapshot(
            snapshot, quarantine=quarantine, source_for=lambda member: paths[member]
        )

        assert report.code == "partial"
        assert report.counts == {"failed": 1, "completed": 1}
        assert not present.exists()  # the healthy action still ran

    def test_an_unlocatable_member_is_reported_not_raised(
        self, tmp_path: Path, quarantine: QuarantineStore
    ) -> None:
        snapshot = _snapshot(ResolvedOutcome(member_id="unknown", kind="quarantine"))

        def resolve(member_id: str) -> Path:
            raise KeyError(member_id)

        report = execute_snapshot(snapshot, quarantine=quarantine, source_for=resolve)

        assert report.code == "failed"
        assert "could not be located" in (report.actions[0].detail or "")

    def test_cancellation_stops_between_actions_and_leaves_the_rest_alone(
        self, tmp_path: Path, quarantine: QuarantineStore
    ) -> None:
        files = {f"m{index}": _file(tmp_path / "library" / f"{index}.jpg") for index in range(4)}
        snapshot = _snapshot(*[ResolvedOutcome(member_id=key, kind="quarantine") for key in files])
        calls = {"count": 0}

        def cancel() -> bool:
            calls["count"] += 1
            return calls["count"] > 2

        report = execute_snapshot(
            snapshot,
            quarantine=quarantine,
            source_for=lambda member: files[member],
            cancel=cancel,
        )

        assert report.cancelled is True
        assert report.code == "cancelled"
        assert sum(1 for path in files.values() if path.exists()) == 2

    def test_every_action_is_reported_as_it_happens(
        self, tmp_path: Path, quarantine: QuarantineStore
    ) -> None:
        source = _file(tmp_path / "library" / "a.jpg")
        snapshot = _snapshot(ResolvedOutcome(member_id="a", kind="quarantine"))
        seen: list[str] = []

        execute_snapshot(
            snapshot,
            quarantine=quarantine,
            source_for=lambda _id: source,
            on_action=lambda record: seen.append(record.state),
        )

        assert seen == ["completed"]


class TestReconciliation:
    def test_a_clean_run_needs_no_reconciliation(
        self, tmp_path: Path, quarantine: QuarantineStore
    ) -> None:
        source = _file(tmp_path / "library" / "a.jpg")
        report = execute_snapshot(
            _snapshot(ResolvedOutcome(member_id="a", kind="quarantine")),
            quarantine=quarantine,
            source_for=lambda _id: source,
        )

        assert reconcile(report, quarantine) == ()

    def test_a_missing_quarantined_file_is_reported(
        self, tmp_path: Path, quarantine: QuarantineStore
    ) -> None:
        source = _file(tmp_path / "library" / "a.jpg")
        report = execute_snapshot(
            _snapshot(ResolvedOutcome(member_id="a", kind="quarantine")),
            quarantine=quarantine,
            source_for=lambda _id: source,
        )
        Path(report.actions[0].result_path or "").unlink()

        assert any("missing" in note for note in reconcile(report, quarantine))

    def test_failed_actions_are_collected_across_runs(
        self, tmp_path: Path, quarantine: QuarantineStore
    ) -> None:
        snapshot = _snapshot(ResolvedOutcome(member_id="gone", kind="quarantine"))
        report = execute_snapshot(
            snapshot,
            quarantine=quarantine,
            source_for=lambda _id: tmp_path / "nowhere.jpg",
        )

        assert len(unresolved_actions([report, report])) == 2


class TestPrerequisiteContracts:
    """This change depends on the indexing work; that dependency is asserted."""

    def test_the_catalog_paging_and_checkpoint_contracts_exist(self, tmp_path: Path) -> None:
        from app.services.catalog import MediaCatalog
        from app.services.catalog_duplicates import CatalogDuplicateIndex

        with MediaCatalog(tmp_path / "catalog.db") as catalog:
            catalog.register_root("r1", tmp_path, role="input")
            index = CatalogDuplicateIndex(catalog)

            assert callable(catalog.iter_files)  # cursor paging
            assert callable(catalog.save_checkpoint) and callable(catalog.checkpoint)
            assert callable(index.exact_matches) and callable(index.perceptual_candidates)
            assert catalog.root_path("r1") is not None  # typed roots

    def test_the_progress_contract_carries_honest_totals(self) -> None:
        from app.api.schemas import TaskProgressData

        progress = TaskProgressData(current=0, total=0, percentage=0.0)

        assert progress.total_known is False
        assert progress.eta_confidence == "unknown"

    def test_a_group_member_can_be_built_from_catalog_facts(self) -> None:
        member = GroupMember(
            member_id="r1:1",
            root_id="r1",
            role="input",
            relative_path="a.jpg",
            observed_path="/library/a.jpg",
            facts=MemberFacts(size_bytes=1, modified_at=FactValue.of(1)),
            evidence=MemberEvidence(sha256="a" * 64, confidence="high"),
        )

        assert member.mutable is True
