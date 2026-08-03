"""Transactional access to the persistent media catalog.

Two properties matter more than speed here.

*Nothing is trusted that cannot be revalidated.* Every derived fact is stored
with the stat fingerprint and extractor version it came from, and is returned
only when both still match. A stale row is simply not a cache hit.

*Nothing is pruned on incomplete evidence.* Rows are marked missing only by a
generation that finished completely. A cancelled, partial, or crashed scan
leaves the catalog exactly as it found it, because "I did not see it" and "it
is not there" are different statements and only one of them is safe to act on.
"""

from __future__ import annotations

import hashlib
import os
import sqlite3
from collections.abc import Iterator, Sequence
from contextlib import closing, contextmanager, suppress
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from app.core.catalog_schema import (
    CATALOG_SCHEMA_VERSION,
    FINGERPRINT_ROLE,
    FINGERPRINT_VERSION,
    HASH_EXTRACTOR_VERSION,
    MEDIA_FACT_EXTRACTOR_VERSION,
    SIGNATURE_EXTRACTOR_VERSION,
    CatalogCorruptionError,
    apply_schema,
    fingerprint,
)
from app.core.logging_config import get_logger

logger = get_logger(__name__)

DEFAULT_BATCH_SIZE = 500
GenerationOutcome = Literal["running", "complete", "partial", "cancelled"]


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@dataclass(frozen=True)
class FileRecord:
    """One catalogued file and the fingerprint its facts were derived from."""

    file_id: int
    root_id: str
    relative_path: str
    size_bytes: int
    mtime_ns: int
    fingerprint: str
    ctime_ns: int | None = None
    fingerprint_version: int = 1
    fingerprint_role: str = "cache_hint"
    file_identity: str | None = None
    missing_since_generation: int | None = None
    unit_id: str | None = None
    companion_role: str | None = None
    unit_primary: bool = False
    primary_relative_path: str | None = None


@dataclass(frozen=True)
class ObservedFile:
    """What a traversal actually saw, before anything is derived from it."""

    relative_path: str
    size_bytes: int
    mtime_ns: int
    ctime_ns: int | None = None
    file_identity: str | None = None
    sample_sha256: str | None = None
    unit_id: str | None = None
    companion_role: str | None = None
    unit_primary: bool = False
    primary_relative_path: str | None = None

    @property
    def fingerprint(self) -> str:
        return fingerprint(
            size_bytes=self.size_bytes,
            mtime_ns=self.mtime_ns,
            ctime_ns=self.ctime_ns,
            file_identity=self.file_identity,
            sample_sha256=self.sample_sha256,
        )

    @classmethod
    def from_path(cls, path: Path, root: Path) -> ObservedFile:
        observed = path.stat()
        return cls(
            relative_path=str(path.relative_to(root)),
            size_bytes=observed.st_size,
            mtime_ns=observed.st_mtime_ns,
            ctime_ns=getattr(observed, "st_ctime_ns", None),
            file_identity=str(observed.st_ino) if observed.st_ino else None,
            sample_sha256=bounded_sample_sha256(path) if os.name == "nt" else None,
        )


@dataclass(frozen=True)
class CatalogDiagnostics:
    path: str
    schema_version: int
    size_bytes: int
    roots: int
    files: int
    hashed_files: int
    missing_files: int
    generations: int
    open_generations: int


@dataclass(frozen=True)
class CatalogUnit:
    """A primary and all currently-present catalog members in one unit."""

    unit_id: str
    primary: FileRecord
    members: tuple[FileRecord, ...]


