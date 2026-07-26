"""Persistent destination dedup index — the cross-run memory behind
"also compare against media already in the destination".

A small standalone SQLite file (by default hidden inside the destination root,
so it travels with the library) stores one row per destination media file:
SHA-256 always, perceptual signatures when perceptual dedup is enabled.

The index is refreshed incrementally at the start of a run: a file whose
(size, mtime) is unchanged keeps its stored signatures, so re-runs over a
large destination cost one stat per file, not one hash. Rows for files that
disappeared from the destination are dropped. This module never writes to the
destination tree itself — only to its own database file.
"""

from __future__ import annotations

import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.background_tasks.task_manager import CancellationToken
from app.core.config import Config
from app.core.logging_config import get_logger
from app.services.duplicate_service import (
    DuplicateCheckCancelled,
    DuplicateRegistry,
    DuplicateService,
    _ImageSig,
    _VideoSig,
)
from app.services.filesystem_service import TraversalIssue
from app.utils.media_utils import is_image, is_media, is_video

if TYPE_CHECKING:
    from app.background_tasks.task_manager import Task

logger = get_logger(__name__)

DEFAULT_INDEX_FILENAME = ".mediasort-dedup-index.sqlite3"

# Top-level quarantine folders are *outcomes* of previous runs, not library
# content — indexing them would make e.g. an already-quarantined duplicate
# block its own kept original from being recognised.
_EXCLUDED_TOP_LEVEL_DIRS = frozenset(
    {
        "_unknown_dates",
        "_future_dates",
        "_duplicates",
        "_failed",
        "_corrupted",
        "_junk",
        "_already_in_destination",
    }
)

_COMMIT_BATCH = 200


def resolve_index_path(config: Config) -> Path:
    """The index DB path: explicit config value, or hidden in the destination."""
    if config.dedup_index_path:
        return Path(config.dedup_index_path)
    return Path(config.target_directory) / DEFAULT_INDEX_FILENAME


@dataclass(frozen=True)
class RefreshStats:
    indexed: int = 0
    reused: int = 0
    removed: int = 0
    partial: bool = False
    issue_count: int = 0
    cancelled: bool = False


