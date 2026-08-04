"""Shared typed-root profile validation contracts."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.exceptions import LibraryProfileError
from app.core.library_profiles import LibraryProfile, LibraryRoot
from app.core.library_validation import validate_library_profile


def _root(root_id: str, role: str, path: Path, **kwargs) -> LibraryRoot:
    return LibraryRoot(root_id=root_id, role=role, path=str(path), **kwargs)


def test_validates_multiple_inputs_references_destination_and_exclusions(
    tmp_path: Path,
) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    reference = tmp_path / "reference"
    destination = tmp_path / "destination"
    for path in (first, second, reference):
        path.mkdir()
    (first / "ignored").mkdir()
    profile = LibraryProfile(
        roots=[
            _root("first", "input", first, exclusions=["ignored"]),
            _root("second", "input", second, priority=1),
            _root("reference", "reference", reference),
            _root("destination", "destination", destination),
        ]
    )

    validated = validate_library_profile(profile)

    assert [item.root.root_id for item in validated.inputs] == ["first", "second"]
    assert [item.root.root_id for item in validated.references] == ["reference"]
    assert validated.destination is not None
    assert validated.destination.canonical_path == destination
    assert validated.inputs[0].exclusions == ((first / "ignored").resolve(),)


def test_requires_input_and_destination() -> None:
    with pytest.raises(LibraryProfileError) as no_input:
        validate_library_profile(LibraryProfile())
    assert no_input.value.details["reason"] == "input_required"

    profile = LibraryProfile(roots=[LibraryRoot(root_id="input", role="input", path="/unresolved")])
    with pytest.raises(LibraryProfileError) as no_destination:
        validate_library_profile(profile)
    assert no_destination.value.details["reason"] == "destination_required"


def test_missing_reference_is_not_treated_as_empty(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    profile = LibraryProfile(
        roots=[
            _root("source", "input", source),
            _root("truth", "reference", tmp_path / "offline-reference"),
            _root("destination", "destination", tmp_path / "destination"),
        ]
    )

    with pytest.raises(LibraryProfileError) as error:
        validate_library_profile(profile)

    assert error.value.details["root_id"] == "truth"
    assert error.value.details["role"] == "reference"
    assert error.value.details["reason"] == "missing"


@pytest.mark.parametrize(
    "left_role,right_role",
    [
        ("input", "input"),
        ("input", "reference"),
        ("reference", "destination"),
    ],
)
def test_rejects_overlap_for_every_role_pair(
    tmp_path: Path,
    left_role: str,
    right_role: str,
) -> None:
    parent = tmp_path / "parent"
    child = parent / "child"
    parent.mkdir()
    child.mkdir()
    separate_input = tmp_path / "separate-input"
    separate_input.mkdir()
    separate_destination = tmp_path / "separate-destination"
    roots = [
        _root("left", left_role, parent),
        _root("right", right_role, child),
    ]
    if "input" not in (left_role, right_role):
        roots.append(_root("input", "input", separate_input))
    if "destination" not in (left_role, right_role):
        roots.append(_root("destination", "destination", separate_destination))
    profile = LibraryProfile(roots=roots)

    with pytest.raises(LibraryProfileError) as error:
        validate_library_profile(profile)

    assert error.value.details["reason"] == "root_overlap"
    assert {error.value.details["left_root_id"], error.value.details["right_root_id"]} >= {
        "left",
        "right",
    }


def test_accepts_similar_text_prefixes(tmp_path: Path) -> None:
    media = tmp_path / "media"
    media_backup = tmp_path / "media-backup"
    destination = tmp_path / "organized"
    media.mkdir()
    media_backup.mkdir()
    profile = LibraryProfile(
        roots=[
            _root("media", "input", media),
            _root("backup", "reference", media_backup),
            _root("destination", "destination", destination),
        ]
    )

    validated = validate_library_profile(profile)

    assert len(validated.inputs) == 1
    assert len(validated.references) == 1


@pytest.mark.parametrize("exclusion", ["../outside", "/absolute"])
def test_rejects_exclusion_outside_parent(tmp_path: Path, exclusion: str) -> None:
    source = tmp_path / "source"
    source.mkdir()
    profile = LibraryProfile(
        roots=[
            _root("source", "input", source, exclusions=[exclusion]),
            _root("destination", "destination", tmp_path / "destination"),
        ]
    )

    with pytest.raises(LibraryProfileError) as error:
        validate_library_profile(profile)

    assert error.value.details["reason"] == "invalid_exclusion"
