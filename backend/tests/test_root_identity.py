"""Cross-platform contracts for read-only root identity probing."""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.core.library_profiles import RootIdentity
from app.core.root_identity import canonical_path_key, probe_root_identity, same_root


def test_existing_directory_has_online_identity(tmp_path: Path) -> None:
    root = tmp_path / "library"
    root.mkdir()

    result = probe_root_identity(root)

    assert result.availability == "online"
    assert result.error_code is None
    assert result.identity.canonical_path == canonical_path_key(root.resolve())
    assert result.identity.volume_id
    assert result.identity.root_file_id
    assert result.identity.confidence == "medium"


def test_symlink_alias_resolves_to_same_root(tmp_path: Path) -> None:
    root = tmp_path / "library"
    root.mkdir()
    alias = tmp_path / "alias"
    try:
        alias.symlink_to(root, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks are unavailable on this runner")

    direct = probe_root_identity(root)
    through_alias = probe_root_identity(alias)

    assert through_alias.availability == "online"
    assert same_root(direct.identity, through_alias.identity)
    assert through_alias.identity.canonical_path == direct.identity.canonical_path


def test_missing_directory_is_offline_not_empty(tmp_path: Path) -> None:
    missing = tmp_path / "unmounted"

    result = probe_root_identity(missing)

    assert result.availability == "offline"
    assert result.error_code == "root_missing"
    assert result.identity.confidence == "unresolved"


def test_regular_file_is_not_a_root(tmp_path: Path) -> None:
    file_path = tmp_path / "image.jpg"
    file_path.write_bytes(b"image")

    result = probe_root_identity(file_path)

    assert result.availability == "not_directory"
    assert result.error_code == "root_not_directory"


def test_windows_comparison_key_normalizes_case_and_separators() -> None:
    upper = canonical_path_key(r"C:/Media/Family", platform="win32")
    lower = canonical_path_key(r"c:\\media\\family", platform="win32")
    assert upper == lower


def test_similar_prefixes_are_distinct(tmp_path: Path) -> None:
    media = tmp_path / "media"
    media_backup = tmp_path / "media-backup"
    media.mkdir()
    media_backup.mkdir()

    assert not same_root(
        probe_root_identity(media).identity,
        probe_root_identity(media_backup).identity,
    )


def test_path_only_identity_requires_equal_canonical_path() -> None:
    left = RootIdentity(confidence="path_only", canonical_path="/media/a")
    same = RootIdentity(confidence="path_only", canonical_path="/media/a")
    other = RootIdentity(confidence="path_only", canonical_path="/media/b")

    assert same_root(left, same)
    assert not same_root(left, other)


@pytest.mark.skipif(os.name != "nt", reason="Windows volume contract")
def test_windows_probe_uses_volume_serial(tmp_path: Path) -> None:
    result = probe_root_identity(tmp_path)
    assert result.availability == "online"
    assert result.identity.volume_id is not None
    assert result.identity.volume_id.startswith(("windows-volume:", "device:"))
