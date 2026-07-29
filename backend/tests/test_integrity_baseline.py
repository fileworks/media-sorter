"""Executable ledger for the media mutation engine.

Transfer assertions describe guarantees the verified engine now proves. The
remaining assertions still pin unsafe pre-manifest behavior, and later
preservation tasks should replace them one at a time as each one is removed.
"""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
from typing import BinaryIO

import pytest

from app.core.exceptions import SortingError
from app.services import verified_transfer
from app.services.filesystem_service import FileSystemService
from app.services.metadata_service import MetadataService


class _SameSizeCorruptingWriter:
    def __init__(self, raw: BinaryIO) -> None:
        self._raw = raw
        self._changed = False

    def __enter__(self) -> _SameSizeCorruptingWriter:
        self._raw.__enter__()
        return self

    def __exit__(self, *args: object) -> object:
        return self._raw.__exit__(*args)

    def flush(self) -> None:
        self._raw.flush()

    def fileno(self) -> int:
        return self._raw.fileno()

    def write(self, data: bytes) -> int:
        if data and not self._changed:
            data = bytes([data[0] ^ 0xFF]) + data[1:]
            self._changed = True
        return self._raw.write(data)


def test_equal_length_corruption_is_rejected_before_publication(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "destination.bin"
    source.write_bytes(b"integrity requires content evidence")
    real_open = Path.open

    def corrupting_open(path: Path, mode: str = "r", *args: object, **kwargs: object):  # type: ignore[no-untyped-def]
        opened = real_open(path, mode, *args, **kwargs)
        if mode == "xb":
            return _SameSizeCorruptingWriter(opened)
        return opened

    monkeypatch.setattr(Path, "open", corrupting_open)

    with pytest.raises(SortingError) as error:
        FileSystemService().safe_copy(source, destination, verify=True)

    assert error.value.details["reason"] == "stage_hash_mismatch"
    assert destination.exists() is False
    assert not list(tmp_path.glob(".*ms-stage-*"))


def test_interrupted_copy_never_publishes_a_partial_final_path(tmp_path: Path) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "destination.bin"
    source.write_bytes(b"x" * (2 * 1024 * 1024))

    def interrupt(_copied: int, _total: int) -> None:
        raise RuntimeError("simulated process interruption")

    with pytest.raises(RuntimeError, match="simulated process interruption"):
        FileSystemService().safe_copy(source, destination, on_progress=interrupt)

    assert source.exists()
    assert destination.exists() is False
    assert not list(tmp_path.glob(".*ms-stage-*"))


def test_copy_preserves_source_filesystem_timestamps(tmp_path: Path) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "destination.bin"
    source.write_bytes(b"timestamp guarantee")
    historical = 978_307_200  # 2001-01-01T00:00:00Z
    os.utime(source, (historical, historical))

    result = FileSystemService().safe_copy(source, destination)

    assert destination.stat().st_mtime_ns == source.stat().st_mtime_ns
    assert result.observed_metadata.mtime_ns == result.requested_metadata.mtime_ns
    assert result.warnings == ()


def test_same_volume_move_needs_no_second_copy(tmp_path: Path) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "moved" / "source.bin"
    source.write_bytes(b"no byte copy needed")

    result = FileSystemService().safe_move(source, destination)

    assert result.protocol == "same_volume_link"
    assert result.integrity_source == "same_inode"
    assert result.source_removed is True
    assert source.exists() is False
    assert destination.read_bytes() == b"no byte copy needed"


def test_cross_volume_move_removal_failure_reports_recoverable_duplicate_state(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "destination.bin"
    source.write_bytes(b"recoverable duplicate state")
    real_unlink = Path.unlink

    def fail_source_unlink(path: Path, *args: object, **kwargs: object) -> None:
        if path == source:
            raise OSError("simulated source removal failure")
        real_unlink(path, *args, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(verified_transfer, "_same_volume", lambda *_: False)
    monkeypatch.setattr(Path, "unlink", fail_source_unlink)

    with pytest.raises(SortingError) as error:
        FileSystemService().safe_move(source, destination)

    assert error.value.details["reason"] == "source_removal_failed"
    assert error.value.details["source_safety"] == "redundant_verified_copies"
    assert source.exists()
    assert destination.exists()
    assert source.read_bytes() == destination.read_bytes()


def test_embedded_date_update_changes_media_hash(tmp_path: Path) -> None:
    image = pytest.importorskip("PIL.Image")
    piexif = pytest.importorskip("piexif")
    path = tmp_path / "photo.jpg"
    image.new("RGB", (16, 16), color=(90, 120, 150)).save(path, format="JPEG")
    before = hashlib.sha256(path.read_bytes()).hexdigest()

    from datetime import datetime

    assert MetadataService().set_creation_date(path, datetime(2024, 1, 2, 3, 4, 5))

    after = hashlib.sha256(path.read_bytes()).hexdigest()
    assert after != before
    assert piexif.load(str(path))["Exif"][piexif.ExifIFD.DateTimeOriginal]
