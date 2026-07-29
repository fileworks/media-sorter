"""Persisted desktop-state path, migration, and recovery contracts."""

from __future__ import annotations

import json
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any, cast
from unittest.mock import patch

import pytest

from app.core.config import Config, ConfigLoader, UnsupportedConfigVersion
from app.core.database import (
    CURRENT_DATABASE_SCHEMA,
    FILE_OPERATIONS_TABLE,
    OPERATIONS_TABLE,
    DatabaseManager,
    DatabaseMigrationError,
)
from app.core.paths import (
    AppPaths,
    LegacyPaths,
    paths_refer_to_same_file,
    resolve_app_paths,
    resolve_legacy_paths,
)
from app.core.state_migration import StateMigrationError, migrate_legacy_state


class FakeDirs:
    user_config_path = "/current/config/MediaSorter"
    user_data_path = "/current/data/MediaSorter"
    user_log_path = "/current/log/MediaSorter"


def _paths(tmp_path: Path, **overrides: bool) -> AppPaths:
    return AppPaths(
        config_dir=tmp_path / "current-config",
        data_dir=tmp_path / "current-data",
        log_dir=tmp_path / "current-logs",
        db_path=tmp_path / "current-data" / "mediasort.db",
        config_overridden=overrides.get("config", False),
        data_overridden=overrides.get("data", False),
        log_overridden=overrides.get("log", False),
        db_overridden=overrides.get("db", False),
    )


def _legacy(tmp_path: Path) -> LegacyPaths:
    return LegacyPaths(
        config_file=tmp_path / "legacy-config" / "config.json",
        db_path=tmp_path / "legacy-config" / "mediasort.db",
        log_dir=tmp_path / "legacy-logs",
    )


def _loader(tmp_path: Path) -> ConfigLoader:
    loader = ConfigLoader.__new__(ConfigLoader)
    loader.config_dir = tmp_path
    loader.config_file = tmp_path / "config.json"
    loader.backup_file = tmp_path / "config.json.bak"
    tmp_path.mkdir(parents=True, exist_ok=True)
    return loader


def _database(path: Path) -> DatabaseManager:
    manager = DatabaseManager.__new__(DatabaseManager)
    manager.db_dir = path.parent
    manager.db_path = path
    path.parent.mkdir(parents=True, exist_ok=True)
    return manager


