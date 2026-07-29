"""Cross-platform contract and runtime tests for filesystem capability probes."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.filesystem_capabilities import (
    platform_capability_applicability,
    probe_filesystem_capabilities,
)


@pytest.mark.parametrize(
    ("platform", "permissions", "attributes", "xattrs", "fifo"),
    [
        ("win32", False, True, False, False),
        ("darwin", True, False, True, True),
        ("linux", True, False, True, True),
    ],
)
def test_platform_matrix_declares_applicable_capabilities(
    platform: str,
    permissions: bool,
    attributes: bool,
    xattrs: bool,
    fifo: bool,
) -> None:
    matrix = platform_capability_applicability(platform)
    assert matrix == {
        "posix_permissions": permissions,
        "windows_file_attributes": attributes,
        "extended_attributes": xattrs,
        "fifo_special_files": fifo,
    }


def test_runtime_probe_records_preservation_and_commit_capabilities(tmp_path: Path) -> None:
    report = probe_filesystem_capabilities(tmp_path)

    assert report.schema_version == 1
    assert report.timestamp.status == "supported"
    assert report.timestamp.observed_mtime_ns is not None
    assert report.timestamp.absolute_error_ns is not None
    assert report.atomic_rename.status == "supported"
    assert report.atomic_replace.status == "supported"
    assert report.flush_and_fsync.status == "supported"
    assert report.permissions.status in {"supported", "unsupported"}
    assert report.platform_attributes.status in {"supported", "unsupported", "unknown"}
    assert report.extended_attributes.status in {
        "supported",
        "unsupported",
        "permission_denied",
    }
    assert report.sparse_files.status in {"supported", "unsupported", "unknown"}
    assert report.symlinks.status in {"supported", "unsupported", "permission_denied"}
    assert report.special_files.status in {"supported", "unsupported", "permission_denied"}
    assert report.cross_volume.status == "unknown"


def test_cross_root_probe_never_claims_cross_volume_without_device_evidence(
    tmp_path: Path,
) -> None:
    first = tmp_path / "first"
    second = tmp_path / "second"
    first.mkdir()
    second.mkdir()

    report = probe_filesystem_capabilities(first, other_root=second)

    assert report.cross_volume.status == "supported"
    assert report.cross_volume.same_device is True
    assert report.cross_volume.rename_succeeded is True
