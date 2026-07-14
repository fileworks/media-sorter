"""Filesystem service — file enumeration, safe copy/move, and path helpers."""

import asyncio
import contextlib
import os
import shutil
from collections.abc import Callable, Iterator
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

from app.core.exceptions import InsufficientStorageError, SortingError

if TYPE_CHECKING:
    from PIL.Image import Image
from app.core.logging_config import get_logger

# The media extension registries live in app.utils.media_utils (the single source
# of truth). They are re-exported here — via the redundant ``as`` alias so they
# stay explicit re-exports under mypy --strict — because many modules and tests
# import them from this service. New code should import the ``is_*`` helpers
# straight from app.utils.media_utils.
from app.utils.media_utils import (
    IMAGE_EXTENSIONS as IMAGE_EXTENSIONS,
)
from app.utils.media_utils import (
    MEDIA_EXTENSIONS as MEDIA_EXTENSIONS,
)
from app.utils.media_utils import (
    VIDEO_EXTENSIONS as VIDEO_EXTENSIONS,
)
from app.utils.media_utils import (
    is_media,
    is_size_included,
)
from app.utils.path_utils import is_excluded_by_pattern

logger = get_logger(__name__)

_CHUNK = 1024 * 1024  # 1 MB

# Subset of IMAGE_EXTENSIONS that need pillow-heif to open.
HEIC_EXTENSIONS: frozenset[str] = frozenset({".heic", ".heif"})

# Subset of IMAGE_EXTENSIONS that are RAW camera formats (decoded via rawpy).
RAW_EXTENSIONS: frozenset[str] = frozenset(
    {
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
    }
)


# Bucketing for type-breakdown charts (Analysis "by_type" and Report
# "files_per_type"). Everything not bucketed here falls through to its bare
# extension so webp/tiff/mkv/webm/avif/etc. stay distinct rather than lumping
# into one "other".
_JPEG_BUCKET: frozenset[str] = frozenset({".jpg", ".jpeg", ".jpe", ".jfif"})
_MP4_BUCKET: frozenset[str] = frozenset({".mp4", ".m4v"})
_MOV_BUCKET: frozenset[str] = frozenset({".mov", ".qt"})
_PNG_BUCKET: frozenset[str] = frozenset({".png"})
_HEIC_BUCKET: frozenset[str] = frozenset({".heic", ".heif"})
_GIF_BUCKET: frozenset[str] = frozenset({".gif"})


def categorize_media_type(suffix: str) -> str:
    """Map a file extension to a coarse type bucket for breakdown charts.

    Single source of truth shared by AnalysisService and ReportService so the
    Analysis and Report type breakdowns never diverge.
    """
    s = suffix.lower()
    if s in _JPEG_BUCKET:
        return "jpeg"
    if s in _MP4_BUCKET:
        return "mp4"
    if s in _MOV_BUCKET:
        return "mov"
    if s in RAW_EXTENSIONS:
        return "raw"
    if s in _PNG_BUCKET:
        return "png"
    if s in _HEIC_BUCKET:
        return "heic"
    if s in _GIF_BUCKET:
        return "gif"
    if s.startswith("."):
        return s[1:] or "other"
    return s or "other"


def register_heif() -> None:
    """Register the pillow-heif opener with Pillow. Idempotent; safe to call repeatedly."""
    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
    except Exception:
        pass  # HEIC just won't be openable; callers handle None


def _open_raw(path: Path) -> "Image | None":
    """Decode a RAW file to a PIL.Image.

    Prefers the embedded JPEG thumbnail; falls back to a half-size demosaic.
    Returns None if rawpy is unavailable or the file is unreadable.
    """
    try:
        import io

        import rawpy
        from PIL import Image

        with rawpy.imread(str(path)) as raw:
            try:
                thumb = raw.extract_thumb()
                # rawpy>=0.27 stopped re-exporting ThumbFormat and types thumb.data
                # as bytes | ndarray; match by enum name and narrow to bytes (a JPEG
                # thumbnail's data is always bytes) so this stays mypy-clean across
                # rawpy versions without a type: ignore.
                if thumb.format.name == "JPEG" and isinstance(thumb.data, bytes):
                    return Image.open(io.BytesIO(thumb.data)).convert("RGB")
            except Exception:
                pass
            rgb = raw.postprocess(use_camera_wb=True, half_size=True, no_auto_bright=False)
            return Image.fromarray(rgb)
    except Exception as exc:
        logger.debug("_open_raw failed", path=str(path), error=str(exc))
        return None


