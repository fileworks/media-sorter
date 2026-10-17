"""Factory for building the local vision encoder based on config + hardware.

The local encoder is shared between AI tagging and Smart Categorization.
This factory owns the tier→encoder mapping and keeps both consumers unaware
of which concrete encoder is running.

Tier → encoder:
  off      → returns None (AI callers must treat None encoder as disabled)
  standard → SiglipOnnxEncoder when its verified optional pack is installed

Saved ``lite`` and ``max`` values from older releases resolve to ``standard``
(see :data:`~app.services.ai.hardware.LEGACY_TIER_ALIASES`). SigLIP 2 is smaller
to download than the retired CLIP ViT-B/32 pack, stronger at zero-shot matching
and multilingual, so German labels are understood too.
No constructor performs I/O or downloads. The user-managed installer owns all
network access; model objects load their already-verified files only on first use.
"""

from __future__ import annotations

from app.core.config import Config
from app.core.exceptions import MediaSortException
from app.core.logging_config import get_logger
from app.services.ai.encoder_protocol import VisionEncoder
from app.services.ai.hardware import HardwareProfile, ModelTier
from app.services.ai.model_installation import AiModelStore
from app.services.ai.model_manifest import candidate_packs_for_tier, pack_for_tier

logger = get_logger(__name__)


def build_encoder(
    config: Config,
    hardware: HardwareProfile,
    model_store: AiModelStore,
) -> VisionEncoder | None:
    """Return the local encoder for *config* and *hardware*, or ``None``.

    Returns ``None`` when the effective tier is ``"off"`` or the pack is not
    installed — callers must handle this and skip AI-dependent operations.
    """
    tier: ModelTier = hardware.effective_tier(getattr(config, "ai_model_tier", "auto"))

    if tier == "off":
        logger.info("AI model tier is off; local AI disabled")
        return None

    pack_id = installed_pack(tier, model_store)
    if pack_id is None:
        logger.info("Local AI model pack is not installed", tier=tier, pack_id=pack_for_tier(tier))
        return None
    if pack_id != pack_for_tier(tier):
        logger.info(
            "Using the previous local AI model until the current one is installed",
            pack_id=pack_id,
            current=pack_for_tier(tier),
        )

    from app.services.ai.siglip_encoder import SiglipOnnxEncoder

    return SiglipOnnxEncoder(
        allow_gpu=getattr(config, "ai_allow_gpu", True),
        model_store=model_store,
        pack_id=pack_id,
    )


def installed_pack(tier: str, model_store: AiModelStore) -> str | None:
    """The pack local AI uses for *tier*: the current one, else a working predecessor."""
    for pack_id in candidate_packs_for_tier(tier):
        try:
            if model_store.component_paths(pack_id, verify=False):
                return pack_id
        except MediaSortException:  # a pack this manifest does not know
            continue
    return None
