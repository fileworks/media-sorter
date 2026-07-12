"""Tests for DuplicateService — hash-based and perceptual duplicate detection."""

import random
import shutil
import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from app.core.config import Config
from app.services.duplicate_service import (
    DuplicateRegistry,
    DuplicateService,
    _VideoSig,
    quality_processing_order,
)


@pytest.fixture()
def svc() -> DuplicateService:
    return DuplicateService()


# ------------------------------------------------------------------ #
# compute_hash                                                          #
# ------------------------------------------------------------------ #


def test_compute_hash_is_deterministic(tmp_path: Path) -> None:
    f = tmp_path / "test.bin"
    f.write_bytes(b"hello world")
    assert DuplicateService.compute_hash(f) == DuplicateService.compute_hash(f)


def test_compute_hash_sha256_length(tmp_path: Path) -> None:
    f = tmp_path / "test.bin"
    f.write_bytes(b"data")
    assert len(DuplicateService.compute_hash(f)) == 64


def test_compute_hash_differs_for_different_content(tmp_path: Path) -> None:
    a = tmp_path / "a.bin"
    b = tmp_path / "b.bin"
    a.write_bytes(b"aaa")
    b.write_bytes(b"bbb")
    assert DuplicateService.compute_hash(a) != DuplicateService.compute_hash(b)


# ------------------------------------------------------------------ #
# check_duplicate — registry contract                                   #
# ------------------------------------------------------------------ #


def test_check_duplicate_first_occurrence_returns_false(
    tmp_path: Path, svc: DuplicateService
) -> None:
    f = tmp_path / "file.bin"
    f.write_bytes(b"unique content")
    reg = DuplicateRegistry()
    result = svc.check_duplicate(f, reg)
    assert result.is_duplicate is False
    # file should now be registered
    assert str(f) in reg.exact.values()


def test_check_duplicate_second_occurrence_returns_true(
    tmp_path: Path, svc: DuplicateService
) -> None:
    original = tmp_path / "original.bin"
    copy = tmp_path / "copy.bin"
    original.write_bytes(b"same content")
    copy.write_bytes(b"same content")

    reg = DuplicateRegistry()
    assert svc.check_duplicate(original, reg).is_duplicate is False
    result = svc.check_duplicate(copy, reg)
    assert result.is_duplicate is True
    assert result.match_type == "exact"
    assert result.similarity == 100


def test_check_duplicate_tracks_original_path(tmp_path: Path, svc: DuplicateService) -> None:
    original = tmp_path / "original.bin"
    original.write_bytes(b"content")
    reg = DuplicateRegistry()
    svc.check_duplicate(original, reg)
    assert str(original) in reg.exact.values()


def test_check_duplicate_distinct_files_not_flagged(tmp_path: Path, svc: DuplicateService) -> None:
    a = tmp_path / "a.bin"
    b = tmp_path / "b.bin"
    a.write_bytes(b"alpha")
    b.write_bytes(b"beta")
    reg = DuplicateRegistry()
    assert svc.check_duplicate(a, reg).is_duplicate is False
    assert svc.check_duplicate(b, reg).is_duplicate is False


def test_check_duplicate_with_exact_disabled(tmp_path: Path, svc: DuplicateService) -> None:
    """When exact=False and perceptual=False, identical files are not flagged."""
    f1 = tmp_path / "f1.bin"
    f2 = tmp_path / "f2.bin"
    f1.write_bytes(b"same content")
    f2.write_bytes(b"same content")
    reg = DuplicateRegistry()
    assert svc.check_duplicate(f1, reg, exact=False, perceptual=False).is_duplicate is False
    assert svc.check_duplicate(f2, reg, exact=False, perceptual=False).is_duplicate is False
    assert len(reg.exact) == 0  # nothing registered when exact=False


def test_check_duplicate_exact_match_returns_original_path(
    tmp_path: Path, svc: DuplicateService
) -> None:
    original = tmp_path / "orig.bin"
    dupe = tmp_path / "dupe.bin"
    original.write_bytes(b"data")
    dupe.write_bytes(b"data")

    reg = DuplicateRegistry()
    svc.check_duplicate(original, reg)
    result = svc.check_duplicate(dupe, reg)
    assert result.is_duplicate is True
    assert result.match_type == "exact"
    assert result.similarity == 100
    assert result.original_path == str(original)


