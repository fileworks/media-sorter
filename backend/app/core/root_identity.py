"""Cross-platform, read-only root identity and canonical path probing."""

from __future__ import annotations

import ctypes
import ntpath
import os
import sys
from dataclasses import dataclass
from pathlib import Path

from app.core.library_profiles import IdentityConfidence, RootIdentity, RootProbe


@dataclass(frozen=True)
class _VolumeEvidence:
    volume_id: str | None
    filesystem_id: str | None


def canonical_path_key(path: str | Path, *, platform: str | None = None) -> str:
    """Return a comparison key using the target platform's case semantics.

    The path is made absolute without requiring it to exist.  Existing aliases
    are resolved by :func:`probe_root_identity` before this function is called.
    Supplying ``platform`` keeps Windows case/drive behavior contract-testable
    from non-Windows CI runners.
    """
    raw = os.path.abspath(os.fspath(path))
    target = platform or sys.platform
    if target.startswith("win"):
        return ntpath.normcase(ntpath.normpath(raw.replace("/", "\\")))
    return os.path.normpath(raw)


def probe_root_identity(path: str | Path) -> RootProbe:
    """Probe availability and the strongest safe identity evidence available."""
    configured = os.fspath(path)
    expanded = Path(configured).expanduser()
    fallback_path = canonical_path_key(expanded)

    try:
        canonical = expanded.resolve(strict=True)
    except FileNotFoundError:
        return RootProbe(
            configured_path=configured,
            availability="offline",
            identity=RootIdentity(
                confidence="unresolved",
                canonical_path=fallback_path,
                platform=sys.platform,
            ),
            error_code="root_missing",
        )
    except (PermissionError, OSError) as exc:
        return RootProbe(
            configured_path=configured,
            availability="inaccessible",
            identity=RootIdentity(
                confidence="path_only",
                canonical_path=fallback_path,
                platform=sys.platform,
            ),
            error_code=_error_code(exc, "root_resolve_failed"),
        )

    canonical_key = canonical_path_key(canonical)
    if not canonical.is_dir():
        return RootProbe(
            configured_path=configured,
            availability="not_directory",
            identity=RootIdentity(
                confidence="path_only",
                canonical_path=canonical_key,
                platform=sys.platform,
            ),
            error_code="root_not_directory",
        )

    try:
        stat_result = canonical.stat()
        volume = _volume_evidence(canonical, stat_result.st_dev)
    except (PermissionError, OSError) as exc:
        return RootProbe(
            configured_path=configured,
            availability="inaccessible",
            identity=RootIdentity(
                confidence="path_only",
                canonical_path=canonical_key,
                platform=sys.platform,
            ),
            error_code=_error_code(exc, "root_stat_failed"),
        )

    root_file_id = str(stat_result.st_ino) if stat_result.st_ino else None
    confidence: IdentityConfidence = "medium" if volume.volume_id and root_file_id else "path_only"
    return RootProbe(
        configured_path=configured,
        availability="online",
        identity=RootIdentity(
            confidence=confidence,
            canonical_path=canonical_key,
            volume_id=volume.volume_id,
            filesystem_id=volume.filesystem_id,
            root_file_id=root_file_id,
            platform=sys.platform,
        ),
    )


def same_root(left: RootIdentity, right: RootIdentity) -> bool:
    """Return true only when sufficient identity evidence proves equality."""
    if (
        left.volume_id
        and right.volume_id
        and left.root_file_id
        and right.root_file_id
        and left.volume_id == right.volume_id
        and left.root_file_id == right.root_file_id
    ):
        return True
    if left.confidence == "path_only" or right.confidence == "path_only":
        return left.canonical_path == right.canonical_path
    return False


def _volume_evidence(path: Path, device_id: int) -> _VolumeEvidence:
    if os.name == "nt":  # pragma: no cover - exercised by Windows CI
        windows = _windows_volume_evidence(path)
        if windows.volume_id is not None:
            return windows

    filesystem_id: str | None = None
    try:
        statvfs = os.statvfs(path)
        raw_fsid = getattr(statvfs, "f_fsid", None)
        if raw_fsid is not None:
            filesystem_id = f"fsid:{raw_fsid}"
    except OSError:
        pass
    return _VolumeEvidence(volume_id=f"device:{device_id}", filesystem_id=filesystem_id)


def _windows_volume_evidence(path: Path) -> _VolumeEvidence:
    """Read Windows volume serial and filesystem name without a subprocess."""
    kernel32 = ctypes.windll.kernel32  # type: ignore[attr-defined]
    volume_path = ctypes.create_unicode_buffer(261)
    if not kernel32.GetVolumePathNameW(str(path), volume_path, len(volume_path)):
        return _VolumeEvidence(None, None)

    serial = ctypes.c_ulong()
    maximum_component = ctypes.c_ulong()
    flags = ctypes.c_ulong()
    filesystem_name = ctypes.create_unicode_buffer(261)
    if not kernel32.GetVolumeInformationW(
        volume_path.value,
        None,
        0,
        ctypes.byref(serial),
        ctypes.byref(maximum_component),
        ctypes.byref(flags),
        filesystem_name,
        len(filesystem_name),
    ):
        return _VolumeEvidence(None, None)
    return _VolumeEvidence(
        volume_id=f"windows-volume:{serial.value:08X}",
        filesystem_id=filesystem_name.value or None,
    )


def _error_code(exc: OSError, fallback: str) -> str:
    if isinstance(exc, PermissionError):
        return "root_permission_denied"
    if exc.errno is not None:
        return f"os_error_{exc.errno}"
    return fallback
