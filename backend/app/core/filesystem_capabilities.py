"""Runtime filesystem capability probes for preservation and commit planning.

Operating-system names are not sufficient evidence: the same machine may use a
local filesystem, removable FAT/exFAT media, or a network share with different
semantics. These probes use isolated temporary artifacts below a caller-selected
root and never touch media content.
"""

from __future__ import annotations

import os
import stat
import sys
import tempfile
from pathlib import Path
from typing import Any, Literal, cast

from pydantic import BaseModel, ConfigDict

FILESYSTEM_CAPABILITY_SCHEMA_VERSION: Literal[1] = 1
CapabilityStatus = Literal["supported", "unsupported", "permission_denied", "unknown"]


class CapabilityObservation(BaseModel):
    model_config = ConfigDict(frozen=True)

    status: CapabilityStatus
    detail: str | None = None


class TimestampCapability(BaseModel):
    model_config = ConfigDict(frozen=True)

    status: CapabilityStatus
    requested_mtime_ns: int
    observed_mtime_ns: int | None = None
    absolute_error_ns: int | None = None
    exact: bool = False


class CrossVolumeCapability(BaseModel):
    model_config = ConfigDict(frozen=True)

    status: CapabilityStatus
    same_device: bool | None = None
    rename_succeeded: bool | None = None
    detail: str | None = None


class FilesystemCapabilityReport(BaseModel):
    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = FILESYSTEM_CAPABILITY_SCHEMA_VERSION
    platform: str
    probe_root: str
    device_id: str | None
    timestamp: TimestampCapability
    permissions: CapabilityObservation
    platform_attributes: CapabilityObservation
    extended_attributes: CapabilityObservation
    atomic_rename: CapabilityObservation
    atomic_replace: CapabilityObservation
    flush_and_fsync: CapabilityObservation
    sparse_files: CapabilityObservation
    symlinks: CapabilityObservation
    special_files: CapabilityObservation
    cross_volume: CrossVolumeCapability


def probe_filesystem_capabilities(
    root: Path,
    *,
    other_root: Path | None = None,
) -> FilesystemCapabilityReport:
    """Measure preservation-relevant behavior beneath ``root``.

    ``other_root`` enables a cross-root rename probe. The report states whether
    the roots are actually on different devices; callers must not label a
    same-device result as cross-volume evidence.
    """
    root = root.resolve(strict=True)
    if not root.is_dir():
        raise ValueError(f"filesystem probe root is not a directory: {root}")

    device_id = _device_id(root)
    with tempfile.TemporaryDirectory(prefix="mediasort-fs-probe-", dir=root) as raw_probe:
        probe_dir = Path(raw_probe)
        timestamp = _probe_timestamp(probe_dir)
        permissions = _probe_permissions(probe_dir)
        platform_attributes = _probe_platform_attributes(probe_dir)
        extended_attributes = _probe_extended_attributes(probe_dir)
        atomic_rename = _probe_rename(probe_dir)
        atomic_replace = _probe_replace(probe_dir)
        flush_and_fsync = _probe_flush(probe_dir)
        sparse_files = _probe_sparse(probe_dir)
        symlinks = _probe_symlink(probe_dir)
        special_files = _probe_special_file(probe_dir)

    cross_volume = _probe_cross_volume(root, other_root)
    return FilesystemCapabilityReport(
        platform=sys.platform,
        probe_root=str(root),
        device_id=device_id,
        timestamp=timestamp,
        permissions=permissions,
        platform_attributes=platform_attributes,
        extended_attributes=extended_attributes,
        atomic_rename=atomic_rename,
        atomic_replace=atomic_replace,
        flush_and_fsync=flush_and_fsync,
        sparse_files=sparse_files,
        symlinks=symlinks,
        special_files=special_files,
        cross_volume=cross_volume,
    )


def platform_capability_applicability(platform: str) -> dict[str, bool]:
    """Return which platform-specific probes are meaningful in CI contracts."""
    return {
        "posix_permissions": not platform.startswith("win"),
        "windows_file_attributes": platform.startswith("win"),
        "extended_attributes": platform.startswith(("darwin", "linux")),
        "fifo_special_files": platform.startswith(("darwin", "linux")),
    }


