"""The catalog may forget, but it may never be wrong.

Two invariants carry every test here: a derived fact is returned only while it
is still provably about the current bytes, and a row becomes "missing" only
because a scan that actually finished failed to see it.
"""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
from collections.abc import Iterator
from contextlib import closing
from pathlib import Path
from typing import Any

import pytest

import app.services.catalog as catalog_module
from app.core.catalog_schema import (
    CATALOG_SCHEMA_VERSION,
    FINGERPRINT_ROLE,
    FINGERPRINT_VERSION,
    CatalogCorruptionError,
    apply_schema,
    fingerprint,
)
from app.services.catalog import MediaCatalog, ObservedFile, bounded_sample_sha256


@pytest.fixture()
def catalog(tmp_path: Path) -> Iterator[MediaCatalog]:
    with MediaCatalog(tmp_path / "catalog.db") as opened:
        yield opened


def observed(
    name: str, *, size: int = 100, mtime: int = 1_000, identity: str | None = "1"
) -> ObservedFile:
    return ObservedFile(
        relative_path=name,
        size_bytes=size,
        mtime_ns=mtime,
        file_identity=identity,
    )


def _scan(
    catalog: MediaCatalog, root_id: str, files: list[ObservedFile], *, outcome: Any = "complete"
) -> tuple[Any, Any]:
    generation = catalog.begin_generation(root_id)
    records = catalog.observe(root_id, generation, files)
    catalog.finish_generation(generation, outcome)
    return generation, records


