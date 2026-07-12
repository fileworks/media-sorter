"""VisionEncoder protocol — the shared contract for image+text encoders.

Both AI tagging (:mod:`app.services.ai.base_tagger`) and Smart Categorization
(:mod:`app.services.ai.category_classifier_service`) need only the three methods
below; they are completely agnostic about *which* model backs the encoder.

Encoder-specific calibration constants (``tagger_slope``, ``categorize_scale``)
travel with the encoder rather than being hardcoded in the consumers, because
different model families have different cosine-similarity scales.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from PIL.Image import Image


class VisionEncoder:
    """Structural base / Protocol for image+text encoders.

    Concrete implementations: :class:`~app.services.ai.clip_embedder.ClipEmbedder`
    (CLIP ViT-B/32 via fastembed — "Lite" tier) and the future
    ``SiglipOnnxEncoder`` ("Standard" / "Max" tier).

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
        """Sigmoid sharpness for the per-label tagging scorer.

        CLIP ViT-B/32: 100.0 (trained logit scale).
        SigLIP 2: lower value (~10–20) because SigLIP's cosine scores are
        already sharper; recalibrate after the model swap.
        """
        return 100.0

    @property
    def categorize_scale(self) -> float:
        """Softmax temperature for the Smart Categorization classifier.

        CLIP ViT-B/32: 40.0 (empirically tuned).
        SigLIP 2: needs recalibration once the swap lands.
        """
        return 40.0

    def embed_image(self, image: Image) -> Any | None:
        """Return a 1-D float32 numpy array for *image*, or ``None``."""
        return None

    def embed_texts(self, texts: list[str]) -> Any | None:
        """Return a ``(len(texts), dim)`` float32 numpy matrix, or ``None``."""
        return None