# ------------------------------------------------------------------ #
# perceptual hash helpers                                               #
# ------------------------------------------------------------------ #


def test_is_image_recognises_jpeg() -> None:
    assert DuplicateService._is_image(Path("photo.jpg")) is True
    assert DuplicateService._is_image(Path("photo.JPEG")) is True


def test_is_image_rejects_video() -> None:
    assert DuplicateService._is_image(Path("clip.mp4")) is False


def test_is_video_recognises_mp4() -> None:
    assert DuplicateService._is_video(Path("clip.mp4")) is True
    assert DuplicateService._is_video(Path("clip.MOV")) is True


def test_is_video_rejects_image() -> None:
    assert DuplicateService._is_video(Path("photo.jpg")) is False


# ------------------------------------------------------------------ #
# SHA-256 (compute_hash — the digest check_duplicate uses)              #
# ------------------------------------------------------------------ #


def test_compute_hash_consistent(tmp_path: Path) -> None:
    f = tmp_path / "test.bin"
    f.write_bytes(b"hello world")
    assert DuplicateService.compute_hash(f) == DuplicateService.compute_hash(f)


def test_compute_hash_length(tmp_path: Path) -> None:
    f = tmp_path / "test.bin"
    f.write_bytes(b"data")
    assert len(DuplicateService.compute_hash(f)) == 64


# ------------------------------------------------------------------ #
# image_signature (the perceptual signature check_duplicate uses)       #
# ------------------------------------------------------------------ #


def test_image_signature_returns_none_for_non_image(tmp_path: Path, svc: DuplicateService) -> None:
    f = tmp_path / "data.bin"
    f.write_bytes(b"\x00\x01\x02\x03" * 100)
    assert svc.image_signature(f) is None


def test_image_signature_returns_sig_for_valid_image(tmp_path: Path, svc: DuplicateService) -> None:
    PIL_Image = pytest.importorskip("PIL.Image")
    pytest.importorskip("imagehash")

    img_path = tmp_path / "test.jpg"
    img = PIL_Image.new("RGB", (64, 64), color=(128, 64, 32))
    img.save(img_path)

    sig = svc.image_signature(img_path)
    assert sig is not None
    assert sig.phash is not None
    assert sig.mean_rgb is not None


# ------------------------------------------------------------------ #
# similarity_percent                                                    #
# ------------------------------------------------------------------ #


def test_similarity_percent_identical(svc: DuplicateService) -> None:
    PIL_Image = pytest.importorskip("PIL.Image")
    imagehash = pytest.importorskip("imagehash")

    img = PIL_Image.new("RGB", (64, 64), color=(100, 100, 100))
    h = imagehash.average_hash(img, hash_size=16)
    assert svc.similarity_percent(h, h) == 100


# ------------------------------------------------------------------ #
# similarity_percent threshold boundaries                               #
# ------------------------------------------------------------------ #


def test_similarity_percent_below_threshold_for_different_images(svc: DuplicateService) -> None:
    PIL_Image = pytest.importorskip("PIL.Image")
    imagehash = pytest.importorskip("imagehash")

    # Solid grey image — average_hash is all zeros
    img1 = PIL_Image.new("RGB", (64, 64), color=(128, 128, 128))
    # Gradient image — produces very different average_hash bits
    pixels = [(int(i * 255 / 64), int(j * 255 / 64), 128) for j in range(64) for i in range(64)]
    img2 = PIL_Image.new("RGB", (64, 64))
    img2.putdata(pixels)

    h1 = imagehash.average_hash(img1, hash_size=16)
    h2 = imagehash.average_hash(img2, hash_size=16)
    assert h1 - h2 > 0, "Test images must produce different hashes"
    similarity = svc.similarity_percent(h1, h2)
    assert similarity < 95, f"Expected similarity < 95%, got {similarity}%"


# ------------------------------------------------------------------ #
# New image perceptual tests                                            #
# ------------------------------------------------------------------ #


