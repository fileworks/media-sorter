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

import asyncio
import json
import sqlite3
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.core.config import Config
from app.core.logging_config import get_logger
from app.services.duplicate_service import (
    DuplicateRegistry,
    DuplicateService,
    _ImageSig,
    _VideoSig,
)
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
        cancel_event: asyncio.Event | None = None,
        task: Task | None = None,
    ) -> RefreshStats:
        """Bring the index in line with what is actually in the destination.

        Blocking (hashing + decoding) — callers dispatch via ``asyncio.to_thread``.
        Safe to interrupt: rows are upserted in batches, so a cancelled refresh
        leaves a valid (merely incomplete) index. ``sample_video=False`` skips
        *computing* missing video signatures (an ffmpeg subprocess per file)
        but keeps any already stored.
        """
        media = self._destination_media(dest_root)
        if task is not None:
            task.progress.phase = "indexing"
            task.progress.total = len(media)
            task.progress.current = 0
            task.progress.percentage = 0.0

        indexed = reused = 0
        seen: list[str] = []
        with self._connect() as conn:
            known = {
                row["path"]: (row["size"], row["mtime"], row["phash"], row["video_frames"])
                for row in conn.execute("SELECT path, size, mtime, phash, video_frames FROM files")
            }
            pending = 0
            for i, file_path in enumerate(media):
                if cancel_event is not None and cancel_event.is_set():
                    logger.info("Destination indexing cancelled", processed=i, total=len(media))
                    return RefreshStats(indexed=indexed, reused=reused, removed=0)
                try:
                    stat = file_path.stat()
                except OSError:
                    continue
                key = str(file_path)
                seen.append(key)
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
                        continue
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
                    self._build_row(
                        file_path, stat.st_size, stat.st_mtime, duplicates, perceptual, sample_video
                    ),
                )
                indexed += 1
                pending += 1
                if pending >= _COMMIT_BATCH:
                    conn.commit()
                    pending = 0
                self._report(task, i, len(media))

            placeholders = ",".join("?" for _ in seen) or "''"
            removed = conn.execute(
                f"DELETE FROM files WHERE path NOT IN ({placeholders})", seen
            ).rowcount

        stats = RefreshStats(indexed=indexed, reused=reused, removed=removed)
        logger.info(
            "Destination index refreshed",
            path=str(self._path),
            indexed=indexed,
            reused=reused,
            removed=removed,
        )
        return stats

    @staticmethod
    def _report(task: Task | None, i: int, total: int) -> None:
        if task is not None:
            task.progress.current = i + 1
            task.progress.percentage = round((i + 1) / total * 100, 1) if total else 0.0

    def _destination_media(self, dest_root: Path) -> list[Path]:
        """All media files under the destination, minus quarantine outcomes."""
        if not dest_root.is_dir():
            return []
        results: list[Path] = []
        try:
            top = sorted(dest_root.iterdir())
        except OSError:
            return []
        for entry in top:
            if entry.name in _EXCLUDED_TOP_LEVEL_DIRS:
                continue
            if entry.is_file():
                if is_media(entry):
                    results.append(entry)
            elif entry.is_dir():
                results.extend(p for p in sorted(entry.rglob("*")) if p.is_file() and is_media(p))
        return results

    def _build_row(
        self,
        file_path: Path,
        size: int,
        mtime: float,
        duplicates: DuplicateService,
        perceptual: bool,
        sample_video: bool,
    ) -> tuple[Any, ...]:
        sha256 = duplicates.compute_hash(file_path)
        phash: str | None = None
        mean_rgb: str | None = None
        video_frames: str | None = None
        kind = "other"
        if is_image(file_path):
            kind = "image"
            if perceptual:
                sig = duplicates.image_signature(file_path)
                if sig is not None:
                    phash = str(sig.phash)
                    if sig.mean_rgb is not None:
                        mean_rgb = ",".join(f"{c:.3f}" for c in sig.mean_rgb)
        elif is_video(file_path):
            kind = "video"
            if perceptual and sample_video:
                vsig = duplicates.video_signature(file_path)
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
                "SELECT path, sha256, phash, mean_rgb, video_frames FROM files"
            ):
                path = row["path"]
                # First-seen wins, matching in-run semantics; ties are harmless.
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
        return registry

    @staticmethod
    def _parse_rgb(raw: str | None) -> tuple[float, float, float] | None:
        if not raw:
            return None
        parts = raw.split(",")
        if len(parts) != 3:
            return None
        return (float(parts[0]), float(parts[1]), float(parts[2]))
