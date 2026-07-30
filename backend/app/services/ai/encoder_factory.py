"""Factory for building the local vision encoder based on config + hardware.

The local encoder is shared between AI tagging and Smart Categorization.
This factory owns the tier→encoder mapping and keeps both consumers unaware
of which concrete encoder is running.

Tier → encoder:
  off      → returns None (AI callers must treat None encoder as disabled)
  lite     → ClipEmbedder when its verified optional pack is installed
  standard → SiglipOnnxEncoder when its verified optional pack is installed
  max      → SiglipOnnxEncoder (same weights, accelerator EP preferred)

SigLIP 2 is a substantially stronger zero-shot encoder than CLIP ViT-B/32 at the
exact image↔text-label task both features use (~79% vs ~63% zero-shot ImageNet).
No constructor performs I/O or downloads. The user-managed installer owns all
network access; model objects load their already-verified files only on first use.
"""

from __future__ import annotations

from app.core.config import Config
from app.core.logging_config import get_logger
from app.services.ai.clip_embedder import ClipEmbedder
from app.services.ai.encoder_protocol import VisionEncoder
from app.services.ai.hardware import HardwareProfile, ModelTier
from app.services.ai.model_installation import AiModelStore
from app.services.ai.model_manifest import pack_for_tier

logger = get_logger(__name__)


def build_encoder(
    config: Config,
    hardware: HardwareProfile,
    model_store: AiModelStore,
) -> VisionEncoder | None:
    """Return the best available local encoder for *config* and *hardware*.

    Returns ``None`` when the effective tier is ``"off"`` — callers must handle
    this and skip AI-dependent operations gracefully.
    """
    tier: ModelTier = hardware.effective_tier(getattr(config, "ai_model_tier", "auto"))

    if tier == "off":
        logger.info("AI model tier is off; local AI disabled")
        return None

    pack_id = pack_for_tier(tier)
    if pack_id is None or model_store.component_paths(pack_id, verify=False) is None:
        logger.info("Local AI model pack is not installed", tier=tier, pack_id=pack_id)
        return None

    if tier in ("standard", "max"):
        from app.services.ai.siglip_encoder import SiglipOnnxEncoder

        return SiglipOnnxEncoder(
            allow_gpu=getattr(config, "ai_allow_gpu", True),
            model_store=model_store,
        )

    return ClipEmbedder(model_store=model_store)