def _make_content_image(path: Path, size: int = 256) -> None:
    """Save a mid-grey textured JPEG to *path*.

    Uses a slowly-varying pattern so that:
    - A scaled-down copy (same content, different resolution) still produces a
      very similar phash (≥90% similarity).
    - Flipping ~0.5% of pixel values has negligible effect on the phash since
      all pixel values hover near mid-grey (flipping keeps them in a similar range).
    """
    PIL_Image = pytest.importorskip("PIL.Image")
    pixels = [
        (128 + (i + j) % 30, 128 + (i * j // 300) % 30, 100)
        for j in range(size)
        for i in range(size)
    ]
    img = PIL_Image.new("RGB", (size, size))
    img.putdata(pixels)
    img.save(str(path), format="JPEG", quality=95)


def _make_solid_image(path: Path, color: tuple, size: int = 64) -> None:
    """Save a solid-colour JPEG to *path*."""
    PIL_Image = pytest.importorskip("PIL.Image")
    img = PIL_Image.new("RGB", (size, size), color=color)
    img.save(str(path), format="JPEG", quality=95)


def test_image_perceptual_duplicate_exact_disabled(tmp_path: Path, svc: DuplicateService) -> None:
    """Byte-identical copy, exact=False → perceptual path catches it (similarity=100)."""
    pytest.importorskip("imagehash")
    original = tmp_path / "orig.jpg"
    copy = tmp_path / "copy.jpg"
    _make_content_image(original)
    shutil.copyfile(original, copy)

    reg = DuplicateRegistry()
    svc.check_duplicate(original, reg, exact=False)
    result = svc.check_duplicate(copy, reg, exact=False)
    assert result.is_duplicate is True
    assert result.match_type == "perceptual"
    assert result.similarity == 100


def test_image_scaled_down_copy_is_perceptual_duplicate(
    tmp_path: Path, svc: DuplicateService
) -> None:
    """A 64×64 JPEG resized from a 256×256 original is a perceptual duplicate."""
    PIL_Image = pytest.importorskip("PIL.Image")
    pytest.importorskip("imagehash")

    original = tmp_path / "original.jpg"
    _make_content_image(original, size=256)

    # Downscale to 64×64 and re-save as JPEG — different bytes, same content
    small = tmp_path / "small.jpg"
    with PIL_Image.open(original) as img:
        img.resize((64, 64)).save(str(small), format="JPEG", quality=85)

    reg = DuplicateRegistry()
    r1 = svc.check_duplicate(original, reg)
    assert r1.is_duplicate is False  # first file, not a duplicate

    r2 = svc.check_duplicate(small, reg, threshold=90)
    assert r2.is_duplicate is True, f"Expected perceptual duplicate, got similarity={r2.similarity}"
    assert r2.match_type == "perceptual"
    # Exact must NOT have matched (different bytes)
    assert r2.similarity is not None
    assert r2.similarity >= 90


def test_image_few_pixels_changed_is_perceptual_duplicate(
    tmp_path: Path, svc: DuplicateService
) -> None:
    """An image with ~0.5% of pixels modified is still a perceptual duplicate."""
    PIL_Image = pytest.importorskip("PIL.Image")
    pytest.importorskip("imagehash")

    original = tmp_path / "original.jpg"
    _make_content_image(original, size=256)

    # Load, flip ~0.5% of pixels (~330 pixels in a 256×256 = 65536 pixel image)
    modified = tmp_path / "modified.jpg"
    np = pytest.importorskip("numpy")
    with PIL_Image.open(original) as img:
        arr = np.array(img.convert("RGB"))
        flat = arr.reshape(-1, 3)
        step = max(1, len(flat) // 200)  # flip ~0.5%
        flat[::step] = 255 - flat[::step]
        img2 = PIL_Image.fromarray(arr)
        img2.save(str(modified), format="JPEG", quality=95)

    reg = DuplicateRegistry()
    svc.check_duplicate(original, reg)
    result = svc.check_duplicate(modified, reg, threshold=95)
    assert result.is_duplicate is True
    assert result.match_type == "perceptual"


def test_image_solid_red_vs_green_not_duplicate(tmp_path: Path, svc: DuplicateService) -> None:
    """Solid red and solid green images — colour gate prevents false positive."""
    pytest.importorskip("imagehash")

    red = tmp_path / "red.jpg"
    green = tmp_path / "green.jpg"
    _make_solid_image(red, color=(255, 0, 0))
    _make_solid_image(green, color=(0, 200, 0))

    reg = DuplicateRegistry()
    svc.check_duplicate(red, reg)
    result = svc.check_duplicate(green, reg)
    assert result.is_duplicate is False


def test_image_completely_different_not_duplicate(tmp_path: Path, svc: DuplicateService) -> None:
    """Two visually unrelated images of the same size are not duplicates.

    The mid-grey texture (mean ≈ 143,135,100) vs bright blue (60,120,200) have a
    colour distance > 40, so the colour gate prevents a false positive even before
    the phash comparison runs.
    """
    PIL_Image = pytest.importorskip("PIL.Image")
    pytest.importorskip("imagehash")

    img_a = tmp_path / "a.jpg"
    img_b = tmp_path / "b.jpg"
    _make_content_image(img_a, size=128)
    # Clearly different colour distribution — blue/white vs mid-grey/brown
    img = PIL_Image.new("RGB", (128, 128), color=(60, 120, 200))
    img.save(str(img_b), format="JPEG", quality=95)

    reg = DuplicateRegistry()
    svc.check_duplicate(img_a, reg)
    result = svc.check_duplicate(img_b, reg, threshold=95)
    assert result.is_duplicate is False


def test_image_scaled_red_vs_full_red_is_duplicate(tmp_path: Path, svc: DuplicateService) -> None:
    """Scaled-down red image vs full red image — colour gate passes, phash matches."""
    PIL_Image = pytest.importorskip("PIL.Image")
    pytest.importorskip("imagehash")

    full_red = tmp_path / "full_red.jpg"
    small_red = tmp_path / "small_red.jpg"
    _make_solid_image(full_red, color=(255, 0, 0), size=256)
    with PIL_Image.open(full_red) as img:
        img.resize((32, 32)).save(str(small_red), format="JPEG", quality=95)

    reg = DuplicateRegistry()
    svc.check_duplicate(full_red, reg, exact=False)
    result = svc.check_duplicate(small_red, reg, exact=False)
    assert result.is_duplicate is True
    assert result.match_type == "perceptual"


# ------------------------------------------------------------------ #
# Video perceptual tests — gated on ffmpeg                              #
# ------------------------------------------------------------------ #


def _make_color_video(path: Path, color: str, size: str = "64x64", dur: str = "2") -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"color=c={color}:s={size}:d={dur}",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


def _make_testsrc_video(path: Path, size: str = "64x64", dur: str = "2") -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc=s={size}:d={dur}",
            "-pix_fmt",
            "yuv420p",
            str(path),
        ],
        check=True,
        capture_output=True,
    )


_needs_ffmpeg = pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")


@_needs_ffmpeg
def test_video_red_vs_green_not_duplicate(tmp_path: Path, svc: DuplicateService) -> None:
    """Solid-red and solid-green clips are NOT duplicates (colour gate rejects frames)."""
    pytest.importorskip("imagehash")
    red = tmp_path / "red.mp4"
    green = tmp_path / "green.mp4"
    _make_color_video(red, "red")
    _make_color_video(green, "green")

    reg = DuplicateRegistry()
    svc.check_duplicate(red, reg, exact=False)
    result = svc.check_duplicate(green, reg, exact=False)
    assert result.is_duplicate is False


@_needs_ffmpeg
def test_video_scaled_copy_is_perceptual_duplicate(tmp_path: Path, svc: DuplicateService) -> None:
    """The same solid-colour footage at two different resolutions is a perceptual duplicate.

    Bytes differ (different resolution → different file size/headers), but the
    visual content is identical, so the perceptual path matches them at 100%.
    """
    pytest.importorskip("imagehash")
    original = tmp_path / "orig.mp4"
    small = tmp_path / "small.mp4"
    # Same solid colour (purple) encoded at two resolutions — different bytes
    _make_color_video(original, "purple", size="64x64")
    _make_color_video(small, "purple", size="32x32")
    assert original.read_bytes() != small.read_bytes(), "Files must differ in bytes"

    reg = DuplicateRegistry()
    r1 = svc.check_duplicate(original, reg, exact=False)
    assert r1.is_duplicate is False

    r2 = svc.check_duplicate(small, reg, exact=False, threshold=90)
    assert r2.is_duplicate is True, f"Expected video perceptual dup, similarity={r2.similarity}"
    assert r2.match_type == "perceptual"


@_needs_ffmpeg
def test_video_different_content_not_duplicate(tmp_path: Path, svc: DuplicateService) -> None:
    """testsrc (complex pattern) vs solid-colour clip are NOT duplicates."""
    pytest.importorskip("imagehash")
    a = tmp_path / "testsrc.mp4"
    b = tmp_path / "solid.mp4"
    _make_testsrc_video(a)
    _make_color_video(b, "blue")

    reg = DuplicateRegistry()
    svc.check_duplicate(a, reg, exact=False)
    result = svc.check_duplicate(b, reg, exact=False, threshold=95)
    assert result.is_duplicate is False


@_needs_ffmpeg
def test_video_identical_copy_is_exact_duplicate(tmp_path: Path, svc: DuplicateService) -> None:
    """Byte-identical copy of a video is caught as an exact duplicate."""
    original = tmp_path / "orig.mp4"
    copy = tmp_path / "copy.mp4"
    _make_color_video(original, "red")
    shutil.copyfile(original, copy)

    reg = DuplicateRegistry()
    svc.check_duplicate(original, reg)
    result = svc.check_duplicate(copy, reg)
    assert result.is_duplicate is True
    assert result.match_type == "exact"
    assert result.similarity == 100


def test_video_signature_non_video_returns_none(tmp_path: Path, svc: DuplicateService) -> None:
    """video_signature on a non-video file returns None (no ffmpeg needed)."""
    f = tmp_path / "data.bin"
    f.write_bytes(b"\x00" * 1000)
    # _probe_duration will fail gracefully whether or not ffmpeg is installed
    assert svc.video_signature(f) is None


@_needs_ffmpeg
def test_video_similarity_self_is_100(tmp_path: Path, svc: DuplicateService) -> None:
    """video_similarity of a signature with itself must be 100."""
    pytest.importorskip("imagehash")
    vid = tmp_path / "test.mp4"
    _make_color_video(vid, "red")
    sig = svc.video_signature(vid)
    assert sig is not None
    assert svc.video_similarity(sig, sig) == 100


def test_video_similarity_empty_frames_is_zero(svc: DuplicateService) -> None:
    """video_similarity with no frames should return 0, not crash."""
    empty_a = _VideoSig(frames=[], path="/a.mp4")
    empty_b = _VideoSig(frames=[], path="/b.mp4")
    assert svc.video_similarity(empty_a, empty_b) == 0


@_needs_ffmpeg
def test_preview_does_not_call_video_signature(tmp_path: Path, svc: DuplicateService) -> None:
    """check_duplicate(..., sample_video=False) must NOT call video_signature."""
    pytest.importorskip("imagehash")
    vid = tmp_path / "test.mp4"
    _make_color_video(vid, "red")

    reg = DuplicateRegistry()
    with patch.object(svc, "video_signature", side_effect=AssertionError("video_signature called")):
        # Should not raise — video_signature must not be invoked
        result = svc.check_duplicate(vid, reg, sample_video=False)
    # Not a duplicate (first occurrence)
    assert result.is_duplicate is False


# ------------------------------------------------------------------ #
# Quality-based duplicate preference                                    #
# ------------------------------------------------------------------ #


def _make_sized_image(path: Path, size: int, quality: int = 95) -> None:
    """Save a solid-grey JPEG; *size* controls resolution → file size proxy."""
    PIL_Image = pytest.importorskip("PIL.Image")
    img = PIL_Image.new("RGB", (size, size), color=(128, 128, 128))
    img.save(str(path), format="JPEG", quality=quality)


def test_smaller_duplicate_stays_duplicate_when_larger_registered_first(
    tmp_path: Path, svc: DuplicateService
) -> None:
    """When the larger image is registered first and the smaller one arrives later,
    the smaller file is still marked as a duplicate (larger one wins)."""
    pytest.importorskip("imagehash")

    large = tmp_path / "large.jpg"
    small = tmp_path / "small.jpg"
    _make_sized_image(large, size=256, quality=95)  # bigger file
    _make_sized_image(small, size=32, quality=95)  # much smaller file

    reg = DuplicateRegistry()
    r1 = svc.check_duplicate(large, reg, exact=False)
    assert r1.is_duplicate is False

    r2 = svc.check_duplicate(small, reg, exact=False, threshold=90)
    # small matches the already-registered large copy → flagged as its duplicate
    assert r2.is_duplicate is True
    assert r2.match_type == "perceptual"


def test_later_arrival_is_duplicate_of_first_registered(
    tmp_path: Path, svc: DuplicateService
) -> None:
    """check_duplicate is pure detection: the first-registered copy is the kept
    original and any later perceptual match — even a higher-resolution one — is
    flagged as a duplicate of it. Keeping the *best* copy is the caller's job; it
    feeds files in descending quality_key order so the best one registers first."""
    pytest.importorskip("imagehash")

    small = tmp_path / "small.jpg"
    large = tmp_path / "large.jpg"
    _make_sized_image(small, size=64, quality=95)  # fewer pixels, registered first
    _make_sized_image(large, size=256, quality=95)  # more pixels, arrives later

    reg = DuplicateRegistry()
    assert svc.check_duplicate(small, reg, exact=False).is_duplicate is False
    r = svc.check_duplicate(large, reg, exact=False, threshold=90)
    assert r.is_duplicate is True
    assert r.match_type == "perceptual"
    assert r.original_path == str(small)
    # The registry keeps exactly the first-registered signature (no swap).
    assert len(reg.images) == 1
    assert reg.images[0].path == str(small)


def test_quality_key_ranks_by_resolution_then_size(tmp_path: Path, svc: DuplicateService) -> None:
    """quality_key is (pixels, size): more pixels outranks fewer, so sorting by it
    descending puts the higher-resolution copy — the one to keep — first."""
    pytest.importorskip("PIL.Image")

    low = tmp_path / "low.jpg"
    high = tmp_path / "high.jpg"
    _make_sized_image(low, size=64, quality=95)
    _make_sized_image(high, size=256, quality=95)

    assert svc.quality_key(low)[0] == 64 * 64
    assert svc.quality_key(high)[0] == 256 * 256
    assert svc.quality_key(high) > svc.quality_key(low)
    assert sorted([low, high], key=svc.quality_key, reverse=True)[0] == high


def test_quality_key_size_breaks_resolution_ties(tmp_path: Path, svc: DuplicateService) -> None:
    """At equal resolution the larger file (more detail) ranks first."""
    PIL_Image = pytest.importorskip("PIL.Image")

    # A textured image so JPEG quality actually changes the byte size at a fixed
    # resolution (a solid colour would compress identically at any quality).
    size = 128
    pixels = [
        (128 + (i + j) % 30, 128 + (i * j // 300) % 30, 100)
        for j in range(size)
        for i in range(size)
    ]
    img = PIL_Image.new("RGB", (size, size))
    img.putdata(pixels)

    lossy = tmp_path / "lossy.jpg"
    fine = tmp_path / "fine.jpg"
    img.save(str(lossy), format="JPEG", quality=10)  # same res, fewer bytes
    img.save(str(fine), format="JPEG", quality=95)  # same res, more bytes

    lk, fk = svc.quality_key(lossy), svc.quality_key(fine)
    assert lk[0] == fk[0] == size * size
    assert fk[1] > lk[1]
    assert fk > lk


def test_quality_key_unknown_dimensions_falls_back_to_size(
    tmp_path: Path, svc: DuplicateService
) -> None:
    """When dimensions can't be read, pixels is 0 and size is the sole signal."""
    a = tmp_path / "a.jpg"
    b = tmp_path / "b.jpg"
    a.write_bytes(b"not a real image" * 10)  # 160 bytes, unreadable
    b.write_bytes(b"not a real image" * 30)  # 480 bytes, unreadable

    ak, bk = svc.quality_key(a), svc.quality_key(b)
    assert ak[0] == 0 and bk[0] == 0
    assert bk[1] > ak[1]
    assert bk > ak


def test_quality_key_video_ranked_by_size_only(tmp_path: Path, svc: DuplicateService) -> None:
    """Videos are ranked by size only (no ffprobe), so pixels is always 0 and the
    larger file wins."""
    vid = tmp_path / "clip.mp4"
    vid.write_bytes(b"\x00" * 2048)
    pixels, size = svc.quality_key(vid)
    assert pixels == 0
    assert size == 2048


def test_equal_size_first_file_wins(tmp_path: Path, svc: DuplicateService) -> None:
    """When both files are identical bytes (shutil.copy), first-seen wins."""
    pytest.importorskip("imagehash")

    original = tmp_path / "orig.jpg"
    copy = tmp_path / "copy.jpg"
    _make_content_image(original)
    shutil.copyfile(original, copy)

    reg = DuplicateRegistry()
    svc.check_duplicate(original, reg, exact=False)
    result = svc.check_duplicate(copy, reg, exact=False)
    # Byte-identical → same size → first-seen (original) wins, copy is duplicate
    assert result.is_duplicate is True
    assert result.original_path == str(original)


# ------------------------------------------------------------------ #
# P1-3 — keeper selection audit: quality_processing_order + check_duplicate  #
# must together keep the highest-quality copy of a group, for any input     #
# discovery order.                                                          #
# ------------------------------------------------------------------ #


def test_keeper_is_highest_quality_regardless_of_discovery_order(
    tmp_path: Path, svc: DuplicateService
) -> None:
    """A 5-copy duplicate group at different resolutions: whichever order the
    files are discovered on disk, quality_processing_order + check_duplicate
    must keep exactly the highest-resolution copy and flag the other four."""
    pytest.importorskip("imagehash")

    sizes = [32, 64, 96, 160, 256]
    paths = []
    for i, size in enumerate(sizes):
        p = tmp_path / f"dup_{i}.jpg"
        _make_sized_image(p, size=size, quality=95)
        paths.append(p)
    best = max(paths, key=svc.quality_key)
    assert best == paths[-1]  # sanity: the 256px file is genuinely the best

    config = Config(remove_duplicates=True, duplicate_perceptual_enabled=True)

    for seed in range(8):
        shuffled = paths.copy()
        random.Random(seed).shuffle(shuffled)

        order = quality_processing_order(shuffled, config, svc)
        registry = DuplicateRegistry()
        kept: Path | None = None
        flagged = 0
        for idx in order:
            f = shuffled[idx]
            match = svc.check_duplicate(f, registry, threshold=90)
            if match.is_duplicate:
                flagged += 1
            else:
                assert kept is None, f"seed={seed}: more than one file kept: {kept}, {f}"
                kept = f

        assert kept == best, f"seed={seed}: kept {kept}, expected highest-quality {best}"
        assert flagged == len(paths) - 1


def test_keeper_selection_does_not_cross_talk_between_groups(
    tmp_path: Path, svc: DuplicateService
) -> None:
    """Two visually-distinct duplicate groups interleaved in one file list must
    each keep their own highest-quality copy — selection never leaks across
    groups just because both were ranked in the same processing pass."""
    PIL_Image = pytest.importorskip("PIL.Image")
    pytest.importorskip("imagehash")

    def make_group(prefix: str, color: tuple[int, int, int], sizes: list[int]) -> list[Path]:
        made = []
        for i, size in enumerate(sizes):
            p = tmp_path / f"{prefix}_{i}.jpg"
            PIL_Image.new("RGB", (size, size), color=color).save(str(p), format="JPEG", quality=95)
            made.append(p)
        return made

    group_a = make_group("a", (128, 128, 128), [32, 96, 256])
    group_b = make_group("b", (10, 200, 40), [48, 200])
    best_a, best_b = max(group_a, key=svc.quality_key), max(group_b, key=svc.quality_key)

    all_files = group_a + group_b
    config = Config(remove_duplicates=True, duplicate_perceptual_enabled=True)

    for seed in range(5):
        shuffled = all_files.copy()
        random.Random(seed).shuffle(shuffled)

        order = quality_processing_order(shuffled, config, svc)
        registry = DuplicateRegistry()
        kept: list[Path] = []
        for idx in order:
            f = shuffled[idx]
            match = svc.check_duplicate(f, registry, threshold=90)
            if not match.is_duplicate:
                kept.append(f)

        assert sorted(kept) == sorted([best_a, best_b]), f"seed={seed}: kept {kept}"
