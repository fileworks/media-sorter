"""Tests for AI tagging — the local tagger, factory, and orchestrator service.

These never load a real CLIP model and never touch the network: the local
tagger is exercised with injected fake embedders. There is no cloud provider to
test; ``test_local_only_tagging.py`` asserts there cannot be one.
"""

from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from app.core.config import Config
from app.services.ai.ai_tagging_service import AITaggingService
from app.services.ai.base_tagger import (
    LocalClipTagger,
    build_tagger,
)
from app.services.ai.clip_embedder import ClipEmbedder


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
    assert isinstance(build_tagger(cfg, ClipEmbedder()), LocalClipTagger)


# ------------------------------------------------------------------ #
# LocalClipTagger — injected fake embedders (no fastembed/model needed) #
# ------------------------------------------------------------------ #


class _FakeEmbedder:
    """Mimics fastembed: ``embed(iterable)`` yields a vector per item."""

    def __init__(self, vector_for: Any) -> None:
        self._vector_for = vector_for

    def embed(self, items: Any) -> Iterator[Any]:
        for it in items:
            yield self._vector_for(it)


def _local_tagger(
    labels: list[str], image_vec: list[float], threshold: float = 0.2
) -> LocalClipTagger:
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

    text_model = _FakeEmbedder(_vec_for)
    image_model = _FakeEmbedder(lambda _img: np.asarray(image_vec))
    return LocalClipTagger(
        labels=labels, threshold=threshold, image_model=image_model, text_model=text_model
    )


def test_local_clip_scores_aligned_label_highest() -> None:
    labels = ["beach", "city", "snow"]
    tagger = _local_tagger(labels, image_vec=[1.0, 0.0, 0.0], threshold=0.2)
    result = tagger.tag(_img())
    assert result, "expected at least one tag"
    assert result[0][0] == "beach"
    assert result[0][1] > 0.2


def test_local_clip_empty_labels_returns_empty() -> None:
    tagger = LocalClipTagger(labels=[], threshold=0.2, image_model=object(), text_model=object())
    assert tagger.tag(_img()) == []


def test_local_clip_missing_fastembed_degrades_gracefully(monkeypatch: pytest.MonkeyPatch) -> None:
    # No injected models + fastembed import fails → returns [] (never raises).
    import builtins

    real_import = builtins.__import__

    def fake_import(name: str, *args: Any, **kwargs: Any) -> Any:
        if name == "fastembed":
            raise ImportError("no fastembed")
        return real_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", fake_import)
    tagger = LocalClipTagger(labels=["beach"], threshold=0.2)
    assert tagger.tag(_img()) == []


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

    tagger = LocalClipTagger(
        labels=["beach", "city"],
        threshold=0.5,
        image_model=_FakeEmbedder(lambda _i: np.asarray([0.6, 0.3, 0.5])),
        text_model=_FakeEmbedder(vec_for),
    )
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
    from app.services.ai import ai_tagging_service as mod

    p = tmp_path / "clip.mp4"
    p.write_bytes(b"\x00")  # content irrelevant; extraction is monkeypatched
    monkeypatch.setattr(mod, "probe_duration", lambda _p: 9.0)
    monkeypatch.setattr(mod, "extract_frame", lambda _p, _t: _img())

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
    from app.services.ai import ai_tagging_service as mod

    p = tmp_path / "clip.mp4"
    p.write_bytes(b"\x00")
    monkeypatch.setattr(mod, "probe_duration", lambda _p: None)
    svc = _service_with(_StubProvider([("a", 0.9)]))
    assert svc.tag_file(p) == []
