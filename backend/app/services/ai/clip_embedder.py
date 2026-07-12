"""Shared, lazily-loaded CLIP image+text embedder (fastembed / ONNX).

Both AI tagging (:mod:`app.services.ai.base_tagger`) and Smart Categorization
(:mod:`app.services.ai.category_classifier_service`) score images against text
labels with the same CLIP model. Loading that model twice would double the
memory footprint and the first-run download, so this component owns the single
process-wide model pair and is shared via the DI container.

The heavy ``fastembed`` import and model construction are lazy, so neither
CI/tests nor the cloud-only tagging path require onnxruntime. ``image_model`` /
``text_model`` may be injected for testing (any object exposing
``embed(iterable) -> iterator`` of ``numpy`` vectors), avoiding a real download.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.core.logging_config import get_logger
from app.services.ai.encoder_protocol import VisionEncoder

if TYPE_CHECKING:
    from PIL.Image import Image

logger = get_logger(__name__)

# CLIP's trained logit scale (exp(0.07⁻¹) ≈ 100) — kept for backward-compat
# imports; tagger/categoriser now read the slope from the encoder instance.
LOGIT_SCALE = 100.0


def _upright_rgb(image: Image) -> Image:
    """Return *image* with its EXIF orientation applied and converted to RGB.

    Best-effort: any failure falls back to the original image so embedding is
    never blocked by a quirky file.
    """
    from PIL import ImageOps

    try:
        img = ImageOps.exif_transpose(image)
    except Exception:
        img = image
    if img is None:  # pragma: no cover - exif_transpose only returns None in-place mode
        img = image
    if img.mode != "RGB":
        try:
            img = img.convert("RGB")
        except Exception:
            return image
    return img


def _clip_cache_dir() -> Path | None:
    """Resolve where fastembed should find/cache the CLIP model.

    Order: explicit ``MEDIASORT_CLIP_MODEL_DIR`` → the ``clip/`` resource bundled
    next to the frozen backend (PyInstaller release) → ``None`` (let fastembed use
    its own cache and download on first use, the dev/desktop path).
    """
    env = os.environ.get("MEDIASORT_CLIP_MODEL_DIR")
    if env:
        return Path(env)
    if getattr(sys, "frozen", False):
        candidate = Path(sys.executable).resolve().parent.parent / "clip"
        if candidate.is_dir():
            return candidate
    return None


class ClipEmbedder(VisionEncoder):
    """Lazy, process-wide CLIP ViT-B/32 embedder backed by fastembed ("Lite" tier).

    ``embed_image`` / ``embed_texts`` return raw (un-normalised) ``numpy``
    vectors, or ``None`` when the model is unavailable. ``embed_texts`` memoises
    by the exact tuple of input strings, so a fixed label/category set is encoded
    once and only recomputed when the list changes.

    Extends :class:`~app.services.ai.encoder_protocol.VisionEncoder` so tagging
    and categorization can accept either this or a future SigLIP encoder without
    caring about the concrete class.
    """

    _IMAGE_MODEL = "Qdrant/clip-ViT-B-32-vision"
    _TEXT_MODEL = "Qdrant/clip-ViT-B-32-text"

    def __init__(self, image_model: Any | None = None, text_model: Any | None = None) -> None:
        self._image_model: Any = image_model
        self._text_model: Any = text_model
        self._load_failed = False
        self._text_cache: dict[tuple[str, ...], Any] = {}

    def _ensure_models(self) -> bool:
        """Lazily construct the fastembed CLIP models. Returns False if unavailable."""
        if self._image_model is not None and self._text_model is not None:
            return True
        if self._load_failed:
            return False
        try:
            from fastembed import ImageEmbedding, TextEmbedding

            cache = _clip_cache_dir()
            cache_dir = str(cache) if cache is not None else None
            if self._image_model is None:
                self._image_model = ImageEmbedding(self._IMAGE_MODEL, cache_dir=cache_dir)
            if self._text_model is None:
                self._text_model = TextEmbedding(self._TEXT_MODEL, cache_dir=cache_dir)
            return True
        except Exception as exc:  # pragma: no cover - depends on optional dep
            self._load_failed = True
            logger.warning(
                "Local CLIP model unavailable; AI tagging/categorization disabled",
                error=str(exc),
            )
            return False

    @property
    def model_id(self) -> str:
        return "clip-vit-b-32"

    @property
    def tagger_slope(self) -> float:
        return LOGIT_SCALE

    @property
    def categorize_scale(self) -> float:
        return 40.0

    @property
    def available(self) -> bool:
        """True if the CLIP model can be loaded (or was injected)."""
        return self._ensure_models()

    def embed_image(self, image: Image) -> Any | None:
        """Return the CLIP embedding for *image*, or ``None`` if unavailable.

        The image is first normalised to upright RGB: phone photos record their
        rotation in EXIF rather than baking it into the pixels, and CLIP embeds a
        sideways frame poorly, so applying the EXIF orientation (and converting
        non-RGB modes) measurably improves match quality.
        """
        if not self._ensure_models():
            return None
        import numpy as np

        embs = list(self._image_model.embed([_upright_rgb(image)]))
        if not embs:
            return None
        return np.asarray(embs[0], dtype=np.float32)

    def embed_texts(self, texts: list[str]) -> Any | None:
        """Return a ``(len(texts), dim)`` matrix of text embeddings, or ``None``.

        Memoised by the tuple of *texts* so a stable vocabulary is encoded once.
        """
        if not self._ensure_models():
            return None
        import numpy as np

        key = tuple(texts)
        cached = self._text_cache.get(key)
        if cached is None:
            embs = list(self._text_model.embed(list(texts)))
            cached = np.asarray(embs, dtype=np.float32)
            self._text_cache[key] = cached
        return cached
