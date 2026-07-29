"""The only place that actually re-encodes media, and how its claim is measured.

Every encoder here is bound to one :class:`~app.core.optimization_contracts.FormatContract`
and may only produce a candidate *beside* the original — never in place. What
comes back is not "it worked": it is a set of measurements, plus whatever could
not be measured, so the caller can reject a result that failed to prove itself.

An unmeasurable metric is deliberately not a pass. A missing VMAF binary makes a
visually-lossless claim indeterminate, and indeterminate results are rejected by
:mod:`app.services.optimization_execution`, so a machine without the tooling
degrades into doing nothing rather than into trusting an encoder.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Protocol

from app.core.integrity import QualityEvidence
from app.core.logging_config import get_logger
from app.core.optimization_contracts import (
    CONTRACTS,
    FormatContract,
    OptimizationUnavailableError,
    QualityMetric,
    discover_tool,
)

logger = get_logger(__name__)

#: No sample encode may run forever. A slow encoder is a blocked one; the plan
#: falls back to an estimate rather than holding a preview hostage.
DEFAULT_ENCODE_TIMEOUT_SECONDS = 120

#: Measurement names the contracts declare. Kept here so a typo in a contract
#: metric surfaces as an unmeasured metric rather than a silent pass.
MEASURABLE = (
    "decoded_pixels_identical",
    "dimensions_identical",
    "size_reduction_ratio",
    "stream_count_identical",
    "codec_identical",
    "duration_delta_seconds",
    "vmaf_mean",
    "vmaf_minimum",
)

MeasurementValue = float | int | str | bool | None


class EncoderUnavailableError(OptimizationUnavailableError):
    """No encoder can honour this contract on this machine."""


@dataclass(frozen=True)
class EncodeAttempt:
    """One candidate produced beside one original, and what could be proven."""

    contract_id: str
    source_path: Path
    source_bytes: int
    candidate_path: Path | None = None
    candidate_bytes: int | None = None
    measurements: Mapping[str, MeasurementValue] = field(default_factory=dict)
    warnings: tuple[str, ...] = ()
    #: Set when the encoder itself failed. A failed attempt still returns so the
    #: reason reaches the report instead of an exception unwinding the batch.
    error: str | None = None

    @property
    def produced_candidate(self) -> bool:
        return self.candidate_path is not None and self.error is None

    @property
    def size_reduction_ratio(self) -> float | None:
        if self.candidate_bytes is None or self.source_bytes <= 0:
            return None
        return (self.source_bytes - self.candidate_bytes) / self.source_bytes


class Encoder(Protocol):
    """Produces one candidate for one contract and measures the claim."""

    contract: FormatContract

    def supports(self, path: Path) -> bool: ...

    def encode(self, source: Path, destination: Path) -> EncodeAttempt: ...


# --------------------------------------------------------------------------- #
# Metric evaluation                                                            #
# --------------------------------------------------------------------------- #


def _metric_met(metric: QualityMetric, value: MeasurementValue) -> bool | None:
    """Whether one measurement satisfies one declared threshold.

    ``None`` means *not proven*, which is different from *failed*: it is what a
    missing measurement produces, and it must not be collapsed into either
    outcome by the caller.
    """
    if value is None:
        return None
    threshold = metric.threshold
    if metric.comparison == "equals":
        return bool(value == threshold)
    if isinstance(value, bool) or isinstance(threshold, str):
        return None
    if metric.comparison == "at_least":
        return float(value) >= float(threshold)
    return float(value) <= float(threshold)


def evaluate_metrics(
    contract: FormatContract,
    measurements: Mapping[str, MeasurementValue],
    *,
    decoded_successfully: bool,
    sampling_scope: str | None = None,
    warnings: tuple[str, ...] = (),
) -> QualityEvidence:
    """Turn raw measurements into the evidence a commit decision is made from.

    ``passed`` is tri-state on purpose. ``False`` means a threshold was violated,
    ``None`` means at least one threshold could not be measured, and only ``True``
    authorizes replacing anything.
    """
    unmet: list[str] = []
    unproven: list[str] = []
    for metric in contract.metrics:
        met = _metric_met(metric, measurements.get(metric.name))
        if met is None:
            unproven.append(metric.name)
        elif not met:
            unmet.append(metric.name)

    if not decoded_successfully:
        passed: bool | None = False
    elif unmet:
        passed = False
    elif unproven:
        passed = None
    else:
        passed = True

    detail = tuple(
        [*warnings]
        + [f"threshold not met: {name}" for name in unmet]
        + [f"not measured: {name}" for name in unproven]
    )
    return QualityEvidence(
        contract_id=contract.contract_id,
        decoded_successfully=decoded_successfully,
        measurements=dict(measurements),
        thresholds={metric.name: metric.threshold for metric in contract.metrics},
        sampling_scope=sampling_scope,
        passed=passed,
        warnings=detail,
    )


# --------------------------------------------------------------------------- #
# Image                                                                        #
# --------------------------------------------------------------------------- #


@dataclass
class PillowImageEncoder:
    """Recompresses an image without touching a single decoded pixel.

    The claim is checked the only way it can honestly be checked: both files are
    decoded and their raw pixel buffers compared. A format Pillow would silently
    convert (a palette flattened, an alpha dropped) fails that comparison and is
    rejected here rather than at the user's expense later.
    """

    contract: FormatContract

    def supports(self, path: Path) -> bool:
        return path.suffix.lower() in self.contract.source_formats

    def encode(self, source: Path, destination: Path) -> EncodeAttempt:
        source_bytes = source.stat().st_size
        try:
            from PIL import Image
        except ImportError as exc:  # pragma: no cover - Pillow is a hard dependency
            return EncodeAttempt(
                self.contract.contract_id, source, source_bytes, error=f"pillow: {exc}"
            )

        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            with Image.open(source) as image:
                image.load()
                original_size = image.size
                original_frames = getattr(image, "n_frames", 1)
                image.save(
                    destination,
                    **_pillow_parameters(self.contract),
                    **_carried_metadata(image, self.contract),
                )
            with Image.open(source) as before, Image.open(destination) as after:
                mode_kept = before.mode == after.mode
                identical = (
                    mode_kept and before.size == after.size and before.tobytes() == after.tobytes()
                )
                same_dimensions = before.size == after.size == original_size
                frames_kept = getattr(after, "n_frames", 1) == original_frames
        except (OSError, ValueError) as exc:
            _discard(destination)
            return EncodeAttempt(
                self.contract.contract_id,
                source,
                source_bytes,
                error=f"{type(exc).__name__}: {exc}",
            )

        candidate_bytes = destination.stat().st_size
        warnings: list[str] = []
        if not frames_kept:
            warnings.append("animation frames were not preserved")
        if not mode_kept:
            warnings.append("colour mode changed during save")
        lost_metadata = _lost_metadata(source, destination)
        if lost_metadata:
            warnings.append(f"embedded metadata not carried over: {', '.join(lost_metadata)}")

        return EncodeAttempt(
            contract_id=self.contract.contract_id,
            source_path=source,
            source_bytes=source_bytes,
            candidate_path=destination,
            candidate_bytes=candidate_bytes,
            measurements={
                "decoded_pixels_identical": identical and frames_kept,
                "dimensions_identical": same_dimensions,
                "size_reduction_ratio": _ratio(source_bytes, candidate_bytes),
                "metadata_preserved": not lost_metadata,
            },
            warnings=tuple(warnings),
        )


def _pillow_parameters(contract: FormatContract) -> dict[str, Any]:
    """Only parameters Pillow understands, so a contract typo cannot crash a save."""
    allowed = {"optimize", "compress_level", "quality", "progressive", "subsampling"}
    return {key: value for key, value in contract.parameters.items() if key in allowed}


#: Keys Pillow puts in ``info`` that describe the encoding rather than the
#: user's data. Carrying them forward would re-declare decisions the new save
#: has already made.
_ENCODING_INFO_KEYS = frozenset(
    {
        "transparency",
        "gamma",
        "dpi",
        "aspect",
        "compression",
        "interlace",
        "srgb",
        "chromaticity",
        "duration",
        "loop",
        "version",
        "background",
        "palette",
    }
)


def _text_chunks(image: Any) -> dict[str, str]:
    """Textual metadata a viewer would show, keyed as the file stores it."""
    info = getattr(image, "info", {}) or {}
    text = getattr(image, "text", {}) or {}
    carried = {str(key): str(value) for key, value in text.items()}
    for key, value in info.items():
        if key in _ENCODING_INFO_KEYS or not isinstance(value, str):
            continue
        carried.setdefault(str(key), value)
    return carried


def _carried_metadata(image: Any, contract: FormatContract) -> dict[str, Any]:
    """Re-attach what the contract promises to keep.

    Pillow writes what it is given, not what it read: a plain ``save()`` drops
    every text chunk and the ICC profile. The metadata policy is part of the
    contract, so carrying them is the encoder's job, not the caller's.
    """
    carried: dict[str, Any] = {}
    icc = (getattr(image, "info", {}) or {}).get("icc_profile")
    if icc:
        carried["icc_profile"] = icc
    if contract.output_container != "png":
        exif = (getattr(image, "info", {}) or {}).get("exif")
        if exif:
            carried["exif"] = exif
        return carried

    chunks = _text_chunks(image)
    if not chunks:
        return carried
    try:
        from PIL import PngImagePlugin
    except ImportError:  # pragma: no cover - Pillow is a hard dependency
        return carried
    info = PngImagePlugin.PngInfo()
    for key, value in chunks.items():
        info.add_text(key, value)
    carried["pnginfo"] = info
    return carried


def _lost_metadata(source: Path, candidate: Path) -> tuple[str, ...]:
    """Textual keys the original had and the candidate does not."""
    try:
        from PIL import Image

        with Image.open(source) as before, Image.open(candidate) as after:
            return tuple(sorted(set(_text_chunks(before)) - set(_text_chunks(after))))
    except Exception:  # noqa: BLE001 - metadata comparison is advisory
        return ()


# --------------------------------------------------------------------------- #
# Video                                                                        #
# --------------------------------------------------------------------------- #


@dataclass
class FfmpegEncoder:
    """Remuxes or re-encodes video, and proves what the container now holds.

    Stream count, codec, and duration come from ``ffprobe`` on both files rather
    than from ffmpeg's own exit code — an encoder that dropped an audio track
    exits successfully, and only a comparison catches it.
    """

    contract: FormatContract
    timeout_seconds: int = DEFAULT_ENCODE_TIMEOUT_SECONDS
    #: Sample encodes clip long sources; a projection does not need the whole film.
    sample_seconds: float | None = None

    def supports(self, path: Path) -> bool:
        return path.suffix.lower() in self.contract.source_formats

    def encode(self, source: Path, destination: Path) -> EncodeAttempt:
        source_bytes = source.stat().st_size
        ffmpeg = shutil.which("ffmpeg")
        if ffmpeg is None:
            return EncodeAttempt(
                self.contract.contract_id, source, source_bytes, error="ffmpeg is not on PATH"
            )
        destination.parent.mkdir(parents=True, exist_ok=True)
        argv = [ffmpeg, "-nostdin", "-y", "-i", str(source)]
        if self.sample_seconds is not None:
            argv += ["-t", f"{self.sample_seconds:g}"]
        argv += _ffmpeg_parameters(self.contract)
        argv.append(str(destination))

        completed = _run(argv, self.timeout_seconds)
        if completed is None or completed.returncode != 0 or not destination.exists():
            detail = "timed out" if completed is None else _tail(completed.stderr)
            _discard(destination)
            return EncodeAttempt(
                self.contract.contract_id, source, source_bytes, error=f"ffmpeg: {detail}"
            )

        candidate_bytes = destination.stat().st_size
        before = probe(source)
        after = probe(destination)
        measurements: dict[str, MeasurementValue] = {
            "size_reduction_ratio": _ratio(source_bytes, candidate_bytes),
        }
        warnings: list[str] = []
        if before is None or after is None:
            warnings.append("ffprobe could not describe both files")
        else:
            measurements["stream_count_identical"] = before.stream_count == after.stream_count
            measurements["codec_identical"] = before.video_codec == after.video_codec
            if before.duration_seconds is not None and after.duration_seconds is not None:
                expected = (
                    min(before.duration_seconds, self.sample_seconds)
                    if self.sample_seconds is not None
                    else before.duration_seconds
                )
                measurements["duration_delta_seconds"] = abs(after.duration_seconds - expected)
            else:
                warnings.append("duration was not reported for both files")

        if any(metric.name.startswith("vmaf") for metric in self.contract.metrics):
            scores = measure_vmaf(source, destination, timeout_seconds=self.timeout_seconds)
            if scores is None:
                warnings.append("libvmaf is unavailable, so the visual claim is unproven")
            else:
                measurements["vmaf_mean"] = scores[0]
                measurements["vmaf_minimum"] = scores[1]

        return EncodeAttempt(
            contract_id=self.contract.contract_id,
            source_path=source,
            source_bytes=source_bytes,
            candidate_path=destination,
            candidate_bytes=candidate_bytes,
            measurements=measurements,
            warnings=tuple(warnings),
        )


def _ffmpeg_parameters(contract: FormatContract) -> list[str]:
    argv: list[str] = []
    for key, value in contract.parameters.items():
        argv += [f"-{key}", str(value)]
    return argv


@dataclass(frozen=True)
class MediaProbe:
    stream_count: int
    video_codec: str | None
    duration_seconds: float | None


def probe(path: Path) -> MediaProbe | None:
    """Describe a container with ffprobe, or admit that it could not be read."""
    ffprobe = shutil.which("ffprobe")
    if ffprobe is None:
        return None
    completed = _run(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "stream=codec_type,codec_name:format=duration",
            "-of",
            "json",
            str(path),
        ],
        30,
    )
    if completed is None or completed.returncode != 0:
        return None
    try:
        payload = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError:
        return None
    streams = payload.get("streams") or []
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    duration = payload.get("format", {}).get("duration")
    try:
        duration_seconds = float(duration) if duration is not None else None
    except (TypeError, ValueError):
        duration_seconds = None
    return MediaProbe(
        stream_count=len(streams),
        video_codec=None if video is None else str(video.get("codec_name")),
        duration_seconds=duration_seconds,
    )


def measure_vmaf(
    reference: Path,
    candidate: Path,
    *,
    timeout_seconds: int = DEFAULT_ENCODE_TIMEOUT_SECONDS,
) -> tuple[float, float] | None:
    """Mean and worst-frame VMAF, or ``None`` when the filter is not built in.

    The worst frame matters as much as the mean: one badly degraded scene inside
    an otherwise excellent average is exactly the failure a mean hides.
    """
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg is None:
        return None
    with tempfile.TemporaryDirectory(prefix="mediasort-vmaf-") as tmp:
        report = Path(tmp) / "vmaf.json"
        completed = _run(
            [
                ffmpeg,
                "-nostdin",
                "-i",
                str(candidate),
                "-i",
                str(reference),
                "-lavfi",
                f"libvmaf=log_fmt=json:log_path={report.as_posix()}",
                "-f",
                "null",
                "-",
            ],
            timeout_seconds,
        )
        if completed is None or completed.returncode != 0 or not report.is_file():
            return None
        try:
            payload = json.loads(report.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return None
    pooled = payload.get("pooled_metrics", {}).get("vmaf", {})
    frames = [
        frame.get("metrics", {}).get("vmaf")
        for frame in payload.get("frames", [])
        if frame.get("metrics", {}).get("vmaf") is not None
    ]
    mean = pooled.get("mean")
    minimum = pooled.get("min", min(frames) if frames else None)
    if mean is None or minimum is None:
        return None
    return float(mean), float(minimum)


# --------------------------------------------------------------------------- #
# Registry                                                                     #
# --------------------------------------------------------------------------- #


def encoder_for(contract: FormatContract, **kwargs: Any) -> Encoder:
    """The one encoder allowed to satisfy a contract, or a refusal."""
    if contract.tool == "pillow":
        return PillowImageEncoder(contract)
    if contract.tool == "ffmpeg":
        return FfmpegEncoder(contract, **kwargs)
    raise EncoderUnavailableError(f"No encoder implements {contract.tool!r}")


def available_encoders(
    *,
    include_unvalidated: bool = False,
    **kwargs: Any,
) -> tuple[Encoder, ...]:
    """Encoders whose contract is validated *and* whose tool exists here.

    ``include_unvalidated`` exists for the fixture harness that promotes
    contracts. Nothing in normal execution may pass it.
    """
    encoders: list[Encoder] = []
    for contract in CONTRACTS.values():
        if not contract.enabled and not include_unvalidated:
            continue
        if contract.status == "blocked":
            continue
        if not discover_tool(contract.tool).available:
            continue
        try:
            encoders.append(encoder_for(contract, **kwargs))
        except EncoderUnavailableError:
            continue
    return tuple(encoders)


# --------------------------------------------------------------------------- #
# Helpers                                                                      #
# --------------------------------------------------------------------------- #


def _ratio(source_bytes: int, candidate_bytes: int) -> float | None:
    if source_bytes <= 0:
        return None
    return (source_bytes - candidate_bytes) / source_bytes


def _run(argv: list[str], timeout_seconds: int) -> subprocess.CompletedProcess[str] | None:
    try:
        return subprocess.run(  # noqa: S603 - fixed argv, no shell
            argv,
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
    except subprocess.TimeoutExpired:
        return None
    except (OSError, subprocess.SubprocessError) as exc:
        logger.debug("Encoder subprocess failed", tool=argv[0], error=str(exc))
        return None


def _tail(stderr: str | None, *, limit: int = 200) -> str:
    if not stderr:
        return "no output"
    return stderr.strip().splitlines()[-1][:limit]


def _discard(path: Path) -> None:
    try:
        path.unlink(missing_ok=True)
    except OSError:  # pragma: no cover - best effort cleanup
        logger.debug("Could not remove failed candidate", path=str(path))
