"""Media routes — on-demand thumbnails, file info, and visual diffs.

Backs the preview hover card, the full-size preview modal, and the duplicate
comparison view. Everything here works on the user's own local files; the
backend is localhost-only, so reading an arbitrary local path is by design.
"""

import asyncio
import contextlib
import io
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Query, Response
from PIL import Image, ImageChops, ImageOps
from pydantic import BaseModel

from app.api.deps import ContainerDep
from app.core.exceptions import UnsupportedMediaError
from app.services.filesystem_service import (
    IMAGE_EXTENSIONS,
    VIDEO_EXTENSIONS,
    image_dimensions,
    open_image,
)
from app.utils.ffmpeg_utils import extract_frame, probe_duration, run_ffprobe_json

router = APIRouter()


class MediaInfoResponse(BaseModel):
    width: int | None
    height: int | None
    file_size: int | None
    extracted_date: str | None
    metadata_source: str
    media_type: str


# Default longest-edge size of generated thumbnails, in pixels. Small enough to
# render instantly in a hover card and cheap to encode. Callers can request a
# larger size (e.g. for the full preview modal) via the `size` query param.
_THUMB_MAX_PX = 160

# Hard bounds on the requested thumbnail edge so a stray/huge value can't make
# the backend allocate an enormous bitmap.
_THUMB_MIN_PX = 16
_THUMB_LIMIT_PX = 2048


def _encode_thumbnail(img: Image.Image, s: int) -> bytes | None:
    """Encode *img* as a JPEG thumbnail with longest edge *s* pixels. Never raises."""
    try:
        img = ImageOps.exif_transpose(img) or img
        rgb = img.convert("RGB")
        rgb.thumbnail((s, s), resample=Image.Resampling.LANCZOS)
        buf = io.BytesIO()
        rgb.save(buf, format="JPEG", quality=85)
        return buf.getvalue()
    except Exception:
        return None


def _render_thumbnail(path_str: str, size: int = _THUMB_MAX_PX) -> bytes | None:
    """Return a JPEG thumbnail for an image or video file, or None.

    Images are decoded directly; videos seek to 10 % of duration (capped at
    1 s) and extract a keyframe via ffmpeg. PIL's ``thumbnail`` never upscales.
    Returns None for unsupported types, missing files, or unreadable content.
    Never raises.
    """
    s = max(_THUMB_MIN_PX, min(size, _THUMB_LIMIT_PX))
    path = Path(path_str)
    if not path.is_file():
        return None
    suffix = path.suffix.lower()
    if suffix in IMAGE_EXTENSIONS:
        with open_image(path) as img:
            if img is None:
                return None
            return _encode_thumbnail(img, s)
    if suffix in VIDEO_EXTENSIONS:
        duration = probe_duration(path)
        t = min(1.0, (duration or 0.0) * 0.1)
        frame = extract_frame(path, t)
        if frame is None:
            return None
        try:
            return _encode_thumbnail(frame, s)
        finally:
            with contextlib.suppress(Exception):
                frame.close()
    return None


@router.get("/thumbnail")
async def thumbnail(
    path: str = Query(...),
    size: int = Query(default=_THUMB_MAX_PX),
) -> Response:
    """Return a JPEG thumbnail for a local image or video file.

    Backs the preview hover tooltip, the duplicate comparison view, and the
    full image-preview modal. The ``size`` query param is the longest-edge
    pixel size the client wants rendered (clamped to a sane range); pass ~2× the
    CSS display size for crisp HiDPI output. Videos seek to 10 % of duration
    (capped at 1 s) for the keyframe. Unreadable or unsupported files yield 415
    so the client can fall back to a placeholder. The backend is localhost-only
    and works on the user's own files, so reading an arbitrary local path here
    is by design — there is no other origin.
    """
    data = await asyncio.to_thread(_render_thumbnail, path, size)
    if data is None:
        raise UnsupportedMediaError("No thumbnail available for this file", file_path=path)
    return Response(
        content=data,
        media_type="image/jpeg",
        headers={"Cache-Control": "private, max-age=3600"},
    )


# ------------------------------------------------------------------ #
# File info (resolution + size + date)                                 #
# ------------------------------------------------------------------ #


def _video_dimensions(path: Path) -> "tuple[int, int] | None":
    """Return ``(width, height)`` of a video's first video stream via ffprobe.

    Returns None when ffprobe is unavailable, the file has no video stream, or
    the probe fails — callers treat that as "resolution unknown".
    """
    try:
        data = run_ffprobe_json(path, "stream=width,height", select_streams="v:0")
        if data is None:
            return None
        streams = data.get("streams", [])
        if not streams:
            return None
        w, h = streams[0].get("width"), streams[0].get("height")
        if not w or not h:
            return None
        return int(w), int(h)
    except Exception:
        return None


