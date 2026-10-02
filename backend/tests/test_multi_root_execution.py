"""Every configured input is processed; reference roots are never touched."""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any

import pytest

from app.core.config import Config
from app.core.exceptions import MutationPolicyError
from app.core.integrity_policy import authorize_config_mutations
from app.core.library_profiles import LibraryProfile, LibraryRoot
from app.core.library_validation import validate_configured_library
from app.services.filesystem_service import FileSystemService
from app.services.operation_execution import OperationExecution
from app.services.sorting_service import root_identifier


def _profile(*roots: LibraryRoot) -> LibraryProfile:
    return LibraryProfile(profile_id="multi-root", name="Multi root", roots=list(roots))


def _media(path: Path, payload: bytes = b"media") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return path


def _execution(tmp_path: Path, protected: tuple[Path, ...] = ()) -> OperationExecution:
    config = Config(source_directory=str(tmp_path), target_directory=str(tmp_path / "sorted"))
    return OperationExecution.start(
        operation_id="op_multi",
        state_root=tmp_path / "state",
        preservation=config.preservation_profile,
        authorization=authorize_config_mutations(config),
        effective_config_sha256=hashlib.sha256(b"config").hexdigest(),
        protected_roots=protected,
    )


# ------------------------------------------------------------------ #
# Multiple inputs                                                      #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_every_input_root_contributes_files(tmp_path: Path) -> None:
    first = tmp_path / "phone"
    second = tmp_path / "camera"
    _media(first / "a.jpg")
    _media(second / "b.jpg")
    _media(second / "nested" / "c.jpg")

    enumerated = await FileSystemService().traverse_roots([(first, ()), (second, ())])

    assert {path.name for path in enumerated.result.files} == {"a.jpg", "b.jpg", "c.jpg"}


@pytest.mark.asyncio
async def test_each_file_remembers_the_root_it_came_from(tmp_path: Path) -> None:
    first = tmp_path / "phone"
    second = tmp_path / "camera"
    _media(first / "a.jpg")
    _media(second / "b.jpg")

    enumerated = await FileSystemService().traverse_roots([(first, ()), (second, ())])

    assert enumerated.root_of[first / "a.jpg"] == first
    assert enumerated.root_of[second / "b.jpg"] == second


@pytest.mark.asyncio
async def test_per_root_exclusions_apply_to_their_own_root_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = tmp_path / "phone"
    second = tmp_path / "camera"
    _media(first / "skip" / "a.jpg")
    _media(first / "keep" / "b.jpg")
    _media(second / "skip" / "c.jpg")
    excluded = first / "skip"
    real_iterdir = Path.iterdir

    def guarded_iterdir(path: Path):  # type: ignore[no-untyped-def]
        if path == excluded:
            raise AssertionError("excluded subtree was entered")
        return real_iterdir(path)

    monkeypatch.setattr(Path, "iterdir", guarded_iterdir)

    enumerated = await FileSystemService().traverse_roots([(first, (excluded,)), (second, ())])

    names = {path.name for path in enumerated.result.files}
    assert names == {"b.jpg", "c.jpg"}
    assert enumerated.result.excluded_directories >= 1


@pytest.mark.asyncio
async def test_one_unreadable_root_does_not_stop_the_others(tmp_path: Path) -> None:
    good = tmp_path / "phone"
    _media(good / "a.jpg")
    missing = tmp_path / "not-mounted"

    enumerated = await FileSystemService().traverse_roots([(missing, ()), (good, ())])

    assert {path.name for path in enumerated.result.files} == {"a.jpg"}


# ------------------------------------------------------------------ #
# Reference roots are comparison-only                                  #
# ------------------------------------------------------------------ #


def test_a_reference_root_can_never_be_a_source(tmp_path: Path) -> None:
    reference = tmp_path / "archive"
    source = _media(reference / "old.jpg")
    execution = _execution(tmp_path, protected=(reference,))

    with pytest.raises(MutationPolicyError) as error:
        execution.place(
            source,
            tmp_path / "sorted" / "old.jpg",
            kind="move",
            move=True,
            root_id=root_identifier(Path(str(reference))),
            relative_path="old.jpg",
        )

    assert error.value.details["reason"] == "reference_root_is_immutable"
    assert error.value.details["role"] == "source"
    assert source.read_bytes() == b"media"


def test_a_reference_root_can_never_be_a_destination(tmp_path: Path) -> None:
    reference = tmp_path / "archive"
    reference.mkdir()
    source = _media(tmp_path / "phone" / "new.jpg")
    execution = _execution(tmp_path, protected=(reference,))

    with pytest.raises(MutationPolicyError) as error:
        execution.place(
            source,
            reference / "new.jpg",
            kind="copy",
            move=False,
            root_id=root_identifier(Path(str(tmp_path / "phone"))),
            relative_path="new.jpg",
        )

    assert error.value.details["role"] == "destination"
    assert list(reference.iterdir()) == []


def test_the_refusal_is_recorded_as_an_integrity_violation(tmp_path: Path) -> None:
    reference = tmp_path / "archive"
    source = _media(reference / "old.jpg")
    execution = _execution(tmp_path, protected=(reference,))

    with pytest.raises(MutationPolicyError):
        execution.place(
            source,
            tmp_path / "sorted" / "old.jpg",
            kind="move",
            move=True,
            root_id=root_identifier(Path(str(reference))),
            relative_path="old.jpg",
        )

    assert execution.events is not None
    codes = [event.event_code for event in execution.events.events]
    assert "integrity.violation" in codes


def test_a_sibling_of_a_reference_root_is_not_protected(tmp_path: Path) -> None:
    reference = tmp_path / "archive"
    reference.mkdir()
    source = _media(tmp_path / "archive-2024" / "new.jpg")
    execution = _execution(tmp_path, protected=(reference,))

    result = execution.place(
        source,
        tmp_path / "sorted" / "new.jpg",
        kind="copy",
        move=False,
        root_id=root_identifier(Path(str(tmp_path / "archive-2024"))),
        relative_path="new.jpg",
    )

    assert result is not None
    assert result.destination_path.read_bytes() == b"media"


# ------------------------------------------------------------------ #
# Validation no longer blocks multi-root configurations                #
# ------------------------------------------------------------------ #


def test_a_multi_input_profile_validates_for_execution(tmp_path: Path) -> None:
    first = tmp_path / "phone"
    second = tmp_path / "camera"
    reference = tmp_path / "archive"
    for path in (first, second, reference, tmp_path / "sorted"):
        path.mkdir()
    config: Any = Config(
        source_directory=str(first),
        target_directory=str(tmp_path / "sorted"),
        library_profile=_profile(
            LibraryRoot(root_id="in-1", role="input", path=str(first)),
            LibraryRoot(root_id="in-2", role="input", path=str(second)),
            LibraryRoot(root_id="ref-1", role="reference", path=str(reference)),
            LibraryRoot(root_id="dest", role="destination", path=str(tmp_path / "sorted")),
        ),
    )

    validated = validate_configured_library(config)

    assert len(validated.inputs) == 2
    assert len(validated.references) == 1
    assert validated.destination is not None