class TestSchema:
    def test_a_fresh_catalog_reports_its_schema_version(self, catalog: MediaCatalog) -> None:
        assert catalog.schema_version == CATALOG_SCHEMA_VERSION

    def test_reopening_is_idempotent(self, tmp_path: Path) -> None:
        path = tmp_path / "catalog.db"
        with MediaCatalog(path) as first:
            first.register_root("r1", tmp_path)
        with MediaCatalog(path) as second:
            assert second.diagnostics().roots == 1

    @staticmethod
    def _snapshot(paths: tuple[Path, ...]) -> dict[Path, tuple[bytes, os.stat_result]]:
        content = {path: path.read_bytes() for path in paths}
        old_atime_ns = 946_684_800_000_000_000
        for path in paths:
            observed = path.stat()
            os.utime(path, ns=(old_atime_ns, observed.st_mtime_ns))
        return {path: (content[path], path.stat()) for path in paths}

    @staticmethod
    def _assert_unchanged(before: dict[Path, tuple[bytes, os.stat_result]]) -> None:
        after_stats = {path: path.stat() for path in before}
        for path, (content, observed) in before.items():
            current = after_stats[path]
            assert path.read_bytes() == content
            assert (
                current.st_ino,
                current.st_size,
                current.st_mode,
                current.st_atime_ns,
                current.st_mtime_ns,
                current.st_ctime_ns,
            ) == (
                observed.st_ino,
                observed.st_size,
                observed.st_mode,
                observed.st_atime_ns,
                observed.st_mtime_ns,
                observed.st_ctime_ns,
            )

    def test_future_main_schema_preflight_changes_no_file_metadata(self, tmp_path: Path) -> None:
        path = tmp_path / "future.db"
        with closing(sqlite3.connect(path)) as connection, connection:
            connection.execute(f"PRAGMA user_version = {CATALOG_SCHEMA_VERSION + 1}")
        before = self._snapshot((path,))

        with pytest.raises(CatalogCorruptionError, match="newer build"):
            MediaCatalog(path)

        self._assert_unchanged(before)
        assert not path.with_name(path.name + "-wal").exists()
        assert not path.with_name(path.name + "-shm").exists()
        assert not path.with_name(path.name + "-journal").exists()

    def test_windows_preflight_always_uses_the_no_atime_handle(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        source = tmp_path / "source.db"
        destination = tmp_path / "copy.db"
        source.write_bytes(b"SQLite fixture")
        calls: list[tuple[Path, Path]] = []
        monkeypatch.setattr(sys, "platform", "win32")
        monkeypatch.setattr(os, "name", "nt")
        monkeypatch.setattr(
            catalog_module,
            "_copy_windows_without_source_atime",
            lambda observed_source, observed_destination: calls.append(
                (observed_source, observed_destination)
            ),
        )

        catalog_module._copy_without_source_atime(source, destination)

        assert calls == [(source, destination)]
        assert not destination.exists()

    def test_a_concurrent_reader_does_not_invalidate_schema_inspection(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        path = tmp_path / "read-during-preflight.db"
        with MediaCatalog(path):
            pass
        before = self._snapshot((path,))
        original_copy = catalog_module._copy_without_source_atime

        def copy_while_reading(source: Path, destination: Path) -> None:
            original_copy(source, destination)
            source.read_bytes()

        monkeypatch.setattr(catalog_module, "_copy_without_source_atime", copy_while_reading)
        with MediaCatalog(path) as reopened:
            assert reopened.schema_version == CATALOG_SCHEMA_VERSION
        # Windows can disable last-access updates globally; macOS/Linux expose
        # the read that used to be mistaken for a schema mutation.
        if os.name != "nt":
            assert path.stat().st_atime_ns != before[path][1].st_atime_ns

    @pytest.mark.parametrize("change", ["write", "replace", "create_wal", "remove_journal"])
    def test_schema_inspection_refuses_concurrent_mutations(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, change: str
    ) -> None:
        path = tmp_path / "changed.db"
        with MediaCatalog(path):
            pass
        journal = path.with_name(path.name + "-journal")
        if change == "remove_journal":
            journal.write_bytes(b"")
        original_copy = catalog_module._copy_without_source_atime

        def copy_then_change(source: Path, destination: Path) -> None:
            original_copy(source, destination)
            if source != path:
                return
            if change == "write":
                with source.open("r+b") as stream:
                    stream.seek(60)
                    stream.write((CATALOG_SCHEMA_VERSION + 1).to_bytes(4, "big"))
            elif change == "replace":
                replacement = source.with_suffix(".replacement")
                original_copy(source, replacement)
                replacement.replace(source)
            elif change == "create_wal":
                source.with_name(source.name + "-wal").write_bytes(b"")
            else:
                journal.unlink()

        monkeypatch.setattr(catalog_module, "_copy_without_source_atime", copy_then_change)
        with pytest.raises(CatalogCorruptionError, match="changed while its schema"):
            MediaCatalog(path)

    def test_wal_carried_future_schema_is_refused_without_checkpointing(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "future-wal.db"
        with closing(sqlite3.connect(path)) as initial, initial:
            initial.execute(f"PRAGMA user_version = {CATALOG_SCHEMA_VERSION}")
            initial.execute("CREATE TABLE evidence(value TEXT)")
        writer = sqlite3.connect(path)
        try:
            assert writer.execute("PRAGMA journal_mode=WAL").fetchone()[0] == "wal"
            writer.execute("PRAGMA wal_autocheckpoint=0")
            writer.execute(f"PRAGMA user_version = {CATALOG_SCHEMA_VERSION + 1}")
            writer.execute("INSERT INTO evidence VALUES ('future')")
            writer.commit()
            wal = path.with_name(path.name + "-wal")
            shm = path.with_name(path.name + "-shm")
            assert wal.is_file() and shm.is_file()
            assert int.from_bytes(path.read_bytes()[60:64], "big") == CATALOG_SCHEMA_VERSION
            before = self._snapshot((path, wal, shm))

            with pytest.raises(CatalogCorruptionError, match="newer build"):
                MediaCatalog(path)

            self._assert_unchanged(before)
        finally:
            writer.close()

    def test_future_schema_with_a_hot_journal_is_refused_without_recovery(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "future-journal.db"
        with closing(sqlite3.connect(path)) as connection, connection:
            connection.execute(f"PRAGMA user_version = {CATALOG_SCHEMA_VERSION + 1}")
            connection.execute("CREATE TABLE evidence(value TEXT)")
            connection.execute("INSERT INTO evidence VALUES ('before')")
        child = """
import os, sqlite3, sys
connection = sqlite3.connect(sys.argv[1])
connection.execute('PRAGMA journal_mode=DELETE')
connection.execute('BEGIN IMMEDIATE')
connection.execute("UPDATE evidence SET value='uncommitted'")
os._exit(17)
"""
        completed = subprocess.run([sys.executable, "-c", child, str(path)], check=False)
        assert completed.returncode == 17
        journal = path.with_name(path.name + "-journal")
        assert journal.is_file()
        before = self._snapshot((path, journal))

        with pytest.raises(CatalogCorruptionError, match="newer build"):
            MediaCatalog(path)

        self._assert_unchanged(before)

    def test_a_corrupt_file_is_refused_rather_than_used(self, tmp_path: Path) -> None:
        path = tmp_path / "broken.db"
        path.write_bytes(b"SQLite format 3\x00" + b"\x01" * 4096)

        with pytest.raises((CatalogCorruptionError, sqlite3.DatabaseError)):
            MediaCatalog(path)

    def test_applying_the_schema_twice_changes_nothing(self, tmp_path: Path) -> None:
        connection = sqlite3.connect(tmp_path / "x.db")
        assert apply_schema(connection) == apply_schema(connection)
        connection.close()

    def test_fingerprint_changes_with_any_input(self) -> None:
        base = fingerprint(size_bytes=1, mtime_ns=2, file_identity="3")

        assert base != fingerprint(size_bytes=2, mtime_ns=2, file_identity="3")
        assert base != fingerprint(size_bytes=1, mtime_ns=3, file_identity="3")
        assert base != fingerprint(size_bytes=1, mtime_ns=2, file_identity="4")
        assert base != fingerprint(size_bytes=1, mtime_ns=2, ctime_ns=4, file_identity="3")
        assert base != fingerprint(
            size_bytes=1,
            mtime_ns=2,
            file_identity="3",
            sample_sha256="a" * 64,
        )
        assert base.startswith(f"v{FINGERPRINT_VERSION}:{FINGERPRINT_ROLE}:")

    def test_legacy_rows_are_cache_misses_and_migration_keeps_a_backup(
        self, tmp_path: Path
    ) -> None:
        path = tmp_path / "catalog.db"
        with MediaCatalog(path) as legacy:
            legacy.register_root("r1", tmp_path)
            _, records = _scan(legacy, "r1", [observed("a.jpg")])
            legacy.store_hash(records[0], "a" * 64)
            legacy._connection.execute(  # noqa: SLF001 - migration fixture
                "UPDATE files SET fingerprint_version = 1"
            )
            legacy._connection.execute("PRAGMA user_version = 2")  # noqa: SLF001

        with MediaCatalog(path) as migrated:
            record = next(migrated.iter_files("r1"))
            assert record.fingerprint_version == 1
            assert migrated.hash_for(record) is None
            assert migrated.diagnostics().files == 1

        backup = path.with_name("catalog.db.v2.backup")
        assert backup.is_file()
        with closing(sqlite3.connect(backup)) as saved:
            assert saved.execute("PRAGMA user_version").fetchone()[0] == 2

    def test_catalog_can_rebuild_after_migration_from_the_backup(self, tmp_path: Path) -> None:
        path = tmp_path / "catalog.db"
        with MediaCatalog(path) as legacy:
            legacy.register_root("r1", tmp_path)
            _scan(legacy, "r1", [observed("a.jpg")])
            legacy._connection.execute("PRAGMA user_version = 2")  # noqa: SLF001

        with MediaCatalog(path):
            pass
        backup = path.with_name("catalog.db.v2.backup")

        path.unlink()
        path.write_bytes(backup.read_bytes())
        with MediaCatalog(path) as rebuilt:
            assert [item.relative_path for item in rebuilt.iter_files("r1")] == ["a.jpg"]


class TestObservation:
    def test_same_size_rewrite_with_restored_mtime_invalidates_cached_hash(
        self, tmp_path: Path
    ) -> None:
        root = tmp_path / "library"
        root.mkdir()
        path = root / "a.jpg"
        path.write_bytes(b"before")
        original_mtime = path.stat().st_mtime_ns

        with MediaCatalog(tmp_path / "rewrite.db") as catalog:
            catalog.register_root("r1", root)
            _, records = _scan(catalog, "r1", [ObservedFile.from_path(path, root)])
            catalog.store_hash(records[0], "a" * 64)

            path.write_bytes(b"after!")
            os.utime(path, ns=(path.stat().st_atime_ns, original_mtime))
            _, rescanned = _scan(catalog, "r1", [ObservedFile.from_path(path, root)])

            assert rescanned[0].size_bytes == records[0].size_bytes
            assert rescanned[0].mtime_ns == records[0].mtime_ns
            assert rescanned[0].fingerprint != records[0].fingerprint
            assert catalog.hash_for(rescanned[0]) is None

    def test_bounded_sample_detects_a_windows_style_same_stat_rewrite(self, tmp_path: Path) -> None:
        path = tmp_path / "sample.bin"
        path.write_bytes(b"a" * 20_000)
        first = bounded_sample_sha256(path)
        path.write_bytes(b"b" + b"a" * 19_998 + b"c")

        assert bounded_sample_sha256(path) != first

    def test_observing_the_same_path_twice_updates_one_row(self, catalog: MediaCatalog) -> None:
        catalog.register_root("r1", Path("/library"))
        _scan(catalog, "r1", [observed("a.jpg")])
        _scan(catalog, "r1", [observed("a.jpg", size=200, mtime=2_000)])

        records = list(catalog.iter_files("r1"))

        assert len(records) == 1
        assert records[0].size_bytes == 200

    def test_a_changed_fingerprint_stops_the_old_hash_being_a_cache_hit(
        self, catalog: MediaCatalog
    ) -> None:
        catalog.register_root("r1", Path("/library"))
        _, records = _scan(catalog, "r1", [observed("a.jpg")])
        catalog.store_hash(records[0], "a" * 64)
        assert catalog.hash_for(records[0]) == "a" * 64

        _, changed = _scan(catalog, "r1", [observed("a.jpg", size=999, mtime=9_999)])

        assert catalog.hash_for(changed[0]) is None

    def test_derived_facts_survive_an_unchanged_rescan(self, catalog: MediaCatalog) -> None:
        catalog.register_root("r1", Path("/library"))
        _, records = _scan(catalog, "r1", [observed("a.jpg")])
        catalog.store_hash(records[0], "b" * 64)
        catalog.store_media_facts(records[0], kind="image", width=100, height=50)

        _, rescanned = _scan(catalog, "r1", [observed("a.jpg")])

        assert catalog.hash_for(rescanned[0]) == "b" * 64
        assert (catalog.media_facts_for(rescanned[0]) or {})["width"] == 100

    def test_batches_are_bounded_and_still_atomic(self, catalog: MediaCatalog) -> None:
        catalog.register_root("r1", Path("/library"))
        generation = catalog.begin_generation("r1")

        catalog.observe(
            "r1", generation, [observed(f"{i}.jpg", identity=str(i)) for i in range(500)]
        )
        catalog.observe(
            "r1", generation, [observed(f"{i}.jpg", identity=str(i)) for i in range(500, 900)]
        )
        catalog.finish_generation(generation, "complete")

        assert sum(1 for _ in catalog.iter_files("r1")) == 900


class TestReconciliation:
    def test_a_completed_scan_marks_what_it_did_not_see(self, catalog: MediaCatalog) -> None:
        catalog.register_root("r1", Path("/library"))
        _scan(catalog, "r1", [observed("a.jpg", identity="1"), observed("b.jpg", identity="2")])

        _scan(catalog, "r1", [observed("a.jpg", identity="1")])

        assert [record.relative_path for record in catalog.iter_files("r1")] == ["a.jpg"]
        assert sum(1 for _ in catalog.iter_files("r1", include_missing=True)) == 2

    def test_a_partial_scan_never_prunes(self, catalog: MediaCatalog) -> None:
        catalog.register_root("r1", Path("/library"))
        _scan(catalog, "r1", [observed("a.jpg", identity="1"), observed("b.jpg", identity="2")])

        _scan(catalog, "r1", [observed("a.jpg", identity="1")], outcome="partial")

        assert sum(1 for _ in catalog.iter_files("r1")) == 2

    def test_a_cancelled_scan_never_prunes(self, catalog: MediaCatalog) -> None:
        catalog.register_root("r1", Path("/library"))
        _scan(catalog, "r1", [observed("a.jpg", identity="1"), observed("b.jpg", identity="2")])

        _scan(catalog, "r1", [observed("a.jpg", identity="1")], outcome="cancelled")

        assert sum(1 for _ in catalog.iter_files("r1")) == 2

    def test_a_returning_file_stops_being_missing(self, catalog: MediaCatalog) -> None:
        catalog.register_root("r1", Path("/library"))
        _scan(catalog, "r1", [observed("a.jpg", identity="1"), observed("b.jpg", identity="2")])
        _scan(catalog, "r1", [observed("a.jpg", identity="1")])

        _scan(catalog, "r1", [observed("a.jpg", identity="1"), observed("b.jpg", identity="2")])

        assert sum(1 for _ in catalog.iter_files("r1")) == 2

    def test_a_rename_keeps_the_hash_the_catalog_already_paid_for(
        self, catalog: MediaCatalog
    ) -> None:
        catalog.register_root("r1", Path("/library"))
        _, records = _scan(catalog, "r1", [observed("old.jpg", identity="42")])
        catalog.store_hash(records[0], "c" * 64)

        generation = catalog.begin_generation("r1")
        moved = catalog.reconcile_rename(
            "r1", generation, file_identity="42", new_relative_path="new.jpg"
        )
        catalog.finish_generation(generation, "complete")

        assert moved is not None
        assert moved.relative_path == "new.jpg"
        assert catalog.hash_for(moved) == "c" * 64
        assert sum(1 for _ in catalog.iter_files("r1")) == 1

    def test_an_unknown_identity_is_not_treated_as_a_rename(self, catalog: MediaCatalog) -> None:
        catalog.register_root("r1", Path("/library"))
        _scan(catalog, "r1", [observed("a.jpg", identity="1")])
        generation = catalog.begin_generation("r1")

        assert (
            catalog.reconcile_rename(
                "r1", generation, file_identity="unknown", new_relative_path="b.jpg"
            )
            is None
        )


class TestDerivedFacts:
    def test_a_signature_is_returned_only_for_its_own_fingerprint(
        self, catalog: MediaCatalog
    ) -> None:
        catalog.register_root("r1", Path("/library"))
        _, records = _scan(catalog, "r1", [observed("a.jpg")])
        catalog.store_signature(records[0], kind="phash", value="ff00", mean_rgb="1,2,3")

        assert (catalog.signature_for(records[0], "phash") or {})["value"] == "ff00"

        _, changed = _scan(catalog, "r1", [observed("a.jpg", mtime=5_000)])
        assert catalog.signature_for(changed[0], "phash") is None

    def test_selective_invalidation_leaves_other_facts_alone(self, catalog: MediaCatalog) -> None:
        catalog.register_root("r1", Path("/library"))
        _, records = _scan(catalog, "r1", [observed("a.jpg")])
        catalog.store_hash(records[0], "d" * 64)
        catalog.store_media_facts(records[0], kind="image", width=10, height=10)

        catalog.invalidate_derived(records[0], kinds=("signatures", "thumbnails"))

        assert catalog.hash_for(records[0]) == "d" * 64
        assert catalog.media_facts_for(records[0]) is not None

    def test_full_invalidation_drops_every_derived_fact(self, catalog: MediaCatalog) -> None:
        catalog.register_root("r1", Path("/library"))
        _, records = _scan(catalog, "r1", [observed("a.jpg")])
        catalog.store_hash(records[0], "e" * 64)
        catalog.store_media_facts(records[0], kind="image")

        catalog.invalidate_derived(records[0])

        assert catalog.hash_for(records[0]) is None
        assert catalog.media_facts_for(records[0]) is None


class TestQueries:
    def test_hash_lookup_finds_every_present_copy(self, catalog: MediaCatalog) -> None:
        catalog.register_root("r1", Path("/library"))
        _, records = _scan(
            catalog, "r1", [observed("a.jpg", identity="1"), observed("b.jpg", identity="2")]
        )
        for record in records:
            catalog.store_hash(record, "f" * 64)

        assert len(catalog.find_by_hash("f" * 64)) == 2

    def test_hash_lookup_skips_missing_files(self, catalog: MediaCatalog) -> None:
        catalog.register_root("r1", Path("/library"))
        _, records = _scan(
            catalog, "r1", [observed("a.jpg", identity="1"), observed("b.jpg", identity="2")]
        )
        for record in records:
            catalog.store_hash(record, "0" * 64)
        _scan(catalog, "r1", [observed("a.jpg", identity="1")])

        assert [record.relative_path for record in catalog.find_by_hash("0" * 64)] == ["a.jpg"]

    def test_the_cursor_walk_is_stable_and_flat(self, catalog: MediaCatalog) -> None:
        catalog.register_root("r1", Path("/library"))
        _scan(catalog, "r1", [observed(f"{i:04}.jpg", identity=str(i)) for i in range(50)])

        first = [record.relative_path for record in catalog.iter_files("r1", batch_size=7)]
        second = [record.relative_path for record in catalog.iter_files("r1", batch_size=13)]

        assert first == second
        assert first == sorted(first)


class TestCheckpointsAndDiagnostics:
    def test_a_checkpoint_round_trips(self, catalog: MediaCatalog) -> None:
        catalog.save_checkpoint("op1", cursor=1234, root_id="r1", phase="hashing")

        assert (catalog.checkpoint("op1") or {})["cursor"] == 1234
        assert catalog.checkpoint("missing") is None

    def test_the_newest_checkpoint_wins(self, catalog: MediaCatalog) -> None:
        catalog.save_checkpoint("op1", cursor=1)
        catalog.save_checkpoint("op1", cursor=2)

        assert (catalog.checkpoint("op1") or {})["cursor"] == 2

    def test_diagnostics_count_what_a_user_would_ask_about(self, catalog: MediaCatalog) -> None:
        catalog.register_root("r1", Path("/library"))
        _, records = _scan(
            catalog, "r1", [observed("a.jpg", identity="1"), observed("b.jpg", identity="2")]
        )
        catalog.store_hash(records[0], "1" * 64)
        _scan(catalog, "r1", [observed("a.jpg", identity="1")])

        diagnostics = catalog.diagnostics()

        assert diagnostics.roots == 1
        assert diagnostics.files == 1
        assert diagnostics.missing_files == 1
        assert diagnostics.hashed_files == 1
        assert diagnostics.open_generations == 0

    def test_issues_are_recorded_against_their_generation(self, catalog: MediaCatalog) -> None:
        catalog.register_root("r1", Path("/library"))
        generation = catalog.begin_generation("r1")

        catalog.record_issue(
            "r1",
            generation,
            path="/library/locked",
            error_class="PermissionError",
            message="denied",
        )
        catalog.finish_generation(generation, "partial")

        assert catalog.diagnostics().generations == 1

    def test_forgetting_one_root_leaves_the_others(self, catalog: MediaCatalog) -> None:
        catalog.register_root("r1", Path("/a"))
        catalog.register_root("r2", Path("/b"))
        _scan(catalog, "r1", [observed("a.jpg")])
        _scan(catalog, "r2", [observed("b.jpg")])

        catalog.forget_root("r1")

        assert sum(1 for _ in catalog.iter_files("r2")) == 1
        assert sum(1 for _ in catalog.iter_files("r1")) == 0