class DedupIndex:
    """SQLite-backed store of destination file signatures."""

    def __init__(self, db_path: Path) -> None:
        self._path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._init_schema()

    # ------------------------------------------------------------------ #
    # Schema / connection                                                   #
    # ------------------------------------------------------------------ #

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self._path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS files (
                    path TEXT PRIMARY KEY,
                    size INTEGER NOT NULL,
                    mtime REAL NOT NULL,
                    sha256 TEXT NOT NULL,
                    phash TEXT,
                    mean_rgb TEXT,
                    video_frames TEXT,
                    kind TEXT NOT NULL,
                    indexed_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_files_sha256 ON files(sha256);
                """
            )

    # ------------------------------------------------------------------ #
    # Refresh                                                               #
    # ------------------------------------------------------------------ #

    def refresh(
        self,
        dest_root: Path,
        duplicates: DuplicateService,
        *,
        perceptual: bool,
        sample_video: bool,
        cancel_event: CancellationToken | None = None,
        task: Task | None = None,
    ) -> RefreshStats:
        """Bring the index in line with what is actually in the destination.

        Blocking (hashing + decoding) — callers dispatch via ``asyncio.to_thread``.
        Safe to interrupt: rows are upserted in batches, so a cancelled refresh
        leaves a valid (merely incomplete) index. ``sample_video=False`` skips
        *computing* missing video signatures (an ffmpeg subprocess per file)
        but keeps any already stored.
        """
        if task is not None:
            task.transition("indexing_destination")
        media, issues, enumeration_cancelled = self._destination_media(
            dest_root,
            cancel_event=cancel_event,
        )
        if task is not None:
            task.update_progress(0, total=len(media))
            task.add_event("operation.destination_total", total=len(media))
            logger.info(
                "operation.destination_total",
                task_id=task.id,
                operation_kind=task.operation_kind,
                phase="indexing_destination",
                total=len(media),
            )
            task.mark_partial([issue.to_dict() for issue in issues])
            for issue in issues:
                logger.warning(
                    "operation.partial",
                    task_id=task.id,
                    operation_kind=task.operation_kind,
                    phase="indexing_destination",
                    path=issue.path,
                    error_class=issue.error_class,
                    error=issue.message,
                )

        indexed = reused = 0
        with self._connect() as conn:
            conn.execute(
                "CREATE TEMP TABLE IF NOT EXISTS seen_paths (path TEXT PRIMARY KEY) WITHOUT ROWID"
            )
            conn.execute("DELETE FROM seen_paths")
            known = {
                row["path"]: (row["size"], row["mtime"], row["phash"], row["video_frames"])
                for row in conn.execute("SELECT path, size, mtime, phash, video_frames FROM files")
            }
            pending = 0
            seen_batch: list[tuple[str]] = []
            for i, file_path in enumerate(media):
                if cancel_event is not None and cancel_event.is_set():
                    logger.info("Destination indexing cancelled", processed=i, total=len(media))
                    if seen_batch:
                        conn.executemany(
                            "INSERT OR IGNORE INTO seen_paths(path) VALUES (?)",
                            seen_batch,
                        )
                    return RefreshStats(
                        indexed=indexed,
                        reused=reused,
                        removed=0,
                        partial=bool(issues),
                        issue_count=len(issues),
                        cancelled=True,
                    )
                try:
                    stat = file_path.stat()
                except OSError as exc:
                    issue = TraversalIssue(str(file_path), type(exc).__name__, str(exc))
                    issues.append(issue)
                    if task is not None:
                        task.mark_partial([issue.to_dict()])
                    continue
                key = str(file_path)
                seen_batch.append((key,))
                prior = known.get(key)
                if prior is not None and prior[0] == stat.st_size and prior[1] == stat.st_mtime:
                    # Unchanged file: only fill in a signature kind that is newly
                    # wanted (e.g. first perceptual-enabled run over an
                    # exact-only index).
                    needs_phash = perceptual and is_image(file_path) and prior[2] is None
                    needs_video = (
                        perceptual and sample_video and is_video(file_path) and prior[3] is None
                    )
                    if not needs_phash and not needs_video:
                        reused += 1
                        self._report(task, i, len(media))
                        if len(seen_batch) >= _COMMIT_BATCH:
                            conn.executemany(
                                "INSERT OR IGNORE INTO seen_paths(path) VALUES (?)",
                                seen_batch,
                            )
                            seen_batch.clear()
                            conn.commit()
                        continue
                try:
                    row = self._build_row(
                        file_path,
                        stat.st_size,
                        stat.st_mtime,
                        duplicates,
                        perceptual,
                        sample_video,
                        cancel_event,
                    )
                except DuplicateCheckCancelled:
                    if seen_batch:
                        conn.executemany(
                            "INSERT OR IGNORE INTO seen_paths(path) VALUES (?)",
                            seen_batch,
                        )
                    return RefreshStats(
                        indexed=indexed,
                        reused=reused,
                        removed=0,
                        partial=bool(issues),
                        issue_count=len(issues),
                        cancelled=True,
                    )
                conn.execute(
                    """
                    INSERT INTO files (path, size, mtime, sha256, phash, mean_rgb,
                                       video_frames, kind, indexed_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(path) DO UPDATE SET
                        size=excluded.size, mtime=excluded.mtime, sha256=excluded.sha256,
                        phash=excluded.phash, mean_rgb=excluded.mean_rgb,
                        video_frames=excluded.video_frames, kind=excluded.kind,
                        indexed_at=excluded.indexed_at
                    """,
                    row,
                )
                indexed += 1
                pending += 1
                if pending >= _COMMIT_BATCH:
                    conn.executemany(
                        "INSERT OR IGNORE INTO seen_paths(path) VALUES (?)",
                        seen_batch,
                    )
                    seen_batch.clear()
                    conn.commit()
                    pending = 0
                self._report(task, i, len(media))

            if seen_batch:
                conn.executemany(
                    "INSERT OR IGNORE INTO seen_paths(path) VALUES (?)",
                    seen_batch,
                )
            cancellation_observed = enumeration_cancelled or (
                cancel_event is not None and cancel_event.is_set()
            )
            complete = not issues and not cancellation_observed
            removed = (
                conn.execute(
                    "DELETE FROM files "
                    "WHERE NOT EXISTS (SELECT 1 FROM seen_paths "
                    "WHERE seen_paths.path = files.path)"
                ).rowcount
                if complete
                else 0
            )

        stats = RefreshStats(
            indexed=indexed,
            reused=reused,
            removed=removed,
            partial=bool(issues),
            issue_count=len(issues),
            cancelled=cancellation_observed,
        )
        logger.info(
            "Destination index refreshed",
            path=str(self._path),
            indexed=indexed,
            reused=reused,
            removed=removed,
            partial=stats.partial,
            issue_count=stats.issue_count,
        )
        return stats

    @staticmethod
    def _report(task: Task | None, i: int, total: int) -> None:
        if task is not None:
            task.update_progress(i + 1, total=total)

    def _destination_media(
        self,
        dest_root: Path,
        *,
        cancel_event: CancellationToken | None = None,
    ) -> tuple[list[Path], list[TraversalIssue], bool]:
        """All media files under the destination, minus quarantine outcomes."""
        if not dest_root.is_dir():
            return [], [], False
        results: list[Path] = []
        issues: list[TraversalIssue] = []
        stack: list[tuple[Path, bool]] = [(dest_root, True)]
        while stack:
            current, is_root = stack.pop()
            if cancel_event is not None and cancel_event.is_set():
                return results, issues, True
            try:
                entries: list[Path] = []
                for entry in current.iterdir():
                    if cancel_event is not None and cancel_event.is_set():
                        return results, issues, True
                    entries.append(entry)
                entries.sort()
            except OSError as exc:
                issues.append(TraversalIssue(str(current), type(exc).__name__, str(exc)))
                logger.warning(
                    "operation.partial",
                    phase="indexing_destination",
                    path=str(current),
                    error_class=type(exc).__name__,
                    error=str(exc),
                )
                continue
            for entry in entries:
                if cancel_event is not None and cancel_event.is_set():
                    return results, issues, True
                if is_root and entry.name in _EXCLUDED_TOP_LEVEL_DIRS:
                    continue
                try:
                    if entry.is_file():
                        if is_media(entry):
                            results.append(entry)
                    elif entry.is_dir():
                        stack.append((entry, False))
                except OSError as exc:
                    issues.append(TraversalIssue(str(entry), type(exc).__name__, str(exc)))
        return sorted(results), issues, False

    def _build_row(
        self,
        file_path: Path,
        size: int,
        mtime: float,
        duplicates: DuplicateService,
        perceptual: bool,
        sample_video: bool,
        cancel_event: CancellationToken | None,
    ) -> tuple[Any, ...]:
        sha256 = duplicates.compute_hash(file_path, cancel_token=cancel_event)
        phash: str | None = None
        mean_rgb: str | None = None
        video_frames: str | None = None
        kind = "other"
        if is_image(file_path):
            kind = "image"
            if perceptual:
                sig = duplicates.image_signature(file_path, cancel_token=cancel_event)
                if sig is not None:
                    phash = str(sig.phash)
                    if sig.mean_rgb is not None:
                        mean_rgb = ",".join(f"{c:.3f}" for c in sig.mean_rgb)
        elif is_video(file_path):
            kind = "video"
            if perceptual and sample_video:
                vsig = duplicates.video_signature(file_path, cancel_token=cancel_event)
                if vsig is not None:
                    video_frames = json.dumps(
                        [
                            None if f is None else [str(f[0]), list(f[1]) if f[1] else None]
                            for f in vsig.frames
                        ]
                    )
        return (
            str(file_path),
            size,
            mtime,
            sha256,
            phash,
            mean_rgb,
            video_frames,
            kind,
            datetime.now(timezone.utc).isoformat(),
        )

    # ------------------------------------------------------------------ #
    # Loading                                                               #
    # ------------------------------------------------------------------ #

    def load_registry(self) -> DuplicateRegistry:
        """Materialise the index as a read-only DuplicateRegistry."""
        import imagehash

        registry = DuplicateRegistry()
        with self._connect() as conn:
            for row in conn.execute(
                "SELECT path, sha256, phash, mean_rgb, video_frames FROM files ORDER BY path"
            ):
                path = row["path"]
                # Stable lexical order gives deterministic destination tie-breaking.
                registry.exact.setdefault(row["sha256"], path)
                if row["phash"]:
                    registry.images.append(
                        _ImageSig(
                            phash=imagehash.hex_to_hash(row["phash"]),
                            mean_rgb=self._parse_rgb(row["mean_rgb"]),
                            path=path,
                        )
                    )
                if row["video_frames"]:
                    frames: list[tuple[Any, tuple[float, float, float] | None] | None] = []
                    for item in json.loads(row["video_frames"]):
                        if item is None:
                            frames.append(None)
                        else:
                            hex_hash, rgb = item
                            frames.append(
                                (
                                    imagehash.hex_to_hash(hex_hash),
                                    tuple(rgb) if rgb else None,
                                )
                            )
                    registry.videos.append(_VideoSig(frames=frames, path=path))
        registry.build_perceptual_indexes()
        return registry

    @staticmethod
    def _parse_rgb(raw: str | None) -> tuple[float, float, float] | None:
        if not raw:
            return None
        parts = raw.split(",")
        if len(parts) != 3:
            return None
        return (float(parts[0]), float(parts[1]), float(parts[2]))
