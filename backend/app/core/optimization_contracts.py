"""Declared validation contracts for every format an optimizer may touch.

An optimizer is not allowed to exist for a format until that format has a
contract here saying exactly what "lossless" or "visually lossless" means for
it, which tool and version produces it, which measurements decide acceptance,
and what compatibility it costs. Every contract therefore starts at ``declared``
and only a passing curated-fixture run may move it to ``validated``.

Nothing in this module encodes media. It is the specification the encoder must
later satisfy, kept separate so the claim and the implementation cannot drift
into agreeing with each other by accident.
"""

from __future__ import annotations

import shutil
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Literal

from app.core.integrity import OptimizationMode, OptimizationProfile, utc_now

ContractStatus = Literal["declared", "validated", "blocked"]
MediaKind = Literal["image", "video"]


@dataclass(frozen=True)
class QualityMetric:
    """One objective measurement and the threshold that decides acceptance."""

    name: str
    comparison: Literal["at_least", "at_most", "equals"]
    threshold: float | int | str
    applies_to: Literal["whole_media", "sampled_frames"] = "whole_media"
    #: Why this number, in terms a reviewer can argue with.
    rationale: str = ""


@dataclass(frozen=True)
class FormatContract:
    """What one optimizer must prove before it may run on real media."""

    contract_id: str
    media_kind: MediaKind
    mode: OptimizationMode
    source_formats: tuple[str, ...]
    output_container: str
    output_codec: str
    tool: str
    minimum_tool_version: str
    #: What is preserved exactly. For lossless contracts this is the decoded
    #: content claim; for visually lossless it names what is *not* preserved.
    decoded_content: str
    metadata_policy: str
    metrics: tuple[QualityMetric, ...]
    compatibility_warnings: tuple[str, ...] = ()
    parameters: Mapping[str, str | int | float | bool] = field(default_factory=dict)
    #: Contracts ship as ``declared``. Only a passing curated-fixture and
    #: interruption run may promote one, and that promotion is a code change.
    status: ContractStatus = "declared"

    @property
    def enabled(self) -> bool:
        return self.status == "validated"


def _contracts() -> tuple[FormatContract, ...]:
    return (
        FormatContract(
            contract_id="image-png-lossless-v1",
            media_kind="image",
            mode="lossless",
            source_formats=(".png",),
            output_container="png",
            output_codec="png",
            tool="pillow",
            minimum_tool_version="10.0.0",
            decoded_content=(
                "Every decoded pixel, the colour mode, the bit depth, the alpha "
                "channel, and the animation frame count are identical. Only the "
                "compressed representation changes."
            ),
            metadata_policy=(
                "Textual chunks and ICC profiles are carried over unchanged. No chunk is added."
            ),
            metrics=(
                QualityMetric(
                    "decoded_pixels_identical",
                    "equals",
                    True,
                    rationale="A lossless claim is false if any pixel differs.",
                ),
                QualityMetric(
                    "dimensions_identical",
                    "equals",
                    True,
                    rationale="Resizing is a different operation, never an optimization.",
                ),
                QualityMetric(
                    "size_reduction_ratio",
                    "at_least",
                    0.02,
                    rationale="Below 2% the rewrite costs more than it saves.",
                ),
            ),
            compatibility_warnings=(
                "Recompressed PNGs are byte-different, so external checksums and "
                "deduplication indexes covering the original will not match.",
            ),
            parameters={"optimize": True, "compress_level": 9},
        ),
        FormatContract(
            contract_id="image-jpeg-lossless-transcode-v1",
            media_kind="image",
            mode="lossless",
            source_formats=(".jpg", ".jpeg"),
            output_container="jpeg",
            output_codec="jpeg",
            tool="jpegtran",
            minimum_tool_version="9e",
            decoded_content=(
                "The DCT coefficients are rearranged, not re-quantized, so the "
                "decoded image is bit-identical. Progressive rescan only."
            ),
            metadata_policy="EXIF, ICC, and XMP segments are copied verbatim.",
            metrics=(
                QualityMetric(
                    "decoded_pixels_identical",
                    "equals",
                    True,
                    rationale="Coefficient-only transforms must not change output.",
                ),
                QualityMetric(
                    "size_reduction_ratio",
                    "at_least",
                    0.02,
                    rationale="Progressive rescan typically saves 2-10%.",
                ),
            ),
            compatibility_warnings=(
                "Progressive JPEG decodes more slowly on some embedded viewers.",
                "jpegtran is not bundled; the contract stays blocked without it.",
            ),
            parameters={"progressive": True, "copy": "all", "optimize": True},
            status="blocked",
        ),
        FormatContract(
            contract_id="video-remux-lossless-v1",
            media_kind="video",
            mode="lossless",
            source_formats=(".mov", ".avi", ".mkv", ".mp4"),
            output_container="mp4",
            output_codec="copy",
            tool="ffmpeg",
            minimum_tool_version="6.0",
            decoded_content=(
                "Every video, audio, and subtitle stream is copied without "
                "re-encoding. Decoded content is unchanged by construction; only "
                "the container changes."
            ),
            metadata_policy=(
                "Container tags and creation time are mapped where the target "
                "container supports them; unsupported tags are reported, not dropped "
                "silently."
            ),
            metrics=(
                QualityMetric(
                    "stream_count_identical",
                    "equals",
                    True,
                    rationale="A dropped audio or subtitle track is data loss.",
                ),
                QualityMetric(
                    "duration_delta_seconds",
                    "at_most",
                    0.04,
                    rationale="One frame at 25fps; container timebase rounding only.",
                ),
                QualityMetric(
                    "codec_identical",
                    "equals",
                    True,
                    rationale="A codec change means this was not a remux.",
                ),
            ),
            compatibility_warnings=(
                "MP4 cannot carry every codec an MKV can; unsupported inputs must "
                "be skipped rather than re-encoded.",
            ),
            parameters={"c": "copy", "movflags": "+faststart"},
        ),
        FormatContract(
            contract_id="video-h265-visually-lossless-v1",
            media_kind="video",
            mode="visually_lossless",
            source_formats=(".mov", ".avi", ".mkv", ".mp4"),
            output_container="mp4",
            output_codec="hevc",
            tool="ffmpeg",
            minimum_tool_version="6.0",
            decoded_content=(
                "This is lossy encoding. Decoded content differs from the original. "
                "The contract asserts only that sampled objective measurements met "
                "the thresholds below — never that a person cannot tell."
            ),
            metadata_policy=(
                "Stream metadata and creation time are carried over; the encoder "
                "settings are recorded in the output so the run is reproducible."
            ),
            metrics=(
                QualityMetric(
                    "vmaf_mean",
                    "at_least",
                    95.0,
                    applies_to="sampled_frames",
                    rationale=(
                        "Netflix's widely cited visually-lossless band starts near 95; "
                        "below it, differences become findable in side-by-side review."
                    ),
                ),
                QualityMetric(
                    "vmaf_minimum",
                    "at_least",
                    88.0,
                    applies_to="sampled_frames",
                    rationale="A good mean must not hide one badly degraded scene.",
                ),
                QualityMetric(
                    "duration_delta_seconds",
                    "at_most",
                    0.04,
                    rationale="Timeline drift is a correctness bug, not a quality one.",
                ),
                QualityMetric(
                    "size_reduction_ratio",
                    "at_least",
                    0.25,
                    rationale="Lossy re-encoding is only worth its risk at real savings.",
                ),
            ),
            compatibility_warnings=(
                "HEVC playback is not universal on older devices and browsers.",
                "HDR and 10-bit sources need their own fixtures before enabling.",
                "Re-encoding is irreversible; the original must stay in quarantine.",
            ),
            parameters={"c:v": "libx265", "crf": 20, "preset": "slow", "c:a": "copy"},
        ),
    )


