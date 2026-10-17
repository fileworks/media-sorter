"""Host capability probes, so a test skips only for a named, missing capability.

Windows without Developer Mode cannot create symlinks, never makes a directory
unreadable through ``chmod``, has no POSIX executable bits, and may refuse paths
over 260 characters. Those tests still prove a product contract, so they must
run wherever the capability exists: ``test_capability_guards`` fails if a POSIX
CI host would skip them.
"""

from __future__ import annotations

import os
import stat
import tempfile
from pathlib import Path

import pytest


def _symlinks() -> bool:
    with tempfile.TemporaryDirectory() as directory:
        try:
            (Path(directory) / "link").symlink_to("target")
        except (OSError, NotImplementedError):
            return False
    return True


def _posix_permissions() -> bool:
    """True when ``chmod 000`` actually makes a directory unreadable."""
    with tempfile.TemporaryDirectory() as directory:
        locked = Path(directory) / "locked"
        locked.mkdir()
        os.chmod(locked, 0o000)
        try:
            os.listdir(locked)
        except PermissionError:
            return True
        else:
            return False
        finally:
            os.chmod(locked, stat.S_IRWXU)


def _long_paths() -> bool:
    with tempfile.TemporaryDirectory() as directory:
        deep = Path(directory).joinpath(*(["d" * 40] * 8))
        try:
            deep.mkdir(parents=True)
            (deep / "f").write_bytes(b"x")
        except OSError:
            return False
    return True


SYMLINKS = _symlinks()
POSIX_PERMISSIONS = _posix_permissions()
POSIX_MODES = os.name == "posix"
LONG_PATHS = _long_paths()

requires_symlinks = pytest.mark.skipif(
    not SYMLINKS, reason="host cannot create symlinks (Windows: enable Developer Mode)"
)
requires_posix_permissions = pytest.mark.skipif(
    not POSIX_PERMISSIONS,
    reason="host does not enforce chmod-based unreadability (Windows ACLs, or running as root)",
)
requires_posix_modes = pytest.mark.skipif(
    not POSIX_MODES, reason="executable mode bits are a POSIX contract"
)
requires_long_paths = pytest.mark.skipif(
    not LONG_PATHS, reason="host refuses long paths (Windows: enable LongPathsEnabled)"
)