class MediaCatalog:
    """The catalog's only writer and reader.

    One connection per instance, WAL enabled, with a busy timeout so a
    concurrent reader waits instead of failing. Callers work in bounded batches
    so a two-million-file library never builds one giant transaction.
    """

    def __init__(self, path: Path, *, busy_timeout_ms: int = 10_000) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = self._open(busy_timeout_ms)
        try:
            self.schema_version = self._initialize()
        except BaseException:
            self._connection.close()
            raise

    def _open(self, busy_timeout_ms: int) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, isolation_level=None)
        try:
            connection.row_factory = sqlite3.Row
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute(f"PRAGMA busy_timeout={busy_timeout_ms}")
            connection.execute("PRAGMA foreign_keys=ON")
            connection.execute("PRAGMA synchronous=NORMAL")
            return connection
        except BaseException:
            connection.close()
            raise

    def _initialize(self) -> int:
        integrity = self._connection.execute("PRAGMA integrity_check").fetchone()[0]
        if integrity != "ok":
            raise CatalogCorruptionError(f"Catalog failed integrity check: {integrity}")
        current_version = int(self._connection.execute("PRAGMA user_version").fetchone()[0])
        if 0 < current_version < CATALOG_SCHEMA_VERSION:
            backup = self.path.with_name(f"{self.path.name}.v{current_version}.backup")
            if not backup.exists():
                with closing(sqlite3.connect(backup)) as destination, destination:
                    self._connection.backup(destination)
        # Not wrapped in `transaction()`: sqlite3's ``executescript`` commits any
        # open transaction before it runs, so an explicit BEGIN here would leave
        # the COMMIT with nothing to close. The schema is idempotent
        # (``IF NOT EXISTS`` throughout), which is what makes that safe.
        return apply_schema(self._connection)

    def close(self) -> None:
        connection = getattr(self, "_connection", None)
        if connection is not None:
            connection.close()

    def __del__(self) -> None:
        """Best-effort fallback for callers that forget the context manager."""
        with suppress(Exception):
            self.close()

    def __enter__(self) -> MediaCatalog:
        return self

    def __exit__(self, *_exc: object) -> None:
        self.close()

    @contextmanager
    def transaction(self) -> Iterator[sqlite3.Connection]:
        """Run one bounded batch atomically; a failure changes nothing."""
        self._connection.execute("BEGIN IMMEDIATE")
        try:
            yield self._connection
        except BaseException:
            self._connection.execute("ROLLBACK")
            raise
        self._connection.execute("COMMIT")

    # ---------------------------------------------------------------- #
    # Roots and generations                                             #
    # ---------------------------------------------------------------- #

    def register_root(
        self,
        root_id: str,
        canonical_path: Path,
        *,
        role: str = "input",
        volume_id: str | None = None,
    ) -> str:
        now = _now()
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO roots (root_id, canonical_path, role, volume_id,
                                   first_seen_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(root_id) DO UPDATE SET
                    canonical_path = excluded.canonical_path,
                    role = excluded.role,
                    volume_id = excluded.volume_id,
                    last_seen_at = excluded.last_seen_at
                """,
                (root_id, str(canonical_path), role, volume_id, now, now),
            )
        return root_id

    def begin_generation(self, root_id: str) -> int:
        with self.transaction() as connection:
            cursor = connection.execute(
                "INSERT INTO scan_generations (root_id, started_at) VALUES (?, ?)",
                (root_id, _now()),
            )
        return int(cursor.lastrowid or 0)

    def current_generation(self) -> int:
        """The newest completed generation across every root, or 0 if none is.

        One scalar for "what the catalog currently says", so a review plan can
        tell that the results it holds were computed against an older catalog.
        Only complete generations count, for the same reason freshness does:
        a cancelled scan describes a library nobody has finished looking at.
        """
        row = self._connection.execute(
            "SELECT MAX(generation_id) AS generation FROM scan_generations "
            "WHERE outcome = 'complete'"
        ).fetchone()
        return 0 if row is None or row["generation"] is None else int(row["generation"])

    def finish_generation(self, generation_id: int, outcome: GenerationOutcome) -> None:
        """Close a generation and, only if it completed, mark what it never saw.

        This is the single place a row can become "missing". A partial or
        cancelled scan deliberately leaves every record alone.
        """
        with self.transaction() as connection:
            row = connection.execute(
                "SELECT root_id FROM scan_generations WHERE generation_id = ?",
                (generation_id,),
            ).fetchone()
            if row is None:
                return
            connection.execute(
                "UPDATE scan_generations SET finished_at = ?, outcome = ? WHERE generation_id = ?",
                (_now(), outcome, generation_id),
            )
            if outcome != "complete":
                logger.info(
                    "Generation did not complete; catalog rows left untouched",
                    generation_id=generation_id,
                    outcome=outcome,
                )
                return
            connection.execute(
                """
                UPDATE files
                   SET missing_since_generation = ?
                 WHERE root_id = ?
                   AND last_seen_generation < ?
                   AND missing_since_generation IS NULL
                """,
                (generation_id, row["root_id"], generation_id),
            )
            connection.execute(
                """
                UPDATE files
                   SET missing_since_generation = NULL
                 WHERE root_id = ?
                   AND last_seen_generation = ?
                """,
                (row["root_id"], generation_id),
            )

    # ---------------------------------------------------------------- #
    # Observation                                                       #
    # ---------------------------------------------------------------- #

    def observe(
        self,
        root_id: str,
        generation_id: int,
        observed: Sequence[ObservedFile],
    ) -> list[FileRecord]:
        """Record one bounded batch of observations and return their records.

        A file whose fingerprint changed keeps its row and its identity, but
        every fact derived from the old fingerprint stops being a cache hit —
        the fingerprint columns do the invalidation, so nothing has to be
        deleted and nothing stale can be returned.
        """
        records: list[FileRecord] = []
        with self.transaction() as connection:
            for item in observed:
                connection.execute(
                    """
                    INSERT INTO files (root_id, relative_path, file_identity, size_bytes,
                                       mtime_ns, ctime_ns, fingerprint,
                                       fingerprint_version, fingerprint_role, unit_id,
                                       companion_role, unit_primary, primary_relative_path,
                                       first_seen_generation, last_seen_generation)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(root_id, relative_path) DO UPDATE SET
                        file_identity = excluded.file_identity,
                        size_bytes = excluded.size_bytes,
                        mtime_ns = excluded.mtime_ns,
                        ctime_ns = excluded.ctime_ns,
                        fingerprint = excluded.fingerprint,
                        fingerprint_version = excluded.fingerprint_version,
                        fingerprint_role = excluded.fingerprint_role,
                        unit_id = excluded.unit_id,
                        companion_role = excluded.companion_role,
                        unit_primary = excluded.unit_primary,
                        primary_relative_path = excluded.primary_relative_path,
                        last_seen_generation = excluded.last_seen_generation,
                        missing_since_generation = NULL
                    """,
                    (
                        root_id,
                        item.relative_path,
                        item.file_identity,
                        item.size_bytes,
                        item.mtime_ns,
                        item.ctime_ns,
                        item.fingerprint,
                        FINGERPRINT_VERSION,
                        FINGERPRINT_ROLE,
                        item.unit_id,
                        item.companion_role,
                        int(item.unit_primary),
                        item.primary_relative_path,
                        generation_id,
                        generation_id,
                    ),
                )
                records.append(self._record(connection, root_id, item.relative_path))
        return records

    def reconcile_rename(
        self,
        root_id: str,
        generation_id: int,
        *,
        file_identity: str,
        new_relative_path: str,
    ) -> FileRecord | None:
        """Follow a moved file by its filesystem identity instead of its name.

        A rename that is treated as a delete plus an add throws away a hash the
        catalog already paid to compute, so identity is checked first.
        """
        with self.transaction() as connection:
            row = connection.execute(
                """
                SELECT file_id, relative_path FROM files
                 WHERE root_id = ? AND file_identity = ? AND relative_path != ?
                 ORDER BY last_seen_generation DESC LIMIT 1
                """,
                (root_id, file_identity, new_relative_path),
            ).fetchone()
            if row is None:
                return None
            connection.execute(
                """
                UPDATE files
                   SET relative_path = ?,
                       last_seen_generation = ?,
                       missing_since_generation = NULL
                 WHERE file_id = ?
                """,
                (new_relative_path, generation_id, row["file_id"]),
            )
            return self._record(connection, root_id, new_relative_path)

    # ---------------------------------------------------------------- #
    # Derived facts                                                     #
    # ---------------------------------------------------------------- #

    def store_hash(self, record: FileRecord, sha256: str) -> None:
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO file_hashes (file_id, sha256, fingerprint,
                                         extractor_version, computed_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(file_id) DO UPDATE SET
                    sha256 = excluded.sha256,
                    fingerprint = excluded.fingerprint,
                    extractor_version = excluded.extractor_version,
                    computed_at = excluded.computed_at
                """,
                (record.file_id, sha256, record.fingerprint, HASH_EXTRACTOR_VERSION, _now()),
            )

    def hash_for(self, record: FileRecord) -> str | None:
        """Return a stored hash only if it is still provably about this content."""
        if record.fingerprint_version != FINGERPRINT_VERSION:
            return None
        row = self._connection.execute(
            """
            SELECT sha256 FROM file_hashes
             WHERE file_id = ? AND fingerprint = ? AND extractor_version = ?
            """,
            (record.file_id, record.fingerprint, HASH_EXTRACTOR_VERSION),
        ).fetchone()
        return None if row is None else str(row["sha256"])

    def store_media_facts(self, record: FileRecord, **facts: Any) -> None:
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO media_facts (file_id, kind, captured_at, camera_model,
                                         width, height, duration_seconds,
                                         fingerprint, extractor_version, computed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(file_id) DO UPDATE SET
                    kind = excluded.kind,
                    captured_at = excluded.captured_at,
                    camera_model = excluded.camera_model,
                    width = excluded.width,
                    height = excluded.height,
                    duration_seconds = excluded.duration_seconds,
                    fingerprint = excluded.fingerprint,
                    extractor_version = excluded.extractor_version,
                    computed_at = excluded.computed_at
                """,
                (
                    record.file_id,
                    facts.get("kind", "unknown"),
                    facts.get("captured_at"),
                    facts.get("camera_model"),
                    facts.get("width"),
                    facts.get("height"),
                    facts.get("duration_seconds"),
                    record.fingerprint,
                    MEDIA_FACT_EXTRACTOR_VERSION,
                    _now(),
                ),
            )

    def media_facts_for(self, record: FileRecord) -> dict[str, Any] | None:
        if record.fingerprint_version != FINGERPRINT_VERSION:
            return None
        row = self._connection.execute(
            """
            SELECT kind, captured_at, camera_model, width, height, duration_seconds
              FROM media_facts
             WHERE file_id = ? AND fingerprint = ? AND extractor_version = ?
            """,
            (record.file_id, record.fingerprint, MEDIA_FACT_EXTRACTOR_VERSION),
        ).fetchone()
        return None if row is None else dict(row)

    def store_signature(
        self,
        record: FileRecord,
        kind: str,
        value: str,
        *,
        mean_rgb: str | None = None,
    ) -> None:
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO signatures (file_id, kind, value, mean_rgb, fingerprint,
                                        extractor_version, computed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(file_id, kind) DO UPDATE SET
                    value = excluded.value,
                    mean_rgb = excluded.mean_rgb,
                    fingerprint = excluded.fingerprint,
                    extractor_version = excluded.extractor_version,
                    computed_at = excluded.computed_at
                """,
                (
                    record.file_id,
                    kind,
                    value,
                    mean_rgb,
                    record.fingerprint,
                    SIGNATURE_EXTRACTOR_VERSION,
                    _now(),
                ),
            )

    def signature_for(self, record: FileRecord, kind: str) -> dict[str, Any] | None:
        if record.fingerprint_version != FINGERPRINT_VERSION:
            return None
        row = self._connection.execute(
            """
            SELECT value, mean_rgb FROM signatures
             WHERE file_id = ? AND kind = ? AND fingerprint = ? AND extractor_version = ?
            """,
            (record.file_id, kind, record.fingerprint, SIGNATURE_EXTRACTOR_VERSION),
        ).fetchone()
        return None if row is None else dict(row)

    def invalidate_derived(self, record: FileRecord, *, kinds: Sequence[str] = ()) -> None:
        """Drop selected derived facts without touching the observation itself."""
        targets = kinds or ("hash", "media_facts", "signatures", "thumbnails")
        table_by_kind = {
            "hash": "file_hashes",
            "media_facts": "media_facts",
            "signatures": "signatures",
            "thumbnails": "thumbnails",
        }
        with self.transaction() as connection:
            for kind in targets:
                table = table_by_kind.get(kind)
                if table is None:
                    continue
                connection.execute(f"DELETE FROM {table} WHERE file_id = ?", (record.file_id,))

    # ---------------------------------------------------------------- #
    # Queries                                                           #
    # ---------------------------------------------------------------- #

    def iter_files(
        self,
        root_id: str,
        *,
        batch_size: int = DEFAULT_BATCH_SIZE,
        include_missing: bool = False,
    ) -> Iterator[FileRecord]:
        """Walk a root by indexed cursor so memory stays flat at any size."""
        cursor = 0
        missing_clause = "" if include_missing else " AND missing_since_generation IS NULL"
        while True:
            rows = self._connection.execute(
                f"""
                SELECT * FROM files
                 WHERE root_id = ? AND file_id > ?{missing_clause}
                 ORDER BY file_id LIMIT ?
                """,
                (root_id, cursor, batch_size),
            ).fetchall()
            if not rows:
                return
            for row in rows:
                cursor = int(row["file_id"])
                yield _to_record(row)

    def count_files(self, root_id: str, *, include_missing: bool = False) -> int:
        """Count catalog rows without materializing them."""
        missing_clause = "" if include_missing else " AND missing_since_generation IS NULL"
        row = self._connection.execute(
            f"SELECT count(*) AS total FROM files WHERE root_id = ?{missing_clause}",
            (root_id,),
        ).fetchone()
        return int(row["total"]) if row is not None else 0

    def file_by_id(self, file_id: int) -> FileRecord | None:
        """Return one current catalog row by its stable identifier."""
        row = self._connection.execute(
            "SELECT * FROM files WHERE file_id = ? AND missing_since_generation IS NULL",
            (file_id,),
        ).fetchone()
        return _to_record(row) if row is not None else None

    def find_by_hash(self, sha256: str, *, limit: int = 50) -> list[FileRecord]:
        rows = self._connection.execute(
            """
            SELECT f.* FROM files f
              JOIN file_hashes h ON h.file_id = f.file_id
             WHERE h.sha256 = ? AND h.fingerprint = f.fingerprint
               AND f.fingerprint_version = ?
               AND f.missing_since_generation IS NULL
             LIMIT ?
            """,
            (sha256, FINGERPRINT_VERSION, limit),
        ).fetchall()
        return [_to_record(row) for row in rows]

    def iter_units(self, root_id: str) -> Iterator[CatalogUnit]:
        """Return complete units while leaving :meth:`iter_files` unchanged."""
        rows = self._connection.execute(
            """
            SELECT * FROM files
             WHERE root_id = ? AND unit_id IS NOT NULL
               AND missing_since_generation IS NULL
             ORDER BY unit_id, unit_primary DESC, file_id
            """,
            (root_id,),
        )
        current_id: str | None = None
        members: list[FileRecord] = []
        for row in rows:
            record = _to_record(row)
            if current_id is not None and record.unit_id != current_id:
                primary = next(item for item in members if item.unit_primary)
                yield CatalogUnit(current_id, primary, tuple(members))
                members = []
            current_id = record.unit_id
            members.append(record)
        if current_id is not None and members:
            primary = next(item for item in members if item.unit_primary)
            yield CatalogUnit(current_id, primary, tuple(members))

    def root_path(self, root_id: str) -> Path | None:
        """The canonical location a root's relative paths are resolved against."""
        row = self._connection.execute(
            "SELECT canonical_path FROM roots WHERE root_id = ?", (root_id,)
        ).fetchone()
        return None if row is None else Path(str(row["canonical_path"]))

    def last_complete_generation(self, root_id: str) -> dict[str, Any] | None:
        """The newest generation that actually finished, with its issue count.

        Only a complete generation is reported: freshness derived from a scan
        that was cancelled halfway would certify a library nobody has seen.
        """
        row = self._connection.execute(
            """
            SELECT g.generation_id, g.finished_at,
                   (SELECT COUNT(*) FROM issues i
                     WHERE i.generation_id = g.generation_id) AS issue_count
              FROM scan_generations g
             WHERE g.root_id = ? AND g.outcome = 'complete'
             ORDER BY g.generation_id DESC LIMIT 1
            """,
            (root_id,),
        ).fetchone()
        return None if row is None else dict(row)

    def record_issue(
        self,
        root_id: str,
        generation_id: int,
        *,
        path: str,
        error_class: str,
        message: str,
    ) -> None:
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO issues (root_id, generation_id, path, error_class,
                                    message, recorded_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (root_id, generation_id, path, error_class, message, _now()),
            )

    def save_checkpoint(
        self,
        operation_id: str,
        *,
        cursor: int,
        root_id: str | None = None,
        phase: str | None = None,
        payload: str | None = None,
    ) -> None:
        with self.transaction() as connection:
            connection.execute(
                """
                INSERT INTO checkpoints (operation_id, root_id, cursor, phase, payload, updated_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(operation_id) DO UPDATE SET
                    root_id = excluded.root_id,
                    cursor = excluded.cursor,
                    phase = excluded.phase,
                    payload = excluded.payload,
                    updated_at = excluded.updated_at
                """,
                (operation_id, root_id, cursor, phase, payload, _now()),
            )

    def checkpoint(self, operation_id: str) -> dict[str, Any] | None:
        row = self._connection.execute(
            "SELECT root_id, cursor, phase, payload FROM checkpoints WHERE operation_id = ?",
            (operation_id,),
        ).fetchone()
        return None if row is None else dict(row)

    # ---------------------------------------------------------------- #
    # Diagnostics and maintenance                                       #
    # ---------------------------------------------------------------- #

    def diagnostics(self) -> CatalogDiagnostics:
        counts = {
            name: int(self._connection.execute(query).fetchone()[0])
            for name, query in (
                ("roots", "SELECT COUNT(*) FROM roots"),
                ("files", "SELECT COUNT(*) FROM files WHERE missing_since_generation IS NULL"),
                ("hashed", "SELECT COUNT(*) FROM file_hashes"),
                (
                    "missing",
                    "SELECT COUNT(*) FROM files WHERE missing_since_generation IS NOT NULL",
                ),
                ("generations", "SELECT COUNT(*) FROM scan_generations"),
                ("open", "SELECT COUNT(*) FROM scan_generations WHERE outcome = 'running'"),
            )
        }
        return CatalogDiagnostics(
            path=str(self.path),
            schema_version=CATALOG_SCHEMA_VERSION,
            size_bytes=self.path.stat().st_size if self.path.exists() else 0,
            roots=counts["roots"],
            files=counts["files"],
            hashed_files=counts["hashed"],
            missing_files=counts["missing"],
            generations=counts["generations"],
            open_generations=counts["open"],
        )

    def forget_root(self, root_id: str) -> None:
        """Selective rebuild: drop one root's records, leaving the rest intact."""
        with self.transaction() as connection:
            connection.execute("DELETE FROM roots WHERE root_id = ?", (root_id,))

    def vacuum(self) -> None:
        self._connection.execute("VACUUM")

    # ---------------------------------------------------------------- #
    # Internals                                                         #
    # ---------------------------------------------------------------- #

    @staticmethod
    def _record(connection: sqlite3.Connection, root_id: str, relative_path: str) -> FileRecord:
        row = connection.execute(
            "SELECT * FROM files WHERE root_id = ? AND relative_path = ?",
            (root_id, relative_path),
        ).fetchone()
        return _to_record(row)


