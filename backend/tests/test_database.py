"""Tests for DatabaseManager schema creation and idempotent migrations."""

from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path

from app.core.database import FILE_OPERATIONS_TABLE, OPERATIONS_TABLE, DatabaseManager


def _manager(tmp_path: Path) -> DatabaseManager:
    db = DatabaseManager.__new__(DatabaseManager)
    db.db_dir = tmp_path
    db.db_path = tmp_path / "test.db"
    return db


def _columns(db: DatabaseManager, table: str) -> set[str]:
    with db._connect() as conn:
        return {r[1] for r in conn.execute(f"PRAGMA table_info({table})").fetchall()}


def test_fresh_schema_has_category_column(tmp_path: Path) -> None:
    db = _manager(tmp_path)
    db.init_schema()
    assert "category" in _columns(db, "file_operations")


def test_category_column_migrated_onto_old_db(tmp_path: Path) -> None:
    """A pre-existing DB without `category` gets the column added in place."""
    db = _manager(tmp_path)
    # Simulate the complete v1 schema before tagging/category columns existed.
    with closing(sqlite3.connect(db.db_path)) as conn, conn:
        conn.execute(
            OPERATIONS_TABLE.replace(
                "    future_dates INTEGER NOT NULL DEFAULT 0,\n"
                "    unknown_dates INTEGER NOT NULL DEFAULT 0,\n"
                "    corrupted_files INTEGER NOT NULL DEFAULT 0,\n"
                "    junk_files INTEGER NOT NULL DEFAULT 0,\n"
                "    already_in_destination INTEGER NOT NULL DEFAULT 0,\n",
                "",
            )
        )
        conn.execute(
            FILE_OPERATIONS_TABLE.replace(
                "    tags TEXT,\n"
                "    category TEXT,\n"
                "    camera_model TEXT,\n"
                "    duplicate_type TEXT,\n"
                "    duplicate_similarity INTEGER,\n"
                "    duplicate_of TEXT,\n"
                "    suspicious INTEGER NOT NULL DEFAULT 0,\n",
                "",
            )
        )
    assert "category" not in _columns(db, "file_operations")

    db.init_schema()
    assert "category" in _columns(db, "file_operations")

    # Idempotent: a second init must not raise (column already exists).
    db.init_schema()
    assert "category" in _columns(db, "file_operations")
