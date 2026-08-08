"""Discovery streams, obeys the profile's rules, and never lies about coverage."""

from __future__ import annotations

import os
import stat
from collections.abc import Iterator
from pathlib import Path

import pytest

from app.services.catalog import MediaCatalog
from app.services.discovery import (
    DiscoveryStats,
    TraversalRules,
    discover_into_catalog,
    discover_many,
    walk,
)


@pytest.fixture()
def catalog(tmp_path: Path) -> Iterator[MediaCatalog]:
    with MediaCatalog(tmp_path / "catalog.db") as opened:
        opened.register_root("r1", tmp_path / "library")
        yield opened


def _library(root: Path, files: int = 5, *, nested: bool = True) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    for index in range(files):
        (root / f"file{index}.jpg").write_bytes(b"x" * (index + 1))
    if nested:
        (root / "sub").mkdir(exist_ok=True)
        (root / "sub" / "deep.jpg").write_bytes(b"deep")
        (root / "sub" / "deeper").mkdir(exist_ok=True)
        (root / "sub" / "deeper" / "deepest.jpg").write_bytes(b"deepest")
    return root


class TestTraversal:
    def test_it_finds_every_file_in_the_tree(self, tmp_path: Path) -> None:
        root = _library(tmp_path / "library")
        stats = DiscoveryStats()

        found = list(walk(root, TraversalRules(), stats))

        assert len(found) == 7
        assert stats.files == 7
        assert stats.complete is True

    def test_non_recursive_stays_at_the_top(self, tmp_path: Path) -> None:
        root = _library(tmp_path / "library")
        stats = DiscoveryStats()

        found = list(walk(root, TraversalRules(recursive=False), stats))

        assert {item.relative_path for item in found} == {f"file{i}.jpg" for i in range(5)}

    def test_depth_is_respected(self, tmp_path: Path) -> None:
        root = _library(tmp_path / "library")
        stats = DiscoveryStats()

        found = list(walk(root, TraversalRules(max_depth=1), stats))

        assert not any("deeper" in item.relative_path for item in found)
        assert any("sub" in item.relative_path for item in found)

    def test_an_excluded_subtree_is_never_entered(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        root = _library(tmp_path / "library")
        stats = DiscoveryStats()
        excluded = root / "sub"
        real_iterdir = Path.iterdir

        def guarded_iterdir(path: Path):  # type: ignore[no-untyped-def]
            if path == excluded:
                raise AssertionError("excluded subtree was entered")
            return real_iterdir(path)

        monkeypatch.setattr(Path, "iterdir", guarded_iterdir)

        found = list(walk(root, TraversalRules(exclusions=(Path("sub"),)), stats))

        assert not any(item.relative_path.startswith("sub") for item in found)
        assert stats.excluded >= 1

    def test_patterns_exclude_files_and_directories(self, tmp_path: Path) -> None:
        root = _library(tmp_path / "library", files=2, nested=False)
        (root / "thumbs.db").write_bytes(b"junk")
        stats = DiscoveryStats()

        found = list(walk(root, TraversalRules(exclude_patterns=("*.db",)), stats))

        assert {item.relative_path for item in found} == {"file0.jpg", "file1.jpg"}

    def test_size_bounds_are_applied(self, tmp_path: Path) -> None:
        root = tmp_path / "library"
        root.mkdir()
        (root / "tiny.jpg").write_bytes(b"x")
        (root / "big.jpg").write_bytes(b"x" * 5_000)
        stats = DiscoveryStats()

        found = list(walk(root, TraversalRules(min_file_size_bytes=100), stats))

        assert [item.relative_path for item in found] == ["big.jpg"]

    def test_an_unreadable_directory_is_an_issue_not_an_abort(self, tmp_path: Path) -> None:
        root = _library(tmp_path / "library", files=2, nested=False)
        locked = root / "locked"
        locked.mkdir()
        (locked / "hidden.jpg").write_bytes(b"secret")
        os.chmod(locked, 0o000)
        stats = DiscoveryStats()

        try:
            found = list(walk(root, TraversalRules(), stats))
        finally:
            os.chmod(locked, stat.S_IRWXU)

        assert len(found) == 2
        assert stats.issues
        assert stats.complete is False
        assert stats.outcome == "partial"

    def test_cancellation_stops_the_walk_and_marks_it(self, tmp_path: Path) -> None:
        root = _library(tmp_path / "library", files=50)
        stats = DiscoveryStats()
        seen = 0

        def cancel() -> bool:
            return seen >= 5

        for _ in walk(root, TraversalRules(), stats, cancel=cancel):
            seen += 1

        assert stats.cancelled is True
        assert stats.outcome == "cancelled"

    def test_symlinks_are_skipped_unless_asked_for(self, tmp_path: Path) -> None:
        root = _library(tmp_path / "library", files=1, nested=False)
        outside = tmp_path / "outside"
        outside.mkdir()
        (outside / "elsewhere.jpg").write_bytes(b"elsewhere")
        try:
            (root / "link").symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):  # pragma: no cover - platform dependent
            pytest.skip("symlinks are not available here")
        stats = DiscoveryStats()

        found = list(walk(root, TraversalRules(), stats))

        assert [item.relative_path for item in found] == ["file0.jpg"]


