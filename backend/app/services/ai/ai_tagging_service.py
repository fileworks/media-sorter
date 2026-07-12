"""AI tagging orchestrator.

Turns a media file into a short list of descriptive tag strings, merging two
independent sources:

1. **Deterministic EXIF metadata** — GPS coordinates reverse-geocoded offline to
   a city name, and the camera's ``SceneCaptureType`` flag (Landscape / Portrait /
   Night).  These run for every image regardless of the configured ML provider;
   they are always accurate and require no inference time.

2. **CLIP zero-shot ML** — the configured :class:`~app.services.ai.base_tagger.AITagger`
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
from pathlib import Path
from typing import Any

from app.core.config import Config
from app.core.logging_config import get_logger
from app.services.ai.base_tagger import AITagger, build_tagger
from app.services.ai.encoder_protocol import VisionEncoder
from app.services.filesystem_service import open_image
from app.utils.ffmpeg_utils import extract_frame, probe_duration, sample_fractions
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


def _geocode_tags(lat: float, lon: float) -> list[tuple[str, float]]:
    """Return location tags for *(lat, lon)* via offline reverse geocoding.

    Uses ``reverse_geocoder`` (bundled GeoNames dataset, ~26 MB, no network
    needed at runtime).  Returns an empty list if the package is not installed
    or geocoding fails for any reason.

    Tags returned: lowercased city name and, when distinct, the 2-letter
    ISO country code.  Both carry score 1.0 — they are exact facts, not
    probabilities.
    """
    try:
        import reverse_geocoder

        results = reverse_geocoder.search([(lat, lon)], mode=1, verbose=False)
        if not results:
            return []
        r = results[0]
        city = (r.get("name") or "").strip().lower()
        cc = (r.get("cc") or "").strip().lower()
        tags: list[tuple[str, float]] = []
        if city:
            tags.append((city, 1.0))
        if cc and cc != city:
            tags.append((cc, 1.0))
        return tags
    except ImportError:
        return []
    except Exception:
        return []


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
        if self._max_tags <= 0:
            return []

        # Step 1: deterministic EXIF metadata tags (GPS + scene mode).
        scored: list[tuple[str, float]] = list(self._exif_tags(path))

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
        seen: dict[str, float] = {}
        for label, score in scored:
            if score > seen.get(label, -1.0):
                seen[label] = score
        return [
            label
            for label, _ in sorted(seen.items(), key=lambda p: p[1], reverse=True)[: self._max_tags]
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
                gps_ifd = exif.get_ifd(34853)  # 34853 = GPSInfo IFD tag
                if gps_ifd:
                    lat = _gps_to_decimal(gps_ifd.get(2), gps_ifd.get(1, "N"))
                    lon = _gps_to_decimal(gps_ifd.get(4), gps_ifd.get(3, "E"))
                    if lat is not None and lon is not None:
                        tags.extend(_geocode_tags(lat, lon))

                # Camera scene capture mode (set by the camera, not user-editable)
                _SCENE_TAGS = {1: "landscape", 2: "portrait", 3: "night"}
                scene_key = exif.get(41990)  # 41990 = SceneCaptureType
                scene = _SCENE_TAGS.get(scene_key) if isinstance(scene_key, int) else None
                if scene:
                    tags.append((scene, 1.0))

        except Exception:
            pass
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
