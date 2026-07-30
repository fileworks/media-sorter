"""Contract tests for versioned library profiles and scalable API models."""

from __future__ import annotations

from datetime import datetime

import pytest
from pydantic import ValidationError

from app.core.library_profiles import (
    CatalogPlacement,
    DurableCheckpoint,
    EffectiveProfileSnapshot,
    LibraryProfile,
    LibraryRoot,
    ProgressDimension,
    ResourcePreferences,
    ResultPage,
    ResultPageRequest,
    RootIdentity,
    RunOverrides,
    ScalableProgress,
)


def test_legacy_profile_contains_one_input_and_destination() -> None:
    profile = LibraryProfile.from_legacy(
        source_directory="/media/in",
        target_directory="/media/out",
        copy_instead_of_move=True,
    )

    assert profile.schema_version == 1
    assert [root.path for root in profile.inputs] == ["/media/in"]
    assert profile.destination is not None
    assert profile.destination.path == "/media/out"
    assert profile.references == []
    assert profile.transfer_mode == "copy"
    assert profile.catalog.mode == "application_data"
    assert profile.catalog.relative_path is None


def test_legacy_directory_adapter_preserves_extra_inputs_and_references() -> None:
    profile = LibraryProfile(
        roots=[
            LibraryRoot(root_id="primary", role="input", path="/old"),
            LibraryRoot(root_id="second", role="input", path="/second", priority=1),
            LibraryRoot(root_id="truth", role="reference", path="/reference"),
            LibraryRoot(root_id="dest", role="destination", path="/dest"),
        ]
    )

    updated = profile.with_legacy_directories(
        source_directory="/new",
        target_directory="/new-dest",
        copy_instead_of_move=True,
    )

    assert [(root.root_id, root.path) for root in updated.inputs] == [
        ("primary", "/new"),
        ("second", "/second"),
    ]
    assert [(root.root_id, root.path) for root in updated.references] == [("truth", "/reference")]
    assert updated.destination is not None
    assert updated.destination.root_id == "dest"
    assert updated.destination.path == "/new-dest"
    assert updated.transfer_mode == "copy"


def test_profile_rejects_duplicate_root_ids_and_destinations() -> None:
    with pytest.raises(ValidationError, match="root ids"):
        LibraryProfile(
            roots=[
                LibraryRoot(root_id="same", role="input", path="/a"),
                LibraryRoot(root_id="same", role="reference", path="/b"),
            ]
        )

    with pytest.raises(ValidationError, match="at most one destination"):
        LibraryProfile(
            roots=[
                LibraryRoot(root_id="dest-a", role="destination", path="/a"),
                LibraryRoot(root_id="dest-b", role="destination", path="/b"),
            ]
        )


@pytest.mark.parametrize(
    "relative_path",
    ["/catalog.sqlite3", "../catalog.sqlite3", "C:/catalog.sqlite3"],
)
def test_portable_catalog_rejects_paths_outside_profile(relative_path: str) -> None:
    with pytest.raises(ValidationError):
        CatalogPlacement(mode="portable", relative_path=relative_path)


def test_portable_catalog_accepts_safe_relative_path() -> None:
    placement = CatalogPlacement(mode="portable", relative_path="profile.catalog.sqlite3")
    assert placement.relative_path == "profile.catalog.sqlite3"


def test_custom_resource_mode_requires_a_limit() -> None:
    with pytest.raises(ValidationError, match="requires at least one"):
        ResourcePreferences(mode="custom")


def test_root_identity_round_trip_preserves_confidence() -> None:
    identity = RootIdentity(
        confidence="high",
        canonical_path="/Volumes/Media",
        volume_id="volume-1",
        filesystem_id="apfs",
        root_file_id="inode-2",
        platform="darwin",
    )
    restored = RootIdentity.model_validate_json(identity.model_dump_json())
    assert restored == identity
    assert isinstance(restored.observed_at, datetime)


def test_effective_snapshot_and_checkpoint_are_versioned() -> None:
    profile = LibraryProfile.from_legacy(
        source_directory="/in",
        target_directory="/out",
        copy_instead_of_move=False,
    )
    checkpoint = DurableCheckpoint(
        operation_id="operation-1",
        profile_id=profile.profile_id,
        profile_schema_version=profile.schema_version,
        catalog_schema_version=1,
        phase="discovery",
        high_water_marks={"last_path": "2024/image.jpg", "count": 10},
        algorithm_versions={"fingerprint": "1"},
    )
    snapshot = EffectiveProfileSnapshot(
        profile=profile,
        run_overrides=RunOverrides(values={"recursive_scan": False}),
        effective_config_hash="a" * 64,
    )
    progress = ScalableProgress(
        mode="indeterminate",
        phase="discovery",
        dimensions=[ProgressDimension(unit="files", completed=10)],
        checkpoint=checkpoint,
    )

    assert snapshot.profile.profile_id == checkpoint.profile_id
    assert checkpoint.schema_version == 1
    assert progress.dimensions[0].total is None


def test_result_page_contract_is_bounded_and_generic() -> None:
    request = ResultPageRequest(limit=500, sort="size", descending=True)
    page = ResultPage[dict[str, str]](
        generation_id="generation-1",
        items=[{"path": "a.jpg"}],
        next_cursor="opaque",
        total_count=1,
    )

    assert request.limit == 500
    assert page.items[0]["path"] == "a.jpg"
    with pytest.raises(ValidationError):
        ResultPageRequest(limit=501)
