"""SQLite operation-history storage with explicit schema migrations."""

from __future__ import annotations

import sqlite3
import time
from collections.abc import Generator
from contextlib import closing, contextmanager
from pathlib import Path

from app.core.paths import resolve_app_paths

CURRENT_DATABASE_SCHEMA = 6
BASELINE_OPERATION_COLUMNS = {
    "id",
    "execution_date",
    "source_path",
    "dest_path",
    "total_files",
    "files_sorted",
    "files_failed",
    "files_skipped",
    "duplicates_found",
    "duration_seconds",
    "config_hash",
    "created_at",
}
BASELINE_FILE_OPERATION_COLUMNS = {
    "id",
    "operation_id",
    "source_path",
    "dest_path",
    "extracted_date",
    "metadata_source",
    "action",
    "status",
    "error_message",
    "file_size",
    "file_type",
    "timestamp",
}
VERSION_2_OPERATION_COLUMNS = {"future_dates", "unknown_dates", "corrupted_files"}
VERSION_2_FILE_OPERATION_COLUMNS = {
    "tags",
    "category",
    "camera_model",
    "duplicate_type",
    "duplicate_similarity",
    "duplicate_of",
    "suspicious",
}
VERSION_3_OPERATION_COLUMNS = {"junk_files", "already_in_destination"}
VERSION_4_OPERATION_COLUMNS = {"companion_files", "incomplete_units"}
VERSION_4_FILE_OPERATION_COLUMNS = {"unit_id", "companion_role", "unit_primary_path"}
VERSION_5_FILE_OPERATION_COLUMNS = {"source_root", "would_be_destination"}
VERSION_6_OPERATION_COLUMNS = {"excluded_roots"}

OPERATIONS_TABLE = """
CREATE TABLE IF NOT EXISTS operations (
    id TEXT PRIMARY KEY,
    execution_date DATETIME NOT NULL,
    source_path TEXT NOT NULL,
    dest_path TEXT NOT NULL,
    total_files INTEGER NOT NULL DEFAULT 0,
    files_sorted INTEGER NOT NULL DEFAULT 0,
    files_failed INTEGER NOT NULL DEFAULT 0,
    files_skipped INTEGER NOT NULL DEFAULT 0,
    duplicates_found INTEGER NOT NULL DEFAULT 0,
    future_dates INTEGER NOT NULL DEFAULT 0,
    unknown_dates INTEGER NOT NULL DEFAULT 0,
    corrupted_files INTEGER NOT NULL DEFAULT 0,
    junk_files INTEGER NOT NULL DEFAULT 0,
    already_in_destination INTEGER NOT NULL DEFAULT 0,
    companion_files INTEGER NOT NULL DEFAULT 0,
    incomplete_units INTEGER NOT NULL DEFAULT 0,
    excluded_roots TEXT NOT NULL DEFAULT '[]',
    duration_seconds INTEGER,
    config_hash TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)
"""

FILE_OPERATIONS_TABLE = """
CREATE TABLE IF NOT EXISTS file_operations (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    source_path TEXT NOT NULL,
    dest_path TEXT,
    extracted_date DATE,
    metadata_source TEXT,
    action TEXT,
    status TEXT,
    error_message TEXT,
    file_size INTEGER,
    file_type TEXT,
    tags TEXT,
    category TEXT,
    camera_model TEXT,
    duplicate_type TEXT,
    duplicate_similarity INTEGER,
    duplicate_of TEXT,
    suspicious INTEGER NOT NULL DEFAULT 0,
    unit_id TEXT,
    companion_role TEXT,
    unit_primary_path TEXT,
    source_root TEXT,
    would_be_destination TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (operation_id) REFERENCES operations(id)
)
"""


class DatabaseMigrationError(RuntimeError):
    """Raised when history schema inspection or migration is unsafe."""


