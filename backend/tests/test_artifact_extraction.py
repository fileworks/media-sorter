"""Publication must retain payload bytes and reject ambiguous archive layouts."""

from __future__ import annotations

import importlib.util
import stat
import zipfile
from pathlib import Path

import pytest

SCRIPT = Path(__file__).parents[2] / ".github/scripts/extract_artifacts.py"
SPEC = importlib.util.spec_from_file_location("extract_artifacts", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
extract_artifacts = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(extract_artifacts)


def make_archive(source: Path, artifact: str, name: str, payload: bytes) -> None:
    folder = source / artifact
    folder.mkdir(parents=True)
    with zipfile.ZipFile(folder / "artifact.zip", "w") as archive:
        member = zipfile.ZipInfo("placeholder")
        # ZipInfo's constructor normalizes Windows separators; preserve the
        # deliberately malformed entry so the same refusal is tested on NTFS.
        member.filename = name
        archive.writestr(member, payload)


def test_distinct_artifacts_keep_same_named_files_and_nested_zip_bytes(tmp_path: Path) -> None:
    source, output = tmp_path / "source", tmp_path / "output"
    make_archive(source, "windows", "portable.zip", b"nested zip remains opaque")
    make_archive(source, "mac", "SHA256SUMS", b"mac checksum")
    with zipfile.ZipFile(source / "windows/artifact.zip", "a") as archive:
        archive.writestr("SHA256SUMS", b"windows checksum")
    extract_artifacts.extract(source, output)
    assert (output / "windows/portable.zip").read_bytes() == b"nested zip remains opaque"
    assert (output / "windows/SHA256SUMS").read_bytes() == b"windows checksum"
    assert (output / "mac/SHA256SUMS").read_bytes() == b"mac checksum"
    with pytest.raises(ValueError, match="overwrite"):
        extract_artifacts.extract(source, output)


@pytest.mark.parametrize(
    "name", ["../outside", "/absolute", "a/../../outside", "C:/drive", "a\\b", "a/./b", "a//b"]
)
def test_escaping_or_nonportable_members_are_refused(tmp_path: Path, name: str) -> None:
    source, output = tmp_path / "source", tmp_path / "output"
    make_archive(source, "sample", name, b"unsafe")
    with pytest.raises(ValueError, match="Unsafe"):
        extract_artifacts.extract(source, output)
    assert not output.exists()


def test_symlink_members_are_refused(tmp_path: Path) -> None:
    source, output = tmp_path / "source", tmp_path / "output"
    make_archive(source, "sample", "safe", b"safe")
    with zipfile.ZipFile(source / "sample/artifact.zip", "a") as archive:
        member = zipfile.ZipInfo("link")
        member.create_system = 3
        member.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(member, "../outside")
    with pytest.raises(ValueError, match="Unsafe"):
        extract_artifacts.extract(source, output)
    assert not output.exists()


def test_empty_or_ambiguous_artifact_input_is_refused(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    with pytest.raises(ValueError, match="separate"):
        extract_artifacts.extract(source, tmp_path / "output")
    make_archive(source, "sample", "safe", b"safe")
    (source / "sample/extra.zip").write_bytes(b"unexpected")
    with pytest.raises(ValueError, match="one raw ZIP"):
        extract_artifacts.extract(source, tmp_path / "output")


def test_duplicate_members_cannot_replace_verified_payloads(tmp_path: Path) -> None:
    source, output = tmp_path / "source", tmp_path / "output"
    make_archive(source, "sample", "payload", b"first")
    with zipfile.ZipFile(source / "sample/artifact.zip", "a") as archive:
        with pytest.warns(UserWarning, match="Duplicate name"):
            archive.writestr("payload", b"replacement")
    with pytest.raises(ValueError, match="duplicate"):
        extract_artifacts.extract(source, output)
    assert not output.exists()
