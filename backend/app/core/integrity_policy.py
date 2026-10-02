"""Central authorization guard for every configured media-byte mutation."""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Literal

from app.core.exceptions import MutationPolicyError
from app.core.integrity import OptimizationProfile, PreservationProfile

if TYPE_CHECKING:
    from app.core.config import Config

MutationCapability = Literal[
    "embedded_metadata",
    "repair",
    "conversion",
    "compression",
]


@dataclass(frozen=True)
class MutationAuthorization:
    preservation: PreservationProfile
    optimization: OptimizationProfile
    requested: frozenset[MutationCapability]

    @property
    def is_organize_only(self) -> bool:
        return not self.requested and self.preservation.mode == "organize_only"

    def require(self, capability: MutationCapability) -> None:
        if capability not in self.requested:
            raise MutationPolicyError(
                f"The active operation is not authorized for {capability.replace('_', ' ')}.",
                reason="capability_not_in_manifest",
                capability=capability,
                preservation_profile_id=self.preservation.profile_id,
                optimization_profile_id=self.optimization.profile_id,
            )


def authorize_config_mutations(config: Config) -> MutationAuthorization:
    """Return reviewed authorization or fail before preview/execution work.

    Read-only analysis, cataloging, naming, routing, and report/sidecar-only
    derived metadata do not request a media-byte capability.
    """
    preservation = config.preservation_profile
    optimization = config.optimization_profile
    requested = _requested_capabilities(config)

    if preservation.requires_review:
        raise _policy_error(
            preservation,
            optimization,
            requested,
            reason="migration_review_required",
            message=(
                "Review the modifying settings carried over from the previous "
                "configuration before previewing or executing them."
            ),
        )

    if not requested:
        return MutationAuthorization(preservation, optimization, requested)

    if preservation.mode != "explicit_mutation" or preservation.acknowledged_at is None:
        raise _policy_error(
            preservation,
            optimization,
            requested,
            reason="explicit_profile_required",
            message=(
                "Organize Only does not modify media bytes. Select and acknowledge "
                "a separate mutation profile for the requested changes."
            ),
        )

    permissions: dict[MutationCapability, bool] = {
        "embedded_metadata": preservation.allow_embedded_metadata_edits,
        "repair": preservation.allow_repair,
        "conversion": preservation.allow_conversion,
        "compression": preservation.allow_compression,
    }
    denied = sorted(capability for capability in requested if not permissions[capability])
    if denied:
        raise _policy_error(
            preservation,
            optimization,
            requested,
            reason="capability_not_authorized",
            message="The selected preservation profile does not authorize: " + ", ".join(denied),
            denied=denied,
        )

    if "conversion" in requested:
        if optimization.mode == "disabled" or optimization.acknowledged_at is None:
            raise _policy_error(
                preservation,
                optimization,
                requested,
                reason="optimization_profile_required",
                message=(
                    "Conversion requires an acknowledged Lossless or Visually lossless "
                    "optimization profile."
                ),
            )
        if "compression" in requested and optimization.mode != "visually_lossless":
            raise _policy_error(
                preservation,
                optimization,
                requested,
                reason="compression_profile_required",
                message="Compression requires a reviewed Visually lossless profile.",
            )

    return MutationAuthorization(preservation, optimization, requested)


def _requested_capabilities(config: Config) -> frozenset[MutationCapability]:
    requested: set[MutationCapability] = set()
    if config.override_metadata or (config.ai_tagging_enabled and config.embed_tags_in_files):
        requested.add("embedded_metadata")
    if config.repair_enabled:
        requested.add("repair")
    if config.convert_images or config.convert_videos:
        requested.update(("conversion", "compression"))
    return frozenset(requested)


def _policy_error(
    preservation: PreservationProfile,
    optimization: OptimizationProfile,
    requested: frozenset[MutationCapability],
    *,
    reason: str,
    message: str,
    denied: Sequence[str] | None = None,
) -> MutationPolicyError:
    return MutationPolicyError(
        message,
        reason=reason,
        requested=sorted(requested),
        denied=denied or [],
        preservation_profile_id=preservation.profile_id,
        preservation_mode=preservation.mode,
        optimization_profile_id=optimization.profile_id,
        optimization_mode=optimization.mode,
        source_safety="source_retained",
    )
