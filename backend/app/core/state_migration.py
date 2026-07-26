"""Non-destructive migration of historical desktop state."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, cast

from app.core.paths import (
    AppPaths,
    paths_refer_to_same_file,
    resolve_app_paths,
    resolve_legacy_paths,
)

MIGRATION_FORMAT_VERSION = 1


class StateMigrationError(RuntimeError):
    """Raised when legacy state cannot be preserved safely."""


@dataclass(frozen=True)
class MigrationRecord:
    kind: str
    source: str
    destination: str
    fingerprint: str
    outcome: str
    backup: str | None = None


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _source_fingerprint(path: Path, *, sqlite_file: bool) -> str:
    digest = hashlib.sha256()
    digest.update(_sha256(path).encode())
    if sqlite_file:
        for suffix in ("-wal", "-shm"):
            companion = Path(f"{path}{suffix}")
            if companion.exists():
                digest.update(suffix.encode())
                digest.update(_sha256(companion).encode())
    return digest.hexdigest()


def _fsync_parent(path: Path) -> None:
    try:
        descriptor = os.open(path.parent, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _atomic_bytes_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, raw_temp = tempfile.mkstemp(
        prefix=".mediasort-migrate-",
        suffix=".tmp",
        dir=destination.parent,
    )
    temp_path = Path(raw_temp)
    try:
        with os.fdopen(fd, "wb") as target, source.open("rb") as source_handle:
            shutil.copyfileobj(source_handle, target, length=1024 * 1024)
            target.flush()
            os.fsync(target.fileno())
        if _sha256(source) != _sha256(temp_path):
            raise StateMigrationError(f"Verification failed while copying {source}")
        os.replace(temp_path, destination)
        _fsync_parent(destination)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def _atomic_sqlite_snapshot(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, raw_temp = tempfile.mkstemp(
        prefix=".mediasort-migrate-",
        suffix=".db.tmp",
        dir=destination.parent,
    )
    os.close(fd)
    temp_path = Path(raw_temp)
    temp_path.unlink(missing_ok=True)
    try:
        with sqlite3.connect(source) as source_db, sqlite3.connect(temp_path) as target_db:
            source_db.backup(target_db)
        with sqlite3.connect(temp_path) as verification:
            result = verification.execute("PRAGMA integrity_check").fetchone()
            if result is None or result[0] != "ok":
                raise StateMigrationError(f"SQLite verification failed for {source}")
        os.replace(temp_path, destination)
        _fsync_parent(destination)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


def _sqlite_content_fingerprint(path: Path) -> str:
    """Hash a consistent logical snapshot, including committed WAL contents."""
    fd, raw_temp = tempfile.mkstemp(prefix=".mediasort-fingerprint-", suffix=".db")
    os.close(fd)
    temp_path = Path(raw_temp)
    temp_path.unlink(missing_ok=True)
    try:
        with sqlite3.connect(path) as source_db, sqlite3.connect(temp_path) as target_db:
            source_db.backup(target_db)
        digest = hashlib.sha256()
        with sqlite3.connect(temp_path) as snapshot:
            for statement in snapshot.iterdump():
                digest.update(statement.encode("utf-8"))
                digest.update(b"\n")
        return digest.hexdigest()
    finally:
        temp_path.unlink(missing_ok=True)


def _atomic_json(path: Path, document: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, raw_temp = tempfile.mkstemp(prefix=".state-migration-", suffix=".tmp", dir=path.parent)
    temp_path = Path(raw_temp)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(document, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, path)
        _fsync_parent(path)
    except Exception:
        temp_path.unlink(missing_ok=True)
        raise


@contextmanager
def _migration_lock(path: Path) -> Iterator[None]:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle = path.open("a+b")
    try:
        if os.name == "nt":  # pragma: no cover - exercised by Windows CI
            import msvcrt

            windows_lock = cast(Any, msvcrt)
            acquired = False
            for _ in range(200):
                try:
                    handle.seek(0)
                    windows_lock.locking(handle.fileno(), windows_lock.LK_NBLCK, 1)
                    acquired = True
                    break
                except OSError:
                    time.sleep(0.05)
            if not acquired:
                raise StateMigrationError(f"Timed out waiting for state migration lock: {path}")
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        yield
    finally:
        if os.name == "nt":  # pragma: no cover - exercised by Windows CI
            import msvcrt

            windows_lock = cast(Any, msvcrt)
            try:
                handle.seek(0)
                windows_lock.locking(handle.fileno(), windows_lock.LK_UNLCK, 1)
            except OSError:
                pass
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def _load_manifest(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"version": MIGRATION_FORMAT_VERSION, "records": []}
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise StateMigrationError(f"Cannot read state migration manifest {path}: {exc}") from exc
    if not isinstance(document, dict):
        raise StateMigrationError(f"Invalid state migration manifest root in {path}")
    if document.get("version") != MIGRATION_FORMAT_VERSION:
        raise StateMigrationError(
            f"Unsupported state migration manifest version in {path}: {document.get('version')!r}"
        )
    if not isinstance(document.get("records"), list):
        raise StateMigrationError(f"Invalid state migration manifest records in {path}")
    return cast(dict[str, Any], document)


def _unique_backup(destination: Path, kind: str, fingerprint: str) -> Path:
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    suffix = "".join(destination.suffixes)
    stem = f"legacy-{kind}-{stamp}-{fingerprint[:12]}"
    candidate = destination.parent / f"{stem}{suffix}"
    counter = 1
    while candidate.exists():
        candidate = destination.parent / f"{stem}-{counter}{suffix}"
        counter += 1
    return candidate


def _record_key(record: dict[str, Any] | MigrationRecord) -> tuple[str, str, str, str]:
    values = asdict(record) if isinstance(record, MigrationRecord) else record
    return (
        str(values["kind"]),
        str(values["source"]),
        str(values["destination"]),
        str(values["fingerprint"]),
    )


def _migrate_artifact(
    *,
    kind: str,
    source: Path,
    destination: Path,
    sqlite_file: bool,
    records: list[dict[str, Any]],
) -> MigrationRecord | None:
    if not source.exists() or not source.is_file():
        return None

    fingerprint = _source_fingerprint(source, sqlite_file=sqlite_file)
    pending = MigrationRecord(
        kind=kind,
        source=str(source),
        destination=str(destination),
        fingerprint=fingerprint,
        outcome="pending",
    )
    completed = {_record_key(record) for record in records}
    if _record_key(pending) in completed:
        return None

    if paths_refer_to_same_file(source, destination):
        return MigrationRecord(**{**asdict(pending), "outcome": "same_file"})

    snapshot = _atomic_sqlite_snapshot if sqlite_file else _atomic_bytes_copy
    if not destination.exists():
        snapshot(source, destination)
        return MigrationRecord(**{**asdict(pending), "outcome": "copied"})

    identical = (
        _sqlite_content_fingerprint(source) == _sqlite_content_fingerprint(destination)
        if sqlite_file
        else _sha256(source) == _sha256(destination)
    )
    if identical:
        return MigrationRecord(**{**asdict(pending), "outcome": "identical"})

    prior_backups = sorted(
        destination.parent.glob(f"legacy-{kind}-*-{fingerprint[:12]}*{destination.suffix}")
    )
    if prior_backups:
        return MigrationRecord(
            **{
                **asdict(pending),
                "outcome": "conflict_backup",
                "backup": str(prior_backups[0]),
            }
        )

    backup = _unique_backup(destination, kind, fingerprint)
    snapshot(source, backup)
    return MigrationRecord(
        **{
            **asdict(pending),
            "outcome": "conflict_backup",
            "backup": str(backup),
        }
    )


def migrate_legacy_state(paths: AppPaths | None = None) -> list[MigrationRecord]:
    """Copy historical state before normal config/database/log initialization."""

    current = paths or resolve_app_paths()
    legacy = resolve_legacy_paths()
    current.data_dir.mkdir(parents=True, exist_ok=True)
    lock_path = current.data_dir / ".state-migration.lock"

    with _migration_lock(lock_path):
        for root in {current.config_dir, current.data_dir, current.log_dir}:
            if root.exists():
                for temp in root.glob(".mediasort-migrate-*.tmp"):
                    temp.unlink(missing_ok=True)

        manifest = _load_manifest(current.migration_manifest)
        records = manifest["records"]
        additions: list[MigrationRecord] = []
        artifacts: list[tuple[str, Path, Path, bool]] = []

        if not current.config_overridden:
            artifacts.append(("config", legacy.config_file, current.config_file, False))
        if not (current.config_overridden or current.data_overridden or current.db_overridden):
            artifacts.append(("database", legacy.db_path, current.db_path, True))
        if not current.log_overridden and legacy.log_dir.exists():
            for source in sorted(path for path in legacy.log_dir.rglob("*") if path.is_file()):
                relative = source.relative_to(legacy.log_dir)
                artifacts.append(("log", source, current.log_dir / relative, False))

        try:
            for kind, source, destination, sqlite_file in artifacts:
                record = _migrate_artifact(
                    kind=kind,
                    source=source,
                    destination=destination,
                    sqlite_file=sqlite_file,
                    records=records,
                )
                if record is None:
                    continue
                records.append(asdict(record))
                additions.append(record)
                _atomic_json(current.migration_manifest, manifest)
        except (OSError, sqlite3.Error, StateMigrationError) as exc:
            raise StateMigrationError(
                f"Legacy state migration failed before startup; source data was retained: {exc}"
            ) from exc

        if not current.migration_manifest.exists():
            _atomic_json(current.migration_manifest, manifest)
        return additions
