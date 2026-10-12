"""AI tagging orchestrator.

Turns a media file into a short list of descriptive tag strings, merging two
independent sources:

1. **Deterministic metadata** — photo EXIF GPS or a video's ISO 6709 location,
   reverse-geocoded offline (bundled GeoNames extract) to a place and country,
   and the camera's ``SceneCaptureType`` flag (Landscape / Portrait / Night).
   These are metadata-derived hints, not proof of image content or an exact
   location. They require no model inference.

2. **SigLIP zero-shot ML** — the configured :class:`~app.services.ai.base_tagger.AITagger`
   scores the user-supplied label vocabulary against the image (or a sample of
   video keyframes).  For videos, a label must appear in at least
   ``_MIN_FRAME_VOTES`` frames to qualify, preventing brief transient content
   from polluting the tag list.

Both sources are strictly best-effort: any failure yields an empty contribution
rather than aborting a sort.  The service is *synchronous* and is invoked from
``SortingService._process_file``, which already runs per-file work in a worker
thread.
"""

from __future__ import annotations

import contextlib
import re
import subprocess
from pathlib import Path
from typing import Any

from app.core.concepts import CATALOG
from app.core.config import Config
from app.core.logging_config import get_logger
from app.core.rules import normalized_key
from app.services.ai.base_tagger import AITagger, build_tagger
from app.services.ai.encoder_protocol import VisionEncoder
from app.services.ai.geo_lookup import GeoDataError, nearest_place, valid_coordinate
from app.services.filesystem_service import open_image
from app.utils.ffmpeg_utils import (
    extract_frame,
    probe_duration,
    run_ffprobe_json,
    sample_fractions,
)
from app.utils.media_utils import is_image, is_video

logger = get_logger(__name__)

# Keyframes sampled per video. Each frame is a separate CLIP call, so 5 gives
# good scene-change coverage without excessive processing time.
_VIDEO_FRAME_SAMPLES = 5

# Minimum number of frames a label must appear in to be included in the final
# video tag list.  Requiring ≥ 2 of 5 frames means a label must persist across
# ≥ 40 % of the clip — enough to exclude objects that flash by for a single
# keyframe.
_MIN_FRAME_VOTES = 2


# --------------------------------------------------------------------------- #
# EXIF / GPS helpers (module-level so they are easily unit-tested)            #
# --------------------------------------------------------------------------- #


def _gps_to_decimal(dms: Any, ref: str) -> float | None:
    """Convert a DMS tuple and hemisphere ref to a signed decimal degree."""
    if not dms or len(dms) < 3:
        return None
    try:
        d, m, s = float(dms[0]), float(dms[1]), float(dms[2])
        decimal = d + m / 60.0 + s / 3600.0
        if ref in ("S", "W"):
            decimal = -decimal
        return decimal
    except Exception:
        return None


_ISO6709 = re.compile(r"^([+-]\d{1,2}(?:\.\d+)?)([+-]\d{1,3}(?:\.\d+)?)")


def _parse_iso6709(value: object) -> tuple[float, float] | None:
    """Read the decimal-degree prefix of an ISO 6709 string (``+48.8577+002.2950/``)."""
    if not isinstance(value, str):
        return None
    match = _ISO6709.match(value.strip())
    if match is None:
        return None
    return float(match.group(1)), float(match.group(2))


def _video_coordinate(path: Path) -> tuple[float, float] | None:
    """The recording location QuickTime/MP4 containers store as ISO 6709, if any."""
    try:
        data = run_ffprobe_json(path, "format_tags")
    except (OSError, subprocess.TimeoutExpired) as exc:
        logger.debug("Video location probe failed", error=type(exc).__name__)
        return None
    tags = ((data or {}).get("format") or {}).get("tags") or {}
    for key in ("com.apple.quicktime.location.ISO6709", "location"):
        coordinate = _parse_iso6709(tags.get(key))
        if coordinate is not None:
            return coordinate
    return None


# --------------------------------------------------------------------------- #
# Service                                                                      #
# --------------------------------------------------------------------------- #


