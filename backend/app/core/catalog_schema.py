"""Versioned SQLite schema for the persistent media catalog.

The catalog remembers what a scan already learned about a library so a second
run does not have to re-read every byte. That only helps if the remembered
facts are trustworthy, so each derived fact records the extractor version that
produced it and the stat fingerprint it was derived from — a file whose
fingerprint changed invalidates exactly the facts that depended on it, and
nothing else.

Schema changes are additive. Columns are never dropped or renamed; a new
version adds tables or nullable columns and bumps ``CATALOG_SCHEMA_VERSION``.
"""

from __future__ import annotations

import sqlite3
from typing import Final

CATALOG_SCHEMA_VERSION: Final = 3
FINGERPRINT_VERSION: Final = 2
FINGERPRINT_ROLE: Final = "cache_hint"

#: Bump the matching extractor version whenever a producer's output could
#: differ for identical bytes. Rows carrying an older version are recomputed
#: rather than trusted.
HASH_EXTRACTOR_VERSION: Final = 1
MEDIA_FACT_EXTRACTOR_VERSION: Final = 1
SIGNATURE_EXTRACTOR_VERSION: Final = 1

SCHEMA: Final = """
CREATE TABLE IF NOT EXISTS roots (
    root_id       TEXT PRIMARY KEY,
    canonical_path TEXT NOT NULL,
    role          TEXT NOT NULL,
    volume_id     TEXT,
    first_seen_at TEXT NOT NULL,
    last_seen_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scan_generations (
    generation_id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id       TEXT NOT NULL REFERENCES roots(root_id) ON DELETE CASCADE,
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    -- 'running' | 'complete' | 'partial' | 'cancelled'. Only 'complete' may
    -- ever authorize pruning rows this generation did not see.
    outcome       TEXT NOT NULL DEFAULT 'running'
);

CREATE INDEX IF NOT EXISTS idx_generations_root ON scan_generations(root_id, generation_id);

CREATE TABLE IF NOT EXISTS files (
    file_id        INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id        TEXT NOT NULL REFERENCES roots(root_id) ON DELETE CASCADE,
    relative_path  TEXT NOT NULL,
    -- Filesystem identity where available (inode / file index). Lets a rename
    -- be recognized as the same content instead of a delete plus an add.
    file_identity  TEXT,
    size_bytes     INTEGER NOT NULL,
    mtime_ns       INTEGER NOT NULL,
    ctime_ns       INTEGER,
    -- The stat fingerprint every derived fact below was computed from.
    fingerprint    TEXT NOT NULL,
    fingerprint_version INTEGER NOT NULL DEFAULT 1,
    fingerprint_role TEXT NOT NULL DEFAULT 'cache_hint',
    unit_id         TEXT,
    companion_role  TEXT,
    unit_primary    INTEGER NOT NULL DEFAULT 0,
    primary_relative_path TEXT,
    first_seen_generation INTEGER NOT NULL,
    last_seen_generation  INTEGER NOT NULL,
    -- Set when a generation that completed successfully no longer saw the row.
    missing_since_generation INTEGER,
    UNIQUE (root_id, relative_path)
);

CREATE INDEX IF NOT EXISTS idx_files_identity ON files(root_id, file_identity);
CREATE INDEX IF NOT EXISTS idx_files_seen ON files(root_id, last_seen_generation);
CREATE INDEX IF NOT EXISTS idx_files_cursor ON files(root_id, file_id);

CREATE TABLE IF NOT EXISTS file_hashes (
    file_id           INTEGER PRIMARY KEY REFERENCES files(file_id) ON DELETE CASCADE,
    sha256            TEXT NOT NULL,
    fingerprint       TEXT NOT NULL,
    extractor_version INTEGER NOT NULL,
    computed_at       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_hashes_sha256 ON file_hashes(sha256);

CREATE TABLE IF NOT EXISTS media_facts (
    file_id           INTEGER PRIMARY KEY REFERENCES files(file_id) ON DELETE CASCADE,
    kind              TEXT NOT NULL,
    captured_at       TEXT,
    camera_model      TEXT,
    width             INTEGER,
    height            INTEGER,
    duration_seconds  REAL,
    fingerprint       TEXT NOT NULL,
    extractor_version INTEGER NOT NULL,
    computed_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signatures (
    file_id           INTEGER NOT NULL REFERENCES files(file_id) ON DELETE CASCADE,
    kind              TEXT NOT NULL,
    value             TEXT NOT NULL,
    mean_rgb          TEXT,
    fingerprint       TEXT NOT NULL,
    extractor_version INTEGER NOT NULL,
    computed_at       TEXT NOT NULL,
    PRIMARY KEY (file_id, kind)
);

CREATE TABLE IF NOT EXISTS thumbnails (
    file_id       INTEGER PRIMARY KEY REFERENCES files(file_id) ON DELETE CASCADE,
    -- A reference, never the image itself: the catalog stays small and a
    -- deleted cache never turns into a corrupt row.
    reference     TEXT NOT NULL,
    fingerprint   TEXT NOT NULL,
    computed_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issues (
    issue_id     INTEGER PRIMARY KEY AUTOINCREMENT,
    root_id      TEXT NOT NULL REFERENCES roots(root_id) ON DELETE CASCADE,
    generation_id INTEGER NOT NULL,
    path         TEXT NOT NULL,
    error_class  TEXT NOT NULL,
    message      TEXT NOT NULL,
    recorded_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_issues_generation ON issues(root_id, generation_id);

CREATE TABLE IF NOT EXISTS checkpoints (
    operation_id TEXT PRIMARY KEY,
    root_id      TEXT,
    cursor       INTEGER NOT NULL DEFAULT 0,
    phase        TEXT,
    payload      TEXT,
    updated_at   TEXT NOT NULL
);
"""


