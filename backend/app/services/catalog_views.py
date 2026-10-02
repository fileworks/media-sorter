"""Cursor-paged projections of the catalog, for lists that must not materialize.

A preview list that holds every row works until the library is large, and then
it is the reason the window stops repainting. Everything here answers a page at
a time from an indexed cursor, so the cost of showing row one is the same
whether the library has a thousand files or two million.

The cursor is opaque to callers and stable across pages: it encodes the last row
seen, not an offset, so rows inserted or removed between pages can never make
one row appear twice or vanish unseen.
"""

from __future__ import annotations

import base64
import json
from collections.abc import Sequence
from dataclasses import dataclass, field
from typing import Any, Literal, cast

from app.core.logging_config import get_logger
from app.services.catalog import FileRecord, MediaCatalog, _to_record

logger = get_logger(__name__)

DEFAULT_PAGE_SIZE = 100
MAX_PAGE_SIZE = 500

SortKey = Literal["path", "size", "modified"]

_SORT_SQL: dict[SortKey, str] = {
    "path": "f.relative_path",
    "size": "f.size_bytes",
    "modified": "f.mtime_ns",
}


class CursorError(ValueError):
    """A cursor could not be read, so the caller must start from the beginning."""


def encode_cursor(payload: dict[str, Any]) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode("utf-8")).decode("ascii")


def decode_cursor(cursor: str) -> dict[str, Any]:
    try:
        decoded = json.loads(base64.urlsafe_b64decode(cursor.encode("ascii")))
        if not isinstance(decoded, dict):
            raise ValueError("cursor payload is not an object")
        return cast(dict[str, Any], decoded)
    except Exception as exc:  # noqa: BLE001 - any malformed cursor is the same problem
        raise CursorError("this page marker is not readable") from exc


@dataclass(frozen=True)
class ViewRow:
    """One row of a list, with only what a row actually needs to draw."""

    file_id: int
    root_id: str
    role: str
    relative_path: str
    size_bytes: int
    mtime_ns: int
    sha256: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "file_id": self.file_id,
            "root_id": self.root_id,
            "role": self.role,
            "relative_path": self.relative_path,
            "size_bytes": self.size_bytes,
            "mtime_ns": self.mtime_ns,
            "sha256": self.sha256,
        }


@dataclass
class ViewPage:
    """A bounded page plus the marker for the next one."""

    rows: list[ViewRow] = field(default_factory=list)
    next_cursor: str | None = None
    #: The generation this page was read at. A page from another generation must
    #: not be appended to these rows — the list would mix two libraries.
    generation: int = 0

    @property
    def exhausted(self) -> bool:
        return self.next_cursor is None

    def to_dict(self) -> dict[str, Any]:
        return {
            "rows": [row.to_dict() for row in self.rows],
            "next_cursor": self.next_cursor,
            "generation": self.generation,
        }


@dataclass(frozen=True)
class ViewQuery:
    """What a list is asking for. Every field narrows an indexed query."""

    roles: tuple[str, ...] = ("input", "destination", "reference")
    root_ids: tuple[str, ...] = ()
    sort: SortKey = "path"
    descending: bool = False
    search: str = ""
    min_size_bytes: int | None = None
    include_missing: bool = False

    def identity(self) -> str:
        """Two queries with the same identity may share a cursor; others may not."""
        return json.dumps(
            {
                "roles": sorted(self.roles),
                "roots": sorted(self.root_ids),
                "sort": self.sort,
                "descending": self.descending,
                "search": self.search.strip().lower(),
                "min_size": self.min_size_bytes,
                "missing": self.include_missing,
            },
            sort_keys=True,
        )


