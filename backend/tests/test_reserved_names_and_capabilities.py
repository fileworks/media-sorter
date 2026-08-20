"""C-11 / C-12 — a device name is handled, and a limited destination says so once.

`CON.jpg` is a real photograph on macOS and is not a file at all on Windows.
Left alone it reached the destination verbatim and became an unmapped per-file
IO error, so the picture was simply not sorted.

Separately, `probe_filesystem_capabilities` existed with no production caller,
so a run onto exFAT or an SMB share discovered each limitation one file at a
time — a per-file warning for every photograph, which is how a real signal
becomes noise.
"""

from __future__ import annotations

import tempfile
from pathlib import Path

import pytest

from app.api.routes.sorting import _capability_degradations
from app.core.filesystem_capabilities import (
    CapabilityObservation,
    CapabilityStatus,
    CrossVolumeCapability,
    FilesystemCapabilityReport,
    TimestampCapability,
)
from app.services.filesystem_service import find_available_filename
from app.utils.path_utils import is_reserved_device_name, safe_destination_name


class TestDeviceNames:
    @pytest.mark.parametrize(
        ("name", "expected"),
        [
            ("CON.jpg", "CON_.jpg"),
            ("con.jpg", "con_.jpg"),
            ("COM1.NEF", "COM1_.NEF"),
            ("LPT9", "LPT9_"),
            ("NUL.mov", "NUL_.mov"),
            # Not device names: only the exact set, and only as the whole stem.
            ("company.jpg", "company.jpg"),
            ("CONTACT.jpg", "CONTACT.jpg"),
            ("holiday.jpg", "holiday.jpg"),
            ("my CON.jpg", "my CON.jpg"),
        ],
    )
    def test_only_real_device_names_are_changed(self, name: str, expected: str) -> None:
        assert safe_destination_name(name) == expected

    def test_the_transform_is_idempotent(self) -> None:
        """A destination that differed between two runs would depend on run order."""
        once = safe_destination_name("CON.jpg")

        assert safe_destination_name(once) == once
        assert not is_reserved_device_name(once)

    def test_the_destination_builder_applies_it(self) -> None:
        """Every destination leaf in the program goes through this function, which
        is why the guard lives there rather than at each call site."""
        with tempfile.TemporaryDirectory() as directory:
            chosen = find_available_filename(Path(directory) / "CON.jpg")

        assert chosen.name == "CON_.jpg"

    def test_an_ordinary_name_is_untouched_by_the_guard(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            chosen = find_available_filename(Path(directory) / "holiday.jpg")

        assert chosen.name == "holiday.jpg"

    def test_the_collision_suffix_still_works_after_the_guard(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "CON_.jpg").write_bytes(b"first")

            chosen = find_available_filename(root / "CON.jpg")

        assert chosen.name == "CON__001.jpg"


def _report(**statuses: CapabilityStatus) -> FilesystemCapabilityReport:
    def observation(name: str) -> CapabilityObservation:
        return CapabilityObservation(status=statuses.get(name, "supported"))

    return FilesystemCapabilityReport(
        platform="darwin",
        probe_root="/tmp/probe",
        device_id="1",
        timestamp=TimestampCapability(
            status=statuses.get("timestamp", "supported"), requested_mtime_ns=0
        ),
        permissions=observation("permissions"),
        platform_attributes=observation("platform_attributes"),
        extended_attributes=observation("extended_attributes"),
        atomic_rename=observation("atomic_rename"),
        atomic_replace=observation("atomic_replace"),
        flush_and_fsync=observation("flush_and_fsync"),
        sparse_files=observation("sparse_files"),
        symlinks=observation("symlinks"),
        special_files=observation("special_files"),
        cross_volume=CrossVolumeCapability(status="supported"),
    )


class TestCapabilityReporting:
    def test_a_capable_destination_reports_nothing(self) -> None:
        assert _capability_degradations(_report()) == []

    def test_an_exfat_shaped_destination_names_what_it_loses(self) -> None:
        """exFAT keeps no permissions, no xattrs and no symlinks."""
        degraded = _capability_degradations(
            _report(
                permissions="unsupported", extended_attributes="unsupported", symlinks="unsupported"
            )
        )

        assert len(degraded) == 3
        assert any("permissions" in item for item in degraded)
        assert any("extended attributes" in item for item in degraded)

    def test_a_probe_that_could_not_find_out_is_not_a_lost_capability(self) -> None:
        """`permission_denied` and `unknown` mean the probe failed, not the
        filesystem. Reporting them would warn about a destination that is fine."""
        assert _capability_degradations(_report(permissions="permission_denied")) == []
        assert _capability_degradations(_report(extended_attributes="unknown")) == []

    def test_every_degradation_is_named_once(self) -> None:
        """The whole point: one report per run, not one line per file."""
        degraded = _capability_degradations(_report(permissions="unsupported"))

        assert degraded == ["file permissions are not preserved"]
