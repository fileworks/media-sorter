"""Tests for MetadataService — EXIF read/write."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest

from app.services.metadata_service import MetadataService


@pytest.fixture()
def svc() -> MetadataService:
    return MetadataService()


@pytest.fixture()
def jpeg_no_exif(tmp_path: Path) -> Path:
    PIL_Image = pytest.importorskip("PIL.Image")
    p = tmp_path / "plain.jpg"
    PIL_Image.new("RGB", (100, 100), color=(200, 100, 50)).save(p, format="JPEG")
    return p


@pytest.fixture()
def jpeg_with_exif(tmp_path: Path) -> Path:
    """JPEG with DateTimeOriginal = 2024-06-15."""
    piexif = pytest.importorskip("piexif")
    PIL_Image = pytest.importorskip("PIL.Image")
    p = tmp_path / "dated.jpg"
    PIL_Image.new("RGB", (100, 100), color=(50, 100, 200)).save(p, format="JPEG")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:06:15 10:00:00"}}
    piexif.insert(piexif.dump(exif_dict), str(p))
    return p


# ------------------------------------------------------------------ #
# set_creation_date + write_exif                                        #
# ------------------------------------------------------------------ #


def test_set_creation_date_writes_exif(svc: MetadataService, jpeg_no_exif: Path) -> None:
    piexif = pytest.importorskip("piexif")
    target_dt = datetime(2023, 8, 20, 14, 30, 0)
    svc.set_creation_date(jpeg_no_exif, target_dt)

    data = piexif.load(str(jpeg_no_exif))
    raw = data["Exif"].get(piexif.ExifIFD.DateTimeOriginal)
    assert raw == b"2023:08:20 14:30:00"


def test_set_creation_date_overwrites_existing(svc: MetadataService, jpeg_with_exif: Path) -> None:
    piexif = pytest.importorskip("piexif")
    new_dt = datetime(2020, 1, 1, 0, 0, 0)
    svc.set_creation_date(jpeg_with_exif, new_dt)

    data = piexif.load(str(jpeg_with_exif))
    raw = data["Exif"].get(piexif.ExifIFD.DateTimeOriginal)
    assert raw == b"2020:01:01 00:00:00"


def test_set_creation_date_no_op_for_non_exif_format(svc: MetadataService, tmp_path: Path) -> None:
    """Non-JPEG/TIFF files should be silently ignored."""
    p = tmp_path / "shot.png"
    p.write_bytes(b"\x89PNG\r\n\x1a\n")
    svc.set_creation_date(p, datetime(2024, 1, 1))  # must not raise


def test_write_exif_returns_true_on_success(jpeg_no_exif: Path) -> None:
    piexif = pytest.importorskip("piexif")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:03:10 09:00:00"}}
    result = MetadataService.write_exif(jpeg_no_exif, exif_dict)
    assert result is True


def test_write_exif_returns_false_on_bad_path(tmp_path: Path) -> None:
    piexif = pytest.importorskip("piexif")
    exif_dict = {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:01:01 00:00:00"}}
    result = MetadataService.write_exif(tmp_path / "ghost.jpg", exif_dict)
    assert result is False


# ------------------------------------------------------------------ #
# write_keywords — embed tags into media files                          #
# ------------------------------------------------------------------ #


def _read_xpkeywords(path: Path) -> str:
    piexif = pytest.importorskip("piexif")
    data = piexif.load(str(path))
    raw = data["0th"][piexif.ImageIFD.XPKeywords]
    return bytes(raw).decode("utf-16le").rstrip("\x00")


def test_write_keywords_empty_is_noop(svc: MetadataService, jpeg_no_exif: Path) -> None:
    assert svc.write_keywords(jpeg_no_exif, []) == ""
    assert svc.write_keywords(jpeg_no_exif, ["   "]) == ""  # whitespace-only stripped


def test_write_keywords_jpeg_embeds_xpkeywords(svc: MetadataService, jpeg_no_exif: Path) -> None:
    result = svc.write_keywords(jpeg_no_exif, ["beach", "sunset"])
    assert result == "embedded"
    assert _read_xpkeywords(jpeg_no_exif) == "beach;sunset"


def test_write_keywords_jpeg_preserves_existing_exif(
    svc: MetadataService, jpeg_with_exif: Path
) -> None:
    piexif = pytest.importorskip("piexif")
    assert svc.write_keywords(jpeg_with_exif, ["dog"]) == "embedded"
    data = piexif.load(str(jpeg_with_exif))
    # The pre-existing DateTimeOriginal must survive the keyword write.
    assert data["Exif"][piexif.ExifIFD.DateTimeOriginal] == b"2024:06:15 10:00:00"
    assert _read_xpkeywords(jpeg_with_exif) == "dog"


def test_write_keywords_png_writes_xmp_sidecar(svc: MetadataService, tmp_path: Path) -> None:
    PIL_Image = pytest.importorskip("PIL.Image")
    p = tmp_path / "shot.png"
    PIL_Image.new("RGB", (40, 40), color=(10, 20, 30)).save(p, format="PNG")

    result = svc.write_keywords(p, ["cat", "garden & yard"])
    assert result == "sidecar"
    # Double-extension sidecar: shot.png → shot.png.xmp (never collides with a
    # same-stem sibling like shot.heic).
    sidecar = p.with_name(p.name + ".xmp")
    assert sidecar.exists()
    text = sidecar.read_text(encoding="utf-8")
    assert "<dc:subject>" in text
    assert "<rdf:li>cat</rdf:li>" in text
    assert "garden &amp; yard" in text  # XML-escaped


def test_write_keywords_sidecars_do_not_collide_across_extensions(
    svc: MetadataService, tmp_path: Path
) -> None:
    """IMG_1.png and IMG_1.heic must get separate sidecars."""
    PIL_Image = pytest.importorskip("PIL.Image")
    png = tmp_path / "IMG_1.png"
    PIL_Image.new("RGB", (20, 20)).save(png, format="PNG")
    heic = tmp_path / "IMG_1.heic"
    heic.write_bytes(b"fake-heic")

    assert svc.write_keywords(png, ["png-tag"]) == "sidecar"
    assert svc.write_keywords(heic, ["heic-tag"]) == "sidecar"

    assert "png-tag" in (tmp_path / "IMG_1.png.xmp").read_text(encoding="utf-8")
    assert "heic-tag" in (tmp_path / "IMG_1.heic.xmp").read_text(encoding="utf-8")


def test_write_keywords_video_invokes_ffmpeg(
    svc: MetadataService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services import metadata_service as mod

    src = tmp_path / "clip.mp4"
    src.write_bytes(b"original-bytes")
    captured: dict[str, list[str]] = {}

    class _Result:
        returncode = 0
        stderr = b""

    def fake_run(cmd: list[str], **kwargs: object) -> _Result:
        captured["cmd"] = cmd
        # Simulate ffmpeg writing the remuxed temp output.
        Path(cmd[-1]).write_bytes(b"remuxed-with-tags")
        return _Result()

    monkeypatch.setattr(mod.subprocess, "run", fake_run)
    result = svc.write_keywords(src, ["beach", "vacation"])
    assert result == "embedded"
    assert "-metadata" in captured["cmd"]
    assert "keywords=beach,vacation" in captured["cmd"]
    assert "use_metadata_tags" in captured["cmd"]  # mp4 needs this flag
    assert src.read_bytes() == b"remuxed-with-tags"  # temp replaced the original


def test_write_keywords_video_ffmpeg_failure_returns_empty(
    svc: MetadataService, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services import metadata_service as mod

    src = tmp_path / "clip.mkv"
    src.write_bytes(b"original")

    def fake_run(cmd: list[str], **kwargs: object) -> object:
        raise FileNotFoundError("ffmpeg not installed")

    monkeypatch.setattr(mod.subprocess, "run", fake_run)
    assert svc.write_keywords(src, ["x"]) == ""
    assert src.read_bytes() == b"original"  # original untouched on failure
