"""The directory listing that both browses folders and validates roots.

This endpoint is the only one that reports the filesystem back to the
interface, so the tests that matter are the ones proving what it will *not*
do: return a file, raise on an unreadable folder, or disagree with the sorter
about what "writable" means.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def tree(tmp_path: Path) -> Path:
    (tmp_path / "albums").mkdir()
    (tmp_path / "albums" / "2019").mkdir()
    (tmp_path / "scans").mkdir()
    (tmp_path / "photo.jpg").write_bytes(b"not a folder")
    (tmp_path / "notes.txt").write_text("also not a folder")
    return tmp_path


def test_lists_only_directories(client: TestClient, tree: Path) -> None:
    body = client.get("/api/fs/list", params={"path": str(tree)}).json()

    assert [entry["name"] for entry in body["entries"]] == ["albums", "scans"]
    assert all(entry["is_dir"] for entry in body["entries"])


def test_never_returns_a_file_entry(client: TestClient, tree: Path) -> None:
    body = client.get("/api/fs/list", params={"path": str(tree)}).json()

    names = {entry["name"] for entry in body["entries"]}
    assert "photo.jpg" not in names
    assert "notes.txt" not in names


def test_reports_the_parent_and_the_permissions(client: TestClient, tree: Path) -> None:
    body = client.get("/api/fs/list", params={"path": str(tree / "albums")}).json()

    assert body["path"] == str(tree / "albums")
    assert body["parent"] == str(tree)
    assert body["exists"] is True
    assert body["readable"] is True
    assert body["writable"] is True


def test_an_empty_path_returns_the_platform_roots(client: TestClient) -> None:
    body = client.get("/api/fs/list", params={"path": ""}).json()

    assert body["parent"] is None
    assert body["entries"], "the platform must offer somewhere to start browsing"
    assert all(entry["is_dir"] for entry in body["entries"])
    assert str(Path.home()) in {entry["path"] for entry in body["entries"]}


def test_a_missing_path_is_404(client: TestClient, tmp_path: Path) -> None:
    response = client.get("/api/fs/list", params={"path": str(tmp_path / "nope")})

    assert response.status_code == 404


def test_a_file_path_is_400(client: TestClient, tree: Path) -> None:
    response = client.get("/api/fs/list", params={"path": str(tree / "photo.jpg")})

    assert response.status_code == 400


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission bits")
@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores permission bits")
def test_an_unreadable_directory_is_200_and_empty_rather_than_an_error(
    client: TestClient, tmp_path: Path
) -> None:
    locked = tmp_path / "locked"
    locked.mkdir()
    (locked / "inside").mkdir()
    locked.chmod(0o000)
    try:
        response = client.get("/api/fs/list", params={"path": str(locked)})
    finally:
        locked.chmod(0o700)

    assert response.status_code == 200
    body = response.json()
    assert body["readable"] is False
    assert body["entries"] == []


@pytest.mark.skipif(sys.platform == "win32", reason="POSIX permission bits")
@pytest.mark.skipif(os.geteuid() == 0, reason="root ignores permission bits")
def test_writable_agrees_with_the_sorter(client: TestClient, tmp_path: Path) -> None:
    """The probe must match `validate_target_directory`, or a browsable folder
    could be rejected the moment the run starts."""
    from app.core.exceptions import SortingError
    from app.services.filesystem_service import validate_target_directory

    read_only = tmp_path / "read_only"
    read_only.mkdir()
    read_only.chmod(0o500)
    try:
        body = client.get("/api/fs/list", params={"path": str(read_only)}).json()
        assert body["writable"] is False
        with pytest.raises(SortingError):
            validate_target_directory(str(read_only))
    finally:
        read_only.chmod(0o700)