def _create_v1_schema(connection: sqlite3.Connection) -> None:
    connection.execute(
        OPERATIONS_TABLE.replace(
            "    future_dates INTEGER NOT NULL DEFAULT 0,\n"
            "    unknown_dates INTEGER NOT NULL DEFAULT 0,\n"
            "    corrupted_files INTEGER NOT NULL DEFAULT 0,\n"
            "    junk_files INTEGER NOT NULL DEFAULT 0,\n"
            "    already_in_destination INTEGER NOT NULL DEFAULT 0,\n",
            "",
        )
    )
    connection.execute(
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


def test_current_paths_use_exact_identity_and_dedicated_roots() -> None:
    paths = resolve_app_paths({}, dirs=cast(Any, FakeDirs()))
    assert paths.config_dir == Path("/current/config/MediaSorter")
    assert paths.data_dir == Path("/current/data/MediaSorter")
    assert paths.log_dir == Path("/current/log/MediaSorter")
    assert paths.db_path == Path("/current/data/MediaSorter/mediasort.db")


def test_path_override_precedence_and_legacy_config_compatibility() -> None:
    paths = resolve_app_paths(
        {
            "MEDIASORT_CONFIG_DIR": "/deploy/state",
            "MEDIASORT_LOG_DIR": "/deploy/logs",
        },
        dirs=cast(Any, FakeDirs()),
    )
    assert paths.config_dir == Path("/deploy/state")
    assert paths.data_dir == Path("/deploy/state")
    assert paths.db_path == Path("/deploy/state/mediasort.db")
    assert paths.log_dir == Path("/deploy/logs")

    explicit = resolve_app_paths(
        {
            "MEDIASORT_CONFIG_DIR": "/deploy/config",
            "MEDIASORT_DATA_DIR": "/deploy/data",
            "MEDIASORT_DB_PATH": "/deploy/db/history.sqlite3",
        },
        dirs=cast(Any, FakeDirs()),
    )
    assert explicit.config_dir == Path("/deploy/config")
    assert explicit.data_dir == Path("/deploy/data")
    assert explicit.db_path == Path("/deploy/db/history.sqlite3")


def test_docker_state_overrides_keep_all_state_under_config_volume() -> None:
    paths = resolve_app_paths(
        {
            "MEDIASORT_CONFIG_DIR": "/config",
            "MEDIASORT_DATA_DIR": "/config",
            "MEDIASORT_DB_PATH": "/config/mediasort.db",
            "MEDIASORT_LOG_DIR": "/config/logs",
        },
        dirs=cast(Any, FakeDirs()),
    )
    assert paths.config_file == Path("/config/config.json")
    assert paths.data_dir == Path("/config")
    assert paths.db_path == Path("/config/mediasort.db")
    assert paths.log_dir == Path("/config/logs")


def test_historical_paths_preserve_lowercase_identity_and_split_logs() -> None:
    legacy_dirs = FakeDirs()
    legacy_dirs.user_config_path = "/legacy/config/mediasort"
    paths = resolve_legacy_paths(
        {"HOME": "/users/test", "XDG_DATA_HOME": "/legacy/data"},
        dirs=cast(Any, legacy_dirs),
        system="Linux",
    )
    assert paths.config_file == Path("/legacy/config/mediasort/config.json")
    assert paths.db_path == Path("/legacy/config/mediasort/mediasort.db")
    assert paths.log_dir == Path("/legacy/data/mediasort/logs")


def test_same_path_detection_handles_aliases_and_case_folding(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    original = tmp_path / "State" / "config.json"
    original.parent.mkdir()
    original.write_text("state", encoding="utf-8")
    alias = tmp_path / "config-alias.json"
    alias.symlink_to(original)
    assert paths_refer_to_same_file(original, alias)

    monkeypatch.setattr(
        "app.core.paths.os.path.normcase",
        lambda value: value.casefold(),
    )
    assert paths_refer_to_same_file(
        tmp_path / "CASE" / "missing.json",
        tmp_path / "case" / "missing.json",
    )


def test_migration_copies_absent_destinations_and_is_idempotent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    current = _paths(tmp_path)
    legacy = _legacy(tmp_path)
    legacy.config_file.parent.mkdir(parents=True)
    legacy.config_file.write_text('{"source_directory": "/photos"}', encoding="utf-8")
    legacy.log_dir.mkdir()
    (legacy.log_dir / "backend.log").write_text("legacy log", encoding="utf-8")
    monkeypatch.setattr(
        "app.core.state_migration.resolve_legacy_paths",
        lambda: legacy,
    )

    first = migrate_legacy_state(current)
    second = migrate_legacy_state(current)

    assert current.config_file.read_bytes() == legacy.config_file.read_bytes()
    assert (current.log_dir / "backend.log").read_text(encoding="utf-8") == "legacy log"
    assert legacy.config_file.exists()
    assert {record.outcome for record in first} == {"copied"}
    assert second == []
    manifest = json.loads(current.migration_manifest.read_text(encoding="utf-8"))
    assert manifest["version"] == 1
    assert len(manifest["records"]) == 2


def test_migration_preserves_conflicts_once_even_after_manifest_interruption(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    current = _paths(tmp_path)
    legacy = _legacy(tmp_path)
    legacy.config_file.parent.mkdir(parents=True)
    legacy.config_file.write_text("legacy", encoding="utf-8")
    current.config_file.parent.mkdir(parents=True)
    current.config_file.write_text("current", encoding="utf-8")
    monkeypatch.setattr("app.core.state_migration.resolve_legacy_paths", lambda: legacy)

    from app.core import state_migration

    real_atomic_json = state_migration._atomic_json
    calls = 0

    def interrupt_once(path: Path, document: dict[str, Any]) -> None:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise OSError("simulated interruption")
        real_atomic_json(path, document)

    monkeypatch.setattr(state_migration, "_atomic_json", interrupt_once)
    with pytest.raises(StateMigrationError):
        migrate_legacy_state(current)

    monkeypatch.setattr(state_migration, "_atomic_json", real_atomic_json)
    records = migrate_legacy_state(current)
    backups = list(current.config_dir.glob("legacy-config-*"))
    assert current.config_file.read_text(encoding="utf-8") == "current"
    assert legacy.config_file.read_text(encoding="utf-8") == "legacy"
    assert len(backups) == 1
    assert backups[0].read_text(encoding="utf-8") == "legacy"
    assert records[0].backup == str(backups[0])


def test_sqlite_migration_snapshot_includes_committed_wal_state(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    current = _paths(tmp_path)
    legacy = _legacy(tmp_path)
    legacy.db_path.parent.mkdir(parents=True)
    source = sqlite3.connect(legacy.db_path)
    try:
        source.execute("PRAGMA journal_mode=WAL")
        source.execute("CREATE TABLE history (value TEXT)")
        source.execute("INSERT INTO history VALUES ('preserved')")
        source.commit()
        monkeypatch.setattr("app.core.state_migration.resolve_legacy_paths", lambda: legacy)
        migrate_legacy_state(current)
    finally:
        source.close()

    with sqlite3.connect(current.db_path) as copied:
        assert copied.execute("SELECT value FROM history").fetchone() == ("preserved",)


def test_identical_sqlite_destination_is_recorded_without_conflict_backup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    current = _paths(tmp_path)
    legacy = _legacy(tmp_path)
    for path in (legacy.db_path, current.db_path):
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as connection:
            connection.execute("CREATE TABLE history (value TEXT)")
            connection.execute("INSERT INTO history VALUES ('same')")
    monkeypatch.setattr("app.core.state_migration.resolve_legacy_paths", lambda: legacy)

    records = migrate_legacy_state(current)

    assert [(record.kind, record.outcome) for record in records] == [("database", "identical")]
    assert not list(current.data_dir.glob("legacy-database-*"))


def test_database_and_split_log_conflicts_preserve_both_sides(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    current = _paths(tmp_path)
    legacy = _legacy(tmp_path)
    legacy.db_path.parent.mkdir(parents=True)
    source = sqlite3.connect(legacy.db_path)
    try:
        source.execute("PRAGMA journal_mode=WAL")
        source.execute("CREATE TABLE history (value TEXT)")
        source.execute("INSERT INTO history VALUES ('legacy')")
        source.commit()

        current.db_path.parent.mkdir(parents=True)
        with sqlite3.connect(current.db_path) as destination:
            destination.execute("CREATE TABLE history (value TEXT)")
            destination.execute("INSERT INTO history VALUES ('current')")

        legacy.log_dir.mkdir()
        (legacy.log_dir / "backend.log").write_text("legacy log", encoding="utf-8")
        current.log_dir.mkdir()
        (current.log_dir / "backend.log").write_text("current log", encoding="utf-8")
        monkeypatch.setattr("app.core.state_migration.resolve_legacy_paths", lambda: legacy)

        records = migrate_legacy_state(current)
    finally:
        source.close()

    by_kind = {record.kind: record for record in records}
    assert by_kind["database"].outcome == "conflict_backup"
    assert by_kind["log"].outcome == "conflict_backup"
    database_backup = by_kind["database"].backup
    log_backup = by_kind["log"].backup
    assert database_backup is not None
    assert log_backup is not None
    with sqlite3.connect(database_backup) as backup:
        assert backup.execute("SELECT value FROM history").fetchone() == ("legacy",)
    with sqlite3.connect(current.db_path) as destination:
        assert destination.execute("SELECT value FROM history").fetchone() == ("current",)
    assert Path(log_backup).read_text(encoding="utf-8") == "legacy log"
    assert (current.log_dir / "backend.log").read_text(encoding="utf-8") == "current log"


def test_data_override_does_not_suppress_independent_config_migration(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    current = _paths(tmp_path, data=True)
    legacy = _legacy(tmp_path)
    legacy.config_file.parent.mkdir(parents=True)
    legacy.config_file.write_text("legacy config", encoding="utf-8")
    monkeypatch.setattr("app.core.state_migration.resolve_legacy_paths", lambda: legacy)

    records = migrate_legacy_state(current)

    assert [(record.kind, record.outcome) for record in records] == [("config", "copied")]
    assert current.config_file.read_text(encoding="utf-8") == "legacy config"


def test_concurrent_migration_records_one_copy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    current = _paths(tmp_path)
    legacy = _legacy(tmp_path)
    legacy.config_file.parent.mkdir(parents=True)
    legacy.config_file.write_text("shared", encoding="utf-8")
    monkeypatch.setattr("app.core.state_migration.resolve_legacy_paths", lambda: legacy)

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: migrate_legacy_state(current), range(2)))

    assert sorted(len(result) for result in results) == [0, 1]
    manifest = json.loads(current.migration_manifest.read_text(encoding="utf-8"))
    assert len(manifest["records"]) == 1


def test_explicit_overrides_are_not_migration_destinations(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    current = _paths(tmp_path, config=True, data=True, db=True, log=True)
    legacy = _legacy(tmp_path)
    legacy.config_file.parent.mkdir(parents=True)
    legacy.config_file.write_text("legacy", encoding="utf-8")
    monkeypatch.setattr("app.core.state_migration.resolve_legacy_paths", lambda: legacy)
    assert migrate_legacy_state(current) == []
    assert not current.config_file.exists()


def test_config_atomic_save_rotates_valid_last_known_good(tmp_path: Path) -> None:
    loader = _loader(tmp_path)
    loader.save(Config(source_directory="/first"))
    loader.save(Config(source_directory="/second"))
    assert loader.load().source_directory == "/second"
    backup = json.loads(loader.backup_file.read_text(encoding="utf-8"))
    assert backup["source_directory"] == "/first"


def test_config_recovers_backup_and_preserves_malformed_primary(tmp_path: Path) -> None:
    loader = _loader(tmp_path)
    loader.save(Config(source_directory="/good"))
    loader._atomic_copy(loader.config_file, loader.backup_file)
    loader.config_file.write_text("{truncated", encoding="utf-8")

    assert loader.load().source_directory == "/good"
    assert list(tmp_path.glob("corrupt-config-*.json"))
    assert json.loads(loader.config_file.read_text(encoding="utf-8"))["source_directory"] == "/good"


def test_config_defaults_only_when_no_copy_is_recoverable(tmp_path: Path) -> None:
    loader = _loader(tmp_path)
    loader.config_file.write_text("{bad", encoding="utf-8")
    loader.backup_file.write_text("[also bad]", encoding="utf-8")
    assert loader.load() == Config.defaults()
    assert len(list(tmp_path.glob("corrupt-*.json*"))) == 2


def test_config_unversioned_migration_and_future_rejection(tmp_path: Path) -> None:
    loader = _loader(tmp_path)
    loader.config_file.write_text('{"source_directory": "/legacy"}', encoding="utf-8")
    assert loader.load().source_directory == "/legacy"
    migrated = json.loads(loader.config_file.read_text(encoding="utf-8"))
    assert migrated["$schema"] == "mediasort-config-v3"
    assert migrated["library_profile"]["profile_id"] == "default-library"
    assert migrated["library_profile"]["catalog"]["mode"] == "application_data"
    assert migrated["preservation_profile"]["mode"] == "organize_only"
    assert migrated["optimization_profile"]["mode"] == "disabled"

    future = '{"$schema": "mediasort-config-v999", "source_directory": "/future"}'
    loader.config_file.write_text(future, encoding="utf-8")
    with pytest.raises(UnsupportedConfigVersion):
        loader.load()
    assert loader.config_file.read_text(encoding="utf-8") == future


def test_interrupted_config_replace_keeps_previous_primary(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    loader = _loader(tmp_path)
    loader.save(Config(source_directory="/before"))
    real_replace = __import__("os").replace

    def fail_primary(source: Path, destination: Path) -> None:
        if Path(destination) == loader.config_file:
            raise OSError("simulated replace failure")
        real_replace(source, destination)

    monkeypatch.setattr("app.core.config.os.replace", fail_primary)
    with pytest.raises(OSError):
        loader.save(Config(source_directory="/after"))
    assert (
        json.loads(loader.config_file.read_text(encoding="utf-8"))["source_directory"] == "/before"
    )


def test_database_fresh_current_and_current_restart_is_noop(tmp_path: Path) -> None:
    manager = _database(tmp_path / "history.db")
    manager.init_schema()
    with manager._connect() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == CURRENT_DATABASE_SCHEMA
    assert not list(tmp_path.glob("*.pre-migration-*.bak"))
    manager.init_schema()
    assert not list(tmp_path.glob("*.pre-migration-*.bak"))


def test_database_unversioned_schema_migrates_with_verified_backup(tmp_path: Path) -> None:
    manager = _database(tmp_path / "history.db")
    with sqlite3.connect(manager.db_path) as conn:
        _create_v1_schema(conn)
        conn.execute(
            "INSERT INTO operations "
            "(id, execution_date, source_path, dest_path) "
            "VALUES ('legacy', '2026-01-01', '/source', '/destination')"
        )

    manager.init_schema()
    with manager._connect() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == CURRENT_DATABASE_SCHEMA
        operation_columns = {row[1] for row in conn.execute("PRAGMA table_info(operations)")}
        assert {"future_dates", "junk_files", "already_in_destination"} <= operation_columns
        assert conn.execute("SELECT id FROM operations").fetchone()[0] == "legacy"
    backups = list(tmp_path.glob("*.pre-migration-*.bak"))
    assert len(backups) == 1
    with sqlite3.connect(backups[0]) as backup:
        assert backup.execute("PRAGMA integrity_check").fetchone()[0] == "ok"


def test_database_v2_migrates_only_v3_columns(tmp_path: Path) -> None:
    manager = _database(tmp_path / "history.db")
    with sqlite3.connect(manager.db_path) as conn:
        _create_v1_schema(conn)
        for column in ("future_dates", "unknown_dates", "corrupted_files"):
            conn.execute(f"ALTER TABLE operations ADD COLUMN {column} INTEGER NOT NULL DEFAULT 0")
        for column, declaration in (
            ("tags", "TEXT"),
            ("category", "TEXT"),
            ("camera_model", "TEXT"),
            ("duplicate_type", "TEXT"),
            ("duplicate_similarity", "INTEGER"),
            ("duplicate_of", "TEXT"),
            ("suspicious", "INTEGER NOT NULL DEFAULT 0"),
        ):
            conn.execute(f"ALTER TABLE file_operations ADD COLUMN {column} {declaration}")
        conn.execute("PRAGMA user_version = 2")

    manager.init_schema()

    with manager._connect() as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == CURRENT_DATABASE_SCHEMA
        columns = {row[1] for row in conn.execute("PRAGMA table_info(operations)")}
        assert {"junk_files", "already_in_destination"} <= columns


def test_database_future_version_and_migration_failure_are_actionable(
    tmp_path: Path,
) -> None:
    future = _database(tmp_path / "future.db")
    with sqlite3.connect(future.db_path) as conn:
        conn.execute("CREATE TABLE operations (id TEXT PRIMARY KEY)")
        conn.execute(f"PRAGMA user_version = {CURRENT_DATABASE_SCHEMA + 1}")
    with pytest.raises(DatabaseMigrationError, match="newer"):
        future.init_schema()

    failing = _database(tmp_path / "failing.db")
    with sqlite3.connect(failing.db_path) as conn:
        _create_v1_schema(conn)

    def fail_after_change(conn: sqlite3.Connection, target_version: int) -> None:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("ALTER TABLE operations ADD COLUMN transient TEXT")
        raise sqlite3.OperationalError(f"failure at {target_version}")

    with patch.object(failing, "_apply_migration", side_effect=fail_after_change):
        with pytest.raises(DatabaseMigrationError, match="pre-upgrade backup"):
            failing.init_schema()
    with sqlite3.connect(failing.db_path) as conn:
        assert "transient" not in {row[1] for row in conn.execute("PRAGMA table_info(operations)")}
    assert list(tmp_path.glob("failing.db.pre-migration-*.bak"))


def test_database_rejects_unexpected_baseline_before_mutation(tmp_path: Path) -> None:
    manager = _database(tmp_path / "unexpected.db")
    with sqlite3.connect(manager.db_path) as conn:
        conn.execute("CREATE TABLE operations (id TEXT PRIMARY KEY)")
        conn.execute("CREATE TABLE file_operations (id TEXT PRIMARY KEY)")

    with pytest.raises(DatabaseMigrationError, match="unexpected operations baseline"):
        manager.init_schema()

    with sqlite3.connect(manager.db_path) as conn:
        assert conn.execute("PRAGMA user_version").fetchone()[0] == 0
        assert conn.execute("PRAGMA journal_mode").fetchone()[0] != "wal"
    assert not list(tmp_path.glob("unexpected.db.pre-migration-*.bak"))


def test_database_rejects_declared_current_version_with_missing_columns(
    tmp_path: Path,
) -> None:
    manager = _database(tmp_path / "incomplete-current.db")
    with sqlite3.connect(manager.db_path) as conn:
        _create_v1_schema(conn)
        conn.execute(f"PRAGMA user_version = {CURRENT_DATABASE_SCHEMA}")

    with pytest.raises(DatabaseMigrationError, match="declares schema"):
        manager.init_schema()

    assert not list(tmp_path.glob("incomplete-current.db.pre-migration-*.bak"))
