"""Conversion service — image and video format conversion via PIL/ffmpeg."""

import subprocess
from pathlib import Path
from typing import Any

from app.core.logging_config import get_logger
from app.services.filesystem_service import find_available_filename, open_image

logger = get_logger(__name__)

# 1 hour — large/high-resolution video conversions can legitimately take this
# long; anything beyond it is treated as a hang and aborted.
_FFMPEG_TIMEOUT_SECONDS = 3600

_QUALITY_CRF = {"low": 28, "medium": 23, "high": 18}

_IMAGE_TARGETS = {"jpeg", "png", "webp", "tiff"}
_VIDEO_TARGETS = {"mp4", "mkv", "mov", "webm", "avi"}

# Extensions that are already in each target format — no conversion needed.
_IMAGE_FORMAT_EXTS: dict[str, set[str]] = {
    "jpeg": {".jpg", ".jpeg", ".jpe", ".jfif"},
    "png": {".png"},
    "webp": {".webp"},
    "tiff": {".tif", ".tiff"},
}
_VIDEO_FORMAT_EXTS: dict[str, set[str]] = {
    "mp4": {".mp4"},
    "mkv": {".mkv"},
    "mov": {".mov"},
    "webm": {".webm"},
    "avi": {".avi"},
}

# ffmpeg codec arguments per output container.
# video_args may contain the placeholder "{crf}" which is substituted at call time.
_VIDEO_CODECS: dict[str, tuple[list[str], list[str]]] = {
    "mp4": (
        ["-c:v", "libx264", "-crf", "{crf}", "-preset", "fast", "-pix_fmt", "yuv420p"],
        ["-c:a", "aac", "-b:a", "128k"],
    ),
    "mov": (
        ["-c:v", "libx264", "-crf", "{crf}", "-preset", "fast", "-pix_fmt", "yuv420p"],
        ["-c:a", "aac", "-b:a", "128k"],
    ),
    "mkv": (
        ["-c:v", "libx264", "-crf", "{crf}", "-preset", "fast", "-pix_fmt", "yuv420p"],
        ["-c:a", "aac", "-b:a", "128k"],
    ),
    "webm": (
        ["-c:v", "libvpx-vp9", "-crf", "{crf}", "-b:v", "0"],
        ["-c:a", "libopus", "-b:a", "128k"],
    ),
    "avi": (
        ["-c:v", "mpeg4", "-qscale:v", "4"],
        ["-c:a", "libmp3lame", "-q:a", "4"],
    ),
}


def _ext_for(fmt: str) -> str:
    """Return the canonical file extension (no dot) for a normalised target format name."""
    if fmt == "jpeg":
        return "jpg"
    if fmt == "tiff":
        return "tif"
    return fmt


def predicted_image_suffix(suffix: str, target_format: str) -> str:
    """Predict the suffix ``convert_image`` would leave a file with — pure.

    Mirrors the no-op rule exactly: a file already in the target format keeps
    its suffix (no re-encode); unknown target formats convert nothing.
    """
    fmt = target_format.lower()
    if fmt not in _IMAGE_TARGETS or suffix.lower() in _IMAGE_FORMAT_EXTS[fmt]:
        return suffix
    return "." + _ext_for(fmt)


def predicted_video_suffix(suffix: str, target_format: str) -> str:
    """Predict the suffix ``convert_video`` would leave a file with — pure."""
    fmt = target_format.lower()
    if fmt not in _VIDEO_TARGETS or suffix.lower() in _VIDEO_FORMAT_EXTS[fmt]:
        return suffix
    return "." + fmt


