"""What the catalog does when the world misbehaves.

Removable drives disappear, network shares time out, traversals stop halfway,
schemas move forward and then back, and processes die between batches. Each of
those has one correct behaviour, and it is almost never "assume the library
changed".
"""

from __future__ import annotations

import os
import sqlite3
import stat
import sys
from pathlib import Path

import pytest

from app.core.catalog_schema import CATALOG_SCHEMA_VERSION, CatalogCorruptionError
from app.core.library_profiles import CatalogPlacement
from app.services.catalog import MediaCatalog, ObservedFile
from app.services.catalog_location import catalog_path, freshness, open_catalog, reset_catalog
from app.services.discovery import TraversalRules, discover_into_catalog
from app.services.pipeline import batched


def _library(root: Path, files: int = 10) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    for index in range(files):
        (root / f"{index:03}.jpg").write_bytes(b"x" * (10 + index))
    return root


class TestRemovableAndOfflineRoots:
    def test_a_root_that_vanishes_leaves_the_index_intact(self, tmp_path: Path) -> None:
        root = _library(tmp_path / "removable")
        with MediaCatalog(tmp_path / "catalog.db") as catalog:
            catalog.register_root("r1", root, role="input")
            discover_into_catalog(catalog, "r1", root)
            before = sum(1 for _ in catalog.iter_files("r1"))

            for path in root.iterdir():
                path.unlink()
            root.rmdir()
            stats = discover_into_catalog(catalog, "r1", root)

            # The drive is gone, not the library. A scan that could not read the
            # root reports issues and must not mark anything missing.
            assert stats.outcome != "complete"
            assert sum(1 for _ in catalog.iter_files("r1")) == before

    def test_an_unreadable_subtree_makes_the_scan_partial(self, tmp_path: Path) -> None:
        if sys.platform.startswith("win"):
            pytest.skip("POSIX permissions do not apply here")
        root = _library(tmp_path / "library", files=4)
        locked = root / "locked"
        locked.mkdir()
        (locked / "hidden.jpg").write_bytes(b"secret")
        os.chmod(locked, 0o000)

        try:
            with MediaCatalog(tmp_path / "catalog.db") as catalog:
                catalog.register_root("r1", root, role="input")
                stats = discover_into_catalog(catalog, "r1", root)

                assert stats.outcome == "partial"
                assert catalog.last_complete_generation("r1") is None
                assert freshness(catalog, "r1").state == "unknown"
        finally:
            os.chmod(locked, stat.S_IRWXU)

    def test_a_root_that_returns_stops_being_missing(self, tmp_path: Path) -> None:
        root = _library(tmp_path / "library", files=3)
        with MediaCatalog(tmp_path / "catalog.db") as catalog:
            catalog.register_root("r1", root, role="input")
            discover_into_catalog(catalog, "r1", root)

            removed = root / "000.jpg"
            content = removed.read_bytes()
            removed.unlink()
            discover_into_catalog(catalog, "r1", root)
            assert sum(1 for _ in catalog.iter_files("r1")) == 2

            removed.write_bytes(content)
            discover_into_catalog(catalog, "r1", root)

            assert sum(1 for _ in catalog.iter_files("r1")) == 3


class TestTimeoutsAndPartialTraversal:
    def test_a_traversal_that_stops_early_is_cancelled_not_complete(self, tmp_path: Path) -> None:
        root = _library(tmp_path / "library", files=30)
        with MediaCatalog(tmp_path / "catalog.db") as catalog:
            catalog.register_root("r1", root, role="input")
            calls = {"count": 0}

            def cancel() -> bool:
                calls["count"] += 1
                return calls["count"] > 3

            stats = discover_into_catalog(catalog, "r1", root, cancel=cancel)

            assert stats.cancelled is True
            assert catalog.last_complete_generation("r1") is None

    def test_a_partial_run_still_commits_the_batches_it_finished(self, tmp_path: Path) -> None:
        root = _library(tmp_path / "library", files=30)
        written: list[int] = []
        with MediaCatalog(tmp_path / "catalog.db") as catalog:
            catalog.register_root("r1", root, role="input")
            calls = {"count": 0}

            def cancel() -> bool:
                calls["count"] += 1
                return calls["count"] > 25

            discover_into_catalog(
                catalog,
                "r1",
                root,
                batch_size=5,
                cancel=cancel,
                on_batch=lambda count, _stats: written.append(count),
            )

            assert written  # at least one batch landed
            assert sum(1 for _ in catalog.iter_files("r1")) == written[-1]