def _probe_timestamp(probe_dir: Path) -> TimestampCapability:
    path = probe_dir / "timestamp.bin"
    path.write_bytes(b"timestamp")
    requested = 1_700_000_000_123_456_789
    try:
        os.utime(path, ns=(requested, requested))
        observed = path.stat().st_mtime_ns
    except PermissionError:
        return TimestampCapability(
            status="permission_denied",
            requested_mtime_ns=requested,
            absolute_error_ns=None,
        )
    except OSError:
        return TimestampCapability(status="unsupported", requested_mtime_ns=requested)
    error = abs(observed - requested)
    return TimestampCapability(
        status="supported",
        requested_mtime_ns=requested,
        observed_mtime_ns=observed,
        absolute_error_ns=error,
        exact=error == 0,
    )


def _probe_permissions(probe_dir: Path) -> CapabilityObservation:
    path = probe_dir / "permissions.bin"
    path.write_bytes(b"permissions")
    try:
        path.chmod(0o600)
        observed = stat.S_IMODE(path.stat().st_mode)
    except PermissionError as exc:
        return CapabilityObservation(status="permission_denied", detail=type(exc).__name__)
    except OSError as exc:
        return CapabilityObservation(status="unsupported", detail=type(exc).__name__)
    return CapabilityObservation(
        status="supported" if observed & 0o777 == 0o600 else "unsupported",
        detail=f"observed_mode={oct(observed)}",
    )


def _probe_platform_attributes(probe_dir: Path) -> CapabilityObservation:
    path = probe_dir / "attributes.bin"
    path.write_bytes(b"attributes")
    attributes = getattr(path.stat(), "st_file_attributes", None)
    if os.name == "nt":
        return CapabilityObservation(
            status="supported" if attributes is not None else "unknown",
            detail=f"st_file_attributes={attributes}" if attributes is not None else None,
        )
    return CapabilityObservation(status="unsupported", detail="not applicable on this platform")


def _probe_extended_attributes(probe_dir: Path) -> CapabilityObservation:
    setxattr = getattr(os, "setxattr", None)
    getxattr = getattr(os, "getxattr", None)
    removexattr = getattr(os, "removexattr", None)
    if not all(callable(operation) for operation in (setxattr, getxattr, removexattr)):
        return CapabilityObservation(status="unsupported", detail="xattr API unavailable")
    setxattr_fn = cast(Any, setxattr)
    getxattr_fn = cast(Any, getxattr)
    removexattr_fn = cast(Any, removexattr)
    path = probe_dir / "xattr.bin"
    path.write_bytes(b"xattr")
    key = "user.mediasort.probe"
    if sys.platform == "darwin":
        key = "com.mediasort.probe"
    try:
        setxattr_fn(path, key, b"1")
        observed = getxattr_fn(path, key)
        removexattr_fn(path, key)
    except PermissionError as exc:
        return CapabilityObservation(status="permission_denied", detail=type(exc).__name__)
    except OSError as exc:
        return _unsupported_os_error(exc)
    return CapabilityObservation(
        status="supported" if observed == b"1" else "unknown",
    )


def _probe_rename(probe_dir: Path) -> CapabilityObservation:
    source = probe_dir / "rename-source.bin"
    destination = probe_dir / "rename-destination.bin"
    source.write_bytes(b"rename")
    try:
        os.rename(source, destination)
    except PermissionError as exc:
        return CapabilityObservation(status="permission_denied", detail=type(exc).__name__)
    except OSError as exc:
        return _unsupported_os_error(exc)
    return CapabilityObservation(
        status="supported" if destination.read_bytes() == b"rename" else "unknown"
    )


def _probe_replace(probe_dir: Path) -> CapabilityObservation:
    source = probe_dir / "replace-source.bin"
    destination = probe_dir / "replace-destination.bin"
    source.write_bytes(b"new")
    destination.write_bytes(b"old")
    try:
        os.replace(source, destination)
    except PermissionError as exc:
        return CapabilityObservation(status="permission_denied", detail=type(exc).__name__)
    except OSError as exc:
        return _unsupported_os_error(exc)
    return CapabilityObservation(
        status="supported" if destination.read_bytes() == b"new" else "unknown"
    )