@contextlib.contextmanager
def open_image(path: Path) -> "Iterator[Image | None]":
    """Yield a PIL.Image for *path* (HEIC and RAW included), or None if it cannot be opened.

    - HEIC/HEIF: via pillow-heif (registered on first use).
    - RAW: via rawpy → RGB → PIL.Image (heavier; only call when pixels are actually needed).
    - Everything else: PIL.Image.open.

    Always use as a context manager. The yielded image is closed on exit.
    Never raises — yields None on failure and logs at debug.
    """
    suffix = path.suffix.lower()
    img: Image | None = None
    try:
        if suffix in HEIC_EXTENSIONS:
            register_heif()
            from PIL import Image

            img = Image.open(path)
        elif suffix in RAW_EXTENSIONS:
            img = _open_raw(path)
        else:
            from PIL import Image

            img = Image.open(path)
        yield img
    except Exception as exc:
        logger.debug("open_image failed", path=str(path), error=str(exc))
        yield None
    finally:
        if img is not None:
            with contextlib.suppress(Exception):
                img.close()


def load_exif_dict(path: Path) -> "dict[str, Any] | None":
    """Return a piexif-format EXIF dict for *path*, or None if unavailable.

    The single shared EXIF-blob loader (date extraction, camera detection and
    format conversion all need it): routes through ``open_image`` so HEIC
    (pillow-heif) and RAW (rawpy) sources work, strips the ``Exif\\x00\\x00``
    prefix pillow-heif adds, and falls back to piexif's own container parsing
    for files whose EXIF lives outside Pillow's ``info["exif"]``.

    Never raises — returns None on any failure.
    """
    try:
        import piexif

        raw_exif = b""
        with open_image(path) as img:
            if img is not None:
                raw_exif = img.info.get("exif", b"") or b""
        if raw_exif:
            if raw_exif[:6] == b"Exif\x00\x00":
                raw_exif = raw_exif[6:]
            return cast("dict[str, Any]", piexif.load(raw_exif))
        return cast("dict[str, Any]", piexif.load(str(path)))
    except Exception as exc:
        logger.debug("load_exif_dict failed", path=str(path), error=str(exc))
        return None


def image_dimensions(path: Path) -> "tuple[int, int] | None":
    """Return ``(width, height)`` of an image in pixels, or None if unreadable.

    Reads dimensions without a full pixel decode where possible:
    - RAW: rawpy's ``sizes`` reports the native sensor resolution (the demosaiced
      pixels), not the half-size preview ``open_image`` yields, so the displayed
      resolution is the real one.
    - HEIC/HEIF: via pillow-heif (registered on first use).
    - Everything else: ``PIL.Image.open`` reads the header only.

    Never raises — returns None on any failure.
    """
    suffix = path.suffix.lower()
    if suffix in RAW_EXTENSIONS:
        try:
            import rawpy

            with rawpy.imread(str(path)) as raw:
                s = raw.sizes
                return int(s.width), int(s.height)
        except Exception as exc:
            logger.debug("image_dimensions (raw) failed", path=str(path), error=str(exc))
            # Fall through to the PIL path (some RAWs carry a readable preview).
    try:
        if suffix in HEIC_EXTENSIONS:
            register_heif()
        from PIL import Image

        with Image.open(path) as img:
            return int(img.width), int(img.height)
    except Exception as exc:
        logger.debug("image_dimensions failed", path=str(path), error=str(exc))
        return None


def find_available_filename(path: Path) -> Path:
    """Return *path* if it doesn't exist; otherwise append _001, _002, …

    Module-level helper so ConversionService (and others) can import it
    without needing a FileSystemService instance.
    """
    if not path.exists():
        return path
    stem, suffix, parent = path.stem, path.suffix, path.parent
    counter = 1
    while True:
        candidate = parent / f"{stem}_{counter:03d}{suffix}"
        if not candidate.exists():
            return candidate
        counter += 1


def validate_source_directory(directory: str | None) -> Path:
    """Return the source root, or raise a message the user can act on.

    ``list_files`` answers "no files" for a directory that does not exist, which
    is the right answer for a generic lister and the wrong one for a sort run:
    an unplugged external drive or an unmounted network share would otherwise
    finish with a green tick and "0 files sorted", which reads as "my library is
    empty" rather than "MediaSorter never saw it".
    """
    if not directory or not directory.strip():
        raise SortingError("No source folder is set — choose one in Settings, then sort.")
    root = Path(directory)
    if not root.exists():
        raise SortingError(
            f"Source folder not found: {root}. If it lives on an external drive or a "
            "network share, check that it is plugged in and mounted."
        )
    if not root.is_dir():
        raise SortingError(f"The source path is a file, not a folder: {root}.")
    if not os.access(root, os.R_OK | os.X_OK):
        raise SortingError(f"Source folder cannot be read (permission denied): {root}.")
    return root


