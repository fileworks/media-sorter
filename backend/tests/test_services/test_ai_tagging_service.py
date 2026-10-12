"""Tests for AI tagging — the local tagger, factory, and orchestrator service.

These never load a real CLIP model and never touch the network: the local
tagger is exercised with injected fake embedders. There is no cloud provider to
test; ``test_local_only_tagging.py`` asserts there cannot be one.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast

import numpy as np
import pytest
from PIL import Image

from app.core.config import Config
from app.services.ai import video_sampling
from app.services.ai.ai_tagging_service import AITaggingService
from app.services.ai.base_tagger import (
    ZeroShotTagger,
    build_tagger,
)
from app.services.ai.encoder_protocol import VisionEncoder


def _img() -> Image.Image:
    return Image.new("RGB", (64, 48), color=(120, 180, 90))


# ------------------------------------------------------------------ #
# build_tagger factory                                                  #
# ------------------------------------------------------------------ #


def test_build_tagger_disabled_returns_none() -> None:
    assert build_tagger(Config(ai_tagging_enabled=False)) is None


def test_build_tagger_local_requires_shared_encoder() -> None:
    cfg = Config(ai_tagging_enabled=True)
    # No shared encoder (tier "off" / model unavailable) → no tagger, rather than
    # silently fabricating a fresh CLIP model the user opted out of.
    assert build_tagger(cfg) is None
    # With a shared encoder, the local CLIP tagger is built and reuses it.
    assert isinstance(
        build_tagger(
            cfg, cast("VisionEncoder", _VectorEncoder(lambda _i: [1.0], lambda _t: [1.0]))
        ),
        ZeroShotTagger,
    )


# ------------------------------------------------------------------ #
# ZeroShotTagger — injected fake embedders (no fastembed/model needed) #
# ------------------------------------------------------------------ #


class _VectorEncoder:
    """Deterministic encoder: fixed vectors for the image and for each prompt."""

    model_id = "test-encoder"
    tagger_slope = 100.0
    categorize_scale = 40.0
    available = True

    def __init__(self, image_vector: Any, text_vector: Any) -> None:
        self._image_vector = image_vector
        self._text_vector = text_vector

    def embed_image(self, image: Any) -> Any:
        return np.asarray(self._image_vector(image), dtype=np.float32)

    def embed_texts(self, texts: list[str]) -> Any:
        return np.asarray([self._text_vector(text) for text in texts], dtype=np.float32)


def _tagger(labels: list[str], encoder: _VectorEncoder, threshold: float) -> ZeroShotTagger:
    return ZeroShotTagger(
        labels=labels, embedder=cast("VisionEncoder", encoder), threshold=threshold
    )


def _local_tagger(
    labels: list[str], image_vec: list[float], threshold: float = 0.2
) -> ZeroShotTagger:
    basis = {
        lbl: [1.0 if i == j else 0.0 for j in range(len(labels))] for i, lbl in enumerate(labels)
    }

    # Each label is now an *ensemble* of template prompts ("a photo of beach",
    # "a beach", "beach", …), so match the label as a substring rather than
    # stripping a single fixed template.
    def _vec_for(prompt: str) -> Any:
        low = prompt.lower()
        for lbl in labels:
            if lbl in low:
                return np.asarray(basis[lbl])
        return np.zeros(len(labels))

    return _tagger(labels, _VectorEncoder(lambda _img: image_vec, _vec_for), threshold)


def test_local_clip_scores_aligned_label_highest() -> None:
    labels = ["beach", "city", "snow"]
    tagger = _local_tagger(labels, image_vec=[1.0, 0.0, 0.0], threshold=0.2)
    result = tagger.tag(_img())
    assert result, "expected at least one tag"
    assert result[0][0] == "beach"
    assert result[0][1] > 0.2


def test_local_clip_empty_labels_returns_empty() -> None:
    encoder = _VectorEncoder(lambda _i: [1.0], lambda _t: [1.0])
    assert _tagger([], encoder, 0.2).tag(_img()) == []


def test_an_unavailable_encoder_degrades_to_no_tags() -> None:
    class _Unavailable(_VectorEncoder):
        def embed_image(self, image: Any) -> Any:
            return None

    encoder = _Unavailable(lambda _i: [1.0], lambda _t: [1.0])
    assert _tagger(["beach"], encoder, 0.2).tag(_img()) == []


def test_local_clip_multilabel_keeps_cooccurring_tags() -> None:
    # Two labels both strongly match the image; a third doesn't. A softmax over
    # the vocabulary would split the budget and drop the runner-up — the per-label
    # sigmoid keeps every co-occurring tag.
    labels = ["beach", "sunset", "document"]
    tagger = _local_tagger(labels, image_vec=[0.7, 0.7, -0.2], threshold=0.5)
    out = dict(tagger.tag(_img()))
    assert set(out) == {"beach", "sunset"}
    assert min(out.values()) > 0.9


def test_local_clip_anchor_background_suppresses_weak_match() -> None:
    # 3-D space: dim0=beach, dim1=city, dim2=the background-anchor axis. The image
    # is strongest on beach, moderate on the anchor, weak on city → only beach
    # beats the anchor-relative bar, even though city has a positive raw cosine.
    basis = {"beach": [1.0, 0.0, 0.0], "city": [0.0, 1.0, 0.0]}

    def vec_for(prompt: str) -> Any:
        low = prompt.lower()
        for lbl, v in basis.items():
            if lbl in low:
                return np.asarray(v)
        return np.asarray([0.0, 0.0, 1.0])  # generic "a photo" anchors

    tagger = _tagger(["beach", "city"], _VectorEncoder(lambda _i: [0.6, 0.3, 0.5], vec_for), 0.5)
    assert set(dict(tagger.tag(_img()))) == {"beach"}


# ------------------------------------------------------------------ #
# AITaggingService orchestration                                        #
# ------------------------------------------------------------------ #


class _StubProvider:
    def __init__(self, tags: list[tuple[str, float]]) -> None:
        self._tags = tags
        self.calls = 0

    def tag(self, image: Any) -> list[tuple[str, float]]:
        self.calls += 1
        return self._tags


def _service_with(provider: Any, **cfg_kwargs: Any) -> AITaggingService:
    svc = AITaggingService(Config(ai_tagging_enabled=True, **cfg_kwargs))
    svc._provider = provider
    svc._provider_built = True
    return svc


def test_tag_file_image_caps_to_max_tags(tmp_path: Path) -> None:
    p = tmp_path / "x.jpg"
    _img().save(p, format="JPEG")
    provider = _StubProvider([("a", 0.9), ("b", 0.8), ("c", 0.7)])
    svc = _service_with(provider, ai_tagging_max_tags=2)
    assert svc.tag_file(p) == ["a", "b"]


def test_tag_file_no_provider_returns_empty(tmp_path: Path) -> None:
    p = tmp_path / "x.jpg"
    _img().save(p, format="JPEG")
    svc = AITaggingService(Config(ai_tagging_enabled=True))
    svc._provider = None
    svc._provider_built = True
    assert svc.tag_file(p) == []


def test_tag_file_non_media_returns_empty(tmp_path: Path) -> None:
    p = tmp_path / "notes.txt"
    p.write_text("hello")
    svc = _service_with(_StubProvider([("a", 0.9)]))
    assert svc.tag_file(p) == []


def test_tag_file_provider_exception_returns_empty(tmp_path: Path) -> None:
    p = tmp_path / "x.jpg"
    _img().save(p, format="JPEG")

    class _Boom:
        def tag(self, image: Any) -> list[tuple[str, float]]:
            raise RuntimeError("model exploded")

    svc = _service_with(_Boom())
    assert svc.tag_file(p) == []


def test_tag_file_video_votes_across_frames(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Labels must appear in >= _MIN_FRAME_VOTES frames; single-frame labels are excluded."""

    p = tmp_path / "clip.mp4"
    p.write_bytes(b"\x00")  # content irrelevant; extraction is monkeypatched
    monkeypatch.setattr(video_sampling, "_probe", lambda _p, _s: 9.0)
    monkeypatch.setattr(video_sampling, "_frame", lambda _p, _t, _s: _img())

    # beach: frames 0+1 → 2 votes → qualifies, peak score 0.95
    # sky:   frame 0 only → 1 vote → excluded
    # palm:  frame 2 only → 1 vote → excluded
    # _VIDEO_FRAME_SAMPLES=5 so 5 entries total.
    frames_tags = [[("beach", 0.6), ("sky", 0.9)], [("beach", 0.95)], [("palm", 0.5)], [], []]

    class _MultiProvider:
        def __init__(self) -> None:
            self._i = 0

        def tag(self, image: Any) -> list[tuple[str, float]]:
            out = frames_tags[self._i]
            self._i += 1
            return out

    svc = _service_with(_MultiProvider(), ai_tagging_max_tags=10)
    tags = svc.tag_file(p)
    # Only "beach" cleared the vote threshold; sky and palm are single-frame blips.
    assert tags == ["beach"]


def test_tag_file_video_no_duration_returns_empty(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:

    p = tmp_path / "clip.mp4"
    p.write_bytes(b"\x00")
    monkeypatch.setattr(video_sampling, "_probe", lambda _p, _s: None)
    svc = _service_with(_StubProvider([("a", 0.9)]))
    assert svc.tag_file(p) == []
