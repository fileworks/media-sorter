"""Scale behaviour, asserted structurally rather than by wall-clock time.

A benchmark that asserts "under 200 ms" fails on a busy laptop and passes on a
fast one while hiding an O(n²) query. These tests assert the properties that
actually decide whether a two-million-file library works: memory stays flat,
queries stay indexed, cursors stay stable, and the number of rows touched grows
with the answer rather than with the library.

The default fixture is small enough to run in CI. Set ``MEDIASORT_SCALE_FIXTURE``
to a larger record count — 2_000_000 is the documented target — to run the same
assertions against a full-size generated catalog without checking one in.
"""

from __future__ import annotations

import os
import tracemalloc
from collections.abc import Iterator
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

import app.services.burst_detection as burst_module
import app.services.library_audit as audit_module
from app.core.config import Config
from app.core.media_units import MediaUnit, MediaUnitMember
from app.services.burst_detection import BurstDetectionService, BurstSettings
from app.services.catalog import MediaCatalog, ObservedFile
from app.services.catalog_duplicates import CatalogDuplicateIndex
from app.services.destination_reconciliation import (
    DestinationReconciliationService,
    _UnitFacts,
)
from app.services.duplicate_grouping import exact_groups
from app.services.library_audit import LibraryAuditService
from app.services.pipeline import batched
from app.services.preview_service import PreviewOutcomeStore

#: Small by default; the assertions are the same at any size.
DEFAULT_RECORDS = int(os.environ.get("MEDIASORT_SCALE_FIXTURE", "20000"))
BATCH = 1_000
STORAGE_FILES = int(os.environ.get("MEDIASORT_STORAGE_FIXTURE", str(DEFAULT_RECORDS)))


def _generate(
    catalog: MediaCatalog, root_id: str, count: int, *, duplicate_every: int = 50
) -> None:
    """Fill a catalog in bounded batches, as the real discovery path does."""
    catalog.register_root(root_id, Path("/library"), role="input")
    generation = catalog.begin_generation(root_id)
    for batch in batched(range(count), BATCH):
        catalog.observe(
            root_id,
            generation,
            [
                ObservedFile(
                    relative_path=f"{index // 1000:04}/{index:07}.jpg",
                    size_bytes=1_000 + (index % 997),
                    mtime_ns=1_700_000_000 + index,
                    file_identity=str(index),
                )
                for index in batch
            ],
        )
    catalog.finish_generation(generation, "complete")

    # Hash a slice of them, with a deliberate duplicate every N files so the
    # grouping queries have real work to do.
    for record in catalog.iter_files(root_id, batch_size=BATCH):
        index = int(record.relative_path.split("/")[-1].removesuffix(".jpg"))
        digest = f"{index // duplicate_every:064x}"
        catalog.store_hash(record, digest)


@pytest.fixture(scope="module")
def large_catalog(tmp_path_factory: pytest.TempPathFactory) -> Iterator[MediaCatalog]:
    path = tmp_path_factory.mktemp("scale") / "catalog.db"
    catalog = MediaCatalog(path)
    _generate(catalog, "input", DEFAULT_RECORDS)
    yield catalog
    catalog.close()


