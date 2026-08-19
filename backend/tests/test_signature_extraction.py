"""P2-DEDUP-D2 — the pure signature extractor.

Every fact the extractor returns is either *known* or explicitly *unknown* with
a reason. A dimension that could not be read is never ``0`` (I-10): a fabricated
zero would let "keep highest resolution" quietly discard the only good copy.

The extractor is pure — a path in, facts out. It never touches the catalog, a
database or a task, which is asserted structurally rather than by convention.
"""

from __future__ import annotations

import ast
import subprocess
from datetime import datetime
from pathlib import Path
from typing import cast

import piexif
import pillow_heif
import pytest
from PIL import Image

from app.core.duplicate_plans import FactValue
from app.services import signature_extraction
from app.services.signature_extraction import (
    MediaSignature,
    capture_time,
    extract_signature,
)

_FFMPEG_TIMEOUT = 120


def _jpeg(path: Path, *, date_str: str = "2022:08:15 12:00:00", camera: bool = True) -> Path:
    zeroth: dict[int, bytes] = {}
    if camera:
        zeroth = {piexif.ImageIFD.Make: b"Canon", piexif.ImageIFD.Model: b"Canon EOS 5D"}
    exif = piexif.dump(
        {"0th": zeroth, "Exif": {piexif.ExifIFD.DateTimeOriginal: date_str.encode()}}
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (320, 240), color=(30, 90, 160)).save(path, exif=exif)
    return path


def _heic(path: Path, *, date_str: str = "2019:01:02 03:04:05") -> Path:
    pillow_heif.register_heif_opener()
    exif = piexif.dump(
        {
            "0th": {piexif.ImageIFD.Make: b"Apple", piexif.ImageIFD.Model: b"iPhone 15 Pro"},
            "Exif": {piexif.ExifIFD.DateTimeOriginal: date_str.encode()},
        }
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (200, 100), color=(10, 200, 60)).save(path, exif=exif)
    return path


