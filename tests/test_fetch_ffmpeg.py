from __future__ import annotations

import importlib.util
import io
import json
import stat
import tarfile
import zipfile
from pathlib import Path
from types import ModuleType

import pytest


def _module() -> ModuleType:
    path = Path(__file__).parents[1] / "scripts" / "fetch_ffmpeg.py"
    spec = importlib.util.spec_from_file_location("fetch_ffmpeg", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


FETCH = _module()


@pytest.mark.parametrize(
    "member",
    [
        "../outside",
        "nested/../../outside",
        "/absolute",
        r"C:\outside",
        r"..\outside",
        "//server/share/outside",
    ],
)
@pytest.mark.parametrize("kind", ["tar", "zip"])
def test_extraction_rejects_escaping_paths_before_writing(
    tmp_path: Path, member: str, kind: str
) -> None:
    archive = tmp_path / f"payload.{kind}"
    if kind == "tar":
        with tarfile.open(archive, "w") as output:
            info = tarfile.TarInfo(member)
            info.size = 4
            output.addfile(info, io.BytesIO(b"evil"))
    else:
        with zipfile.ZipFile(archive, "w") as output:
            output.writestr(member, b"evil")

    destination = tmp_path / "staging"
    with pytest.raises(ValueError, match="unsafe|escapes"):
        FETCH.extract(archive, destination)

    assert not destination.exists()
    assert not (tmp_path / "outside").exists()


@pytest.mark.parametrize("link_type", [tarfile.SYMTYPE, tarfile.LNKTYPE])
def test_tar_extraction_rejects_links(tmp_path: Path, link_type: bytes) -> None:
    archive = tmp_path / "links.tar"
    with tarfile.open(archive, "w") as output:
        info = tarfile.TarInfo("bin/ffmpeg")
        info.type = link_type
        info.linkname = "../../outside"
        output.addfile(info)

    with pytest.raises(ValueError, match="links are forbidden"):
        FETCH.extract(archive, tmp_path / "staging")


def test_tar_extraction_rejects_special_files(tmp_path: Path) -> None:
    archive = tmp_path / "special.tar"
    with tarfile.open(archive, "w") as output:
        info = tarfile.TarInfo("pipe")
        info.type = tarfile.FIFOTYPE
        output.addfile(info)

    with pytest.raises(ValueError, match="unsupported tar member"):
        FETCH.extract(archive, tmp_path / "staging")


def test_zip_extraction_rejects_symlinks(tmp_path: Path) -> None:
    archive = tmp_path / "links.zip"
    info = zipfile.ZipInfo("bin/ffmpeg")
    info.create_system = 3
    info.external_attr = (stat.S_IFLNK | 0o777) << 16
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr(info, "../../outside")

    with pytest.raises(ValueError, match="unsupported zip member"):
        FETCH.extract(archive, tmp_path / "staging")


def test_safe_regular_archives_extract(tmp_path: Path) -> None:
    archive = tmp_path / "safe.zip"
    with zipfile.ZipFile(archive, "w") as output:
        output.writestr("bundle/bin/ffmpeg", b"binary")

    destination = tmp_path / "staging"
    FETCH.extract(archive, destination)

    assert (destination / "bundle" / "bin" / "ffmpeg").read_bytes() == b"binary"


def test_source_manifest_rejects_latest_and_missing_digest(tmp_path: Path) -> None:
    manifest = tmp_path / "sources.json"
    manifest.write_text(
        json.dumps(
            {
                "manifest_version": "test",
                "targets": {
                    "linux-x86_64": [
                        {
                            "url": "https://example.test/latest/archive.tar.xz",
                            "sha256": "not-a-digest",
                            "binaries": ["ffmpeg", "ffprobe"],
                        }
                    ]
                },
            }
        ),
        encoding="utf-8",
    )

    with pytest.raises(SystemExit, match="latest|SHA-256"):
        FETCH.load_sources("linux", "x86_64", manifest_path=manifest)


def test_reviewed_manifest_has_complete_immutable_targets() -> None:
    for os_key, arch_key in (
        ("darwin", "arm64"),
        ("darwin", "x86_64"),
        ("windows", "x86_64"),
        ("linux", "arm64"),
        ("linux", "x86_64"),
    ):
        version, sources = FETCH.load_sources(os_key, arch_key)
        assert version
        assert all(len(source["sha256"]) == 64 for source in sources)
        assert all("/latest/" not in source["url"] for source in sources)
