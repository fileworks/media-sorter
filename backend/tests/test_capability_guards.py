"""POSIX CI must never skip a capability-gated proof (WIN-NEW-8)."""

from __future__ import annotations

import os
import sys

import pytest

from tests.capabilities import LONG_PATHS, POSIX_MODES, POSIX_PERMISSIONS, SYMLINKS


@pytest.mark.skipif(os.name != "posix", reason="the guard describes POSIX CI hosts")
def test_posix_hosts_provide_every_tested_capability() -> None:
    assert SYMLINKS
    assert POSIX_MODES
    assert LONG_PATHS
    if sys.platform != "win32" and os.geteuid() != 0:  # root ignores chmod
        assert POSIX_PERMISSIONS
