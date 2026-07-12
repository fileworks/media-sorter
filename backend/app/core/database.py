"""SQLite database manager for operation history."""

import os
import sqlite3
from collections.abc import Generator
from contextlib import contextmanager, suppress
from pathlib import Path

from platformdirs import user_config_dir


class DatabaseManager:
    """Manages the SQLite database for operation history."""

    def __init__(self) -> None:
        # Allow Docker / headless deployments to redirect the DB via env vars.
        base = os.environ.get("MEDIASORT_CONFIG_DIR") or user_config_dir("mediasort", "mediasort")
        self.db_dir = Path(base)
        self.db_path = Path(os.environ.get("MEDIASORT_DB_PATH") or (self.db_dir / "mediasort.db"))
        # Ensure the parent directory exists — even when MEDIASORT_DB_PATH points
        # outside the config dir (e.g. a Docker volume mount).
        self.db_path.parent.mkdir(parents=True, exist_ok=True)

    def init_schema(self) -> None:
        """Create tables if they don't exist, and apply safe column migrations."""
        with self._connect() as conn:
            conn.executescript("""
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
                    duration_seconds INTEGER,
                    config_hash TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                );

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
                    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
                    FOREIGN KEY (operation_id) REFERENCES operations(id)
                );
            """)
            # Safe migrations — add columns introduced in v0.2 to existing DBs.
            # SQLite raises an error if the column already exists; we silence it.
            for col, col_type in [
                ("future_dates", "INTEGER NOT NULL DEFAULT 0"),
                ("unknown_dates", "INTEGER NOT NULL DEFAULT 0"),
                ("corrupted_files", "INTEGER NOT NULL DEFAULT 0"),
                # v0.3: junk filter + destination-aware dedup outcomes.
                ("junk_files", "INTEGER NOT NULL DEFAULT 0"),
                ("already_in_destination", "INTEGER NOT NULL DEFAULT 0"),
            ]:
                # SQLite errors if the column already exists — expected on re-runs.
                with suppress(Exception):
                    conn.execute(f"ALTER TABLE operations ADD COLUMN {col} {col_type}")
            for col, col_type in [
                ("tags", "TEXT"),
                ("category", "TEXT"),
                ("camera_model", "TEXT"),
                ("duplicate_type", "TEXT"),
                ("duplicate_similarity", "INTEGER"),
                ("duplicate_of", "TEXT"),
                ("suspicious", "INTEGER NOT NULL DEFAULT 0"),
            ]:
                # SQLite errors if the column already exists — expected on re-runs.
                with suppress(Exception):
                    conn.execute(f"ALTER TABLE file_operations ADD COLUMN {col} {col_type}")

    @contextmanager
    def _connect(self) -> Generator[sqlite3.Connection, None, None]:
        conn = sqlite3.connect(self.db_path, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        # WAL mode allows concurrent reads while a write is in progress
        # (threads write file_operations while the UI reads reports).
        # busy_timeout gives readers a grace period instead of an immediate error.
        # foreign_keys enforces FK constraints that the schema declares.
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("PRAGMA foreign_keys=ON")
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()