def _probe_flush(probe_dir: Path) -> CapabilityObservation:
    path = probe_dir / "flush.bin"
    try:
        with path.open("wb") as handle:
            handle.write(b"flush")
            handle.flush()
            os.fsync(handle.fileno())
    except PermissionError as exc:
        return CapabilityObservation(status="permission_denied", detail=type(exc).__name__)
    except OSError as exc:
        return _unsupported_os_error(exc)
    return CapabilityObservation(status="supported")


def _probe_sparse(probe_dir: Path) -> CapabilityObservation:
    path = probe_dir / "sparse.bin"
    logical_size = 4 * 1024 * 1024
    try:
        with path.open("wb") as handle:
            handle.seek(logical_size - 1)
            handle.write(b"\0")
        observed = path.stat()
    except OSError as exc:
        return _unsupported_os_error(exc)
    blocks = getattr(observed, "st_blocks", None)
    if blocks is None:
        return CapabilityObservation(status="unknown", detail="allocated block count unavailable")
    allocated = blocks * 512
    return CapabilityObservation(
        status="supported" if allocated < logical_size else "unsupported",
        detail=f"logical={logical_size},allocated={allocated}",
    )


def _probe_symlink(probe_dir: Path) -> CapabilityObservation:
    target = probe_dir / "symlink-target.bin"
    link = probe_dir / "symlink.bin"
    target.write_bytes(b"symlink")
    try:
        link.symlink_to(target)
        supported = link.is_symlink() and link.read_bytes() == b"symlink"
    except PermissionError as exc:
        return CapabilityObservation(status="permission_denied", detail=type(exc).__name__)
    except OSError as exc:
        return _unsupported_os_error(exc)
    return CapabilityObservation(status="supported" if supported else "unknown")


def _probe_special_file(probe_dir: Path) -> CapabilityObservation:
    if not hasattr(os, "mkfifo"):
        return CapabilityObservation(status="unsupported", detail="FIFO API unavailable")
    path = probe_dir / "probe.fifo"
    try:
        os.mkfifo(path)
        supported = stat.S_ISFIFO(path.stat().st_mode)
        path.unlink()
    except PermissionError as exc:
        return CapabilityObservation(status="permission_denied", detail=type(exc).__name__)
    except OSError as exc:
        return _unsupported_os_error(exc)
    return CapabilityObservation(status="supported" if supported else "unknown")


def _probe_cross_volume(root: Path, other_root: Path | None) -> CrossVolumeCapability:
    if other_root is None:
        return CrossVolumeCapability(status="unknown", detail="second probe root not supplied")
    other_root = other_root.resolve(strict=True)
    if not other_root.is_dir():
        return CrossVolumeCapability(status="unsupported", detail="second root is not a directory")
    same_device = root.stat().st_dev == other_root.stat().st_dev
    with (
        tempfile.TemporaryDirectory(prefix="mediasort-fs-source-", dir=root) as raw_source,
        tempfile.TemporaryDirectory(prefix="mediasort-fs-target-", dir=other_root) as raw_target,
    ):
        source = Path(raw_source) / "source.bin"
        destination = Path(raw_target) / "destination.bin"
        source.write_bytes(b"cross-volume")
        try:
            os.rename(source, destination)
        except OSError as exc:
            return CrossVolumeCapability(
                status="supported",
                same_device=same_device,
                rename_succeeded=False,
                detail=f"{type(exc).__name__}:{exc.errno}",
            )
        return CrossVolumeCapability(
            status="supported",
            same_device=same_device,
            rename_succeeded=True,
        )


def _device_id(root: Path) -> str | None:
    try:
        return str(root.stat().st_dev)
    except OSError:
        return None


def _unsupported_os_error(exc: OSError) -> CapabilityObservation:
    return CapabilityObservation(
        status="unsupported",
        detail=f"{type(exc).__name__}:{exc.errno}",
    )
