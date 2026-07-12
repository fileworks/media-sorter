"""Media-type detection helpers and the canonical file-extension registries.

This module is the single source of truth for which extensions count as images,
videos, or "media" (either). ``FileSystemService`` re-exports the three frozensets
so existing ``from app.services.filesystem_service import IMAGE_EXTENSIONS`` imports
keep working; new code should import the ``is_*`` helpers from here directly.

All checks are case-insensitive (the suffix is lowercased before comparison), so
callers never need to pre-normalise the path.
"""

from pathlib import Path
from typing import Literal

IMAGE_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".jpg",
        ".jpeg",
        ".jpe",
        ".jfif",
        ".png",
        ".tif",
        ".tiff",
        ".raw",
        ".arw",
        ".cr2",
        ".cr3",
        ".crw",
        ".dng",
        ".erf",
        ".kdc",
        ".mef",
        ".mrw",
        ".nef",
        ".nrw",
        ".orf",
        ".pef",
        ".ptx",
        ".r3d",
        ".raf",
        ".rw2",
        ".rwl",
        ".sr2",
        ".srf",
        ".srw",
        ".x3f",
        ".bmp",
        ".gif",
        ".heic",
        ".heif",
        ".ico",
        ".jp2",
        ".j2k",
        ".jpf",
        ".jpx",
        ".psd",
        ".svg",
        ".tga",
        ".webp",
        ".avif",
        ".jxl",
    }
)

VIDEO_EXTENSIONS: frozenset[str] = frozenset(
    {
        ".mp4",
        ".m4v",
        ".mov",
        ".avi",
        ".mkv",
        ".wmv",
        ".flv",
        ".f4v",
        ".webm",
        ".qt",
        ".mpg",
        ".mpeg",
        ".mpe",
        ".m2v",
        ".m2ts",
        ".mts",
        ".ts",
        ".3gp",
        ".3g2",
        ".asf",
        ".divx",
        ".dv",
        ".mxf",
        ".ogv",
        ".rm",
        ".rmvb",
        ".vob",
        ".xvid",
    }
)

MEDIA_EXTENSIONS: frozenset[str] = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS


def is_image(path: Path) -> bool:
    """Return True if *path* has an image extension (case-insensitive)."""
    return path.suffix.lower() in IMAGE_EXTENSIONS


def is_video(path: Path) -> bool:
    """Return True if *path* has a video extension (case-insensitive)."""
    return path.suffix.lower() in VIDEO_EXTENSIONS


def is_media(path: Path) -> bool:
    """Return True if *path* has an image or video extension (case-insensitive)."""
    return path.suffix.lower() in MEDIA_EXTENSIONS


def get_file_type(path: Path) -> Literal["image", "video", "unknown"]:
    """Return ``"image"``, ``"video"``, or ``"unknown"`` for *path* by extension."""
    suffix = path.suffix.lower()
    if suffix in IMAGE_EXTENSIONS:
        return "image"
    if suffix in VIDEO_EXTENSIONS:
        return "video"
    return "unknown"


def is_size_included(size_bytes: int, min_kb: int | None, max_mb: int | None) -> bool:
    """Return True if *size_bytes* falls within the configured size bounds.

    ``None`` on either bound means that bound is not enforced.  Uses
    ``is not None`` guards (not falsy checks) so that a ``min_kb=0`` or
    ``max_mb=0`` limit is honoured correctly.

    This is the single source of truth previously duplicated as an inline
    check in ``FileSystemService._walk`` and as a private
    ``AnalysisService._size_excluded`` helper.
    """
    if min_kb is not None and size_bytes < min_kb * 1024:
        return False
    return not (max_mb is not None and size_bytes > max_mb * 1024 * 1024)