class TestCatalogWriting:
    def test_a_complete_walk_lands_in_the_catalog(
        self, catalog: MediaCatalog, tmp_path: Path
    ) -> None:
        root = _library(tmp_path / "library")

        stats = discover_into_catalog(catalog, "r1", root, batch_size=2)

        assert stats.outcome == "complete"
        assert sum(1 for _ in catalog.iter_files("r1")) == 7

    def test_batches_commit_as_they_go(self, catalog: MediaCatalog, tmp_path: Path) -> None:
        root = _library(tmp_path / "library", files=10, nested=False)
        seen: list[int] = []

        discover_into_catalog(
            catalog, "r1", root, batch_size=3, on_batch=lambda written, _s: seen.append(written)
        )

        assert seen == [3, 6, 9, 10]

    def test_a_cancelled_walk_never_prunes_earlier_records(
        self, catalog: MediaCatalog, tmp_path: Path
    ) -> None:
        root = _library(tmp_path / "library", files=6, nested=False)
        discover_into_catalog(catalog, "r1", root)
        before = sum(1 for _ in catalog.iter_files("r1"))

        calls = {"count": 0}

        def cancel() -> bool:
            calls["count"] += 1
            return calls["count"] > 2

        discover_into_catalog(catalog, "r1", root, cancel=cancel)

        assert sum(1 for _ in catalog.iter_files("r1")) == before

    def test_a_partial_walk_records_its_issues(self, catalog: MediaCatalog, tmp_path: Path) -> None:
        root = _library(tmp_path / "library", files=2, nested=False)
        locked = root / "locked"
        locked.mkdir()
        os.chmod(locked, 0o000)

        try:
            stats = discover_into_catalog(catalog, "r1", root)
        finally:
            os.chmod(locked, stat.S_IRWXU)

        assert stats.outcome == "partial"
        assert catalog.last_complete_generation("r1") is None

    def test_a_rescan_of_an_unchanged_library_keeps_derived_facts(
        self, catalog: MediaCatalog, tmp_path: Path
    ) -> None:
        root = _library(tmp_path / "library", files=3, nested=False)
        discover_into_catalog(catalog, "r1", root)
        first = next(iter(catalog.iter_files("r1")))
        catalog.store_hash(first, "a" * 64)

        discover_into_catalog(catalog, "r1", root)

        rescanned = next(iter(catalog.iter_files("r1")))
        assert catalog.hash_for(rescanned) == "a" * 64

    def test_several_roots_are_walked_independently(
        self, catalog: MediaCatalog, tmp_path: Path
    ) -> None:
        catalog.register_root("r2", tmp_path / "other", role="reference")
        first = _library(tmp_path / "library", files=2, nested=False)
        second = _library(tmp_path / "other", files=3, nested=False)

        results = discover_many(
            catalog,
            [("r1", first, TraversalRules()), ("r2", second, TraversalRules())],
        )

        assert results["r1"].files == 2
        assert results["r2"].files == 3

    def test_cancellation_between_roots_stops_the_rest(
        self, catalog: MediaCatalog, tmp_path: Path
    ) -> None:
        catalog.register_root("r2", tmp_path / "other", role="reference")
        first = _library(tmp_path / "library", files=1, nested=False)
        second = _library(tmp_path / "other", files=1, nested=False)

        checks = {"count": 0}

        def cancel() -> bool:
            # The one-file first root needs a handful of checks to finish; the
            # second root then finds cancellation already requested.
            checks["count"] += 1
            return checks["count"] > 3

        results = discover_many(
            catalog,
            [
                ("r1", first, TraversalRules()),
                ("r2", second, TraversalRules()),
            ],
            cancel=cancel,
        )

        assert set(results) == {"r1"}
        assert results["r1"].outcome == "complete"
