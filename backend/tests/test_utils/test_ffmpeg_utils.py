"""Tests for app.utils.ffmpeg_utils.run_ffprobe_json."""

import json
import subprocess
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.utils.ffmpeg_utils import run_ffprobe_json


def _completed(stdout: str = "", returncode: int = 0) -> MagicMock:
    """Build a mock CompletedProcess."""
    m = MagicMock()
    m.stdout = stdout
    m.returncode = returncode
    return m


# ── Success cases ─────────────────────────────────────────────────────────────


def test_returns_parsed_json_on_success() -> None:
    payload = {"format": {"duration": "120.5"}}
    with patch("subprocess.run", return_value=_completed(json.dumps(payload))) as mock_run:
        result = run_ffprobe_json(Path("video.mp4"), "format=duration")

    assert result == payload
    # Verify -of json and show_entries are passed
    args = mock_run.call_args[0][0]
    assert "-of" in args and "json" in args
    assert "-show_entries" in args and "format=duration" in args


def test_select_streams_included_when_provided() -> None:
    payload = {"streams": [{"codec_type": "video"}]}
    with patch("subprocess.run", return_value=_completed(json.dumps(payload))) as mock_run:
        run_ffprobe_json(Path("video.mp4"), "stream=codec_type", select_streams="v:0")

    args = mock_run.call_args[0][0]
    assert "-select_streams" in args
    idx = args.index("-select_streams")
    assert args[idx + 1] == "v:0"


def test_select_streams_omitted_by_default() -> None:
    with patch("subprocess.run", return_value=_completed("{}", 0)) as mock_run:
        run_ffprobe_json(Path("video.mp4"), "format=duration")

    args = mock_run.call_args[0][0]
    assert "-select_streams" not in args


def test_empty_stdout_returns_empty_dict() -> None:
    with patch("subprocess.run", return_value=_completed("", 0)):
        result = run_ffprobe_json(Path("video.mp4"), "format=duration")

    assert result == {}


# ── Failure / error cases ─────────────────────────────────────────────────────


def test_nonzero_returncode_returns_none() -> None:
    with patch("subprocess.run", return_value=_completed("", 1)):
        assert run_ffprobe_json(Path("video.mp4"), "format=duration") is None


def test_stderr_out_populated_on_nonzero_returncode() -> None:
    mock = _completed("", 1)
    mock.stderr = "no video stream found\n"
    with patch("subprocess.run", return_value=mock):
        buf: list[str] = []
        run_ffprobe_json(Path("video.mp4"), "format=duration", stderr_out=buf)
    assert buf == ["no video stream found\n"]


def test_stderr_out_not_populated_on_success() -> None:
    with patch("subprocess.run", return_value=_completed("{}", 0)):
        buf: list[str] = []
        run_ffprobe_json(Path("video.mp4"), "format=duration", stderr_out=buf)
    assert buf == []


def test_invalid_json_returns_none() -> None:
    with patch("subprocess.run", return_value=_completed("not json", 0)):
        assert run_ffprobe_json(Path("video.mp4"), "format=duration") is None


def test_file_not_found_propagates() -> None:
    with patch("subprocess.run", side_effect=FileNotFoundError("ffprobe not found")):
        with pytest.raises(FileNotFoundError):
            run_ffprobe_json(Path("video.mp4"), "format=duration")


def test_timeout_propagates() -> None:
    with patch("subprocess.run", side_effect=subprocess.TimeoutExpired("ffprobe", 10)):
        with pytest.raises(subprocess.TimeoutExpired):
            run_ffprobe_json(Path("video.mp4"), "format=duration")


def test_custom_timeout_forwarded() -> None:
    with patch("subprocess.run", return_value=_completed("{}", 0)) as mock_run:
        run_ffprobe_json(Path("video.mp4"), "format=duration", timeout=30)

    assert mock_run.call_args[1]["timeout"] == 30


def test_text_mode_always_enabled() -> None:
    """Ensures text=True so stdout is a str (not bytes) for json.loads."""
    with patch("subprocess.run", return_value=_completed("{}", 0)) as mock_run:
        run_ffprobe_json(Path("video.mp4"), "format=duration")

    assert mock_run.call_args[1].get("text") is True
