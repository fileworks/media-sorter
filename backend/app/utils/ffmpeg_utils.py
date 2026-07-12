"""FFprobe JSON-output helper shared across services that probe video files.

All four services that ran ``subprocess.run(["ffprobe", ..., "-of", "json", ...])``
independently now delegate here, eliminating the duplicated subprocess/JSON
boilerplate and the inconsistency in ``DuplicateService._probe_duration`` where
``text=True`` was missing.

Error contract
--------------
* Returns ``None`` for:
  - returncode != 0 (ffprobe detected a problem)
  - malformed / empty JSON in stdout
* Re-raises ``FileNotFoundError`` — callers that want to *tolerate* a missing
  ffprobe binary (e.g. RepairService) must catch it themselves; callers that
  already wrap everything in a broad ``except Exception`` get it for free.
* Re-raises ``subprocess.TimeoutExpired`` — same reasoning: callers decide
  whether a timeout is a hard error or a silent skip.
"""

import io
import json
import subprocess
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

if TYPE_CHECKING:
    from PIL.Image import Image


def run_ffprobe_json(
    path: Path,
    show_entries: str,
    *,
    select_streams: str | None = None,
    timeout: int = 10,
    stderr_out: list[str] | None = None,
) -> dict[str, Any] | None:
    """Run ``ffprobe`` with JSON output and return the parsed dict.

    Parameters
    ----------
    path:
        The media file to probe.
    show_entries:
        The ``-show_entries`` value, e.g. ``"format_tags=creation_time"``.
    select_streams:
        Optional ``-select_streams`` value, e.g. ``"v:0"`` for the first
        video stream.
    timeout:
        Seconds before the subprocess is killed (default 10).
    stderr_out:
        If provided and ffprobe exits non-zero, up to 500 chars of stderr
        are appended to this list so callers can surface the error message.

    Returns
    -------
    dict | None
        Parsed JSON dict on success, ``None`` if ``ffprobe`` returned a
        non-zero exit code or if stdout is not valid JSON.

    Raises
    ------
    FileNotFoundError
        If ``ffprobe`` is not on PATH.
    subprocess.TimeoutExpired
        If the probe takes longer than *timeout* seconds.
    """
    args = ["ffprobe", "-v", "error"]
    if select_streams is not None:
        args += ["-select_streams", select_streams]
    args += ["-show_entries", show_entries, "-of", "json", str(path)]

    # FileNotFoundError and TimeoutExpired propagate intentionally (see module
    # docstring).
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        if stderr_out is not None:
            stderr_out.append(result.stderr[:500])
        return None
    try:
        return cast(dict[str, Any], json.loads(result.stdout or "{}"))
    except json.JSONDecodeError:
        return None


def sample_fractions(n: int) -> list[float]:
    """Return *n* evenly-spaced interior fractions between 0 and 1.

    E.g. ``sample_fractions(5)`` → ``[1/6, 2/6, 3/6, 4/6, 5/6]``. Used to pick
    frame positions across a video's duration for both perceptual de-dup and AI
    tagging, so the two paths sample identically.
    """
    return [(i + 1) / (n + 1) for i in range(n)]


def probe_duration(path: Path, timeout: int = 30) -> float | None:
    """Return *path*'s media duration in seconds via ffprobe, or ``None``.

    Tolerant: any failure (missing ffprobe, malformed output, unreadable file)
    returns ``None`` rather than raising.
    """
    try:
        data = run_ffprobe_json(path, "format=duration", timeout=timeout)
        dur = (data or {}).get("format", {}).get("duration")
        return float(dur) if dur is not None else None
    except Exception:
        return None


def extract_frame(path: Path, t: float, timeout: int = 15) -> "Image | None":
    """Extract a single RGB frame at time *t* seconds via ffmpeg.

    Uses ``-ss`` **before** ``-i`` for a fast keyframe seek and decodes a single
    PNG frame over a pipe. Returns a ``PIL.Image`` (RGB) or ``None`` on any
    failure (missing ffmpeg, seek past end, decode error).
    """
    try:
        from PIL import Image as PILImage

        result = subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-ss",
                str(t),
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
            timeout=timeout,
        )
        if result.returncode != 0 or not result.stdout:
            return None
        return PILImage.open(io.BytesIO(result.stdout)).convert("RGB")
    except Exception:
        return None
