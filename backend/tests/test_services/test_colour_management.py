"""AI-NEW-7 — the model sees sRGB pixels, whatever profile a photo was saved in.

Recent phones save Display P3. Reading those pixel values as sRGB shows the
model different colours from the scene; the encoder converts temporary pixels
through the embedded profile. Source files are never changed.
"""

from __future__ import annotations

import hashlib
import io
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms

from app.services.ai.siglip_encoder import _upright_rgb

P3 = Path(__file__).resolve().parents[1] / "fixtures" / "icc" / "DisplayP3-v4.icc"


def _p3_photo(rgb: tuple[int, int, int]) -> tuple[Image.Image, Image.Image]:
    original = Image.new("RGB", (16, 16), rgb)
    p3_profile = ImageCms.getOpenProfile(str(P3))
    encoded = ImageCms.profileToProfile(original, ImageCms.createProfile("sRGB"), p3_profile)
    assert encoded is not None
    buffer = io.BytesIO()
    encoded.save(buffer, format="PNG", icc_profile=P3.read_bytes())
    return original, Image.open(io.BytesIO(buffer.getvalue()))


def _distance(left: Image.Image, right: Image.Image) -> float:
    return float(np.abs(np.asarray(left, dtype=float) - np.asarray(right, dtype=float)).mean())


def test_the_fixture_is_the_pinned_profile() -> None:
    assert (
        hashlib.sha256(P3.read_bytes()).hexdigest()
        == "cb51de38e482ee974c0c76b9689e16aad04bad16e226fed2f30c842d15ff3a3d"
    )


def test_display_p3_pixels_are_converted_back_to_srgb() -> None:
    original, p3_file = _p3_photo((200, 40, 40))
    raw = p3_file.convert("RGB")

    managed = _upright_rgb(p3_file)

    assert managed.mode == "RGB"
    assert _distance(managed, original) < 2.0
    assert _distance(raw, original) > 10.0


def test_an_srgb_or_missing_profile_leaves_pixels_alone() -> None:
    plain = Image.new("RGB", (8, 8), (10, 120, 200))
    srgb = io.BytesIO()
    plain.save(
        srgb,
        format="PNG",
        icc_profile=ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes(),
    )

    assert _distance(_upright_rgb(plain), plain) == 0.0
    assert _distance(_upright_rgb(Image.open(io.BytesIO(srgb.getvalue()))), plain) == 0.0


def test_a_corrupt_profile_falls_back_to_the_raw_pixels() -> None:
    image = Image.new("RGB", (8, 8), (90, 90, 90))
    image.info["icc_profile"] = b"not a profile"

    assert _distance(_upright_rgb(image), image) == 0.0


def test_cmyk_without_a_profile_still_becomes_rgb() -> None:
    assert _upright_rgb(Image.new("CMYK", (4, 4), (0, 0, 0, 0))).mode == "RGB"
