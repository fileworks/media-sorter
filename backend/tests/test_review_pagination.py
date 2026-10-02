"""P2-DEDUP-D6 — a truncated review page must say so, and be resumable.

`GroupPage.next_cursor` existed from the start and was never set, and
`_take_scoped_groups` stopped at the limit with no signal. A page that ends
because it filled up looked exactly like one that ends because the library ran
out, so the surface told a person they had reviewed everything when they had
reviewed the first fifty.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest

import app.api.routes.review as review_routes
from app.core.config import Config
from app.services.catalog import MediaCatalog, ObservedFile
from app.services.catalog_views import CursorError, decode_cursor

GROUP_COUNT = 5


@pytest.fixture
def catalog_path(tmp_path: Path) -> Path:
    """A catalog holding `GROUP_COUNT` exact groups, two files each."""
    path = tmp_path / "catalog.db"
    with MediaCatalog(path) as catalog:
        catalog.register_root("input", tmp_path / "library", role="input")
        generation = catalog.begin_generation("input")
        observed = [
            ObservedFile(
                f"{index:02}-{side}.jpg", 100 + index, 1_000, file_identity=f"{index}{side}"
            )
            for index in range(GROUP_COUNT)
            for side in ("a", "b")
        ]
        records = catalog.observe("input", generation, observed)
        catalog.finish_generation(generation, "complete")
        for record in records:
            index = int(record.relative_path[:2])
            catalog.store_hash(record, f"{index:064x}")
    return path


@pytest.fixture
def container(monkeypatch: pytest.MonkeyPatch, catalog_path: Path) -> object:
    """Every call reopens the catalog, exactly as a request would."""
    monkeypatch.setattr(review_routes, "_catalog", lambda _c: MediaCatalog(catalog_path))
    return object()


def _page(container: object, **kwargs: Any) -> review_routes.GroupPage:
    params: dict[str, Any] = {
        "kind": "exact",
        "limit": 2,
        "max_distance": 8,
        "excluded_roots": [],
        "cursor": None,
    }
    params.update(kwargs)
    return review_routes._list_groups(  # noqa: SLF001 - the contract under test
        container,
        Config(),
        params["kind"],
        params["limit"],
        params["max_distance"],
        params["excluded_roots"],
        params["cursor"],
    )


def _ids(page: review_routes.GroupPage) -> list[str]:
    return [str(group["group_id"]) for group in page.groups]


class TestTruncationIsVisible:
    def test_a_full_page_says_more_follows(self, container: object) -> None:
        page = _page(container, limit=2)

        assert len(page.groups) == 2
        assert page.truncated is True
        assert page.next_cursor is not None

    def test_a_page_that_exhausts_the_library_does_not(self, container: object) -> None:
        page = _page(container, limit=GROUP_COUNT)

        assert len(page.groups) == GROUP_COUNT
        assert page.truncated is False
        assert page.next_cursor is None

    def test_the_boundary_page_is_not_a_false_positive(self, container: object) -> None:
        """Exactly `limit` groups is the case a naive `len(selected) >= limit`
        check reports as truncated when nothing follows."""
        page = _page(container, limit=GROUP_COUNT)

        assert page.truncated is False


class TestPagingIsExact:
    def test_following_the_cursor_returns_every_group_exactly_once(self, container: object) -> None:
        seen: list[str] = []
        cursor: str | None = None
        for _ in range(GROUP_COUNT + 2):  # a bound, so a broken cursor cannot loop
            page = _page(container, limit=2, cursor=cursor)
            seen.extend(_ids(page))
            cursor = page.next_cursor
            if cursor is None:
                break

        assert cursor is None, "paging did not terminate"
        assert len(seen) == GROUP_COUNT
        assert len(set(seen)) == GROUP_COUNT, "a group was served on two pages"
        assert seen == _ids(_page(container, limit=GROUP_COUNT)), "paging changed the order"

    def test_the_cursor_names_the_last_group_of_the_page(self, container: object) -> None:
        page = _page(container, limit=2)

        assert page.next_cursor is not None
        assert decode_cursor(page.next_cursor)["id"] == _ids(page)[-1]


class TestACursorIsRefusedRatherThanReinterpreted:
    def test_a_cursor_from_a_different_kind_is_refused(self, container: object) -> None:
        cursor = _page(container, limit=2).next_cursor

        with pytest.raises(CursorError, match="different list"):
            _page(container, kind="similar", limit=2, cursor=cursor)

    def test_a_cursor_from_a_different_threshold_is_refused(self, container: object) -> None:
        cursor = _page(container, limit=2, max_distance=8).next_cursor

        with pytest.raises(CursorError, match="different list"):
            _page(container, limit=2, max_distance=4, cursor=cursor)

    def test_a_cursor_from_before_a_reindex_is_refused(
        self, container: object, catalog_path: Path
    ) -> None:
        """Resuming across a re-index would page a list that no longer exists."""
        cursor = _page(container, limit=2).next_cursor
        with MediaCatalog(catalog_path) as catalog:
            generation = catalog.begin_generation("input")
            catalog.finish_generation(generation, "complete")

        with pytest.raises(CursorError, match="catalog changed"):
            _page(container, limit=2, cursor=cursor)

    def test_a_partial_rescan_does_not_invalidate_a_cursor(
        self, container: object, catalog_path: Path
    ) -> None:
        """Deliberate, and consistent with the rest of the codebase rather than
        stricter here: `current_generation()` counts only completed generations,
        and it is the same scalar the plan-freshness check (C-04) and the list
        views key off. A scan nobody finished has not changed what the catalog
        says, so it does not expire a page marker either."""
        cursor = _page(container, limit=2).next_cursor
        with MediaCatalog(catalog_path) as catalog:
            generation = catalog.begin_generation("input")
            catalog.finish_generation(generation, "partial")

        page = _page(container, limit=2, cursor=cursor)

        assert _ids(page)

    def test_an_unreadable_cursor_is_refused(self, container: object) -> None:
        with pytest.raises(CursorError):
            _page(container, limit=2, cursor="not-a-cursor")


class TestTheRouteSurfacesIt:
    def test_an_unreadable_cursor_is_a_400(self, client: Any, monkeypatch: Any) -> None:
        def refuse(*args: object, **kwargs: object) -> None:
            raise CursorError("this page marker is not readable")

        monkeypatch.setattr(review_routes, "_list_groups", refuse)

        response = client.get("/api/review/groups", params={"cursor": "bad"})

        assert response.status_code == 400
        assert "not readable" in response.json()["detail"]

    def test_a_page_carries_the_flag_over_the_wire(self, client: Any) -> None:
        response = client.get("/api/review/groups", params={"kind": "exact"})

        assert response.status_code == 200
        body = response.json()
        assert body["truncated"] is False
        assert body["next_cursor"] is None