class CatalogCorruptionError(RuntimeError):
    """The catalog is not a usable database and must not be trusted."""


def apply_schema(connection: sqlite3.Connection) -> int:
    """Create or migrate the catalog, returning the resulting version.

    A catalog from a *newer* build is left untouched: silently downgrading
    someone's index is worse than refusing to open it.
    """
    version = int(connection.execute("PRAGMA user_version").fetchone()[0])
    if version > CATALOG_SCHEMA_VERSION:
        raise CatalogCorruptionError(
            f"Catalog schema v{version} was written by a newer build "
            f"(this build understands v{CATALOG_SCHEMA_VERSION})"
        )
    connection.executescript(SCHEMA)
    columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(files)").fetchall()}
    additions = {
        "ctime_ns": "INTEGER",
        "unit_id": "TEXT",
        "companion_role": "TEXT",
        "unit_primary": "INTEGER NOT NULL DEFAULT 0",
        "primary_relative_path": "TEXT",
        "fingerprint_version": "INTEGER NOT NULL DEFAULT 1",
        "fingerprint_role": "TEXT NOT NULL DEFAULT 'cache_hint'",
    }
    for column, declaration in additions.items():
        if column not in columns:
            connection.execute(f'ALTER TABLE files ADD COLUMN "{column}" {declaration}')
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_files_unit ON files(root_id, unit_id, unit_primary)"
    )
    if version != CATALOG_SCHEMA_VERSION:
        connection.execute(f"PRAGMA user_version = {CATALOG_SCHEMA_VERSION}")
    return CATALOG_SCHEMA_VERSION


def fingerprint(
    *,
    size_bytes: int,
    mtime_ns: int,
    ctime_ns: int | None = None,
    file_identity: str | None,
    sample_sha256: str | None = None,
) -> str:
    """The cheap identity a derived fact is valid for.

    This is explicitly a cache hint, never destructive proof. Change time catches
    in-place rewrites on POSIX filesystems; platforms whose change time is a
    creation time add a bounded byte sample. Destructive actions independently
    rehash the complete current bytes.
    """
    return (
        f"v{FINGERPRINT_VERSION}:{FINGERPRINT_ROLE}:{size_bytes}:{mtime_ns}:"
        f"{ctime_ns if ctime_ns is not None else '-'}:{file_identity or '-'}:"
        f"{sample_sha256 or '-'}"
    )
