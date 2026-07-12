"""Tests for FileSystemService safe copy/move and directory helpers."""

from datetime import datetime
from pathlib import Path

import pytest

from app.core.exceptions import SortingError
from app.services.filesystem_service import (
    HEIC_EXTENSIONS,
    IMAGE_EXTENSIONS,
    RAW_EXTENSIONS,
    FileSystemService,
    image_dimensions,
    open_image,
    register_heif,
)


@pytest.fixture()
def svc() -> FileSystemService:
    return FileSystemService()


# ------------------------------------------------------------------ #
# safe_copy                                                             #
# ------------------------------------------------------------------ #


def test_safe_copy_creates_file(tmp_path: Path, svc: FileSystemService) -> None:
    src = tmp_path / "src.txt"
    src.write_text("hello")
    dst = tmp_path / "sub" / "dst.txt"

    svc.safe_copy(src, dst)

    assert dst.exists()
    assert dst.read_text() == "hello"


def test_safe_copy_invokes_progress_callback(tmp_path: Path, svc: FileSystemService) -> None:
    src = tmp_path / "big.bin"
    src.write_bytes(b"x" * (2 * 1024 * 1024))  # 2 MB → two chunks
    dst = tmp_path / "out.bin"
    calls: list[tuple[int, int]] = []

    svc.safe_copy(src, dst, on_progress=lambda c, t: calls.append((c, t)))

    assert len(calls) >= 2
    last_copied, total = calls[-1]
    assert last_copied == total == 2 * 1024 * 1024


def test_safe_copy_raises_for_missing_source(tmp_path: Path, svc: FileSystemService) -> None:
    with pytest.raises(SortingError, match="Source not found"):
        svc.safe_copy(tmp_path / "ghost.jpg", tmp_path / "dst.jpg")


def test_safe_copy_verification_catches_mismatch(
    tmp_path: Path, svc: FileSystemService, monkeypatch: pytest.MonkeyPatch
) -> None:
    src = tmp_path / "src.txt"
    src.write_text("abc")
    dst = tmp_path / "dst.txt"

    # Simulate a truncated destination by patching stat on the destination
    original_stat = Path.stat

    def fake_stat(self: Path, **kwargs: object) -> object:
        real = original_stat(self, **kwargs)
        if self == dst:
            import os

            return os.stat_result(
                (
                    real.st_mode,
                    real.st_ino,
                    real.st_dev,
                    real.st_nlink,
                    real.st_uid,
                    real.st_gid,
                    0,  # wrong size
                    real.st_atime,
                    real.st_mtime,
                    real.st_ctime,
                )
            )
        return real

    monkeypatch.setattr(Path, "stat", fake_stat)

    with pytest.raises(SortingError, match="Verification failed"):
        svc.safe_copy(src, dst, verify=True)

    assert not dst.exists(), "Partial file should be cleaned up"


# ------------------------------------------------------------------ #
# safe_move                                                             #
# ------------------------------------------------------------------ #


def test_safe_move_removes_source(tmp_path: Path, svc: FileSystemService) -> None:
    src = tmp_path / "original.jpg"
    src.write_bytes(b"\xff\xd8\xff")
    dst = tmp_path / "moved" / "original.jpg"

    svc.safe_move(src, dst)

    assert dst.exists()
    assert not src.exists()


# ------------------------------------------------------------------ #
# create_directory_structure                                            #
# ------------------------------------------------------------------ #


@pytest.mark.parametrize(
    "criteria,expected_suffix",
    [
        (["year"], "2024"),
        (["year", "month"], "2024/01"),
        (["year", "month", "day"], "2024/01/15"),
        ([], ""),
    ],
)
def test_create_directory_structure(
    tmp_path: Path,
    svc: FileSystemService,
    criteria: list[str],
    expected_suffix: str,
) -> None:
    d = datetime(2024, 1, 15)
    result = svc.create_directory_structure(tmp_path, d, criteria)

    expected = tmp_path / Path(expected_suffix) if expected_suffix else tmp_path
    assert result == expected
    assert result.is_dir()


# ------------------------------------------------------------------ #
# find_available_filename                                               #
# ------------------------------------------------------------------ #


def test_find_available_filename_returns_original_when_free(
    tmp_path: Path, svc: FileSystemService
) -> None:
    p = tmp_path / "photo.jpg"
    assert svc.find_available_filename(p) == p


def test_find_available_filename_increments_suffix(tmp_path: Path, svc: FileSystemService) -> None:
    base = tmp_path / "photo.jpg"
    base.touch()

    first = svc.find_available_filename(base)
    assert first == tmp_path / "photo_001.jpg"

    first.touch()
    second = svc.find_available_filename(base)
    assert second == tmp_path / "photo_002.jpg"


# ------------------------------------------------------------------ #
# list_files                                                            #
# ------------------------------------------------------------------ #


@pytest.mark.asyncio
async def test_list_files_finds_media(tmp_path: Path, svc: FileSystemService) -> None:
    (tmp_path / "a.jpg").touch()
    (tmp_path / "b.mp4").touch()
    (tmp_path / "ignore.txt").touch()
    sub = tmp_path / "sub"
    sub.mkdir()
    (sub / "c.png").touch()

    files = await svc.list_files(str(tmp_path))
    names = {f.name for f in files}

    assert "a.jpg" in names
    assert "b.mp4" in names
    assert "c.png" in names
    assert "ignore.txt" not in names


