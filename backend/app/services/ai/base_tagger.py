"""AI tagging — local only.

Turns a single image into a ranked list of ``(label, score)`` pairs (score in
``0..1``) using :class:`LocalClipTagger`: offline CLIP/SigLIP zero-shot via
``fastembed`` (ONNX Runtime, no torch, no API key). It scores the user-supplied
label vocabulary against the image.

Tagging is deliberately local-only: no provider setting, no credentials, and no
code path that can send a photograph anywhere. That is a product decision, not
an omission — a self-hosted library should not need to trust a third party to
describe its own pictures, and a gate that merely *asks* before uploading is a
weaker guarantee than having nothing to upload with.

Taggers are intentionally synchronous: the sort pipeline already runs per-file
work in a worker thread (``asyncio.to_thread``), so blocking onnxruntime calls
fit naturally without any event-loop juggling.

:func:`build_tagger` returns ``None`` (with a logged reason) when tagging is
disabled or no encoder is available — so an unusable setup degrades to "no AI
tags" rather than breaking a sort.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

from app.core.concepts import Locale
from app.core.logging_config import get_logger
from app.services.ai.clip_embedder import ClipEmbedder
from app.services.ai.encoder_protocol import VisionEncoder

if TYPE_CHECKING:
    from PIL.Image import Image

    from app.core.config import Config

logger = get_logger(__name__)

# Per-label sigmoid slope for the local CLIP tagger. Tagging is inherently
# *multi-label* (a beach-sunset photo is legitimately "beach" AND "sunset" AND
# "sky"), so each label gets an INDEPENDENT probability rather than competing in
# one softmax — a softmax over 30-40 labels divides the budget so co-occurring
# tags fall below threshold. The probability is anchor-relative:
#
#     p(label) = sigmoid(TAGGER_SLOPE * (cos(label) - max cos(anchor)))
#
# i.e. how much better the label explains the image than a generic "a photo"
# background prompt. Anchoring on the image's own background cosine cancels the
# per-model cosine offset, so the gate needs no absolute, model-specific floor.
# Slope 100 was tuned on a sample set so a confident match reads ≈0.9 and a label
# at the background level reads ≈0.5 (the natural threshold).
TAGGER_SLOPE = 100.0


class AITagger(ABC):
    """Abstract base for AI tagging providers."""

    @abstractmethod
    def tag(self, image: Image) -> list[tuple[str, float]]:
        """Return ``(label, score)`` pairs for *image*, already thresholded.

        Scores are normalised to ``0..1`` and the list is sorted by descending
        score. Implementations must never raise for an expected failure (network
        error, bad credentials, unreadable image) — they log and return ``[]``.
        """

    @property
    def warnings(self) -> tuple[str, ...]:
        return ()


# --------------------------------------------------------------------------- #
# Local — CLIP zero-shot via fastembed                                          #
# --------------------------------------------------------------------------- #


class LocalClipTagger(AITagger):
    """Offline CLIP zero-shot tagger backed by a shared :class:`ClipEmbedder`.

    Scores the configured *labels* against the image using aligned CLIP image and
    text embeddings, then assigns each label an INDEPENDENT, anchor-relative
    probability (see :data:`TAGGER_SLOPE`) and keeps those meeting *threshold* —
    so legitimately co-occurring tags are all retained rather than competing in a
    single softmax. The label and background-anchor text embeddings are computed
    once and cached inside the embedder.

    A shared *embedder* may be injected (so AI tagging and Smart Categorization
    load the model only once). For tests, ``image_model`` / ``text_model`` can be
    passed instead — any object exposing ``embed(iterable) -> iterator`` of
    ``numpy`` vectors — and a private embedder is built around them, avoiding any
    real model download.
    """

    def __init__(
        self,
        labels: list[str],
        threshold: float = 0.5,
        embedder: VisionEncoder | None = None,
        image_model: Any | None = None,
        text_model: Any | None = None,
        locale: Locale = "en",
        bundled: bool = False,
    ) -> None:
        self._labels = [lbl.strip() for lbl in labels if lbl.strip()]
        self._locale = locale
        self._bundled = bundled
        self._threshold = threshold
        if embedder is None:
            embedder = ClipEmbedder(image_model=image_model, text_model=text_model)
        self._embedder = embedder
        self._text_emb_cache: tuple[Any, Any] | None = None

    def _text_embeddings(self) -> tuple[Any, Any] | None:
        """L2-normalised ``(label_vectors, anchor_vectors)`` as unit-row matrices.

        Labels use ``category_prompts`` (shared with Smart Categorization) so any
        that appear in DESCRIPTIONS — "screenshot", "beach", "portrait", etc. —
        get an enriched prompt alongside the standard template ensemble, sharpening
        their separation from visually similar concepts. The generic
        ``ANCHOR_PROMPTS`` ("a photo", …) form the background each label is scored
        *against*. Both are embedded in one cached call. Returns ``None`` when the
        embedder is unavailable. Result is cached on this instance since labels are
        fixed at construction time.
        """
        if self._text_emb_cache is not None:
            return self._text_emb_cache

        import numpy as np

        from app.services.ai.prompts import anchor_prompts, pool_normalized, prompt_group

        prompts: list[str] = []
        sizes: list[int] = []
        for lbl in self._labels:
            group = prompt_group(
                lbl,
                operation_locale=self._locale,
                model_id=self._embedder.model_id,
                bundled=self._bundled,
            )
            prompts.extend(group)
            sizes.append(len(group))
        anchors = list(anchor_prompts(self._locale, self._embedder.model_id))
        raw = self._embedder.embed_texts(prompts + anchors)
        if raw is None:
            return None
        raw_arr = np.asarray(raw, dtype=np.float32)
        split = len(prompts)
        label_vecs = pool_normalized(raw_arr[:split], sizes)
        anchor_vecs = pool_normalized(raw_arr[split:], [1] * len(anchors))
        result = label_vecs, anchor_vecs
        self._text_emb_cache = result
        return result

    def tag(self, image: Image) -> list[tuple[str, float]]:
        if not self._labels:
            return []
        try:
            import numpy as np

            img_raw = self._embedder.embed_image(image)
            if img_raw is None:
                return []
            vecs = self._text_embeddings()  # L2-normalised label + anchor matrices
            if vecs is None:
                return []
            label_n, anchor_n = vecs

            img_emb = np.asarray(img_raw, dtype=np.float32).reshape(1, -1)
            img_n = img_emb / (np.linalg.norm(img_emb, axis=1, keepdims=True) + 1e-8)

            label_sims = (img_n @ np.asarray(label_n, dtype=np.float32).T)[0]
            anchor_sims = (img_n @ np.asarray(anchor_n, dtype=np.float32).T)[0]
            # Background level: the best a generic "a photo" prompt explains this
            # image. A label only earns a tag by beating that baseline.
            background = float(anchor_sims.max()) if anchor_sims.size else 0.0

            # Independent per-label sigmoid (multi-label): co-occurring tags each
            # get their own probability instead of dividing one softmax budget.
            # Use the encoder's calibrated slope so different model families
            # (CLIP vs SigLIP) apply the right sharpness.
            slope = self._embedder.tagger_slope
            probs = 1.0 / (1.0 + np.exp(-slope * (label_sims - background)))

            scored = [
                (self._labels[i], float(probs[i]))
                for i in range(len(self._labels))
                if float(probs[i]) >= self._threshold
            ]
            scored.sort(key=lambda p: p[1], reverse=True)
            return scored
        except Exception as exc:
            logger.warning("Local CLIP inference failed", error=str(exc))
            return []


# --------------------------------------------------------------------------- #
# Factory                                                                       #
# --------------------------------------------------------------------------- #


def build_tagger(config: Config, embedder: VisionEncoder | None = None) -> AITagger | None:
    """Build the local tagger, or ``None`` when unusable.

    Returns ``None`` (logging the reason) when AI tagging is disabled or no
    encoder is available, so callers can treat "no tagger" as simply "no AI
    tags". The shared *embedder* (if given) is reused so the CLIP/SigLIP model
    loads only once across AI tagging and Smart Categorization.

    There is one provider by design. Tagging runs entirely on this machine, so
    there is no credential to misconfigure and no image that can leave it.
    """
    if not config.ai_tagging_enabled:
        return None

    if embedder is None:
        # The shared encoder is built by the factory, which returns None when
        # the hardware tier is "off" or the model is unavailable. Honour that
        # here instead of silently fabricating a fresh ClipEmbedder and
        # loading the very model the user opted out of.
        logger.info("AI tagging is enabled but no encoder is available; AI tagging disabled")
        return None

    return LocalClipTagger(
        labels=config.resolved_ai_tagging_labels(),
        threshold=config.ai_tagging_confidence_threshold,
        embedder=embedder,
        locale=config.language,
        bundled=config.ai_tagging_labels_provenance == "bundled",
    )
