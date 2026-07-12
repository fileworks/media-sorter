"""Tests for app.utils.path_utils helpers."""

import sys
from pathlib import Path

import pytest

from app.utils.path_utils import is_excluded_by_pattern, sanitize_path_segment


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
