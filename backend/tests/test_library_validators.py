"""Validation describes a library; it never certifies one it could not read."""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from app.services.catalog import MediaCatalog
from app.services.catalog_duplicates import CatalogDuplicateIndex
from app.services.discovery import discover_into_catalog
from app.services.library_validators import (
    ValidatorContext,
    actionable_findings,
    run_validation,
)


@pytest.fixture()
def library(tmp_path: Path) -> Path:
    root = tmp_path / "library"
    (root / "2019").mkdir(parents=True)
    (root / "2019" / "holiday.jpg").write_bytes(b"holiday")
    (root / "2019" / "holiday (1).jpg").write_bytes(b"holiday")
    (root / "2019" / "beach.jpg").write_bytes(b"beach")
    return root


@pytest.fixture()
def catalog(tmp_path: Path, library: Path) -> Iterator[MediaCatalog]:
    with MediaCatalog(tmp_path / "catalog.db") as opened:
        opened.register_root("r1", library, role="input")
        discover_into_catalog(opened, "r1", library)
        yield opened


def _context(catalog: MediaCatalog, **kwargs) -> ValidatorContext:
    return ValidatorContext(catalog=catalog, root_id="r1", generation=1, **kwargs)


class TestValidators:
    def test_copy_suffixes_are_reported(self, catalog: MediaCatalog) -> None:
        report = run_validation(_context(catalog), enabled=["inconsistent_name"])

        names = report.by_category("inconsistent_name")
        assert any(finding.state == "failed" for finding in names)
        assert any("(1)" in (finding.evidence or "") for finding in names)

    def test_identical_content_is_reported_as_an_exact_duplicate(
        self, catalog: MediaCatalog
    ) -> None:
        for record in catalog.iter_files("r1"):
            catalog.store_hash(record, ("a" if "holiday" in record.relative_path else "b") * 64)
        context = _context(catalog, duplicate_index=CatalogDuplicateIndex(catalog))

        report = run_validation(context, enabled=["exact_duplicate"])

        failed = [f for f in report.by_category("exact_duplicate") if f.state == "failed"]
        assert len(failed) == 1
        assert failed[0].confidence == "high"
        assert failed[0].actionable is True

    def test_a_missing_file_is_an_error(self, catalog: MediaCatalog, library: Path) -> None:
        (library / "2019" / "beach.jpg").unlink()

        report = run_validation(_context(catalog), enabled=["unreadable"])

        failed = [f for f in report.by_category("unreadable") if f.state == "failed"]
        assert [f.relative_path for f in failed] == ["2019/beach.jpg"]
        assert failed[0].severity == "error"

    def test_a_misplaced_file_names_where_it_should_be(self, catalog: MediaCatalog) -> None:
        context = _context(catalog, expected_path_for=lambda record: "2020/moved.jpg")

        report = run_validation(context, enabled=["misplaced"])

        failed = [f for f in report.by_category("misplaced") if f.state == "failed"]
        assert failed and failed[0].expected_path == "2020/moved.jpg"
        assert failed[0].actionable is True

    def test_missing_sidecars_are_only_reported_where_sidecars_are_used(
        self, catalog: MediaCatalog, library: Path
    ) -> None:
        (library / "2019" / "beach.xmp").write_text("<x/>", encoding="utf-8")

        report = run_validation(_context(catalog), enabled=["missing_sidecar"])

        failed = [f for f in report.by_category("missing_sidecar") if f.state == "failed"]
        assert {f.relative_path for f in failed} == {"2019/holiday.jpg", "2019/holiday (1).jpg"}

    def test_a_library_without_sidecars_is_not_missing_any(self, catalog: MediaCatalog) -> None:
        report = run_validation(_context(catalog), enabled=["missing_sidecar"])

        assert all(f.state == "passed" for f in report.by_category("missing_sidecar"))

    def test_an_index_that_never_completed_is_reported(self, tmp_path: Path, library: Path) -> None:
        with MediaCatalog(tmp_path / "fresh.db") as catalog:
            catalog.register_root("r1", library, role="input")
            generation = catalog.begin_generation("r1")
            catalog.finish_generation(generation, "cancelled")

            report = run_validation(
                ValidatorContext(catalog=catalog, root_id="r1"), enabled=["catalog_stale"]
            )

        assert any(f.state == "failed" for f in report.by_category("catalog_stale"))


class TestReportSemantics:
    def test_runner_never_materializes_the_complete_catalog(
        self, catalog: MediaCatalog, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        original = catalog.iter_files

        class SinglePass:
            def __iter__(self):
                yield from original("r1")

            def __len__(self) -> int:
                raise AssertionError("validator runner materialized the catalog")

        monkeypatch.setattr(catalog, "iter_files", lambda _root_id: iter(SinglePass()))
        report = run_validation(_context(catalog), enabled=["inconsistent_name", "unreadable"])

        assert report.findings

    def test_a_disabled_check_is_never_reported_as_passed(self, catalog: MediaCatalog) -> None:
        report = run_validation(_context(catalog), enabled=["unreadable"])

        names = report.by_category("inconsistent_name")
        assert names and all(finding.state == "disabled" for finding in names)
        assert "inconsistent_name" in report.disabled_categories

    def test_an_empty_root_is_not_evaluated_rather_than_passed(self, tmp_path: Path) -> None:
        with MediaCatalog(tmp_path / "empty.db") as catalog:
            catalog.register_root("r1", tmp_path / "nothing", role="input")

            report = run_validation(ValidatorContext(catalog=catalog, root_id="r1"))

        assert all(finding.state in {"not_evaluated", "failed"} for finding in report.findings)

    def test_an_unreachable_subtree_prevents_whole_library_certification(
        self, catalog: MediaCatalog
    ) -> None:
        report = run_validation(
            _context(catalog),
            enabled=["unreadable"],
            unreachable_scopes=("/library/locked",),
        )

        assert report.partial is True
        assert report.certifies_whole_library is False

    def test_a_clean_readable_library_does_certify(self, catalog: MediaCatalog) -> None:
        report = run_validation(_context(catalog), enabled=["unreadable"])

        assert report.certifies_whole_library is True

    def test_only_safe_findings_are_convertible_to_actions(self, catalog: MediaCatalog) -> None:
        context = _context(catalog, expected_path_for=lambda record: "2020/moved.jpg")

        report = run_validation(context, enabled=["misplaced", "inconsistent_name"])

        assert {finding.category for finding in actionable_findings(report)} == {"misplaced"}

    def test_every_finding_carries_its_rule_and_catalog_version(
        self, catalog: MediaCatalog
    ) -> None:
        report = run_validation(_context(catalog), enabled=["inconsistent_name"])

        assert all(finding.rule_version for finding in report.findings)
        assert all(finding.catalog_generation == 1 for finding in report.findings)


class TestIncrementalRerun:
    def test_a_rule_only_change_reuses_the_extraction(self, catalog: MediaCatalog) -> None:
        for record in catalog.iter_files("r1"):
            catalog.store_hash(record, "c" * 64)
        first = run_validation(_context(catalog), enabled=["inconsistent_name"])

        hashes_before = [catalog.hash_for(record) for record in catalog.iter_files("r1")]
        run_validation(_context(catalog), enabled=["unreadable"])
        hashes_after = [catalog.hash_for(record) for record in catalog.iter_files("r1")]

        assert hashes_before == hashes_after
        assert first.findings  # the first run did produce something to reuse
