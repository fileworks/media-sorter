"""A missing source folder must never masquerade as an empty one."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.exceptions import SortingError, SourceUnavailableError
from app.services.filesystem_service import (
    validate_source_directory,
    validate_target_directory,
)


class TestValidateSourceDirectory:
    def test_accepts_a_real_directory(self, tmp_path: Path) -> None:
        assert validate_source_directory(str(tmp_path)) == tmp_path

    def test_missing_directory_names_the_unmounted_drive_case(self, tmp_path: Path) -> None:
        missing = tmp_path / "external-drive" / "photos"
        with pytest.raises(SourceUnavailableError) as excinfo:
            validate_source_directory(str(missing))

        message = str(excinfo.value)
        assert "not found" in message
        assert "mounted" in message  # the actual cause, nine times out of ten

    @pytest.mark.parametrize("unset", ["", "   ", None])
    def test_unset_directory_points_at_settings(self, unset: str | None) -> None:
        with pytest.raises(SourceUnavailableError, match="No source folder is set"):
            validate_source_directory(unset)

    def test_file_instead_of_directory_is_rejected(self, tmp_path: Path) -> None:
        target = tmp_path / "holiday.jpg"
        target.write_bytes(b"not a folder")
        with pytest.raises(SourceUnavailableError, match="file, not a folder"):
            validate_source_directory(str(target))


class TestValidateTargetDirectory:
    def test_creates_the_destination_when_absent(self, tmp_path: Path) -> None:
        dest = tmp_path / "sorted" / "library"
        assert validate_target_directory(str(dest)) == dest
        assert dest.is_dir()

    @pytest.mark.parametrize("unset", ["", "   ", None])
    def test_unset_destination_never_falls_back_to_the_cwd(self, unset: str | None) -> None:
        with pytest.raises(SortingError, match="No destination folder is set"):
            validate_target_directory(unset)

    def test_file_instead_of_directory_is_rejected(self, tmp_path: Path) -> None:
        target = tmp_path / "sorted"
        target.write_bytes(b"not a folder")
        with pytest.raises(SortingError, match="file, not a folder"):
            validate_target_directory(str(target))
