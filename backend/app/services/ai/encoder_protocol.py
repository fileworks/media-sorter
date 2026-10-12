"""VisionEncoder protocol — the shared contract for image+text encoders.

Both AI tagging (:mod:`app.services.ai.base_tagger`) and Smart Categorization
(:mod:`app.services.ai.category_classifier_service`) need only the three methods
below; they are completely agnostic about *which* model backs the encoder.

Encoder-specific calibration (``tagger_slope``, ``tagger_offset``,
``categorize_scale``, ``categorize_floor``)
travel with the encoder rather than being hardcoded in the consumers, because
different model families have different cosine-similarity scales.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from PIL.Image import Image


class VisionEncoder:
    """Structural base / Protocol for image+text encoders.

    The shipped implementation is ``SiglipOnnxEncoder``; tests inject small
    deterministic encoders through the same interface.

    Both tagging and categorization call only ``embed_image`` / ``embed_texts``;
    they never import the concrete class — enabling a clean model swap.
    """

    @property
    def available(self) -> bool:
        """True if the model can produce embeddings right now."""
        return False

    @property
    def model_id(self) -> str:
        """Short, stable identifier (used for logging and bundle naming)."""
        return "unknown"

    @property
    def tagger_slope(self) -> float:
        """Sigmoid sharpness for the per-label, anchor-relative tagging scorer.

        Calibrated per model family; the shipped SigLIP 2 encoder uses 40.
        """
        return 100.0

    def tagger_offset(self, locale: str) -> float:
        """Extra cosine a label must gain over the generic background, per language.

        Calibrated on held-out fixtures (``scripts/evaluate_local_ai.py``).
        """
        return 0.0

    @property
    def categorize_scale(self) -> float:
        """Softmax temperature for Smart Categorization: the model's logit scale."""
        return 40.0

    @property
    def categorize_floor(self) -> float:
        """Cosine the winning category must reach; below it nothing fits clearly."""
        return -1.0

    def embed_image(self, image: Image) -> Any | None:
        """Return a 1-D float32 numpy array for *image*, or ``None``."""
        return None

    def embed_texts(self, texts: list[str]) -> Any | None:
        """Return a ``(len(texts), dim)`` float32 numpy matrix, or ``None``.

        The matrix may be read-only; consumers copy before modifying it.
        """
        return None
