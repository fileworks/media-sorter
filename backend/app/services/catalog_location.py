"""Where a profile's catalog lives, and what state it is in.

Two placements exist and they answer different questions. The default keeps the
index in the application's own data directory, where it is private to the
machine and invisible to the library. Portable mode puts it beside an exported
profile so a moved drive keeps its expensive work — never inside the media
tree, and never at an arbitrary path the profile could point anywhere.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from app.core.library_profiles import CatalogFreshness, CatalogPlacement
from app.core.logging_config import get_logger
from app.services.catalog import CatalogDiagnostics, MediaCatalog

logger = get_logger(__name__)

CATALOG_FILENAME = "catalog.db"
CATALOG_DIRECTORY_NAME = "catalog"

#: A root scanned longer ago than this is reported as stale rather than fresh.
STALE_AFTER_DAYS = 30.0


@dataclass(frozen=True)
class CatalogBudget:
    """What the index is allowed to cost, and what it currently costs."""

    size_bytes: int
    soft_limit_bytes: int
    #: True once the index is large enough that the user should be told.
    over_soft_limit: bool

    @property
    def usage_ratio(self) -> float:
        return 0.0 if self.soft_limit_bytes <= 0 else self.size_bytes / self.soft_limit_bytes


#: Beyond this the catalog is worth mentioning; it is not an error, and nothing
#: is deleted automatically because of it.
DEFAULT_SOFT_LIMIT_BYTES = 2 * 1024 * 1024 * 1024


def catalog_path(
    placement: CatalogPlacement,
    *,
    data_dir: Path,
    profile_dir: Path | None = None,
) -> Path:
    """Resolve a placement to a concrete file, refusing an unsafe portable one."""
    if placement.mode == "application_data":
        return data_dir / CATALOG_DIRECTORY_NAME / CATALOG_FILENAME
    if profile_dir is None:
        raise ValueError("portable catalogs need the directory the profile was saved in")
    relative = (placement.relative_path or CATALOG_FILENAME).replace("\\", "/")
    resolved = (profile_dir / relative).resolve()
    if profile_dir.resolve() not in resolved.parents:
        # The placement model already rejects traversal; this is the second check
        # that survives a hand-written profile file reaching the resolver.
        raise ValueError("portable catalog path must stay beside the profile")
    return resolved


def open_catalog(
    placement: CatalogPlacement,
    *,
    data_dir: Path,
    profile_dir: Path | None = None,
) -> MediaCatalog:
    return MediaCatalog(catalog_path(placement, data_dir=data_dir, profile_dir=profile_dir))


def budget(
    diagnostics: CatalogDiagnostics,
    *,
    soft_limit_bytes: int = DEFAULT_SOFT_LIMIT_BYTES,
) -> CatalogBudget:
    return CatalogBudget(
        size_bytes=diagnostics.size_bytes,
        soft_limit_bytes=soft_limit_bytes,
        over_soft_limit=diagnostics.size_bytes > soft_limit_bytes,
    )


def freshness(
    catalog: MediaCatalog,
    root_id: str,
    *,
    now: datetime | None = None,
    stale_after_days: float = STALE_AFTER_DAYS,
) -> CatalogFreshness:
    """Describe one root's index state without claiming more than it knows.

    A root that has never completed a scan is `unknown`, not `fresh` — an index
    built from a cancelled traversal has never certified anything.
    """
    now = now or datetime.now(timezone.utc)
    row = catalog.last_complete_generation(root_id)
    if row is None:
        return CatalogFreshness(root_id=root_id, state="unknown")
    finished_at = row.get("finished_at")
    completed = _parse(finished_at)
    issues = int(row.get("issue_count") or 0)
    if completed is None:
        return CatalogFreshness(root_id=root_id, state="unknown", issue_count=issues)
    age_days = (now - completed).total_seconds() / 86_400
    state: Literal["stale", "fresh"] = "stale" if age_days > stale_after_days else "fresh"
    return CatalogFreshness(
        root_id=root_id,
        state=state,
        generation=int(row.get("generation_id") or 0),
        last_complete_scan_at=completed,
        issue_count=issues,
    )


def _parse(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def reset_catalog(path: Path) -> bool:
    """Delete the index file and its WAL siblings. Media is never touched.

    Returns whether anything was removed. This is the confirmed-reset path: the
    catalog is a cache, so losing it costs time, never data.
    """
    removed = False
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(str(path) + suffix)
        try:
            if candidate.exists():
                candidate.unlink()
                removed = True
        except OSError as exc:
            logger.warning("Could not remove catalog file", path=str(candidate), error=str(exc))
    return removed