class TestCatalogPlacement:
    def test_the_application_data_catalog_stays_out_of_the_library(self, tmp_path: Path) -> None:
        library = _library(tmp_path / "library")

        path = catalog_path(CatalogPlacement(), data_dir=tmp_path / "appdata")

        assert library not in path.parents

    def test_a_portable_catalog_lives_beside_its_profile(self, tmp_path: Path) -> None:
        placement = CatalogPlacement(mode="portable", relative_path="library.db")
        profile_dir = tmp_path / "profile"
        profile_dir.mkdir()

        with open_catalog(placement, data_dir=tmp_path, profile_dir=profile_dir) as catalog:
            catalog.register_root("r1", tmp_path, role="input")

            assert catalog.path.parent == profile_dir

    def test_both_placements_hold_the_same_schema(self, tmp_path: Path) -> None:
        profile_dir = tmp_path / "profile"
        profile_dir.mkdir()

        with open_catalog(CatalogPlacement(), data_dir=tmp_path / "app") as app_catalog:
            with open_catalog(
                CatalogPlacement(mode="portable", relative_path="p.db"),
                data_dir=tmp_path,
                profile_dir=profile_dir,
            ) as portable:
                assert app_catalog.schema_version == portable.schema_version


class TestSchemaRollback:
    def test_a_newer_schema_is_refused_rather_than_downgraded(self, tmp_path: Path) -> None:
        path = tmp_path / "catalog.db"
        with MediaCatalog(path) as catalog:
            catalog.register_root("r1", tmp_path, role="input")
        connection = sqlite3.connect(path)
        connection.execute(f"PRAGMA user_version = {CATALOG_SCHEMA_VERSION + 5}")
        connection.commit()
        connection.close()

        with pytest.raises(CatalogCorruptionError, match="newer build"):
            MediaCatalog(path)

    def test_resetting_recovers_from_an_unusable_catalog(self, tmp_path: Path) -> None:
        path = tmp_path / "catalog.db"
        with MediaCatalog(path) as catalog:
            catalog.register_root("r1", tmp_path, role="input")
        connection = sqlite3.connect(path)
        connection.execute(f"PRAGMA user_version = {CATALOG_SCHEMA_VERSION + 5}")
        connection.commit()
        connection.close()

        assert reset_catalog(path) is True
        with MediaCatalog(path) as rebuilt:
            assert rebuilt.schema_version == CATALOG_SCHEMA_VERSION

    def test_a_corrupt_file_is_refused_before_it_is_trusted(self, tmp_path: Path) -> None:
        path = tmp_path / "broken.db"
        path.write_bytes(b"SQLite format 3\x00" + b"\x7f" * 8192)

        with pytest.raises((CatalogCorruptionError, sqlite3.DatabaseError)):
            MediaCatalog(path)


class TestCrashAtBatchBoundaries:
    def test_a_crash_between_batches_costs_only_the_current_batch(self, tmp_path: Path) -> None:
        path = tmp_path / "catalog.db"
        observed = [
            ObservedFile(f"{index:03}.jpg", 100, 1_000, file_identity=str(index))
            for index in range(25)
        ]

        with MediaCatalog(path) as catalog:
            catalog.register_root("r1", tmp_path, role="input")
            generation = catalog.begin_generation("r1")
            for batch in list(batched(observed, 10))[:2]:
                catalog.observe("r1", generation, batch)
            # The process dies here: the generation is never finished.

        with MediaCatalog(path) as reopened:
            # Twenty rows survived; the unfinished generation pruned nothing.
            assert sum(1 for _ in reopened.iter_files("r1")) == 20
            assert reopened.last_complete_generation("r1") is None

    def test_the_next_run_completes_what_the_crashed_one_started(self, tmp_path: Path) -> None:
        path = tmp_path / "catalog.db"
        root = _library(tmp_path / "library", files=12)

        with MediaCatalog(path) as catalog:
            catalog.register_root("r1", root, role="input")
            generation = catalog.begin_generation("r1")
            catalog.observe(
                "r1",
                generation,
                [ObservedFile("000.jpg", 10, 1, file_identity="0")],
            )

        with MediaCatalog(path) as reopened:
            stats = discover_into_catalog(reopened, "r1", root)

            assert stats.outcome == "complete"
            assert sum(1 for _ in reopened.iter_files("r1")) == 12

    def test_a_checkpoint_written_after_its_batch_never_claims_more(self, tmp_path: Path) -> None:
        with MediaCatalog(tmp_path / "catalog.db") as catalog:
            catalog.register_root("r1", tmp_path, role="input")
            generation = catalog.begin_generation("r1")
            catalog.observe(
                "r1",
                generation,
                [ObservedFile("a.jpg", 1, 1, file_identity="a")],
            )
            catalog.save_checkpoint("op1", cursor=1, phase="discovery")

            stored = catalog.checkpoint("op1")

            assert stored is not None
            assert stored["cursor"] <= sum(1 for _ in catalog.iter_files("r1"))


class TestTraversalRulesAcrossPlatforms:
    def test_exclusions_use_segments_rather_than_prefixes(self, tmp_path: Path) -> None:
        root = tmp_path / "library"
        (root / "photos").mkdir(parents=True)
        (root / "photos-old").mkdir(parents=True)
        (root / "photos" / "a.jpg").write_bytes(b"a")
        (root / "photos-old" / "b.jpg").write_bytes(b"b")

        with MediaCatalog(tmp_path / "catalog.db") as catalog:
            catalog.register_root("r1", root, role="input")
            discover_into_catalog(catalog, "r1", root, TraversalRules(exclusions=(Path("photos"),)))

            paths = {record.relative_path for record in catalog.iter_files("r1")}

        assert paths == {"photos-old/b.jpg"}
