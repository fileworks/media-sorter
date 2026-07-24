"""Tests for app.utils.path_utils helpers."""

import subprocess
import sys
from pathlib import Path

import pytest

from app.core.exceptions import PathOverlapError
from app.utils.path_utils import (
    is_excluded_by_pattern,
    sanitize_path_segment,
    validate_source_target_overlap,
)


def test_empty_patterns_never_excludes() -> None:
    assert is_excluded_by_pattern(Path("/src/a/photo.jpg"), Path("/src"), []) is False


def test_matches_filename_glob() -> None:
    assert is_excluded_by_pattern(Path("/src/thumb.jpg"), Path("/src"), ["thumb.jpg"]) is True
    assert is_excluded_by_pattern(Path("/src/photo.jpg"), Path("/src"), ["*.tmp"]) is False


def test_matches_wildcard_glob() -> None:
    assert is_excluded_by_pattern(Path("/src/IMG.tmp"), Path("/src"), ["*.tmp"]) is True


def test_matches_any_intermediate_component() -> None:
    """A pattern matches against every path component, not just the filename."""
    p = Path("/src/2024/thumbnails/photo.jpg")
    assert is_excluded_by_pattern(p, Path("/src"), ["thumbnails"]) is True


def test_directory_component_not_matched_when_only_filename_pattern() -> None:
    p = Path("/src/album/photo.jpg")
    assert is_excluded_by_pattern(p, Path("/src"), ["*.raw"]) is False


def test_multiple_patterns_any_match() -> None:
    p = Path("/src/clip.mov")
    assert is_excluded_by_pattern(p, Path("/src"), ["*.tmp", "*.mov"]) is True


def test_path_outside_source_root_is_not_excluded() -> None:
    """relative_to() raising ValueError defensively returns False (not excluded)."""
    p = Path("/other/place/photo.jpg")
    assert is_excluded_by_pattern(p, Path("/src"), ["*.jpg"]) is False


@pytest.mark.skipif(
    sys.platform == "win32",
    reason="fnmatch is case-insensitive on Windows (os.path.normcase lowercases)",
)
def test_glob_is_case_sensitive_on_posix_semantics() -> None:
    """fnmatch is case-sensitive for explicit literals like this; document it."""
    p = Path("/src/PHOTO.JPG")
    assert is_excluded_by_pattern(p, Path("/src"), ["photo.jpg"]) is False
    assert is_excluded_by_pattern(p, Path("/src"), ["PHOTO.JPG"]) is True


def test_source_root_itself_has_no_components() -> None:
    """When path == source_root, there are no relative parts to match."""
    assert is_excluded_by_pattern(Path("/src"), Path("/src"), ["*"]) is False


# ------------------------------------------------------------------ #
# sanitize_path_segment                                                 #
# ------------------------------------------------------------------ #


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("food", "food"),
        ("  food  ", "food"),  # surrounding whitespace stripped
        ("my receipts", "my receipts"),  # internal space kept
        ("a/b", "ab"),  # path separators removed
        ("a\\b", "ab"),
        ("..", ""),  # pure traversal → empty
        ("../etc", "etc"),  # traversal neutralised, rest kept
        ("a..b", "ab"),  # interior traversal collapsed
        ("foo:bar", "foobar"),  # illegal Windows char removed
        ('a<b>c"d|e?f*g', "abcdefg"),  # all illegal chars removed
        ("...hidden", "hidden"),  # leading dots stripped
        ("trailing.", "trailing"),  # trailing dot stripped (invalid on Windows)
        ("a\t\nb", "ab"),  # control chars (incl. tab/newline) stripped entirely
        ("CON", ""),  # reserved device name rejected
        ("com1", ""),  # reserved, case-insensitive
        ("LPT9.txt", ""),  # reserved stem rejected even with extension
        ("company", "company"),  # not reserved (only exact device names)
        ("", ""),
        ("   ", ""),  # whitespace-only → empty
    ],
)
def test_sanitize_path_segment_cases(raw: str, expected: str) -> None:
    assert sanitize_path_segment(raw) == expected


def test_sanitize_path_segment_is_idempotent() -> None:
    once = sanitize_path_segment("../My Photos: 2024?")
    assert sanitize_path_segment(once) == once


def test_sanitize_path_segment_caps_length() -> None:
    out = sanitize_path_segment("x" * 200, max_length=64)
    assert len(out) == 64


def test_sanitize_path_segment_keeps_unicode() -> None:
    # Non-ASCII letters are valid in filenames and must be preserved.
    assert sanitize_path_segment("Münchën") == "Münchën"
    assert sanitize_path_segment("日本") == "日本"


# ------------------------------------------------------------------ #
# canonical source/destination identity                                 #
# ------------------------------------------------------------------ #


def test_rejects_equal_and_nested_paths(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    with pytest.raises(PathOverlapError):
        validate_source_target_overlap(source, source)
    with pytest.raises(PathOverlapError):
        validate_source_target_overlap(source, source / "new" / "target")

    parent = tmp_path / "library"
    nested_source = parent / "incoming"
    nested_source.mkdir(parents=True)
    with pytest.raises(PathOverlapError):
        validate_source_target_overlap(nested_source, parent)


def test_nonexistent_target_tail_is_canonicalized_and_siblings_are_allowed(
    tmp_path: Path,
) -> None:
    source = tmp_path / "media"
    source.mkdir()
    canonical_source, canonical_target = validate_source_target_overlap(
        source, tmp_path / "media-output" / "new"
    )
    assert canonical_source == source.resolve()
    assert canonical_target == (tmp_path / "media-output" / "new").resolve()


def test_symlink_alias_is_rejected(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    alias = tmp_path / "alias"
    try:
        alias.symlink_to(source, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks are unavailable")
    with pytest.raises(PathOverlapError):
        validate_source_target_overlap(source, alias)


@pytest.mark.skipif(sys.platform != "win32", reason="Windows path identity case")
def test_windows_case_alias_is_rejected(tmp_path: Path) -> None:
    source = tmp_path / "MixedCase"
    source.mkdir()
    with pytest.raises(PathOverlapError):
        validate_source_target_overlap(source, Path(str(source).swapcase()))


@pytest.mark.skipif(sys.platform != "win32", reason="Windows junction identity")
def test_windows_junction_alias_is_rejected(tmp_path: Path) -> None:
    source = tmp_path / "source"
    source.mkdir()
    junction = tmp_path / "junction"
    completed = subprocess.run(
        ["cmd", "/c", "mklink", "/J", str(junction), str(source)],
        capture_output=True,
        check=False,
    )
    if completed.returncode != 0:
        pytest.skip("junction creation is unavailable")
    with pytest.raises(PathOverlapError):
        validate_source_target_overlap(source, junction)
