"""AI tagging providers.

A small pluggable family of *synchronous* taggers. Each provider turns a single
image into a ranked list of ``(label, score)`` pairs (score in ``0..1``):

* :class:`LocalClipTagger` — offline CLIP zero-shot via ``fastembed`` (ONNX
  Runtime, no torch, no API key). The default, free, privacy-preserving option.
  Scores the user-supplied label vocabulary against the image.
* :class:`AzureVisionTagger` — Azure AI Vision Image Analysis (free F0 tier).
* :class:`ImaggaTagger` — Imagga tagging API (free hobby tier).
* :class:`GoogleCloudVisionTagger` — Google Cloud Vision ``LABEL_DETECTION``
  (free 1,000/mo), authenticated with a plain API key.

Taggers are intentionally synchronous: the sort pipeline already runs per-file
work in a worker thread (``asyncio.to_thread``), so blocking onnxruntime / HTTP
calls fit naturally without any event-loop juggling.

:func:`build_tagger` resolves the configured provider, returning ``None`` (with a
logged reason) when tagging is disabled or required credentials are missing — so
a misconfiguration degrades to "no AI tags" rather than breaking a sort.
"""

from __future__ import annotations

import base64
import io
from abc import ABC, abstractmethod
from typing import TYPE_CHECKING, Any

import httpx

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

# Tagger HTTP calls are short; keep a generous-but-bounded timeout.
_HTTP_TIMEOUT = 30.0
# Cap the uploaded/inferred image's longest edge to keep payloads (and cloud
# cost) small without hurting tag quality.
_MAX_IMAGE_DIM = 1024


def _image_to_jpeg_bytes(image: Image, max_dim: int = _MAX_IMAGE_DIM, quality: int = 85) -> bytes:
    """Downscale *image* to ``<= max_dim`` on its longest edge and encode as JPEG."""
    from PIL import Image as PILImage

    img = image.convert("RGB") if image.mode != "RGB" else image
    longest = max(img.size)
    if longest > max_dim:
        scale = max_dim / float(longest)
        new_size = (max(1, round(img.width * scale)), max(1, round(img.height * scale)))
        img = img.resize(new_size, PILImage.Resampling.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


class AITagger(ABC):
    """Abstract base for AI tagging providers."""

    @abstractmethod
    def tag(self, image: Image) -> list[tuple[str, float]]:
        """Return ``(label, score)`` pairs for *image*, already thresholded.

        Scores are normalised to ``0..1`` and the list is sorted by descending
        score. Implementations must never raise for an expected failure (network
        error, bad credentials, unreadable image) — they log and return ``[]``.
        """


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
    ) -> None:
        self._labels = [lbl.strip() for lbl in labels if lbl.strip()]
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

        from app.services.ai.prompts import ANCHOR_PROMPTS, category_prompts, pool_normalized

        prompts: list[str] = []
        sizes: list[int] = []
        for lbl in self._labels:
            group = category_prompts(lbl)
            prompts.extend(group)
            sizes.append(len(group))
        anchors = list(ANCHOR_PROMPTS)
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
# Cloud providers                                                               #
# --------------------------------------------------------------------------- #


