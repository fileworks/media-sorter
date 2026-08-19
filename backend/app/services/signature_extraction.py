"""Pure media-signature extraction — a path in, facts out (`P2-DEDUP-D2`).

The catalog remembers signatures; this module does not know the catalog exists.
It reads one file and reports each fact as either *known* or *unknown with a
reason*. It never reports a fabricated zero: a width of ``0`` for a file whose
header could not be read would let "keep highest resolution" quietly discard
the only good copy (I-10).

Deciding what to persist, when to recompute, and how much CPU to spend belongs
to the writer (`P2-DEDUP-D3`) and the cost budget (`P2-DEDUP-D4`).
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

from app.core.duplicate_plans import FactValue
from app.core.logging_config import get_logger
from app.services.duplicate_service import DuplicateService
from app.services.extraction_service import DateExtractionService
from app.services.filesystem_service import image_dimensions, load_exif_dict
from app.utils.ffmpeg_utils import run_ffprobe_json
from app.utils.media_utils import is_image, is_video

logger = get_logger(__name__)

_UNSUPPORTED = "the file is neither a supported image nor a supported video"
_NO_PIXELS = "the pixels could not be decoded"
_NO_DIMENSIONS = "the dimensions could not be read"
_NO_CAMERA = "no camera make or model in the metadata"
_NO_CAPTURE = "no capture timestamp in the metadata"
_NO_MEAN_RGB = "the average colour could not be measured"
#: Not a failure — a scope boundary. A clip's perceptual identity is a series of
#: sampled frames (`DuplicateService.video_signature`), which is a different
#: shape from one hash and belongs to whoever persists it.
_VIDEO_FRAMES = "a video is fingerprinted by sampled frames, not by a single perceptual hash"


class MediaSignature(BaseModel):
    """The six facts one perceptual pass can learn about a file.

    Every field is a `FactValue`, so "unknown" is representable and is never
    confused with zero, empty or epoch.
    """

    model_config = ConfigDict(frozen=True)

    phash: FactValue = Field(default_factory=FactValue)
    mean_rgb: FactValue = Field(default_factory=FactValue)
    width: FactValue = Field(default_factory=FactValue)
    height: FactValue = Field(default_factory=FactValue)
    camera_model: FactValue = Field(default_factory=FactValue)
    captured_at: FactValue = Field(default_factory=FactValue)


def capture_time(path: Path) -> datetime | None:
    """The full capture timestamp, or None when the file does not carry one.

    EXIF times are naive and local to the camera; container times carry an
    offset. Both are returned exactly as the file states them — normalising one
    onto the other would invent a timezone the file never claimed.
    """
    if is_video(path):
        return _container_creation_time(path)
    return _exif_capture_time(path)


def extract_signature(
    path: Path,
    *,
    duplicates: DuplicateService | None = None,
    dates: DateExtractionService | None = None,
    cancel_token: Any = None,
) -> MediaSignature:
    """Read every perceptual and identifying fact available for one file.

    Never raises: an unreadable file yields a signature whose facts are all
    unknown, each carrying why.
    """
    image = is_image(path)
    video = is_video(path)
    if not image and not video:
        return MediaSignature(
            phash=FactValue.unknown(_UNSUPPORTED),
            mean_rgb=FactValue.unknown(_UNSUPPORTED),
            width=FactValue.unknown(_UNSUPPORTED),
            height=FactValue.unknown(_UNSUPPORTED),
            camera_model=FactValue.unknown(_UNSUPPORTED),
            captured_at=FactValue.unknown(_UNSUPPORTED),
        )

    phash, mean_rgb = (
        _image_signature(path, duplicates or DuplicateService(), cancel_token)
        if image
        else (FactValue.unknown(_VIDEO_FRAMES), FactValue.unknown(_VIDEO_FRAMES))
    )
    width, height = _dimensions(path, image=image)
    camera = (dates or DateExtractionService()).extract_camera_model(path)
    captured = capture_time(path)

    return MediaSignature(
        phash=phash,
        mean_rgb=mean_rgb,
        width=width,
        height=height,
        camera_model=FactValue.of(camera) if camera else FactValue.unknown(_NO_CAMERA),
        captured_at=(
            FactValue.of(captured.isoformat())
            if captured is not None
            else FactValue.unknown(_NO_CAPTURE)
        ),
    )


def _image_signature(
    path: Path, duplicates: DuplicateService, cancel_token: Any
) -> tuple[FactValue, FactValue]:
    signature = duplicates.image_signature(path, cancel_token=cancel_token)
    if signature is None:
        return FactValue.unknown(_NO_PIXELS), FactValue.unknown(_NO_PIXELS)
    mean = signature.mean_rgb
    return (
        FactValue.of(str(signature.phash)),
        FactValue.of([float(channel) for channel in mean])
        if mean is not None
        else FactValue.unknown(_NO_MEAN_RGB),
    )


def _dimensions(path: Path, *, image: bool) -> tuple[FactValue, FactValue]:
    size = image_dimensions(path) if image else _video_dimensions(path)
    if size is None:
        return FactValue.unknown(_NO_DIMENSIONS), FactValue.unknown(_NO_DIMENSIONS)
    width, height = size
    return FactValue.of(width), FactValue.of(height)


def _video_dimensions(path: Path) -> tuple[int, int] | None:
    data = run_ffprobe_json(path, "stream=width,height", select_streams="v:0")
    streams = (data or {}).get("streams") or []
    if not streams:
        return None
    stream = streams[0]
    try:
        return int(stream["width"]), int(stream["height"])
    except (KeyError, TypeError, ValueError) as exc:
        logger.debug("video dimensions unreadable", path=str(path), error=str(exc))
        return None


def _container_creation_time(path: Path) -> datetime | None:
    data = run_ffprobe_json(path, "format_tags=creation_time")
    raw = ((data or {}).get("format") or {}).get("tags", {}).get("creation_time")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError as exc:
        logger.debug("creation_time unparseable", path=str(path), error=str(exc))
        return None


def _exif_capture_time(path: Path) -> datetime | None:
    try:
        import piexif

        data = load_exif_dict(path)
        if data is None:
            return None
        for ifd, tag in (
            ("Exif", piexif.ExifIFD.DateTimeOriginal),
            ("Exif", piexif.ExifIFD.DateTimeDigitized),
            ("0th", piexif.ImageIFD.DateTime),
        ):
            raw = data.get(ifd, {}).get(tag)
            if raw:
                return datetime.strptime(raw.decode(), "%Y:%m:%d %H:%M:%S")
    except Exception:
        return None
    return None