class DatabaseManager:
    """Manage the SQLite history database and its monotonic schema version."""

    def __init__(self) -> None:
        paths = resolve_app_paths()
        self.db_dir = paths.data_dir
        self.db_path = paths.db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    def init_schema(self) -> None:
        """Create a fresh current schema or migrate an existing database in order."""

        existed = self.db_path.exists() and self.db_path.stat().st_size > 0
        conn = self._open_migration_connection()
        try:
            version = int(conn.execute("PRAGMA user_version").fetchone()[0])
            if version > CURRENT_DATABASE_SCHEMA:
                raise DatabaseMigrationError(
                    f"Database schema v{version} is newer than supported "
                    f"v{CURRENT_DATABASE_SCHEMA}: {self.db_path}"
                )

            tables = {
                str(row[0])
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            }
            if not existed or not ({"operations", "file_operations"} & tables):
                with conn:
                    conn.execute(OPERATIONS_TABLE)
                    conn.execute(FILE_OPERATIONS_TABLE)
                    conn.execute(f"PRAGMA user_version = {CURRENT_DATABASE_SCHEMA}")
                conn.execute("PRAGMA journal_mode=WAL")
                return

            self._validate_baseline(conn, tables)
            self._validate_version_shape(conn, version)
            baseline = version or 1
            if baseline == CURRENT_DATABASE_SCHEMA:
                conn.execute("PRAGMA journal_mode=WAL")
                return

            backup = self._backup_database(conn, baseline)
            try:
                for target_version in range(baseline + 1, CURRENT_DATABASE_SCHEMA + 1):
                    self._apply_migration(conn, target_version)
                self._verify_database(conn)
                conn.execute("PRAGMA journal_mode=WAL")
            except Exception as exc:
                conn.rollback()
                raise DatabaseMigrationError(
                    f"Database migration failed for {self.db_path}; "
                    f"the verified pre-upgrade backup remains at {backup}: {exc}"
                ) from exc
        finally:
            conn.close()

    def _apply_migration(self, conn: sqlite3.Connection, target_version: int) -> None:
        migrations = {
            2: (
                (
                    "operations",
                    {
                        "future_dates": "INTEGER NOT NULL DEFAULT 0",
                        "unknown_dates": "INTEGER NOT NULL DEFAULT 0",
                        "corrupted_files": "INTEGER NOT NULL DEFAULT 0",
                    },
                ),
                (
                    "file_operations",
                    {
                        "tags": "TEXT",
                        "category": "TEXT",
                        "camera_model": "TEXT",
                        "duplicate_type": "TEXT",
                        "duplicate_similarity": "INTEGER",
                        "duplicate_of": "TEXT",
                        "suspicious": "INTEGER NOT NULL DEFAULT 0",
                    },
                ),
            ),
            3: (
                (
                    "operations",
                    {
                        "junk_files": "INTEGER NOT NULL DEFAULT 0",
                        "already_in_destination": "INTEGER NOT NULL DEFAULT 0",
                    },
                ),
            ),
            4: (
                (
                    "operations",
                    {
                        "companion_files": "INTEGER NOT NULL DEFAULT 0",
                        "incomplete_units": "INTEGER NOT NULL DEFAULT 0",
                    },
                ),
                (
                    "file_operations",
                    {
                        "unit_id": "TEXT",
                        "companion_role": "TEXT",
                        "unit_primary_path": "TEXT",
                    },
                ),
            ),
            5: (
                (
                    "file_operations",
                    {
                        "source_root": "TEXT",
                        "would_be_destination": "TEXT",
                    },
                ),
            ),
            6: (
                (
                    "operations",
                    {
                        "excluded_roots": "TEXT NOT NULL DEFAULT '[]'",
                    },
                ),
            ),
        }
        steps = migrations.get(target_version)
        if steps is None:
            raise DatabaseMigrationError(f"No database migration registered for v{target_version}")

        try:
            conn.execute("BEGIN IMMEDIATE")
            for table, columns in steps:
                existing = self._columns(conn, table)
                for column, declaration in columns.items():
                    if column not in existing:
                        conn.execute(f'ALTER TABLE "{table}" ADD COLUMN "{column}" {declaration}')
            conn.execute(f"PRAGMA user_version = {target_version}")
            conn.commit()
        except Exception:
            conn.rollback()
            raise

    def _validate_baseline(self, conn: sqlite3.Connection, tables: set[str]) -> None:
        missing_tables = {"operations", "file_operations"} - tables
        if missing_tables:
            raise DatabaseMigrationError(
                "History database has an unexpected baseline; missing tables: "
                + ", ".join(sorted(missing_tables))
            )
        requirements = {
            "operations": BASELINE_OPERATION_COLUMNS,
            "file_operations": BASELINE_FILE_OPERATION_COLUMNS,
        }
        for table, required in requirements.items():
            missing = required - self._columns(conn, table)
            if missing:
                raise DatabaseMigrationError(
                    f"History database has an unexpected {table} baseline; "
                    "missing columns: " + ", ".join(sorted(missing))
                )

    def _validate_version_shape(self, conn: sqlite3.Connection, version: int) -> None:
        requirements: list[tuple[str, set[str]]] = []
        if version >= 2:
            requirements.extend(
                (
                    ("operations", VERSION_2_OPERATION_COLUMNS),
                    ("file_operations", VERSION_2_FILE_OPERATION_COLUMNS),
                )
            )
        if version >= 3:
            requirements.append(("operations", VERSION_3_OPERATION_COLUMNS))
        if version >= 4:
            requirements.extend(
                (
                    ("operations", VERSION_4_OPERATION_COLUMNS),
                    ("file_operations", VERSION_4_FILE_OPERATION_COLUMNS),
                )
            )
        if version >= 5:
            requirements.append(("file_operations", VERSION_5_FILE_OPERATION_COLUMNS))
        if version >= 6:
            requirements.append(("operations", VERSION_6_OPERATION_COLUMNS))
        for table, required in requirements:
            missing = required - self._columns(conn, table)
            if missing:
                raise DatabaseMigrationError(
                    f"History database declares schema v{version} but {table} "
                    "is missing columns: " + ", ".join(sorted(missing))
                )

    def _backup_database(self, source: sqlite3.Connection, baseline: int) -> Path:
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        stem = (
            f"{self.db_path.name}.pre-migration-v{baseline}-to-v{CURRENT_DATABASE_SCHEMA}-{stamp}"
        )
        backup = self.db_path.parent / f"{stem}.bak"
        counter = 1
        while backup.exists():
            backup = self.db_path.parent / f"{stem}-{counter}.bak"
            counter += 1

        try:
            with closing(sqlite3.connect(backup)) as target, target:
                source.backup(target)
            with closing(sqlite3.connect(backup)) as verification:
                result = verification.execute("PRAGMA integrity_check").fetchone()
                if result is None or result[0] != "ok":
                    raise DatabaseMigrationError(
                        f"Pre-upgrade database backup failed verification: {backup}"
                    )
        except Exception:
            backup.unlink(missing_ok=True)
            raise
        return backup

    @staticmethod
    def _verify_database(conn: sqlite3.Connection) -> None:
        result = conn.execute("PRAGMA integrity_check").fetchone()
        if result is None or result[0] != "ok":
            raise DatabaseMigrationError("Migrated database failed integrity_check")
        version = int(conn.execute("PRAGMA user_version").fetchone()[0])
        if version != CURRENT_DATABASE_SCHEMA:
            raise DatabaseMigrationError(
                f"Migrated database reports user_version={version}, "
                f"expected {CURRENT_DATABASE_SCHEMA}"
            )

    @staticmethod
    def _columns(conn: sqlite3.Connection, table: str) -> set[str]:
        return {str(row[1]) for row in conn.execute(f'PRAGMA table_info("{table}")').fetchall()}

    def _open_connection(self) -> sqlite3.Connection:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    def _open_migration_connection(self) -> sqlite3.Connection:
        """Inspect and back up an existing schema before enabling WAL or mutating it."""
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    @contextmanager
    def _connect(self) -> Generator[sqlite3.Connection, None, None]:
        conn = self._open_connection()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
