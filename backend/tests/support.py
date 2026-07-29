"""Shared helpers for tests that need reviewed mutation profiles."""

from __future__ import annotations

from app.core.config import Config
from app.core.integrity import OptimizationProfile, PreservationProfile, utc_now


def authorize_mutations(
    config: Config,
    *,
    embedded_metadata: bool = False,
    repair: bool = False,
    conversion: bool = False,
) -> Config:
    """Give ``config`` the reviewed profiles that media mutation now requires.

    Organize Only is the default, so a test that exercises conversion, repair,
    or embedded tagging has to opt in exactly like a real user does.
    """
    config.preservation_profile = PreservationProfile(
        profile_id="test-explicit-mutation",
        name="Test explicit mutation",
        mode="explicit_mutation",
        allow_embedded_metadata_edits=embedded_metadata,
        allow_repair=repair,
        allow_conversion=conversion,
        allow_compression=conversion,
        acknowledged_at=utc_now(),
    )
    if conversion:
        config.optimization_profile = OptimizationProfile(
            profile_id="test-visually-lossless",
            name="Test visually lossless",
            mode="visually_lossless",
            acknowledged_at=utc_now(),
            tool="pillow",
            tool_version="test",
            validation_contract="test-contract-v1",
        )
    return config
