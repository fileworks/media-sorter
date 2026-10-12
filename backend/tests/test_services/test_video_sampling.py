"""AI-NEW-8 / AI-09 / AI-NEW-3 — video frames for local AI.

Failures keep a reason instead of looking like "nothing matched", frames are
normalised before they are averaged, and a cancelled operation stops between
frames instead of finishing every probe and decode first.
"""

from __future__ import annotations

import subprocess
from pathlib import Path
from typing import Any, cast

import numpy as np
import pytest
from PIL import Image

from app.core.config import Config
from app.services.ai import video_sampling
from app.services.ai.ai_tagging_service import AITaggingService
from app.services.ai.base_tagger import AITagger
from app.services.ai.category_classifier_service import CategoryClassifierService
from app.services.ai.encoder_protocol import VisionEncoder
from app.services.ai.video_sampling import FrameSampling, InferenceCancelled, sample_frames


def _clip(tmp_path: Path) -> Path:
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"\x00")
    return clip


class TestFailureReasons:
    @pytest.mark.parametrize(
        ("error", "reason"),
        [
            (FileNotFoundError("ffprobe"), "ffprobe_missing"),
            (subprocess.TimeoutExpired("ffprobe", 30), "probe_timeout"),
            (PermissionError("denied"), "probe_failed"),
        ],
    )
    def test_probe_failures_are_named(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, error: Exception, reason: str
    ) -> None:
        def boom(*_args: Any, **_kwargs: Any) -> None:
            raise error

        monkeypatch.setattr(video_sampling, "run_ffprobe_json", boom)
        sampling = FrameSampling(5)

        assert list(sample_frames(_clip(tmp_path), sampling)) == []
        assert sampling.failure == reason
        assert sampling.decoded == 0

    @pytest.mark.parametrize("duration", [None, "nan", "inf", "-3", "0", "abc"])
    def test_an_unusable_duration_is_named(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch, duration: object
    ) -> None:
        monkeypatch.setattr(
            video_sampling,
            "run_ffprobe_json",
            lambda *_a, **_k: {"format": {"duration": duration}},
        )
        sampling = FrameSampling(5)

        assert list(sample_frames(_clip(tmp_path), sampling)) == []
        assert sampling.failure == "no_duration"

    def test_a_missing_ffmpeg_is_named_and_partial_frames_are_counted(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(video_sampling, "_probe", lambda _p, _s: 10.0)
        calls = {"n": 0}

        def frame(_path: Path, _at: float, sampling: FrameSampling) -> Image.Image | None:
            calls["n"] += 1
            if calls["n"] % 2 == 0:
                sampling.fail("ffmpeg_missing")
                return None
            return Image.new("RGB", (4, 4))

        monkeypatch.setattr(video_sampling, "_frame", frame)
        sampling = FrameSampling(5)

        assert len(list(sample_frames(_clip(tmp_path), sampling))) == 3
        assert sampling.decoded == 3
        assert sampling.failure == "ffmpeg_missing"

    def test_a_video_without_frames_logs_one_warning_with_its_reason(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        warnings: list[dict[str, Any]] = []
        monkeypatch.setattr(
            video_sampling.logger, "warning", lambda _event, **fields: warnings.append(fields)
        )
        sampling = FrameSampling(5)
        sampling.fail("frame_timeout")

        video_sampling.log_sampling(_clip(tmp_path), sampling, purpose="tagging")

        assert len(warnings) == 1
        assert warnings[0]["reason"] == "frame_timeout"
        assert warnings[0]["purpose"] == "tagging"


class TestCancellation:
    def test_sampling_stops_between_frames(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(video_sampling, "_probe", lambda _p, _s: 10.0)
        decoded: list[int] = []

        def frame(_path: Path, _at: float, _sampling: FrameSampling) -> Image.Image:
            decoded.append(1)
            return Image.new("RGB", (4, 4))

        monkeypatch.setattr(video_sampling, "_frame", frame)
        stop = {"now": False}
        frames = sample_frames(_clip(tmp_path), FrameSampling(5), should_stop=lambda: stop["now"])

        next(frames)
        stop["now"] = True
        with pytest.raises(InferenceCancelled):
            next(frames)
        assert decoded == [1]

    def test_tagging_and_categorization_raise_instead_of_answering(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A cancelled file used to come back as an ordinary empty prediction."""
        monkeypatch.setattr(video_sampling, "_probe", lambda _p, _s: 10.0)
        monkeypatch.setattr(video_sampling, "_frame", lambda _p, _t, _s: Image.new("RGB", (4, 4)))
        tagger = AITaggingService(Config(ai_tagging_enabled=True))
        tagger._provider = cast("AITagger", _Provider())
        tagger._provider_built = True
        classifier = CategoryClassifierService(
            Config(categorize_enabled=True, categorize_categories=["nature", "food"]),
            _Encoder([1.0, 0.0]),
        )

        with pytest.raises(InferenceCancelled):
            tagger.tag_file(_clip(tmp_path), lambda: True)
        with pytest.raises(InferenceCancelled):
            classifier.classify_file(_clip(tmp_path), lambda: True)


class _Provider:
    def tag(self, _image: Any) -> list[tuple[str, float]]:
        return [("beach", 0.9)]


class _Encoder(VisionEncoder):
    def __init__(self, image: list[float]) -> None:
        self._images = [np.asarray(image, dtype=np.float32)]

    @property
    def available(self) -> bool:
        return True

    def embed_image(self, image: Any) -> Any:
        return self._images[0] if len(self._images) == 1 else self._images.pop(0)

    def embed_texts(self, texts: list[str]) -> Any:
        return np.eye(len(texts), 2, dtype=np.float32) + 1e-3


def test_frames_are_normalised_before_they_are_averaged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """AI-09: one frame with a large raw norm used to decide the whole video."""
    monkeypatch.setattr(video_sampling, "_probe", lambda _p, _s: 10.0)
    monkeypatch.setattr(video_sampling, "_frame", lambda _p, _t, _s: Image.new("RGB", (4, 4)))
    encoder = _Encoder([0.0, 0.0])
    encoder._images = [
        np.asarray([100.0, 0.0], dtype=np.float32),  # loud frame
        np.asarray([0.0, 1.0], dtype=np.float32),
        np.asarray([0.0, 1.0], dtype=np.float32),
        np.asarray([0.0, 1.0], dtype=np.float32),
        np.asarray([0.0, 1.0], dtype=np.float32),
    ]
    classifier = CategoryClassifierService(Config(categorize_enabled=True), encoder)

    mean = classifier._video_embedding(_clip(tmp_path))

    assert mean is not None
    assert float(np.linalg.norm(mean)) == pytest.approx(1.0, abs=1e-5)
    # Four of five frames point along y; the loud x frame counts once, not 100 times.
    assert float(mean[1]) > float(mean[0])
