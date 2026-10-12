"""Keyframe sampling for local AI, with reasons when it fails.

Tagging and categorization both look at a few frames spread across a video.
``probe_duration`` and ``extract_frame`` answer ``None`` for every failure, so a
missing ffmpeg, a timeout and an undecodable file all used to look exactly like
"nothing matched" (AI-NEW-8). This module keeps the first failure reason and the
number of decoded frames, logs one line per video that yielded nothing, and
stops between frames when the operation is cancelled (AI-NEW-3).
"""

from __future__ import annotations

import contextlib
import io
import math
import subprocess
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.core.logging_config import get_logger
from app.services.pipeline import CancelledStage
from app.utils.ffmpeg_utils import run_ffprobe_json, sample_fractions

if TYPE_CHECKING:
    from PIL.Image import Image

logger = get_logger(__name__)

#: Frames sampled per video. Each is decoded and embedded separately.
VIDEO_FRAME_SAMPLES = 5
_PROBE_TIMEOUT = 30
_FRAME_TIMEOUT = 15

StopCheck = Callable[[], bool]


class InferenceCancelled(CancelledStage):
    """Local inference stopped because the operation was cancelled."""


def stop_check(signal: Any | None) -> StopCheck | None:
    """Adapt a task's cancel event or token (anything with ``is_set``)."""
    return signal.is_set if signal is not None else None


def raise_if_stopped(should_stop: StopCheck | None) -> None:
    if should_stop is not None and should_stop():
        raise InferenceCancelled("local inference cancelled")


@dataclass
class FrameSampling:
    """What sampling one video achieved: frames decoded and the first failure."""

    requested: int
    decoded: int = 0
    failure: str | None = None

    def fail(self, reason: str) -> None:
        if self.failure is None:
            self.failure = reason


def _probe(path: Path, sampling: FrameSampling) -> float | None:
    try:
        data = run_ffprobe_json(path, "format=duration", timeout=_PROBE_TIMEOUT)
    except FileNotFoundError:
        sampling.fail("ffprobe_missing")
        return None
    except subprocess.TimeoutExpired:
        sampling.fail("probe_timeout")
        return None
    except OSError:
        sampling.fail("probe_failed")
        return None
    if data is None:
        sampling.fail("probe_failed")
        return None
    raw = (data.get("format") or {}).get("duration")
    if raw is None:
        sampling.fail("no_duration")
        return None
    try:
        duration = float(raw)
    except (TypeError, ValueError):
        sampling.fail("no_duration")
        return None
    if not math.isfinite(duration) or duration <= 0:
        sampling.fail("no_duration")
        return None
    return duration


def _frame(path: Path, at: float, sampling: FrameSampling) -> Image | None:
    from PIL import Image as PILImage

    try:
        result = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-ss",
                str(at),
                "-i",
                str(path),
                "-frames:v",
                "1",
                "-f",
                "image2pipe",
                "-vcodec",
                "png",
                "-",
            ],
            capture_output=True,
            timeout=_FRAME_TIMEOUT,
        )
    except FileNotFoundError:
        sampling.fail("ffmpeg_missing")
        return None
    except subprocess.TimeoutExpired:
        sampling.fail("frame_timeout")
        return None
    except OSError:
        sampling.fail("frame_failed")
        return None
    if result.returncode != 0 or not result.stdout:
        sampling.fail("frame_failed")
        return None
    try:
        return PILImage.open(io.BytesIO(result.stdout)).convert("RGB")
    except Exception:
        sampling.fail("frame_undecodable")
        return None


def sample_frames(
    path: Path,
    sampling: FrameSampling,
    *,
    should_stop: StopCheck | None = None,
) -> Iterator[Image]:
    """Yield up to ``sampling.requested`` frames spread across *path*.

    Each frame is closed after the consumer is done with it. Raises
    :class:`InferenceCancelled` between steps once *should_stop* says so.
    """
    raise_if_stopped(should_stop)
    duration = _probe(path, sampling)
    if duration is None:
        return
    for fraction in sample_fractions(sampling.requested):
        raise_if_stopped(should_stop)
        frame = _frame(path, duration * fraction, sampling)
        if frame is None:
            continue
        sampling.decoded += 1
        try:
            yield frame
        finally:
            with contextlib.suppress(Exception):
                frame.close()


def log_sampling(path: Path, sampling: FrameSampling, *, purpose: str) -> None:
    """One line per video that produced no frame, so failure is not silent."""
    if sampling.decoded == 0:
        logger.warning(
            "No video frames for local AI",
            path=str(path),
            purpose=purpose,
            reason=sampling.failure or "unknown",
        )
    elif sampling.failure is not None:
        logger.debug(
            "Some video frames were not decoded",
            path=str(path),
            purpose=purpose,
            decoded=sampling.decoded,
            requested=sampling.requested,
            reason=sampling.failure,
        )
