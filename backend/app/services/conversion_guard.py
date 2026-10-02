"""Proof that a converted candidate may replace the file it was made from.

The sort path used to publish a conversion like this::

    converted = self._conversion.convert_image(source=dest, ...)
    if converted != dest:
        dest.unlink(missing_ok=True)   # <- the verified file, gone
        dest = converted               # <- nothing ever checked this

In move mode ``dest`` is the *only* remaining copy of the user's file, so a
converter that produced a truncated, empty or undecodable candidate destroyed
the original and left the wreckage in its place. Nothing validated the
candidate, and nothing recorded that the original had been removed.

`optimization_execution` already had the right shape — validate, quarantine the
original, *then* publish — but its `_validate` cannot be lifted out: it takes a
`FormatContract` from a closed registry of four ids, none of which describes an
arbitrary ``config.image_format`` / ``image_quality``. So the ordering is reused
and the validation is rewritten here, contract-free and mechanically checkable:

* the candidate is a **regular, non-empty file** (never a symlink or directory);
* it is in the **expected format and media class**;
* an **image decodes completely** and has the **same pixel dimensions**;
* a **video probes**, its **duration drifts by at most 40 ms**, and every
  video/audio/subtitle stream survives with **equal per-type counts**;
* a **SHA-256 digest is computed and recorded**.

Size is measured for accounting but never ordered: a conversion is allowed to
grow a file. "Non-empty" is the only size rule.

Every rejection raises `ConversionCandidateRejected`, which the caller must
treat as "keep the original" — never as "publish anyway".
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final, Literal

from app.core.logging_config import get_logger
from app.services.verified_transfer import stream_sha256
from app.utils.ffmpeg_utils import run_ffprobe_json
from app.utils.media_utils import is_image, is_video

logger = get_logger(__name__)

MediaClass = Literal["image", "video"]

#: A transcode re-times frames slightly; 40 ms is a little over one frame at
#: 25 fps. Anything beyond it means content was dropped, not re-timed.
VIDEO_DURATION_TOLERANCE_SECONDS: Final = 0.04

#: Stream kinds whose survival is promised. `data` and `attachment` streams are
#: deliberately excluded — containers disagree about carrying them, and losing a
#: cover-art attachment is not losing media.
_COUNTED_STREAM_KINDS: Final = ("video", "audio", "subtitle")

_PROBE_TIMEOUT_SECONDS: Final = 30


class ConversionCandidateRejected(RuntimeError):
    """A converted candidate failed to prove itself. Keep the original."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


@dataclass(frozen=True)
class CandidateProof:
    """What was measured about a candidate that earned the right to replace."""

    path: Path
    media: MediaClass
    sha256: str
    size_bytes: int
    #: Human-readable evidence, journalled so a later reader can see *why* this
    #: candidate was accepted rather than only that it was.
    detail: str


def _require_regular_non_empty(candidate: Path) -> int:
    if candidate.is_symlink():
        raise ConversionCandidateRejected(f"candidate is a symlink: {candidate}")
    try:
        observed = candidate.stat()
    except OSError as exc:
        raise ConversionCandidateRejected(f"candidate is unreadable: {exc}") from exc
    if not candidate.is_file():
        raise ConversionCandidateRejected(f"candidate is not a regular file: {candidate}")
    if observed.st_size == 0:
        raise ConversionCandidateRejected(f"candidate is empty: {candidate}")
    return int(observed.st_size)


def _require_expected_shape(candidate: Path, *, expected_suffix: str, media: MediaClass) -> None:
    if candidate.suffix.casefold() != expected_suffix.casefold():
        raise ConversionCandidateRejected(
            f"candidate suffix {candidate.suffix!r} is not the planned {expected_suffix!r}"
        )
    in_class = is_image(candidate) if media == "image" else is_video(candidate)
    if not in_class:
        raise ConversionCandidateRejected(
            f"candidate {candidate.name!r} is not recognised as {media}"
        )


def _image_dimensions(path: Path, *, role: str) -> tuple[int, int]:
    """Decode *path* completely and return its size.

    `open_image` is imported lazily: it pulls in Pillow plus the RAW and HEIC
    plugins, and this module is imported by the sort path on every run.
    """
    from app.services.filesystem_service import open_image

    try:
        with open_image(path) as image:
            if image is None:
                raise ConversionCandidateRejected(f"{role} could not be opened: {path}")
            # `open_image` is lazy; `load()` is what actually decodes every
            # pixel, which is the difference between "the header parsed" and
            # "the file is whole".
            image.load()
            return (int(image.width), int(image.height))
    except ConversionCandidateRejected:
        raise
    except Exception as exc:  # Pillow raises a wide family on damaged input.
        raise ConversionCandidateRejected(
            f"{role} did not decode: {type(exc).__name__}: {exc}"
        ) from exc