class ConversionService:
    def convert_image(
        self,
        source: Path,
        target_format: str,
        quality: int = 90,
        preserve_exif: bool = True,
    ) -> Path:
        """Convert *source* to *target_format* (jpeg/png/webp/tiff), including RAW/HEIC
        sources decoded via ``open_image``.

        Returns a NEW collision-free path on disk (caller is responsible for
        swapping it in place of the original), or *source* unchanged when the
        file is already in the target format (no-op).

        Raises:
            ValueError  — unknown *target_format*.
            RuntimeError — source cannot be opened or written.
        """
        from PIL import Image

        from app.services.metadata_service import MetadataService

        fmt = target_format.lower()
        if fmt not in _IMAGE_TARGETS:
            raise ValueError(
                f"Unsupported image_format: {target_format!r}. "
                f"Must be one of: {sorted(_IMAGE_TARGETS)}"
            )

        # No-op: already in the target format — skip re-encoding to avoid quality loss.
        if source.suffix.lower() in _IMAGE_FORMAT_EXTS[fmt]:
            return source

        dest = find_available_filename(source.with_suffix("." + _ext_for(fmt)))

        # JPEG and TIFF EXIF: load via piexif before opening the source image so we can
        # write it back after saving (piexif.insert supports both JPEG and TIFF containers).
        exif_dict = None
        if fmt in ("jpeg", "tiff") and preserve_exif:
            exif_dict = self._load_exif(source)

        with open_image(source) as img:
            if img is None:
                raise RuntimeError(f"Cannot open image: {source}")

            # For WebP: carry the raw EXIF bytes via Pillow's native exif= kwarg.
            # We do NOT use this for TIFF — passing JPEG-origin EXIF bytes to libtiff
            # triggers "Error setting from dictionary" for the EXIF IFD offset pointers.
            exif_bytes: bytes | None = None
            if preserve_exif and fmt == "webp":
                exif_bytes = img.info.get("exif")

            # Flatten alpha/palette to RGB on white for JPEG output.
            save_img = img
            if fmt == "jpeg" and img.mode in ("RGBA", "LA", "P"):
                background = Image.new("RGB", img.size, (255, 255, 255))
                alpha = img.split()[-1] if img.mode in ("RGBA", "LA") else None
                background.paste(img.convert("RGBA"), mask=alpha)
                save_img = background

            # Build save keyword arguments.
            pil_format = "JPEG" if fmt == "jpeg" else fmt.upper()
            save_kwargs: dict[str, Any] = {"format": pil_format}
            if fmt in ("jpeg", "webp"):
                save_kwargs["quality"] = quality
            if fmt == "webp" and exif_bytes:
                save_kwargs["exif"] = exif_bytes

            save_img.save(dest, **save_kwargs)

        # JPEG / TIFF EXIF: write via piexif after the file is fully closed.
        # piexif.insert supports both JPEG and TIFF containers.
        if fmt in ("jpeg", "tiff") and exif_dict and preserve_exif:
            MetadataService.write_exif(dest, exif_dict)

        if fmt == "png":
            logger.debug("PNG target drops EXIF", source=str(source), dest=str(dest))

        logger.info("Converted image", source=str(source), dest=str(dest), format=fmt)
        return dest

    def convert_video(
        self,
        source: Path,
        target_format: str,
        quality: str = "medium",
    ) -> Path:
        """Transcode *source* to *target_format* container using a sensible codec.

        Returns a NEW collision-free path, or *source* unchanged when the file
        is already in the target container (no-op).

        *quality* is one of ``"low"`` | ``"medium"`` | ``"high"``.

        Raises:
            ValueError   — unknown *target_format*.
            RuntimeError — ffmpeg not found or exited non-zero.
        """
        fmt = target_format.lower()
        if fmt not in _VIDEO_TARGETS:
            raise ValueError(
                f"Unsupported video_format: {target_format!r}. "
                f"Must be one of: {sorted(_VIDEO_TARGETS)}"
            )

        # No-op: already the target container.
        if source.suffix.lower() in _VIDEO_FORMAT_EXTS[fmt]:
            return source

        dest = find_available_filename(source.with_suffix("." + fmt))
        crf = str(_QUALITY_CRF.get(quality, _QUALITY_CRF["medium"]))

        video_args_template, audio_args = _VIDEO_CODECS[fmt]
        video_args = [a.replace("{crf}", crf) for a in video_args_template]

        cmd = ["ffmpeg", "-i", str(source)] + video_args + audio_args + ["-y", str(dest)]

        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=_FFMPEG_TIMEOUT_SECONDS,
            )
            if result.returncode != 0:
                logger.error("ffmpeg conversion failed", source=str(source), stderr=result.stderr)
                raise RuntimeError(f"ffmpeg exited {result.returncode}: {result.stderr[:200]}")

            logger.info("Converted video", source=str(source), dest=str(dest), format=fmt)
            return dest

        except subprocess.TimeoutExpired as exc:
            # Include the configured limit so logs reveal which threshold was hit.
            logger.error(
                "Video conversion timed out",
                source=str(source),
                timeout_seconds=exc.timeout,
            )
            raise
        except FileNotFoundError:
            raise RuntimeError("ffmpeg not found") from None

    @staticmethod
    def _load_exif(path: Path) -> dict[str, Any] | None:
        """Return a piexif-format dict for *path*, or None if unavailable.

        Delegates to the shared ``load_exif_dict`` loader so HEIC/RAW sources
        (whose EXIF lives behind pillow-heif/rawpy rather than in the raw file)
        keep their EXIF through RAW → JPEG and HEIC → JPEG conversions.
        """
        from app.services.filesystem_service import load_exif_dict

        return load_exif_dict(path)