class AzureVisionTagger(AITagger):
    """Azure AI Vision Image Analysis ('tags' feature). Free F0 tier ≈ 5,000/mo."""

    _API_VERSION = "2024-02-01"

    def __init__(self, endpoint: str, api_key: str, threshold: float = 0.2) -> None:
        self._endpoint = endpoint.rstrip("/")
        self._api_key = api_key
        self._threshold = threshold

    def tag(self, image: Image) -> list[tuple[str, float]]:
        try:
            payload = _image_to_jpeg_bytes(image)
            url = f"{self._endpoint}/computervision/imageanalysis:analyze"
            resp = httpx.post(
                url,
                params={"api-version": self._API_VERSION, "features": "tags"},
                headers={
                    "Ocp-Apim-Subscription-Key": self._api_key,
                    "Content-Type": "application/octet-stream",
                },
                content=payload,
                timeout=_HTTP_TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()
            values = (data.get("tagsResult") or {}).get("values") or []
            out: list[tuple[str, float]] = []
            for v in values:
                name = v.get("name")
                conf = float(v.get("confidence", 0.0))
                if name and conf >= self._threshold:
                    out.append((str(name), conf))
            out.sort(key=lambda p: p[1], reverse=True)
            return out
        except Exception as exc:
            logger.warning("Azure Vision tagging failed", error=str(exc))
            return []


class ImaggaTagger(AITagger):
    """Imagga tagging API. Free hobby tier ≈ 1,000/mo. Auth: key + secret."""

    _URL = "https://api.imagga.com/v2/tags"

    def __init__(self, api_key: str, api_secret: str, threshold: float = 0.2) -> None:
        self._auth = (api_key, api_secret)
        self._threshold = threshold

    def tag(self, image: Image) -> list[tuple[str, float]]:
        try:
            payload = _image_to_jpeg_bytes(image)
            resp = httpx.post(
                self._URL,
                files={"image": ("image.jpg", payload, "image/jpeg")},
                auth=self._auth,
                timeout=_HTTP_TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()
            tags = (data.get("result") or {}).get("tags") or []
            out: list[tuple[str, float]] = []
            for t in tags:
                name = (t.get("tag") or {}).get("en")
                conf = float(t.get("confidence", 0.0)) / 100.0  # Imagga reports 0..100
                if name and conf >= self._threshold:
                    out.append((str(name), conf))
            out.sort(key=lambda p: p[1], reverse=True)
            return out
        except Exception as exc:
            logger.warning("Imagga tagging failed", error=str(exc))
            return []


class GoogleCloudVisionTagger(AITagger):
    """Google Cloud Vision LABEL_DETECTION via a plain API key. Free ≈ 1,000/mo."""

    _URL = "https://vision.googleapis.com/v1/images:annotate"

    def __init__(self, api_key: str, threshold: float = 0.2, max_results: int = 20) -> None:
        self._api_key = api_key
        self._threshold = threshold
        self._max_results = max_results

    def tag(self, image: Image) -> list[tuple[str, float]]:
        try:
            payload = _image_to_jpeg_bytes(image)
            content = base64.b64encode(payload).decode("ascii")
            body = {
                "requests": [
                    {
                        "image": {"content": content},
                        "features": [{"type": "LABEL_DETECTION", "maxResults": self._max_results}],
                    }
                ]
            }
            resp = httpx.post(
                self._URL,
                params={"key": self._api_key},
                json=body,
                timeout=_HTTP_TIMEOUT,
            )
            resp.raise_for_status()
            data = resp.json()
            responses = data.get("responses") or [{}]
            labels = responses[0].get("labelAnnotations") or []
            out: list[tuple[str, float]] = []
            for lbl in labels:
                name = lbl.get("description")
                conf = float(lbl.get("score", 0.0))
                if name and conf >= self._threshold:
                    out.append((str(name), conf))
            out.sort(key=lambda p: p[1], reverse=True)
            return out
        except Exception as exc:
            logger.warning("Google Cloud Vision tagging failed", error=str(exc))
            return []


# --------------------------------------------------------------------------- #
# Factory                                                                       #
# --------------------------------------------------------------------------- #


def build_tagger(config: Config, embedder: VisionEncoder | None = None) -> AITagger | None:
    """Build the configured tagger, or ``None`` when unusable.

    Returns ``None`` (logging the reason) when AI tagging is disabled or the
    selected provider is missing its required credentials, so callers can treat
    "no tagger" as simply "no AI tags". When the ``local`` provider is selected,
    the shared *embedder* (if given) is reused so the CLIP model loads only once
    across AI tagging and Smart Categorization.
    """
    if not config.ai_tagging_enabled:
        return None

    provider = (config.ai_tagging_provider or "local").lower()
    threshold = config.ai_tagging_confidence_threshold

    if provider == "local":
        if embedder is None:
            # The shared encoder is built by the factory, which returns None when
            # the hardware tier is "off" or the model is unavailable. Honour that
            # here instead of silently fabricating a fresh ClipEmbedder and
            # loading the very model the user opted out of.
            logger.info("Local AI tagging selected but no encoder available; AI tagging disabled")
            return None
        return LocalClipTagger(
            labels=config.ai_tagging_labels, threshold=threshold, embedder=embedder
        )

    if provider == "azure_vision":
        if config.ai_tagging_endpoint and config.ai_tagging_api_key:
            return AzureVisionTagger(
                endpoint=config.ai_tagging_endpoint,
                api_key=config.ai_tagging_api_key,
                threshold=threshold,
            )
        logger.warning("Azure Vision selected but endpoint/api_key missing; AI tagging disabled")
        return None

    if provider == "imagga":
        if config.ai_tagging_api_key and config.ai_tagging_api_secret:
            return ImaggaTagger(
                api_key=config.ai_tagging_api_key,
                api_secret=config.ai_tagging_api_secret,
                threshold=threshold,
            )
        logger.warning("Imagga selected but api_key/api_secret missing; AI tagging disabled")
        return None

    if provider == "google_cloud_vision":
        if config.ai_tagging_api_key:
            return GoogleCloudVisionTagger(api_key=config.ai_tagging_api_key, threshold=threshold)
        logger.warning("Google Vision selected but api_key missing; AI tagging disabled")
        return None

    logger.warning("Unknown ai_tagging_provider %r; AI tagging disabled", provider)
    return None