def validate_converted_image(
    original: Path, candidate: Path, *, expected_suffix: str
) -> CandidateProof:
    """Prove *candidate* is a complete image of the same dimensions as *original*."""
    _require_regular_non_empty(candidate)
    _require_expected_shape(candidate, expected_suffix=expected_suffix, media="image")

    original_size = _image_dimensions(original, role="original")
    candidate_size = _image_dimensions(candidate, role="candidate")
    if candidate_size != original_size:
        raise ConversionCandidateRejected(
            f"candidate is {candidate_size[0]}x{candidate_size[1]}, "
            f"original is {original_size[0]}x{original_size[1]}"
        )

    digest, hashed_bytes = stream_sha256(candidate)
    return CandidateProof(
        path=candidate,
        media="image",
        sha256=digest,
        size_bytes=hashed_bytes,
        detail=f"decoded {candidate_size[0]}x{candidate_size[1]}, {hashed_bytes} bytes",
    )


def _probe(path: Path, entries: str, *, role: str) -> dict[str, Any]:
    try:
        data = run_ffprobe_json(path, entries, timeout=_PROBE_TIMEOUT_SECONDS)
    except FileNotFoundError as exc:
        raise ConversionCandidateRejected(
            "ffprobe is not available to prove the candidate"
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise ConversionCandidateRejected(f"probing the {role} timed out") from exc
    if data is None:
        raise ConversionCandidateRejected(f"{role} could not be probed: {path}")
    return data


def _duration_of(path: Path, *, role: str) -> float:
    data = _probe(path, "format=duration", role=role)
    raw = data.get("format", {}).get("duration")
    if raw is None:
        raise ConversionCandidateRejected(f"{role} reports no duration: {path}")
    try:
        return float(raw)
    except (TypeError, ValueError) as exc:
        raise ConversionCandidateRejected(
            f"{role} reports an unreadable duration: {raw!r}"
        ) from exc


def _stream_counts(path: Path, *, role: str) -> dict[str, int]:
    data = _probe(path, "stream=codec_type", role=role)
    streams = data.get("streams")
    if not isinstance(streams, list):
        raise ConversionCandidateRejected(f"{role} reports no streams: {path}")
    counts = dict.fromkeys(_COUNTED_STREAM_KINDS, 0)
    for stream in streams:
        kind = str(stream.get("codec_type") or "")
        if kind in counts:
            counts[kind] += 1
    return counts


def validate_converted_video(
    original: Path, candidate: Path, *, expected_suffix: str
) -> CandidateProof:
    """Prove *candidate* is a complete transcode that kept every promised stream."""
    _require_regular_non_empty(candidate)
    _require_expected_shape(candidate, expected_suffix=expected_suffix, media="video")

    original_duration = _duration_of(original, role="original")
    candidate_duration = _duration_of(candidate, role="candidate")
    drift = abs(candidate_duration - original_duration)
    if drift > VIDEO_DURATION_TOLERANCE_SECONDS:
        raise ConversionCandidateRejected(
            f"candidate duration drifted {drift:.3f}s "
            f"(limit {VIDEO_DURATION_TOLERANCE_SECONDS}s): "
            f"{candidate_duration:.3f}s vs {original_duration:.3f}s"
        )

    original_streams = _stream_counts(original, role="original")
    candidate_streams = _stream_counts(candidate, role="candidate")
    if candidate_streams != original_streams:
        lost = {
            kind: (original_streams[kind], candidate_streams[kind])
            for kind in _COUNTED_STREAM_KINDS
            if original_streams[kind] != candidate_streams[kind]
        }
        raise ConversionCandidateRejected(f"candidate stream counts changed (was, is): {lost}")

    digest, hashed_bytes = stream_sha256(candidate)
    kept = ", ".join(f"{count} {kind}" for kind, count in candidate_streams.items() if count)
    return CandidateProof(
        path=candidate,
        media="video",
        sha256=digest,
        size_bytes=hashed_bytes,
        detail=(
            f"probed {candidate_duration:.3f}s, kept {kept or 'no'} streams, {hashed_bytes} bytes"
        ),
    )