CONTRACTS: Mapping[str, FormatContract] = {
    contract.contract_id: contract for contract in _contracts()
}


class OptimizationUnavailableError(RuntimeError):
    """An optimization profile was requested that may not run yet."""


def contract(contract_id: str) -> FormatContract:
    try:
        return CONTRACTS[contract_id]
    except KeyError:
        raise OptimizationUnavailableError(f"Unknown contract: {contract_id!r}") from None


def enabled_contracts() -> tuple[FormatContract, ...]:
    """Contracts whose curated fixtures have actually passed.

    This is empty on purpose. Optimization stays unavailable until a fixture
    run promotes a contract, which is the whole point of declaring them first.
    """
    return tuple(item for item in CONTRACTS.values() if item.enabled)


@dataclass(frozen=True)
class ToolCapability:
    tool: str
    available: bool
    version: str | None = None
    detail: str | None = None


def discover_tool(tool: str) -> ToolCapability:
    """Probe whether a declared tool is actually usable on this machine."""
    if tool == "pillow":
        try:
            from PIL import __version__ as pillow_version
        except ImportError as exc:
            return ToolCapability(tool, False, detail=type(exc).__name__)
        return ToolCapability(tool, True, version=str(pillow_version))

    executable = shutil.which(tool)
    if executable is None:
        return ToolCapability(tool, False, detail="not on PATH")
    try:
        completed = subprocess.run(  # noqa: S603 - fixed argv, no shell
            [executable, "-version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as exc:
        return ToolCapability(tool, False, detail=type(exc).__name__)
    first_line = (completed.stdout or completed.stderr or "").splitlines()
    return ToolCapability(
        tool,
        completed.returncode == 0,
        version=first_line[0].strip() if first_line else None,
    )


def build_optimization_profile(
    contract_id: str,
    *,
    acknowledged: bool,
    memory_limit_mib: int = 512,
    temporary_space_limit_bytes: int | None = None,
) -> OptimizationProfile:
    """Turn a validated contract plus an explicit acknowledgement into a profile.

    Every refusal here is deliberate. A contract that has not passed its
    fixtures, a tool that is missing or too old, or a user who has not
    acknowledged the tradeoff each stop the profile from existing at all —
    rather than producing one that silently does nothing.
    """
    declared = contract(contract_id)
    if not declared.enabled:
        raise OptimizationUnavailableError(
            f"{contract_id} is {declared.status}; it has not passed its validation fixtures"
        )
    if not acknowledged:
        raise OptimizationUnavailableError(
            f"{contract_id} re-encodes media and requires an explicit acknowledgement"
        )
    capability = discover_tool(declared.tool)
    if not capability.available:
        raise OptimizationUnavailableError(
            f"{declared.tool} is unavailable: {capability.detail or 'unknown reason'}"
        )
    return OptimizationProfile(
        profile_id=contract_id,
        name=f"{declared.mode.replace('_', ' ').capitalize()} — {declared.output_codec}",
        mode=declared.mode,
        acknowledged_at=utc_now(),
        tool=declared.tool,
        tool_version=capability.version or declared.minimum_tool_version,
        parameters=dict(declared.parameters),
        validation_contract=contract_id,
        memory_limit_mib=memory_limit_mib,
        temporary_space_limit_bytes=temporary_space_limit_bytes,
        retain_original=True,
    )