class AITaggingService:
    """Produce descriptive tags for a media file via the configured provider."""

    def __init__(self, config: Config, embedder: VisionEncoder | None = None) -> None:
        self._config = config
        self._max_tags = max(0, int(config.ai_tagging_max_tags))
        self._embedder = embedder
        self._provider: AITagger | None = None
        self._provider_built = False
        self._geo_warned = False

    def for_operation(self, config: Config) -> AITaggingService:
        """Reuse the loaded encoder while freezing config and locale for one operation."""
        return AITaggingService(config, self._embedder)

    def _get_provider(self) -> AITagger | None:
        """Build (once) and cache the configured tagger, or ``None`` if unusable."""
        if not self._provider_built:
            self._provider = build_tagger(self._config, self._embedder)
            self._provider_built = True
        return self._provider

    def tag_file(self, path: Path) -> list[str]:
        """Return up to ``ai_tagging_max_tags`` descriptive tags for *path*.

        Merges deterministic EXIF/GPS tags (always attempted for images) with
        CLIP zero-shot tags (when a provider is available).  Never raises.
        """
        if not self._config.ai_tagging_enabled or self._max_tags <= 0:
            return []

        # Step 1: deterministic metadata tags (GPS + scene mode).
        scored: list[tuple[str, float]] = list(self._exif_tags(path))
        if is_video(path) and self._config.ai_location_tags_enabled:
            scored.extend(self._location_tags(_video_coordinate(path)))

        # Step 2: CLIP-based ML tags.
        provider = self._get_provider()
        if provider is not None:
            try:
                if is_image(path):
                    scored.extend(self._tag_image(provider, path))
                elif is_video(path):
                    scored.extend(self._tag_video(provider, path))
            except Exception as exc:  # pragma: no cover - defensive catch-all
                logger.warning("AI tagging failed", path=str(path), error=str(exc))

        if not scored:
            return []

        # Deduplicate keeping the highest score per label (EXIF score=1.0 wins
        # over any CLIP probability for the same label), then rank and cap.
        seen: dict[str, tuple[str, float]] = {}
        for label, score in scored:
            key = normalized_key(label)
            previous = seen.get(key)
            if previous is None or score > previous[1]:
                seen[key] = (label, score)
        return [
            label
            for label, _ in sorted(seen.values(), key=lambda pair: pair[1], reverse=True)[
                : self._max_tags
            ]
        ]

    # ------------------------------------------------------------------ #
    # EXIF / GPS metadata tags                                             #
    # ------------------------------------------------------------------ #

    def _exif_tags(self, path: Path) -> list[tuple[str, float]]:
        """Extract deterministic tags from image EXIF data.

        Sources:
        * GPS IFD → offline reverse geocode → city name + country code.
        * ``SceneCaptureType`` → ``"landscape"`` / ``"portrait"`` / ``"night"``.

        Returns ``[]`` for non-images, images without relevant EXIF, or on any
        read error.
        """
        if not is_image(path):
            return []
        tags: list[tuple[str, float]] = []
        try:
            from PIL import Image as PILImage

            with PILImage.open(path) as img:
                exif = img.getexif()

                # GPS → city name (offline, no network)
                gps_ifd = exif.get_ifd(34853) if 34853 in exif else {}
                if gps_ifd:
                    lat = _gps_to_decimal(gps_ifd.get(2), gps_ifd.get(1, "N"))
                    lon = _gps_to_decimal(gps_ifd.get(4), gps_ifd.get(3, "E"))
                    if lat is not None and lon is not None:
                        tags.extend(self._location_tags((lat, lon)))

                # Camera scene mode lives in the Exif sub-IFD, not IFD0.
                # This is a recorded camera setting, not proof of image content.
                _SCENE_TAGS = {1: "landscape", 2: "portrait", 3: "night"}
                scene_ifd = exif.get_ifd(34665) if 34665 in exif else {}
                scene_key = scene_ifd.get(41990)  # SceneCaptureType
                scene = _SCENE_TAGS.get(scene_key) if isinstance(scene_key, int) else None
                if scene:
                    tags.append(
                        (
                            CATALOG.localized_label(scene, self._config.language) or scene,
                            1.0,
                        )
                    )

        except Exception:
            pass
        return tags

    def _location_tags(self, coordinate: tuple[float, float] | None) -> list[tuple[str, float]]:
        """Place and localized country name for *coordinate*, or nothing.

        Score 1.0 gives metadata priority; it is not a calibrated probability.
        Coordinates are never logged: they are personal data.
        """
        if (
            not self._config.ai_location_tags_enabled
            or coordinate is None
            or not valid_coordinate(*coordinate)
        ):
            return []
        try:
            place = nearest_place(*coordinate)
        except GeoDataError as exc:
            if not self._geo_warned:
                self._geo_warned = True
                logger.warning("Location tags unavailable", reason=str(exc))
            return []
        if place is None:
            return []
        tags = [(place.name, 1.0)]
        country = place.country_name(self._config.language)
        if normalized_key(country) != normalized_key(place.name):
            tags.append((country, 1.0))
        return tags

    # ------------------------------------------------------------------ #
    # ML-based tagging                                                     #
    # ------------------------------------------------------------------ #

    def _tag_image(self, provider: AITagger, path: Path) -> list[tuple[str, float]]:
        with open_image(path) as img:
            if img is None:
                return []
            return provider.tag(img)

    def _tag_video(self, provider: AITagger, path: Path) -> list[tuple[str, float]]:
        """Sample keyframes and return labels that appear in ≥ _MIN_FRAME_VOTES frames.

        Max-pooling across all frames (the old approach) allowed a label to be
        included if it appeared in only one frame, so a brief flash of a face in
        an outdoor clip could produce a "portrait" tag.  Voting filters that out:
        a label must be consistent across a significant fraction of the clip.
        """
        duration = probe_duration(path)
        if duration is None or duration <= 0:
            return []
        votes: dict[str, list[float]] = {}
        for frac in sample_fractions(_VIDEO_FRAME_SAMPLES):
            frame = extract_frame(path, duration * frac)
            if frame is None:
                continue
            try:
                for label, score in provider.tag(frame):
                    votes.setdefault(label, []).append(score)
            finally:
                with contextlib.suppress(Exception):
                    frame.close()
        # Keep only labels that appear in enough frames; rank by peak score.
        return [
            (label, max(scores))
            for label, scores in votes.items()
            if len(scores) >= _MIN_FRAME_VOTES
        ]
