"""C-05: a directory cycle must end the walk, not the process.

`_walk_result` recursed whenever `max_depth is None` — the shipped default — and
`Path.is_dir()` follows symlinks. So `a/loop -> ..` descended forever until
`RecursionError`, which aborts the entire scan rather than skipping one folder.

Three things fix it together, and each catches a case the others miss: a
`(st_dev, st_ino)` visited set recognises a cycle however it was formed, a
finite ceiling bounds even an acyclic-but-absurd tree, and both report the skip
instead of swallowing it.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.services.filesystem_service import (
    MAX_TRAVERSAL_DEPTH,
    FileSystemService,
    TraversalResult,
)


def _image(path: Path) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b"\xff\xd8\xff\xe0jpeg")
    return path


@pytest.fixture()
def service() -> FileSystemService:
    return FileSystemService()


def _walk(
    service: FileSystemService, root: Path, *, max_depth: int | None = None
) -> TraversalResult:
    result = TraversalResult()
    service._walk_result(
        root,
        root,
        True,
        max_depth,
        0,
        result,
        [],
        None,
        None,
        None,
        (),
        is_root=True,
    )
    return result


class TestSymlinkCycles:
    def test_a_self_referential_symlink_terminates_and_reports(
        self, service: FileSystemService, tmp_path: Path
    ) -> None:
        """The exact shape from the finding: `a/loop -> ..`."""
        root = tmp_path / "library"
        inner = root / "a"
        inner.mkdir(parents=True)
        _image(inner / "photo.jpg")
        os.symlink(root, inner / "loop", target_is_directory=True)

        result = _walk(service, root)

        assert len(result.files) == 1
        assert any(issue.error_class == "DirectoryCycle" for issue in result.issues), (
            "the cycle was traversed silently or not at all"
        )

    def test_a_two_step_cycle_also_terminates(
        self, service: FileSystemService, tmp_path: Path
    ) -> None:
        root = tmp_path / "library"
        first = root / "one"
        second = root / "two"
        first.mkdir(parents=True)
        second.mkdir(parents=True)
        _image(first / "a.jpg")
        os.symlink(second, first / "to_two", target_is_directory=True)
        os.symlink(first, second / "to_one", target_is_directory=True)

        result = _walk(service, root)

        assert len(result.files) == 1
        assert any(issue.error_class == "DirectoryCycle" for issue in result.issues)

    def test_a_symlink_to_a_real_sibling_is_still_followed_once(
        self, service: FileSystemService, tmp_path: Path
    ) -> None:
        """The guard must not turn every symlink into a dead end.

        A user who symlinks a folder into their library means it to be scanned.
        Only the *second* visit is refused.
        """
        root = tmp_path / "library"
        elsewhere = tmp_path / "elsewhere"
        root.mkdir()
        elsewhere.mkdir()
        _image(elsewhere / "linked.jpg")
        os.symlink(elsewhere, root / "link", target_is_directory=True)

        result = _walk(service, root)

        assert [path.name for path in result.files] == ["linked.jpg"]


class TestDepthCeiling:
    def test_an_unbounded_request_still_stops_at_the_ceiling(
        self, service: FileSystemService, tmp_path: Path
    ) -> None:
        """`max_recursion_depth: None` is the shipped default."""
        root = tmp_path / "library"
        deep = root
        for index in range(MAX_TRAVERSAL_DEPTH + 5):
            deep = deep / f"d{index}"
        _image(deep / "buried.jpg")

        result = _walk(service, root)

        assert result.files == []
        assert any(issue.error_class == "MaxDepthReached" for issue in result.issues)

    def test_an_ordinary_library_is_unaffected(
        self, service: FileSystemService, tmp_path: Path
    ) -> None:
        root = tmp_path / "library"
        _image(root / "2024" / "01" / "15" / "photo.jpg")

        result = _walk(service, root)

        assert [path.name for path in result.files] == ["photo.jpg"]
        assert result.issues == []

    def test_an_explicit_shallower_limit_still_wins(
        self, service: FileSystemService, tmp_path: Path
    ) -> None:
        root = tmp_path / "library"
        _image(root / "one" / "two" / "deep.jpg")
        _image(root / "top.jpg")

        result = _walk(service, root, max_depth=1)

        assert [path.name for path in result.files] == ["top.jpg"]


def test_a_cycle_yields_each_file_once_and_reports_the_cycle(
    service: FileSystemService, tmp_path: Path
) -> None:
    """The measured defect, not the predicted one.

    Before the fix this returned the same photo 16 times with an empty issue
    list. Counting one file as sixteen is not a crash, which is exactly why it
    was worth finding: it flows into the counts, the dedup index and the plan
    without ever announcing itself.
    """
    root = tmp_path / "library"
    inner = root / "a"
    inner.mkdir(parents=True)
    _image(inner / "photo.jpg")
    os.symlink(root, inner / "loop", target_is_directory=True)
    os.symlink(inner, root / "back", target_is_directory=True)

    result = _walk(service, root)

    assert len(result.files) == len({path.resolve() for path in result.files}), (
        "the same file was enumerated more than once"
    )
    assert len(result.files) == 1
    assert result.issues, "a cycle must be reported, not silently pruned"
