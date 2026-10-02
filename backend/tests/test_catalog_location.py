"""The index is a cache: it may be reset, but it may never leak or mislead."""

from __future__ import annotations

from collections.abc import Iterator
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

from app.core.library_profiles import CatalogPlacement
from app.services.catalog import MediaCatalog, ObservedFile
from app.services.catalog_location import (
    CATALOG_FILENAME,
    budget,
    catalog_path,
    freshness,
    open_catalog,
    reset_catalog,
)


@pytest.fixture()
def catalog(tmp_path: Path) -> Iterator[MediaCatalog]:
    with MediaCatalog(tmp_path / "catalog.db") as opened:
        opened.register_root("r1", tmp_path / "library")
        yield opened


def _complete_scan(catalog: MediaCatalog, root_id: str = "r1", *, issues: int = 0) -> int:
    generation = catalog.begin_generation(root_id)
    catalog.observe(root_id, generation, [ObservedFile("a.jpg", 10, 1, file_identity="1")])
    for index in range(issues):
        catalog.record_issue(
            root_id,
            generation,
            path=f"/library/locked{index}",
            error_class="PermissionError",
            message="denied",
        )
    catalog.finish_generation(generation, "complete")
    return generation


class TestPlacement:
    def test_application_data_is_the_default_and_stays_private(self, tmp_path: Path) -> None:
        path = catalog_path(CatalogPlacement(), data_dir=tmp_path)

        assert path.name == CATALOG_FILENAME
        assert tmp_path in path.parents

    def test_portable_mode_lands_beside_the_profile(self, tmp_path: Path) -> None:
        placement = CatalogPlacement(mode="portable", relative_path="library-catalog.db")

        path = catalog_path(placement, data_dir=tmp_path, profile_dir=tmp_path / "profile")

        assert path.parent.name == "profile"

    def test_portable_mode_without_a_profile_directory_is_refused(self, tmp_path: Path) -> None:
        placement = CatalogPlacement(mode="portable", relative_path="c.db")

        with pytest.raises(ValueError, match="profile"):
            catalog_path(placement, data_dir=tmp_path)

    def test_a_portable_path_cannot_escape_the_profile_directory(self, tmp_path: Path) -> None:
        with pytest.raises(ValueError):
            CatalogPlacement(mode="portable", relative_path="../../elsewhere.db")

    def test_opening_creates_the_directory_it_needs(self, tmp_path: Path) -> None:
        with open_catalog(CatalogPlacement(), data_dir=tmp_path / "fresh") as opened:
            assert opened.path.is_file()


class TestBudget:
    def test_a_small_catalog_is_within_budget(self, catalog: MediaCatalog) -> None:
        limits = budget(catalog.diagnostics())

        assert limits.over_soft_limit is False
        assert 0.0 <= limits.usage_ratio < 1.0

    def test_the_soft_limit_is_reported_not_enforced(self, catalog: MediaCatalog) -> None:
        limits = budget(catalog.diagnostics(), soft_limit_bytes=1)

        assert limits.over_soft_limit is True
        assert catalog.path.is_file()  # nothing was deleted because of a budget


class TestFreshness:
    def test_a_root_that_never_completed_a_scan_is_unknown(self, catalog: MediaCatalog) -> None:
        generation = catalog.begin_generation("r1")
        catalog.finish_generation(generation, "cancelled")

        assert freshness(catalog, "r1").state == "unknown"

    def test_a_recent_complete_scan_is_fresh(self, catalog: MediaCatalog) -> None:
        _complete_scan(catalog)

        result = freshness(catalog, "r1")

        assert result.state == "fresh"
        assert result.last_complete_scan_at is not None

    def test_an_old_complete_scan_is_stale(self, catalog: MediaCatalog) -> None:
        _complete_scan(catalog)

        result = freshness(
            catalog,
            "r1",
            now=datetime.now(timezone.utc) + timedelta(days=90),
        )

        assert result.state == "stale"

    def test_issue_counts_travel_with_the_freshness(self, catalog: MediaCatalog) -> None:
        _complete_scan(catalog, issues=3)

        assert freshness(catalog, "r1").issue_count == 3

    def test_an_unknown_root_is_unknown_rather_than_an_error(self, catalog: MediaCatalog) -> None:
        assert freshness(catalog, "never-registered").state == "unknown"


class TestReset:
    def test_reset_removes_the_index_and_its_siblings(self, tmp_path: Path) -> None:
        path = tmp_path / "catalog.db"
        with MediaCatalog(path) as opened:
            opened.register_root("r1", tmp_path)

        assert reset_catalog(path) is True
        assert not path.exists()

    def test_resetting_an_absent_catalog_is_not_an_error(self, tmp_path: Path) -> None:
        assert reset_catalog(tmp_path / "nothing.db") is False

    def test_a_reset_catalog_rebuilds_itself_on_the_next_open(self, tmp_path: Path) -> None:
        path = tmp_path / "catalog.db"
        with MediaCatalog(path) as opened:
            opened.register_root("r1", tmp_path)
        reset_catalog(path)

        with MediaCatalog(path) as reopened:
            assert reopened.diagnostics().roots == 0