def query_page(
    catalog: MediaCatalog,
    query: ViewQuery,
    *,
    cursor: str | None = None,
    page_size: int = DEFAULT_PAGE_SIZE,
    generation: int = 0,
) -> ViewPage:
    """Read one page. Nothing outside the page is loaded or counted.

    A cursor from a different query is refused rather than reinterpreted: the
    sort order it encodes would place rows arbitrarily under the new one.
    """
    size = max(1, min(page_size, MAX_PAGE_SIZE))
    last: dict[str, Any] | None = None
    if cursor:
        decoded = decode_cursor(cursor)
        if decoded.get("q") != query.identity():
            raise CursorError("this page marker belongs to a different list")
        last = decoded

    conditions, parameters = _filter(query)

    column = _SORT_SQL[query.sort]
    direction = "DESC" if query.descending else "ASC"
    if last is not None:
        # The tie-break on file_id is what makes the cursor total: two rows with
        # the same size or path still have exactly one order.
        comparison = "<" if query.descending else ">"
        conditions.append(
            f"({column} {comparison} ? OR ({column} = ? AND f.file_id {comparison} ?))"
        )
        parameters.extend([last["v"], last["v"], last["id"]])

    sql = f"""
        SELECT f.*, r.role, h.sha256
          FROM files f
          JOIN roots r ON r.root_id = f.root_id
          LEFT JOIN file_hashes h
                 ON h.file_id = f.file_id AND h.fingerprint = f.fingerprint
         WHERE {" AND ".join(conditions)}
         ORDER BY {column} {direction}, f.file_id {direction}
         LIMIT ?
    """
    parameters.append(size + 1)

    fetched = catalog._connection.execute(sql, parameters).fetchall()  # noqa: SLF001
    rows = [
        ViewRow(
            file_id=int(row["file_id"]),
            root_id=str(row["root_id"]),
            role=str(row["role"]),
            relative_path=str(row["relative_path"]),
            size_bytes=int(row["size_bytes"]),
            mtime_ns=int(row["mtime_ns"]),
            sha256=None if row["sha256"] is None else str(row["sha256"]),
        )
        for row in fetched[:size]
    ]

    next_cursor: str | None = None
    if len(fetched) > size and rows:
        record = _to_record(fetched[size - 1])
        value = _sort_value(record, query.sort)
        next_cursor = encode_cursor({"q": query.identity(), "v": value, "id": record.file_id})

    return ViewPage(rows=rows, next_cursor=next_cursor, generation=generation)


def _filter(query: ViewQuery) -> tuple[list[str], list[Any]]:
    """The WHERE clause both the page and its header are built from."""
    placeholders = ",".join("?" for _ in query.roles) or "''"
    conditions = [f"r.role IN ({placeholders})"]
    parameters: list[Any] = list(query.roles)

    if query.root_ids:
        root_placeholders = ",".join("?" for _ in query.root_ids)
        conditions.append(f"f.root_id IN ({root_placeholders})")
        parameters.extend(query.root_ids)
    if not query.include_missing:
        conditions.append("f.missing_since_generation IS NULL")
    if query.search:
        conditions.append("f.relative_path LIKE ?")
        parameters.append(f"%{query.search}%")
    if query.min_size_bytes is not None:
        conditions.append("f.size_bytes >= ?")
        parameters.append(query.min_size_bytes)
    return conditions, parameters


def _sort_value(record: FileRecord, sort: SortKey) -> Any:
    if sort == "size":
        return record.size_bytes
    if sort == "modified":
        return record.mtime_ns
    return record.relative_path


@dataclass(frozen=True)
class ViewAggregate:
    """Totals a list header shows, computed by the database, not by the client."""

    total_rows: int
    total_bytes: int
    roots: int

    def to_dict(self) -> dict[str, int]:
        return {"total_rows": self.total_rows, "total_bytes": self.total_bytes, "roots": self.roots}


def aggregate(catalog: MediaCatalog, query: ViewQuery) -> ViewAggregate:
    """One indexed pass for the header, instead of summing a materialized list.

    It shares :func:`_filter` with the page query on purpose: a header that
    counted rows the list does not show is worse than no header at all.
    """
    conditions, parameters = _filter(query)

    row = catalog._connection.execute(  # noqa: SLF001
        f"""
        SELECT COUNT(*) AS rows_count,
               COALESCE(SUM(f.size_bytes), 0) AS bytes,
               COUNT(DISTINCT f.root_id) AS roots
          FROM files f
          JOIN roots r ON r.root_id = f.root_id
         WHERE {" AND ".join(conditions)}
        """,
        parameters,
    ).fetchone()
    return ViewAggregate(
        total_rows=int(row["rows_count"]),
        total_bytes=int(row["bytes"]),
        roots=int(row["roots"]),
    )


def iter_all(
    catalog: MediaCatalog,
    query: ViewQuery,
    *,
    page_size: int = DEFAULT_PAGE_SIZE,
) -> Sequence[ViewRow]:
    """Walk every page. For exports and tests — never for rendering a list."""
    rows: list[ViewRow] = []
    cursor: str | None = None
    while True:
        page = query_page(catalog, query, cursor=cursor, page_size=page_size)
        rows.extend(page.rows)
        if page.exhausted:
            return rows
        cursor = page.next_cursor
