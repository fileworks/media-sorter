"""F-06: a RAW file must not choose how much memory it gets.

`Image.MAX_IMAGE_PIXELS` is Pillow's decompression-bomb guard, and LibRaw
honours none of it. `raw.postprocess()` allocates height x width x 3 from
numbers the *file* supplies, so a crafted RAW claiming an enormous sensor asks
for an allocation bounded only by the header it wrote.

The check is on the declared size, before the allocation — checking afterwards
would mean the allocation already happened, which is the whole problem.
"""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from app.core.exceptions import CorruptedFileError
from app.services.filesystem_service import (
    MAX_RAW_DECLARED_PIXELS,
    _refuse_absurd_raw_dimensions,
)


def _raw(width: int, height: int) -> Any:
    """A stand-in for `rawpy.imread`'s handle, exposing only `.sizes`."""
    return SimpleNamespace(sizes=SimpleNamespace(raw_width=width, raw_height=height))


class TestTheCeiling:
    @pytest.mark.parametrize(
        ("width", "height"),
        [
            (2**16, 2**16),  # 4.3 billion pixels
            (1_000_000, 1_000_000),  # a trillion
            (MAX_RAW_DECLARED_PIXELS, 2),
            (2, MAX_RAW_DECLARED_PIXELS),
        ],
        ids=["65k square", "million square", "absurd width", "absurd height"],
    )
    def test_an_absurd_declaration_raises_rather_than_allocating(
        self, width: int, height: int, tmp_path: Path
    ) -> None:
        with pytest.raises(CorruptedFileError, match="ceiling"):
            _refuse_absurd_raw_dimensions(tmp_path / "bomb.arw", _raw(width, height))

    @pytest.mark.parametrize(
        ("width", "height"),
        [(6000, 4000), (11648, 8736), (17000, 12000)],
        ids=["24MP full-frame", "102MP medium format", "204MP hypothetical"],
    )
    def test_real_camera_dimensions_are_allowed(
        self, width: int, height: int, tmp_path: Path
    ) -> None:
        """The ceiling must clear every sensor a user could plausibly own."""
        _refuse_absurd_raw_dimensions(tmp_path / "photo.arw", _raw(width, height))

    def test_the_ceiling_is_well_clear_of_the_largest_real_sensor(self) -> None:
        largest_shipping_sensor_pixels = 102_000_000
        assert MAX_RAW_DECLARED_PIXELS > largest_shipping_sensor_pixels * 2

    @pytest.mark.parametrize(("width", "height"), [(0, 100), (100, 0), (-1, 100)])
    def test_a_non_positive_declaration_is_refused(
        self, width: int, height: int, tmp_path: Path
    ) -> None:
        with pytest.raises(CorruptedFileError, match="non-positive"):
            _refuse_absurd_raw_dimensions(tmp_path / "broken.arw", _raw(width, height))


class TestWhenSizesAreUnavailable:
    def test_a_handle_without_sizes_is_not_refused(self, tmp_path: Path) -> None:
        """Refusing every RAW whose bindings expose no sizes would be worse.

        Decoding is then no more dangerous than it was before this check
        existed, and RAW support keeps working across rawpy versions.
        """
        _refuse_absurd_raw_dimensions(tmp_path / "photo.arw", SimpleNamespace())

    def test_non_integer_dimensions_are_not_refused(self, tmp_path: Path) -> None:
        handle = SimpleNamespace(sizes=SimpleNamespace(raw_width=None, raw_height=None))

        _refuse_absurd_raw_dimensions(tmp_path / "photo.arw", handle)

    def test_the_fallback_size_fields_are_read(self, tmp_path: Path) -> None:
        """Some rawpy versions expose `height`/`width` rather than `raw_*`."""
        handle = SimpleNamespace(
            sizes=SimpleNamespace(height=10**6, width=10**6, raw_height=None, raw_width=None)
        )

        with pytest.raises(CorruptedFileError):
            _refuse_absurd_raw_dimensions(tmp_path / "bomb.arw", handle)


def test_the_check_runs_before_postprocess() -> None:
    """The ordering *is* the fix: after `postprocess` the allocation happened."""
    source = Path(__file__).resolve().parents[1] / "app" / "services" / "filesystem_service.py"
    body = source.read_text(encoding="utf-8")

    guard = body.index("_refuse_absurd_raw_dimensions(path, raw)")
    # The *call*, not the docstring that explains why it is there — anchoring on
    # `raw.postprocess(` alone matches the comment above it first.
    postprocess = body.index("rgb = raw.postprocess(")
    assert guard < postprocess, "the ceiling is checked after the allocation it exists to prevent"