def _to_record(row: sqlite3.Row) -> FileRecord:
    return FileRecord(
        file_id=int(row["file_id"]),
        root_id=str(row["root_id"]),
        relative_path=str(row["relative_path"]),
        size_bytes=int(row["size_bytes"]),
        mtime_ns=int(row["mtime_ns"]),
        ctime_ns=None if row["ctime_ns"] is None else int(row["ctime_ns"]),
        fingerprint=str(row["fingerprint"]),
        fingerprint_version=int(row["fingerprint_version"]),
        fingerprint_role=str(row["fingerprint_role"]),
        file_identity=(None if row["file_identity"] is None else str(row["file_identity"])),
        missing_since_generation=(
            None
            if row["missing_since_generation"] is None
            else int(row["missing_since_generation"])
        ),
        unit_id=None if row["unit_id"] is None else str(row["unit_id"]),
        companion_role=(None if row["companion_role"] is None else str(row["companion_role"])),
        unit_primary=bool(row["unit_primary"]),
        primary_relative_path=(
            None if row["primary_relative_path"] is None else str(row["primary_relative_path"])
        ),
    )


def bounded_sample_sha256(path: Path, *, sample_bytes: int = 4096) -> str:
    """Hash bounded first/last samples where the platform lacks change time."""
    size = path.stat().st_size
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        digest.update(stream.read(sample_bytes))
        if size > sample_bytes:
            stream.seek(max(sample_bytes, size - sample_bytes))
            digest.update(stream.read(sample_bytes))
    return digest.hexdigest()
