"""Tests for DatabaseManager schema creation and idempotent migrations."""

from __future__ import annotations

import sqlite3
from pathlib import Path

from app.core.database import DatabaseManager


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
    # Simulate an older schema with no `category` column.
    with sqlite3.connect(db.db_path) as conn:
        conn.execute(
            """
            CREATE TABLE file_operations (
                id TEXT PRIMARY KEY,
                operation_id TEXT NOT NULL,
                source_path TEXT NOT NULL,
                tags TEXT
            )
            """
        )
    assert "category" not in _columns(db, "file_operations")

    db.init_schema()
    assert "category" in _columns(db, "file_operations")

    # Idempotent: a second init must not raise (column already exists).
    db.init_schema()
    assert "category" in _columns(db, "file_operations")