@pytest.mark.asyncio
async def test_list_files_missing_directory(svc: FileSystemService) -> None:
    files = await svc.list_files("/does/not/exist")
    assert files == []


@pytest.mark.asyncio
async def test_list_files_respects_max_depth(tmp_path: Path, svc: FileSystemService) -> None:
    deep = tmp_path / "a" / "b" / "c"
    deep.mkdir(parents=True)
    (tmp_path / "root.jpg").touch()
    (tmp_path / "a" / "level1.jpg").touch()
    (deep / "deep.jpg").touch()

    files = await svc.list_files(str(tmp_path), max_depth=1)
    names = {f.name for f in files}

    assert "root.jpg" in names
    assert "level1.jpg" in names
    assert "deep.jpg" not in names


# ------------------------------------------------------------------ #
# Extension-set constants                                               #
# ------------------------------------------------------------------ #


def test_raw_extensions_subset_of_image_extensions() -> None:
    assert RAW_EXTENSIONS <= IMAGE_EXTENSIONS


def test_heic_extensions_subset_of_image_extensions() -> None:
    assert HEIC_EXTENSIONS <= IMAGE_EXTENSIONS


def test_raw_extensions_count() -> None:
    assert len(RAW_EXTENSIONS) == 23


# ------------------------------------------------------------------ #
# open_image helper                                                     #
# ------------------------------------------------------------------ #


def test_open_image_jpeg_yields_image(tmp_path: Path) -> None:
    PIL_Image = pytest.importorskip("PIL.Image")
    img_path = tmp_path / "test.jpg"
    img = PIL_Image.new("RGB", (4, 4), color=(128, 0, 0))
    img.save(img_path, format="JPEG")

    with open_image(img_path) as result:
        assert result is not None
        assert result.size == (4, 4)


def test_open_image_garbage_jpeg_yields_none(tmp_path: Path) -> None:
    bad = tmp_path / "corrupt.jpg"
    bad.write_bytes(b"\x00\x01\x02\x03garbage bytes that are not a JPEG")

    with open_image(bad) as result:
        assert result is None


def test_open_image_nonexistent_yields_none(tmp_path: Path) -> None:
    with open_image(tmp_path / "ghost.jpg") as result:
        assert result is None


def test_open_image_raw_stub_yields_none(tmp_path: Path) -> None:
    """Garbage bytes with a RAW extension yield None gracefully — rawpy rejects them."""
    stub = tmp_path / "photo.arw"
    stub.write_bytes(b"\x00\x01\x02\x03 not a real RAW file")

    with open_image(stub) as result:
        assert result is None


def test_register_heif_idempotent() -> None:
    """register_heif can be called multiple times without raising."""
    register_heif()
    register_heif()


# ------------------------------------------------------------------ #
# get_available_space                                                   #
# ------------------------------------------------------------------ #


def test_get_available_space_existing_path(tmp_path: Path, svc: FileSystemService) -> None:
    """An existing directory reports its volume's free bytes (> 0)."""
    free = svc.get_available_space(tmp_path)
    assert isinstance(free, int)
    assert free > 0


def test_get_available_space_nested_nonexistent_target(
    tmp_path: Path, svc: FileSystemService
) -> None:
    """A 2-level-deep target that does not exist yet (created during the sort)
    reports the free space of its nearest existing ancestor, not 0/None.

    This is the regression: previously the fallback only walked one parent up,
    so a non-existent grandparent collapsed to None → 0.
    """
    nested = tmp_path / "does_not_exist" / "either"
    assert not nested.exists()
    assert not nested.parent.exists()
    free = svc.get_available_space(nested)
    assert free is not None
    assert free == svc.get_available_space(tmp_path)


def test_get_available_space_no_existing_ancestor(
    monkeypatch: pytest.MonkeyPatch, svc: FileSystemService
) -> None:
    """When no ancestor exists at all, returns None (unknown), never 0."""
    monkeypatch.setattr(Path, "exists", lambda self: False)
    assert svc.get_available_space(Path("/totally/bogus/path")) is None


def test_get_available_space_tolerates_permission_error(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, svc: FileSystemService
) -> None:
    """Path.exists() raising (e.g. macOS TCC denial) degrades to None, not a crash."""

    def boom(self: Path) -> bool:
        raise PermissionError("operation not permitted")

    monkeypatch.setattr(Path, "exists", boom)
    assert svc.get_available_space(tmp_path) is None


# ------------------------------------------------------------------ #
# image_dimensions                                                      #
# ------------------------------------------------------------------ #


def test_image_dimensions_reads_resolution(tmp_path: Path) -> None:
    """Returns native (width, height) for a readable image."""
    Image = pytest.importorskip("PIL.Image")
    img = tmp_path / "photo.jpg"
    Image.new("RGB", (800, 600), (1, 2, 3)).save(img, format="JPEG")
    assert image_dimensions(img) == (800, 600)


def test_image_dimensions_unreadable_returns_none(tmp_path: Path) -> None:
    """A missing or non-image file yields None rather than raising."""
    assert image_dimensions(tmp_path / "missing.jpg") is None
    junk = tmp_path / "junk.jpg"
    junk.write_bytes(b"not an image")
    assert image_dimensions(junk) is None