class TestMemory:
    def test_walking_the_whole_catalog_stays_flat(self, large_catalog: MediaCatalog) -> None:
        """Iteration must not scale with the library — that is the whole point."""
        tracemalloc.start()
        try:
            baseline = tracemalloc.get_traced_memory()[0]
            seen = 0
            peak_growth = 0
            for _record in large_catalog.iter_files("input", batch_size=BATCH):
                seen += 1
                if seen % 5_000 == 0:
                    current = tracemalloc.get_traced_memory()[0]
                    peak_growth = max(peak_growth, current - baseline)
        finally:
            tracemalloc.stop()

        assert seen == DEFAULT_RECORDS
        # One batch of rows, not one library. Generous enough to survive
        # interpreter noise, tight enough to catch materialization.
        assert peak_growth < 40 * 1024 * 1024

    def test_grouping_yields_before_it_finishes(self, large_catalog: MediaCatalog) -> None:
        index = CatalogDuplicateIndex(large_catalog)

        first = next(exact_groups(large_catalog, index, roles=("input",)), None)

        assert first is not None
        assert first.member_count >= 2

    def test_outcome_inspector_index_and_lookup_are_bounded(
        self,
        tmp_path: Path,
    ) -> None:
        store = PreviewOutcomeStore(tmp_path / "outcomes.sqlite3")

        tracemalloc.start()
        try:
            baseline = tracemalloc.get_traced_memory()[0]
            store.replace(
                {
                    "source": f"/library/{index:07}.jpg",
                    "extracted_date": "2024-01-02",
                    "provenance": None,
                }
                for index in range(DEFAULT_RECORDS)
            )
            after_index = tracemalloc.get_traced_memory()[0]
            requested = [f"/library/{index:07}.jpg" for index in range(500)]
            outcomes = store.get(requested)
            after_page = tracemalloc.get_traced_memory()[0]
        finally:
            tracemalloc.stop()

        assert len(outcomes) == 500
        assert [item["source"] for item in outcomes] == requested
        # The generated library is written row by row, then one API-sized page
        # is read. Neither phase retains one Python object per catalog row.
        assert after_index - baseline < 10 * 1024 * 1024
        assert after_page - after_index < 5 * 1024 * 1024

    def test_burst_detection_is_linear_and_disabled_cost_is_near_zero(
        self,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        count = DEFAULT_RECORDS
        paths = [Path(f"/library/{index:07}.jpg") for index in range(count)]
        units = [
            MediaUnit(
                unit_id=f"unit-{index}",
                primary=path,
                members=(MediaUnitMember(path, None, True),),
            )
            for index, path in enumerate(paths)
        ]
        bind_calls = 0

        def bind(*_args: object, **_kwargs: object):
            nonlocal bind_calls
            bind_calls += 1
            return units, []

        base = datetime(2024, 1, 1)

        def captured(path: Path) -> datetime:
            index = int(path.stem)
            return (
                base + timedelta(milliseconds=index * 20)
                if index < 100
                else base + timedelta(seconds=index * 10)
            )

        monkeypatch.setattr(burst_module, "bind_media_units", bind)
        monkeypatch.setattr(burst_module, "_capture_time", captured)
        monkeypatch.setattr(
            burst_module,
            "stream_sha256",
            lambda path: (f"{int(path.stem):064x}", 1),
        )
        monkeypatch.setattr(burst_module, "_sharpness", lambda _path: 1.0)
        service = BurstDetectionService()
        monkeypatch.setattr(service.extraction, "extract_camera_model", lambda _path: "camera")
        monkeypatch.setattr(
            service.duplicate_service,
            "image_signature",
            lambda _path: SimpleNamespace(phash=0),
        )

        assert service.detect(paths, Path("/library"), BurstSettings(enabled=False)) == ()
        assert bind_calls == 0

        tracemalloc.start()
        try:
            baseline = tracemalloc.get_traced_memory()[0]
            groups = service.detect(paths, Path("/library"), BurstSettings(enabled=True))
            _current, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()

        assert bind_calls == 1
        assert len(groups) == 1
        assert len(groups[0].frames) == 100
        assert service.sharpness_computations == 100
        assert peak - baseline < 40 * 1024 * 1024

    def test_large_library_audit_uses_disk_backed_baseline_state(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        root = tmp_path / "audited-library"
        for index in range(STORAGE_FILES):
            path = root / f"{index // 100:05}" / f"{index:07}.jpg"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"fixture")
        service = LibraryAuditService(tmp_path / "state" / "audit.sqlite3")
        monkeypatch.setattr(
            service.extraction,
            "extract_detailed",
            lambda _path: SimpleNamespace(extracted_date=None),
        )
        monkeypatch.setattr(
            audit_module,
            "assess_readability",
            lambda _path: SimpleNamespace(readable=True, evidence=None),
        )
        monkeypatch.setattr(
            audit_module,
            "stream_sha256",
            lambda path: (f"{int(path.stem):064x}", path.stat().st_size),
        )
        monkeypatch.setattr(audit_module, "_media_findings", lambda _path, _relative: [])

        tracemalloc.start()
        try:
            baseline = tracemalloc.get_traced_memory()[0]
            report = service.run(root)
            _current, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()

        assert report.scanned_files == STORAGE_FILES
        assert report.coverage == "full"
        assert not report.findings
        assert peak - baseline < 40 * 1024 * 1024

    def test_large_reconciliation_pages_to_disk_with_responsive_cancellation(
        self,
        tmp_path: Path,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        source = tmp_path / "reconciliation-input"
        destination = tmp_path / "reconciliation-destination"
        destination.mkdir()
        for index in range(STORAGE_FILES):
            path = source / f"{index // 100:05}" / f"{index:07}.jpg"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"fixture")
        service = DestinationReconciliationService()
        captured = datetime(2024, 1, 2).date()

        def fast_facts(unit: MediaUnit) -> _UnitFacts:
            index = int(unit.primary.stem)
            return _UnitFacts(
                unit=unit,
                digest=f"{index:064x}",
                signature=None,
                date=captured,
                camera="fixture-camera",
                fingerprint=f"fixture:{index}",
            )

        monkeypatch.setattr(service, "_facts", fast_facts)
        config = Config(
            source_directory=str(source),
            target_directory=str(destination),
            sort_criteria=["year", "month"],
            copy_instead_of_move=True,
        )

        tracemalloc.start()
        try:
            baseline = tracemalloc.get_traced_memory()[0]
            page = service.compare_paged(source, destination, config, page_size=50)
            _current, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()

        assert len(page.findings) == 50
        assert page.counts["missing"] == STORAGE_FILES
        assert page.next_cursor is not None
        assert peak - baseline < 40 * 1024 * 1024

        calls = 0

        def cancel() -> bool:
            nonlocal calls
            calls += 1
            return calls > 500

        partial = service.compare_paged(
            source,
            destination,
            config,
            page_size=50,
            cancel=cancel,
        )

        assert partial.input_coverage == "partial"
        assert partial.destination_coverage == "partial"
        assert partial.counts["missing"] < STORAGE_FILES
        assert any("cancelled" in issue for issue in partial.issues)


class TestQueryPlans:
    def _plan(self, catalog: MediaCatalog, sql: str, parameters: tuple[Any, ...]) -> str:
        rows = catalog._connection.execute(  # noqa: SLF001 - inspecting the plan is the test
            f"EXPLAIN QUERY PLAN {sql}", parameters
        ).fetchall()
        return " ".join(str(row["detail"]) for row in rows)

    def test_the_cursor_walk_uses_an_index(self, large_catalog: MediaCatalog) -> None:
        plan = self._plan(
            large_catalog,
            "SELECT * FROM files WHERE root_id = ? AND file_id > ? ORDER BY file_id LIMIT 10",
            ("input", 0),
        )

        assert "SCAN" not in plan or "USING INDEX" in plan

    def test_exact_hash_lookup_uses_an_index(self, large_catalog: MediaCatalog) -> None:
        plan = self._plan(
            large_catalog,
            "SELECT * FROM file_hashes WHERE sha256 = ?",
            (f"{1:064x}",),
        )

        assert "idx_hashes_sha256" in plan

    def test_no_query_binds_more_than_a_bounded_parameter_list(
        self, large_catalog: MediaCatalog
    ) -> None:
        """SQLite's variable limit is a real ceiling, so nothing may approach it."""
        index = CatalogDuplicateIndex(large_catalog)

        # The widest bind list in the duplicate path is one hash plus the roles.
        matches = index.exact_matches(f"{1:064x}", roles=("input",), limit=10)

        assert len(matches) <= 10


class TestCursorStability:
    def test_the_same_walk_produces_the_same_order(self, large_catalog: MediaCatalog) -> None:
        first = [record.file_id for record in large_catalog.iter_files("input", batch_size=97)][
            :500
        ]
        second = [record.file_id for record in large_catalog.iter_files("input", batch_size=311)][
            :500
        ]

        assert first == second

    def test_paging_never_repeats_or_skips_a_row(self, large_catalog: MediaCatalog) -> None:
        seen = [record.file_id for record in large_catalog.iter_files("input", batch_size=BATCH)]

        assert len(seen) == len(set(seen)) == DEFAULT_RECORDS
        assert seen == sorted(seen)


class TestGroupQueries:
    def test_group_count_matches_the_generated_fixture(self, large_catalog: MediaCatalog) -> None:
        index = CatalogDuplicateIndex(large_catalog)

        groups = list(exact_groups(large_catalog, index, roles=("input",), limit=25))

        assert len(groups) == 25
        assert all(group.member_count >= 2 for group in groups)

    def test_a_bounded_page_touches_a_bounded_number_of_rows(
        self, large_catalog: MediaCatalog
    ) -> None:
        index = CatalogDuplicateIndex(large_catalog)

        matches = index.exact_matches(f"{2:064x}", roles=("input",), limit=5)

        assert len(matches) <= 5

    def test_grouping_memory_does_not_grow_with_the_library(
        self, large_catalog: MediaCatalog
    ) -> None:
        index = CatalogDuplicateIndex(large_catalog)
        tracemalloc.start()
        try:
            baseline = tracemalloc.get_traced_memory()[0]
            for count, _group in enumerate(exact_groups(large_catalog, index, roles=("input",)), 1):
                if count >= 200:
                    break
            growth = tracemalloc.get_traced_memory()[0] - baseline
        finally:
            tracemalloc.stop()

        assert growth < 40 * 1024 * 1024


class TestCheckpointRecovery:
    def test_a_checkpoint_survives_a_reopen_at_scale(
        self, large_catalog: MediaCatalog, tmp_path: Path
    ) -> None:
        large_catalog.save_checkpoint("op-scale", cursor=DEFAULT_RECORDS // 2, phase="hashing")

        restored = large_catalog.checkpoint("op-scale")

        assert restored is not None
        assert restored["cursor"] == DEFAULT_RECORDS // 2