def validate_target_directory(directory: str | None) -> Path:
    """Return the destination root, creating it if needed, or raise a clear error.

    An unset destination would resolve to ``Path("")`` — the working directory —
    and scatter the user's library wherever the app happened to be launched from.
    """
    if not directory or not directory.strip():
        raise SortingError("No destination folder is set — choose one in Settings, then sort.")
    root = Path(directory)
    if root.exists() and not root.is_dir():
        raise SortingError(f"The destination path is a file, not a folder: {root}.")
    try:
        root.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise SortingError(f"Destination folder cannot be created: {root} ({exc}).") from exc
    if not os.access(root, os.W_OK):
        raise SortingError(f"Destination folder is not writable (permission denied): {root}.")
    return root


class FileSystemService:
    MEDIA_EXTENSIONS = MEDIA_EXTENSIONS

    # ------------------------------------------------------------------ #
    # File enumeration                                                      #
    # ------------------------------------------------------------------ #

    async def list_files(
        self,
        directory: str,
        recursive: bool = True,
        max_depth: int | None = None,
        exclude_patterns: list[str] | None = None,
        min_file_size_kb: int | None = None,
        max_file_size_mb: int | None = None,
        counters: dict[str, int] | None = None,
    ) -> list[Path]:
        """Return all media files under *directory* that pass the given filters.

        If *counters* is provided (e.g. ``{"skipped": 0}``), the "skipped" key
        is incremented for every media file excluded by a pattern or size filter.
        This allows callers to report the true excluded count without changing
        the return type.
        """
        root = Path(directory)
        if not root.exists():
            return []
        results: list[Path] = []
        # The recursive walk is pure blocking syscalls (iterdir/stat); run it in
        # a worker thread so a large or network-mounted library never freezes
        # the event loop (and with it progress polling and the log WebSocket).
        await asyncio.to_thread(
            self._walk,
            root,
            root,
            recursive,
            max_depth,
            0,
            results,
            exclude_patterns or [],
            min_file_size_kb,
            max_file_size_mb,
            counters,
        )
        return results

    def _walk(
        self,
        root: Path,
        current: Path,
        recursive: bool,
        max_depth: int | None,
        depth: int,
        results: list[Path],
        exclude_patterns: list[str],
        min_file_size_kb: int | None = None,
        max_file_size_mb: int | None = None,
        counters: dict[str, int] | None = None,
    ) -> None:
        try:
            entries = sorted(current.iterdir())
        except PermissionError:
            logger.warning("Permission denied scanning directory", path=str(current))
            return
        for entry in entries:
            if entry.is_file() and is_media(entry):
                # Check exclusion
                if exclude_patterns and is_excluded_by_pattern(entry, root, exclude_patterns):
                    logger.debug("Excluded file", path=str(entry))
                    if counters is not None:
                        counters["skipped"] = counters.get("skipped", 0) + 1
                    continue
                # Check size filters
                try:
                    size = entry.stat().st_size
                    if not is_size_included(size, min_file_size_kb, max_file_size_mb):
                        too_small = min_file_size_kb is not None and size < min_file_size_kb * 1024
                        logger.debug(
                            "Skipping file",
                            reason="small" if too_small else "large",
                            path=str(entry),
                            size=size,
                        )
                        if counters is not None:
                            counters["skipped"] = counters.get("skipped", 0) + 1
                        continue
                except OSError:
                    pass
                results.append(entry)
            elif entry.is_dir() and recursive and not entry.name.startswith("."):
                # Check directory exclusion
                if exclude_patterns and is_excluded_by_pattern(entry, root, exclude_patterns):
                    logger.debug("Excluded directory", path=str(entry))
                    continue
                if max_depth is None or depth < max_depth:
                    self._walk(
                        root,
                        entry,
                        recursive,
                        max_depth,
                        depth + 1,
                        results,
                        exclude_patterns,
                        min_file_size_kb,
                        max_file_size_mb,
                        counters,
                    )

    # ------------------------------------------------------------------ #
    # Safe copy / move                                                      #
    # ------------------------------------------------------------------ #

    def safe_copy(
        self,
        source: Path,
        destination: Path,
        on_progress: Callable[[int, int], None] | None = None,
        verify: bool = True,
    ) -> None:
        """Copy *source* to *destination* in 1 MB chunks with optional size verification."""
        if not source.exists():
            raise SortingError(f"Source not found: {source}")

        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise SortingError(
                f"Could not create destination directory {destination.parent}: {exc}"
            ) from exc

        source_size = source.stat().st_size
        available = shutil.disk_usage(destination.parent).free
        if available < source_size:
            raise InsufficientStorageError(
                f"Not enough space in {destination.parent}: "
                f"need {source_size} B, have {available} B",
                available=available,
                required=source_size,
            )

        try:
            bytes_copied = 0
            with source.open("rb") as src, destination.open("wb") as dst:
                while True:
                    chunk = src.read(_CHUNK)
                    if not chunk:
                        break
                    dst.write(chunk)
                    bytes_copied += len(chunk)
                    if on_progress:
                        on_progress(bytes_copied, source_size)

            if verify:
                dest_size = destination.stat().st_size
                if dest_size != source_size:
                    destination.unlink(missing_ok=True)
                    raise SortingError(
                        f"Verification failed for {source.name}: "
                        f"expected {source_size} B, got {dest_size} B"
                    )

            logger.debug(
                "File copied",
                source=str(source),
                dest=str(destination),
                bytes=source_size,
            )

        except SortingError:
            raise
        except OSError as exc:
            destination.unlink(missing_ok=True)
            raise SortingError(f"Copy failed for {source}: {exc}") from exc

    def safe_move(self, source: Path, destination: Path) -> None:
        """Move *source* to *destination* — rename when possible, else copy+delete.

        On the same volume ``os.rename`` is atomic and free (no byte copy); it
        fails with EXDEV across filesystems, where we fall back to the verified
        copy-then-delete. Callers pre-pick a collision-free destination via
        ``find_available_filename``, so rename never silently overwrites in
        practice.
        """
        if not source.exists():
            raise SortingError(f"Source not found: {source}")
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            raise SortingError(
                f"Could not create destination directory {destination.parent}: {exc}"
            ) from exc
        try:
            source.rename(destination)
            logger.debug("File moved (rename)", source=str(source), dest=str(destination))
            return
        except OSError:
            pass  # Cross-device (EXDEV) or filesystem quirk — fall back to copy.
        self.safe_copy(source, destination, verify=True)
        try:
            source.unlink()
        except OSError as exc:
            raise SortingError(f"Could not remove source after copy {source}: {exc}") from exc
        logger.debug("File moved", source=str(source), dest=str(destination))

    # ------------------------------------------------------------------ #
    # Directory helpers                                                     #
    # ------------------------------------------------------------------ #

    def create_directory_structure(
        self,
        base_path: Path,
        date: datetime,
        criteria: list[str],
    ) -> Path:
        """Return (and create) a date-based subdirectory under *base_path*.

        criteria elements: "year", "month", "day" in any subset.
        """
        parts: list[str] = []
        if "year" in criteria:
            parts.append(str(date.year))
        if "month" in criteria:
            parts.append(f"{date.month:02d}")
        if "day" in criteria:
            parts.append(f"{date.day:02d}")

        final = base_path.joinpath(*parts) if parts else base_path
        final.mkdir(parents=True, exist_ok=True)
        return final

    def find_available_filename(self, path: Path) -> Path:
        """Return *path* if it doesn't exist; otherwise append _001, _002, …"""
        return find_available_filename(path)

    # ------------------------------------------------------------------ #
    # Disk helpers                                                          #
    # ------------------------------------------------------------------ #

    def get_available_space(self, path: Path) -> int | None:
        """Return free bytes on the volume holding *path*'s nearest existing ancestor.

        A destination folder often does not exist yet — it is created during the
        sort — and may be several levels deep. Resolving to the nearest existing
        ancestor (the path itself if it exists, else the first existing parent)
        yields the free space of the volume the new folder will live on.

        Returns ``None`` when no ancestor exists or ``disk_usage`` raises (e.g. a
        permission denial), so callers can degrade to an "unknown" state rather
        than mistaking ``0`` for an empty volume.
        """
        ancestor: Path | None = None
        for candidate in (path, *path.parents):
            try:
                if candidate.exists():
                    ancestor = candidate
                    break
            except OSError:
                # Path.exists() can raise (e.g. PermissionError under macOS TCC);
                # keep walking up — an accessible ancestor may still exist.
                continue
        if ancestor is None:
            logger.warning("No existing ancestor for free-space check", path=str(path))
            return None
        try:
            return shutil.disk_usage(ancestor).free
        except (OSError, ValueError) as exc:
            logger.warning(
                "Could not read free space",
                path=str(path),
                ancestor=str(ancestor),
                error=str(exc),
            )
            return None
