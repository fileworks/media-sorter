"""Video gets a perceptual signature, so Review can finally see duplicate clips.

`D2` returned `phash` unknown *by scope* for video, which left the similar view
images-only: a library could hold five copies of one clip and the workbench had
nothing to say about them. Persisting a frame signature was the design decision
nobody had made.

The decision made here has two halves, and both are load-bearing:

* **Shape.** A video's signature is its sampled frame hashes concatenated in
  sample order. One row, one `(file_id, kind)` key, no schema change — and every
  existing mechanism keeps working, because `_bands` already splits a signature
  into four bands whatever its width and `hamming` already compares equal-length
  hex.
* **Separation.** Videos are stored under their own kind with their own
  threshold. A 1,280-bit frame series and a 256-bit image hash need different
  distance budgets, and mixing them would either miss every re-encode or judge
  photographs at a threshold no photograph should be judged at.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

from app.services.catalog_duplicates import (
    IMAGE_SIGNATURE_KIND,
    VIDEO_MAX_DISTANCE,
    VIDEO_SIGNATURE_KIND,
    _bands,
    hamming,
)
from app.services.signature_extraction import extract_signature

_FFMPEG_TIMEOUT = 60


def _ffmpeg(*args: str) -> None:
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", *args],
        check=True,
        timeout=_FFMPEG_TIMEOUT,
    )


@pytest.fixture(scope="module")
def clips(tmp_path_factory: pytest.TempPathFactory) -> dict[str, Path]:
    root = tmp_path_factory.mktemp("clips")
    original = root / "original.mp4"
    _ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=640x360:rate=10:duration=3",
        "-pix_fmt",
        "yuv420p",
        str(original),
    )
    recompressed = root / "recompressed.mp4"
    _ffmpeg("-i", str(original), "-crf", "35", "-pix_fmt", "yuv420p", str(recompressed))
    downscaled = root / "downscaled.mp4"
    _ffmpeg("-i", str(original), "-vf", "scale=320:180", "-pix_fmt", "yuv420p", str(downscaled))
    retimed = root / "retimed.mp4"
    _ffmpeg(
        "-i",
        str(original),
        "-vf",
        "scale=320:180",
        "-r",
        "15",
        "-pix_fmt",
        "yuv420p",
        str(retimed),
    )
    unrelated = root / "unrelated.mp4"
    _ffmpeg(
        "-f",
        "lavfi",
        "-i",
        "smptebars=size=640x360:rate=10:duration=3",
        "-pix_fmt",
        "yuv420p",
        str(unrelated),
    )
    return {
        "original": original,
        "recompressed": recompressed,
        "downscaled": downscaled,
        "retimed": retimed,
        "unrelated": unrelated,
    }


def _signature(path: Path) -> str:
    fact = extract_signature(path).phash
    assert fact.known, fact.issue
    return str(fact.value)


class TestTheThresholdSeparatesDuplicatesFromStrangers:
    """The numbers the threshold was chosen from, asserted rather than remembered.

    A threshold picked once from a measurement and then never re-measured is a
    guess with a comment attached. These fail if the extractor's behaviour drifts
    out from under the constant.
    """

    @pytest.mark.parametrize("variant", ["recompressed", "downscaled", "retimed"])
    def test_a_re_encode_is_inside_the_threshold(
        self, clips: dict[str, Path], variant: str
    ) -> None:
        distance = hamming(_signature(clips["original"]), _signature(clips[variant]))

        assert distance is not None
        assert distance <= VIDEO_MAX_DISTANCE, f"{variant} would not be found as a duplicate"

    def test_unrelated_footage_is_far_outside_it(self, clips: dict[str, Path]) -> None:
        distance = hamming(_signature(clips["original"]), _signature(clips["unrelated"]))

        assert distance is not None
        # Unrelated signatures differ in about half their bits, and half of 1,280
        # is 640 — the threshold must sit nowhere near that.
        assert distance > VIDEO_MAX_DISTANCE * 4

    def test_a_remux_is_bit_identical(self, clips: dict[str, Path], tmp_path: Path) -> None:
        """Re-containering does not touch a single decoded pixel."""
        remuxed = tmp_path / "remuxed.mp4"
        _ffmpeg("-i", str(clips["original"]), "-c", "copy", str(remuxed))

        assert hamming(_signature(clips["original"]), _signature(remuxed)) == 0


class TestTheShapeFitsTheMachineryItReuses:
    def test_the_series_divides_into_four_bands(self, clips: dict[str, Path]) -> None:
        """Otherwise every video lookup degrades to a full scan and is flagged unreliable."""
        bands = _bands(_signature(clips["original"]))

        assert len(bands) == 4
        assert len({len(band) for band in bands}) == 1

    def test_videos_and_images_never_share_a_signature_kind(self) -> None:
        assert VIDEO_SIGNATURE_KIND != IMAGE_SIGNATURE_KIND

    def test_an_image_and_a_video_are_not_comparable(
        self, clips: dict[str, Path], tmp_path: Path
    ) -> None:
        """The widths differ, so `hamming` refuses rather than returning a number.

        This is the safety net under the separation: even if the two kinds were
        ever queried together, no image could be reported as near a video.
        """
        from PIL import Image

        still = tmp_path / "still.png"
        Image.new("RGB", (64, 64), "white").save(still)

        assert hamming(_signature(clips["original"]), _signature(still)) is None
