"""A paged list must show every row exactly once, whatever moves underneath it."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services.catalog import MediaCatalog, ObservedFile
from app.services.catalog_views import (
    CursorError,
    ViewQuery,
    aggregate,
    decode_cursor,
    iter_all,
    query_page,
)


@pytest.fixture()
def catalog(tmp_path: Path) -> MediaCatalog:
    with MediaCatalog(tmp_path / "catalog.db") as opened:
        opened.register_root("input", tmp_path / "input", role="input")
        opened.register_root("ref", tmp_path / "library", role="reference")
        generation = opened.begin_generation("input")
        opened.observe(
            "input",
            generation,
            [
                ObservedFile(
                    f"{index:03}.jpg", 100 + index, 1_000 + index, file_identity=str(index)
                )
                for index in range(25)
            ],
        )
        opened.finish_generation(generation, "complete")
        yield opened


class TestPaging:
    def test_every_row_appears_exactly_once(self, catalog: MediaCatalog) -> None:
        rows = iter_all(catalog, ViewQuery(roles=("input",)), page_size=7)

        paths = [row.relative_path for row in rows]
        assert len(paths) == 25
        assert len(set(paths)) == 25

    def test_the_page_size_is_respected_and_bounded(self, catalog: MediaCatalog) -> None:
        page = query_page(catalog, ViewQuery(roles=("input",)), page_size=5)

        assert len(page.rows) == 5
        assert page.exhausted is False

    def test_the_last_page_has_no_cursor(self, catalog: MediaCatalog) -> None:
        page = query_page(catalog, ViewQuery(roles=("input",)), page_size=100)

        assert len(page.rows) == 25
        assert page.exhausted is True

    def test_order_is_stable_across_page_sizes(self, catalog: MediaCatalog) -> None:
        small = [row.file_id for row in iter_all(catalog, ViewQuery(roles=("input",)), page_size=3)]
        large = [
            row.file_id for row in iter_all(catalog, ViewQuery(roles=("input",)), page_size=20)
        ]

        assert small == large

    def test_descending_reverses_without_losing_rows(self, catalog: MediaCatalog) -> None:
        ascending = [row.relative_path for row in iter_all(catalog, ViewQuery(roles=("input",)))]
        descending = [
            row.relative_path
            for row in iter_all(catalog, ViewQuery(roles=("input",), descending=True))
        ]

        assert descending == list(reversed(ascending))

    def test_sorting_by_size_still_pages_totally(self, catalog: MediaCatalog) -> None:
        rows = iter_all(catalog, ViewQuery(roles=("input",), sort="size"), page_size=4)

        sizes = [row.size_bytes for row in rows]
        assert len(rows) == 25
        assert sizes == sorted(sizes)

    def test_equal_sort_values_are_still_totally_ordered(self, tmp_path: Path) -> None:
        with MediaCatalog(tmp_path / "ties.db") as catalog:
            catalog.register_root("input", tmp_path, role="input")
            generation = catalog.begin_generation("input")
            catalog.observe(
                "input",
                generation,
                [ObservedFile(f"{i}.jpg", 100, 1_000, file_identity=str(i)) for i in range(10)],
            )
            catalog.finish_generation(generation, "complete")

            rows = iter_all(catalog, ViewQuery(roles=("input",), sort="size"), page_size=3)

        assert len({row.file_id for row in rows}) == 10


class TestCursors:
    def test_a_cursor_from_another_query_is_refused(self, catalog: MediaCatalog) -> None:
        page = query_page(catalog, ViewQuery(roles=("input",)), page_size=5)

        with pytest.raises(CursorError, match="different list"):
            query_page(
                catalog,
                ViewQuery(roles=("input",), sort="size"),
                cursor=page.next_cursor,
            )

    def test_a_damaged_cursor_is_refused_rather_than_guessed(self, catalog: MediaCatalog) -> None:
        with pytest.raises(CursorError):
            query_page(catalog, ViewQuery(), cursor="not-a-cursor")

    def test_a_cursor_encodes_the_last_row_not_an_offset(self, catalog: MediaCatalog) -> None:
        page = query_page(catalog, ViewQuery(roles=("input",)), page_size=5)

        decoded = decode_cursor(page.next_cursor or "")
        assert "id" in decoded and "v" in decoded

    def test_rows_added_between_pages_never_duplicate_earlier_ones(
        self, catalog: MediaCatalog
    ) -> None:
        first = query_page(catalog, ViewQuery(roles=("input",)), page_size=10)
        generation = catalog.begin_generation("input")
        catalog.observe(
            "input",
            generation,
            [ObservedFile("000-new.jpg", 1, 1, file_identity="new")],
        )
        catalog.finish_generation(generation, "partial")

        second = query_page(
            catalog, ViewQuery(roles=("input",)), page_size=10, cursor=first.next_cursor
        )

        assert not {row.file_id for row in first.rows} & {row.file_id for row in second.rows}


class TestFiltering:
    def test_roles_are_respected(self, catalog: MediaCatalog) -> None:
        assert iter_all(catalog, ViewQuery(roles=("reference",))) == []
        assert len(iter_all(catalog, ViewQuery(roles=("input",)))) == 25

    def test_search_narrows_without_breaking_paging(self, catalog: MediaCatalog) -> None:
        rows = iter_all(catalog, ViewQuery(roles=("input",), search="01"), page_size=2)

        assert rows
        assert all("01" in row.relative_path for row in rows)

    def test_a_size_floor_is_applied(self, catalog: MediaCatalog) -> None:
        rows = iter_all(catalog, ViewQuery(roles=("input",), min_size_bytes=120))

        assert all(row.size_bytes >= 120 for row in rows)

    def test_missing_files_are_excluded_unless_asked_for(self, catalog: MediaCatalog) -> None:
        generation = catalog.begin_generation("input")
        catalog.observe(
            "input",
            generation,
            [ObservedFile("000.jpg", 100, 1_000, file_identity="0")],
        )
        catalog.finish_generation(generation, "complete")

        assert len(iter_all(catalog, ViewQuery(roles=("input",)))) == 1
        assert len(iter_all(catalog, ViewQuery(roles=("input",), include_missing=True))) == 25


class TestAggregate:
    def test_totals_come_from_the_database(self, catalog: MediaCatalog) -> None:
        totals = aggregate(catalog, ViewQuery(roles=("input",)))

        assert totals.total_rows == 25
        assert totals.total_bytes == sum(100 + index for index in range(25))
        assert totals.roots == 1

    def test_an_empty_result_aggregates_to_zero(self, catalog: MediaCatalog) -> None:
        totals = aggregate(catalog, ViewQuery(roles=("reference",)))

        assert totals.to_dict() == {"total_rows": 0, "total_bytes": 0, "roots": 0}

    def test_the_aggregate_respects_the_same_filters_as_the_page(
        self, catalog: MediaCatalog
    ) -> None:
        query = ViewQuery(roles=("input",), min_size_bytes=120)

        assert aggregate(catalog, query).total_rows == len(iter_all(catalog, query))