def _fake_dng(path: Path) -> Path:
    """A TIFF container with a ``.dng`` suffix.

    rawpy cannot demosaic it, which is the degraded RAW case worth pinning: the
    pixels are unreachable so there is no perceptual hash, but the header still
    yields real dimensions. Same fixture shape `test_heic_raw_handling` uses.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (320, 240), color=(120, 60, 20)).save(path, format="TIFF")
    return path


def _video(path: Path, *, created: str = "2021-05-04T10:11:12.000000Z") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=640x360:rate=10:duration=1",
            "-pix_fmt",
            "yuv420p",
            "-metadata",
            f"creation_time={created}",
            str(path),
        ],
        check=True,
        timeout=_FFMPEG_TIMEOUT,
    )
    return path


def _unknown_facts(signature: MediaSignature) -> list[tuple[str, FactValue]]:
    return [(name, fact) for name, fact in signature if not fact.known]


class TestJpeg:
    def test_every_fact_is_known(self, tmp_path: Path) -> None:
        signature = extract_signature(_jpeg(tmp_path / "shot.jpg"))

        assert signature.width.value == 320
        assert signature.height.value == 240
        assert signature.camera_model.value == "Canon-EOS-5D"
        assert signature.captured_at.value == "2022-08-15T12:00:00"
        assert isinstance(signature.phash.value, str) and signature.phash.value
        assert all(fact.known for _name, fact in signature)

    def test_mean_rgb_is_three_channels_of_the_actual_colour(self, tmp_path: Path) -> None:
        signature = extract_signature(_jpeg(tmp_path / "shot.jpg"))

        assert isinstance(signature.mean_rgb.value, list)
        red, green, blue = cast("list[float]", signature.mean_rgb.value)
        # The fixture is a flat (30, 90, 160); JPEG is lossy, so allow drift.
        assert abs(red - 30) < 12
        assert abs(green - 90) < 12
        assert abs(blue - 160) < 12

    def test_two_visually_identical_files_share_a_phash(self, tmp_path: Path) -> None:
        first = extract_signature(_jpeg(tmp_path / "a.jpg"))
        second = extract_signature(_jpeg(tmp_path / "b.jpg"))

        assert first.phash.value == second.phash.value

    def test_a_missing_camera_is_unknown_while_the_rest_stays_known(self, tmp_path: Path) -> None:
        signature = extract_signature(_jpeg(tmp_path / "nocam.jpg", camera=False))

        assert signature.camera_model.known is False
        assert signature.camera_model.value is None
        assert signature.camera_model.issue
        assert signature.width.value == 320


class TestHeic:
    def test_every_fact_is_known(self, tmp_path: Path) -> None:
        signature = extract_signature(_heic(tmp_path / "IMG_0001.heic"))

        assert signature.width.value == 200
        assert signature.height.value == 100
        # `extract_camera_model` joins make and model unless the model already
        # starts with the make — "Apple" + "iPhone 15 Pro" keeps both.
        assert signature.camera_model.value == "Apple-iPhone-15-Pro"
        assert signature.captured_at.value == "2019-01-02T03:04:05"
        assert isinstance(signature.phash.value, str) and signature.phash.value


class TestRaw:
    def test_unreachable_pixels_leave_the_dimensions_known(self, tmp_path: Path) -> None:
        signature = extract_signature(_fake_dng(tmp_path / "frame.dng"))

        # The header is readable even though rawpy cannot demosaic the file.
        assert signature.width.value == 320
        assert signature.height.value == 240

    def test_an_undecodable_raw_reports_an_unknown_phash_not_an_empty_one(
        self, tmp_path: Path
    ) -> None:
        signature = extract_signature(_fake_dng(tmp_path / "frame.dng"))

        assert signature.phash.known is False
        assert signature.phash.value is None
        assert signature.phash.issue
        assert signature.mean_rgb.known is False


class TestVideo:
    def test_dimensions_and_creation_time_are_known(self, tmp_path: Path) -> None:
        signature = extract_signature(_video(tmp_path / "clip.mp4"))

        assert signature.width.value == 640
        assert signature.height.value == 360
        assert signature.captured_at.value == "2021-05-04T10:11:12+00:00"

    def test_a_video_reports_an_unknown_phash_with_a_reason(self, tmp_path: Path) -> None:
        signature = extract_signature(_video(tmp_path / "clip.mp4"))

        assert signature.phash.known is False
        assert signature.phash.issue
        # The reason must name the mechanism, so a reader knows this is a scope
        # boundary and not a decode failure.
        assert "frame" in signature.phash.issue.lower()

    def test_a_video_without_a_creation_time_is_unknown_not_epoch(self, tmp_path: Path) -> None:
        path = tmp_path / "bare.mp4"
        subprocess.run(
            [
                "ffmpeg",
                "-hide_banner",
                "-loglevel",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=size=64x64:rate=5:duration=1",
                "-pix_fmt",
                "yuv420p",
                "-map_metadata",
                "-1",
                str(path),
            ],
            check=True,
            timeout=_FFMPEG_TIMEOUT,
        )

        signature = extract_signature(path)

        assert signature.captured_at.known is False
        assert signature.captured_at.value is None
        assert signature.width.value == 64


class TestUnknownIsNeverZero:
    """I-10 — the whole point of returning `FactValue` rather than plain ints."""

    def test_garbage_bytes_yield_unknowns_carrying_no_value(self, tmp_path: Path) -> None:
        path = tmp_path / "broken.jpg"
        path.write_bytes(b"\x00" * 4096)

        signature = extract_signature(path)

        assert _unknown_facts(signature)
        for name, fact in signature:
            assert fact.known is False, name
            assert fact.value is None, name
            assert fact.issue, name

    def test_an_unreadable_dimension_is_not_reported_as_zero(self, tmp_path: Path) -> None:
        path = tmp_path / "broken.jpg"
        path.write_bytes(b"\x00" * 4096)

        signature = extract_signature(path)

        assert signature.width.value != 0
        assert signature.height.value != 0
        assert signature.width != FactValue.of(0)

    def test_a_missing_file_is_unknown_rather_than_an_exception(self, tmp_path: Path) -> None:
        signature = extract_signature(tmp_path / "nothing-here.jpg")

        assert all(not fact.known for _name, fact in signature)

    def test_an_empty_file_is_unknown(self, tmp_path: Path) -> None:
        path = tmp_path / "empty.jpg"
        path.write_bytes(b"")

        signature = extract_signature(path)

        assert signature.width.known is False
        assert signature.phash.known is False

    def test_an_unknown_fact_cannot_be_constructed_with_a_value(self) -> None:
        with pytest.raises(ValueError):
            FactValue(known=False, value=7)


class TestCaptureTime:
    def test_exif_time_of_day_survives(self, tmp_path: Path) -> None:
        captured = capture_time(_jpeg(tmp_path / "shot.jpg", date_str="2020:03:04 05:06:07"))

        assert captured == datetime(2020, 3, 4, 5, 6, 7)

    def test_a_file_without_exif_has_no_capture_time(self, tmp_path: Path) -> None:
        path = tmp_path / "plain.png"
        Image.new("RGB", (8, 8)).save(path)

        assert capture_time(path) is None


class TestPurity:
    """No DB and no orchestration is a property of the module, not a promise."""

    def test_the_module_imports_nothing_stateful(self) -> None:
        module = Path(str(signature_extraction.__file__))
        source = module.read_text(encoding="utf-8")
        imported: set[str] = set()
        for node in ast.walk(ast.parse(source)):
            if isinstance(node, ast.Import):
                imported.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module)

        forbidden = ("catalog", "sqlite", "database", "task_manager", "background_tasks")
        offenders = sorted(m for m in imported if any(f in m for f in forbidden))
        assert offenders == []

    def test_extraction_writes_nothing_beside_the_file(self, tmp_path: Path) -> None:
        source = _jpeg(tmp_path / "shot.jpg")
        before = sorted(p.name for p in tmp_path.iterdir())

        extract_signature(source)

        assert sorted(p.name for p in tmp_path.iterdir()) == before