def _media_info(path_str: str, extraction_service: Any) -> dict[str, Any]:
    """Gather displayable metadata for a single local file.

    Returns resolution (width/height in px), byte size, and the extracted date +
    its source, so the preview/compare UIs can show the same details for any
    file — including a duplicate's stored "original", which the preview item
    itself carries no metadata for. Never raises; missing fields come back null.
    """
    path = Path(path_str)
    info: dict[str, Any] = {
        "width": None,
        "height": None,
        "file_size": None,
        "extracted_date": None,
        "metadata_source": "none",
        "media_type": "other",
    }
    if not path.is_file():
        return info

    with contextlib.suppress(OSError):
        info["file_size"] = path.stat().st_size

    suffix = path.suffix.lower()
    dims: tuple[int, int] | None = None
    if suffix in IMAGE_EXTENSIONS:
        info["media_type"] = "image"
        dims = image_dimensions(path)
    elif suffix in VIDEO_EXTENSIONS:
        info["media_type"] = "video"
        dims = _video_dimensions(path)
    if dims is not None:
        info["width"], info["height"] = dims

    # Date + source, mirroring the preview pipeline (sanity-check off: this is a
    # read-only display of the file's own metadata, not a sort decision).
    try:
        extr = extraction_service.extract_detailed(path, check_suspicious=False)
        if extr.extracted_date is not None:
            info["extracted_date"] = str(extr.extracted_date)
        info["metadata_source"] = extr.source
    except Exception:
        pass

    return info


@router.get("/media/info", response_model=MediaInfoResponse)
async def media_info(container: ContainerDep, path: str = Query(...)) -> MediaInfoResponse:
    """Return resolution, size, and extracted date/source for a local file.

    Powers the resolution readout in the hover card, preview modal, and both
    panes of the duplicate comparison (the "original" side has no preview item,
    so its details are fetched here).
    """
    info = await asyncio.to_thread(_media_info, path, container.extraction_service)
    return MediaInfoResponse(**info)


# ------------------------------------------------------------------ #
# Visual diff (duplicate comparison)                                   #
# ------------------------------------------------------------------ #

# Longest edge of the rendered diff image. Big enough to spot regional
# differences, small enough to encode quickly.
_DIFF_MAX_PX = 768


def _render_diff(a_str: str, b_str: str, size: int = _DIFF_MAX_PX) -> bytes | None:
    """Render a difference heat-map between two images as a PNG.

    Both images are fit to a common box (the first image's aspect ratio, longest
    edge *size*), the second aligned onto the first, and their per-pixel absolute
    difference is amplified and colourised: identical regions stay near-black,
    differences glow. Returns None when either file is not a readable image.
    """
    s = max(_THUMB_MIN_PX, min(size, _THUMB_LIMIT_PX))
    a_path, b_path = Path(a_str), Path(b_str)
    if a_path.suffix.lower() not in IMAGE_EXTENSIONS:
        return None
    if b_path.suffix.lower() not in IMAGE_EXTENSIONS:
        return None
    with open_image(a_path) as ia, open_image(b_path) as ib:
        if ia is None or ib is None:
            return None
        try:
            ia = ImageOps.exif_transpose(ia) or ia
            ib = ImageOps.exif_transpose(ib) or ib
            ra = ia.convert("RGB")
            rb = ib.convert("RGB")
            ra.thumbnail((s, s), resample=Image.Resampling.LANCZOS)
            # Align the comparison image onto the reference's dimensions so the
            # diff is pixel-for-pixel even when resolutions differ.
            rb = rb.resize(ra.size, resample=Image.Resampling.LANCZOS)
            diff = ImageChops.difference(ra, rb).convert("L")
            # Amplify ×4 (clamped) so subtle but real differences are visible
            # without turning JPEG re-compression noise into a solid wash.
            amplified = diff.point(lambda p: min(255, p * 4))
            heat = ImageOps.colorize(
                amplified, black=(12, 14, 24), mid=(120, 30, 90), white=(255, 70, 140)
            )
            buf = io.BytesIO()
            heat.save(buf, format="PNG")
            return buf.getvalue()
        except Exception:
            return None


@router.get("/media/diff")
async def media_diff(
    a: str = Query(...),
    b: str = Query(...),
    size: int = Query(default=_DIFF_MAX_PX),
) -> Response:
    """Return a PNG heat-map of the pixel differences between images *a* and *b*.

    Backs the duplicate comparison's "view diff" toggle. 415 when either path is
    not a readable image (e.g. a video), so the client can hide the affordance.
    """
    data = await asyncio.to_thread(_render_diff, a, b, size)
    if data is None:
        raise UnsupportedMediaError("Cannot diff these files")
    return Response(
        content=data,
        media_type="image/png",
        headers={"Cache-Control": "private, max-age=3600"},
    )
