"""Factory for building the local vision encoder based on config + hardware.

The local encoder is shared between AI tagging and Smart Categorization.
This factory owns the tier→encoder mapping and keeps both consumers unaware
of which concrete encoder is running.

Tier → encoder:
  off      → returns None (AI callers must treat None encoder as disabled)
  lite     → ClipEmbedder (CLIP ViT-B/32 via fastembed — small, always available)
  standard → SiglipOnnxEncoder (SigLIP 2 base/16 @256, onnxruntime), CLIP fallback
  max      → SiglipOnnxEncoder (same weights, accelerator EP preferred), CLIP fallback

SigLIP 2 is a substantially stronger zero-shot encoder than CLIP ViT-B/32 at the
exact image↔text-label task both features use (~79% vs ~63% zero-shot ImageNet).
It downloads on first use (~100 MB/tower quantised) and, if onnxruntime/weights
are unavailable or the model fails to load, the factory transparently falls back
to CLIP so a sort is never broken.
"""

from __future__ import annotations

from app.core.config import Config
from app.core.logging_config import get_logger
from app.services.ai.clip_embedder import ClipEmbedder
from app.services.ai.encoder_protocol import VisionEncoder
from app.services.ai.hardware import HardwareProfile, ModelTier

logger = get_logger(__name__)


def _build_clip() -> VisionEncoder | None:
    """The always-available CLIP ViT-B/32 encoder, or ``None`` if fastembed is missing."""
    encoder = ClipEmbedder()
    if not encoder.available:
        logger.warning(
            "CLIP model unavailable (fastembed not installed or download failed); local AI disabled"
        )
        return None
    return encoder


def build_encoder(
    config: Config,
    hardware: HardwareProfile,
) -> VisionEncoder | None:
    """Return the best available local encoder for *config* and *hardware*.

    Returns ``None`` when the effective tier is ``"off"`` — callers must handle
    this and skip AI-dependent operations gracefully.
    """
    tier: ModelTier = hardware.effective_tier(getattr(config, "ai_model_tier", "auto"))

    if tier == "off":
        logger.info("AI model tier is off; local AI disabled")
        return None

    if tier in ("standard", "max"):
        from app.services.ai.siglip_encoder import SiglipOnnxEncoder

        siglip = SiglipOnnxEncoder(allow_gpu=getattr(config, "ai_allow_gpu", True))
        if siglip.available:
            logger.info("Local encoder ready", model_id=siglip.model_id, tier=tier)
            return siglip
        # SigLIP unavailable (no onnxruntime/weights, offline first run, …) —
        # degrade to CLIP rather than disabling AI entirely.
        logger.info(
            "SigLIP 2 unavailable; falling back to CLIP ViT-B/32 for this tier",
            requested_tier=tier,
        )

    encoder = _build_clip()
    if encoder is not None:
        logger.info("Local encoder ready", model_id=encoder.model_id, tier=tier)
    return encoder
