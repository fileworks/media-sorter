"""Exercise real file sharing at the destructive boundary, not mocked metadata."""

import hashlib
import os
from pathlib import Path
from typing import Any, BinaryIO

import pytest

from app.core.exceptions import IntegrityTransferError
from app.services import verified_transfer as transfer


def _open_windows_writer(path: Path) -> BinaryIO:
    # A competing application can request DELETE sharing. Python's ordinary
    # open does not, so it cannot distinguish our deny-write sharing from a
    # handle that requests DELETE access but still permits concurrent writers.
    import ctypes
    import msvcrt
    from ctypes import wintypes

    namespace: Any = ctypes
    runtime: Any = msvcrt
    kernel = namespace.WinDLL("kernel32", use_last_error=True)
    create = kernel.CreateFileW
    create.argtypes = (
        wintypes.LPCWSTR,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.LPVOID,
        wintypes.DWORD,
        wintypes.DWORD,
        wintypes.HANDLE,
    )
    create.restype = wintypes.HANDLE
    handle = create(str(path), 0x40000000, 7, None, 3, 0, None)
    if handle == ctypes.c_void_p(-1).value:
        raise namespace.WinError(namespace.get_last_error())
    return os.fdopen(runtime.open_osfhandle(handle, os.O_WRONLY), "wb")


def _rewrite_preserving_mtime(path: Path, stamp: os.stat_result) -> None:
    if os.name != "nt":
        path.write_bytes(b"EVIL")
        os.utime(path, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        return
    import ctypes
    import msvcrt
    from ctypes import wintypes

    namespace: Any = ctypes
    runtime: Any = msvcrt
    kernel = namespace.WinDLL("kernel32", use_last_error=True)
    with _open_windows_writer(path) as writer:
        writer.write(b"EVIL")
        writer.flush()
        ticks = stamp.st_mtime_ns // 100 + 116444736000000000
        modified = wintypes.FILETIME(ticks & 0xFFFFFFFF, ticks >> 32)
        set_time = kernel.SetFileTime
        pointer = ctypes.POINTER(wintypes.FILETIME)
        set_time.argtypes = (wintypes.HANDLE, pointer, pointer, pointer)
        set_time.restype = wintypes.BOOL
        assert set_time(runtime.get_osfhandle(writer.fileno()), None, None, ctypes.byref(modified))


@pytest.mark.parametrize("operation", ["rewrite", "replace"])
def test_changed_source_is_never_removed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, operation: str
) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.write_bytes(b"GOOD")
    destination.write_bytes(b"GOOD")
    stamp = source.stat()
    real_hash = transfer._hash_open_source
    changed = False

    def race(handle: BinaryIO) -> tuple[str, int]:
        nonlocal changed
        proof = real_hash(handle)
        try:
            if operation == "replace":
                replacement = tmp_path / "replacement"
                replacement.write_bytes(b"EVIL")
                replacement.replace(source)
            else:
                _rewrite_preserving_mtime(source, stamp)
            changed = True
        except PermissionError:
            # Windows must hold a handle that excludes writes and replacement.
            assert os.name == "nt"
        return proof

    monkeypatch.setattr(transfer, "_hash_open_source", race)
    try:
        transfer.unlink_revalidated_pair(
            source,
            destination,
            expected_sha256=hashlib.sha256(b"GOOD").hexdigest(),
            expected_size_bytes=4,
        )
    except IntegrityTransferError:
        assert changed
    assert destination.read_bytes() == b"GOOD"
    if changed:
        assert source.exists(), "deleted changed bytes after the final hash"
        assert source.read_bytes() == b"EVIL"
    else:
        assert not source.exists(), "healthy locked source was not removed"


@pytest.mark.skipif(os.name != "nt", reason="Windows kernel sharing contract")
def test_existing_writer_prevents_source_removal(tmp_path: Path) -> None:
    source = tmp_path / "source"
    destination = tmp_path / "destination"
    source.write_bytes(b"GOOD")
    destination.write_bytes(b"GOOD")
    with _open_windows_writer(source):
        with pytest.raises((OSError, IntegrityTransferError)):
            transfer.unlink_revalidated_pair(
                source,
                destination,
                expected_sha256=hashlib.sha256(b"GOOD").hexdigest(),
                expected_size_bytes=4,
            )
    assert source.read_bytes() == destination.read_bytes() == b"GOOD"


@pytest.mark.parametrize("interruption", [KeyboardInterrupt, SystemExit])
def test_interrupted_final_proof_releases_handle_without_deleting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, interruption: type[BaseException]
) -> None:
    source, destination = tmp_path / "source", tmp_path / "destination"
    source.write_bytes(b"GOOD")
    destination.write_bytes(b"GOOD")

    def interrupted(_handle: BinaryIO) -> tuple[str, int]:
        raise interruption

    monkeypatch.setattr(transfer, "_hash_open_source", interrupted)
    with pytest.raises(interruption):
        transfer.unlink_revalidated_pair(
            source,
            destination,
            expected_sha256=hashlib.sha256(b"GOOD").hexdigest(),
            expected_size_bytes=4,
        )
    assert source.read_bytes() == destination.read_bytes() == b"GOOD"
    source.write_bytes(b"after interruption")  # no leaked Windows ownership handle
