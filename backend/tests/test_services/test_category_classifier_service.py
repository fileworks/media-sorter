"""Tests for the Smart Categorization classifier.

These never load a real model: a deterministic fake embedder drives the
best-prompt cosine → native-scale softmax math. Category prompts map (by
substring) to a one-hot basis and anything else to a spare axis, so the
floor/threshold/margin gate can be exercised on synthetic vectors.
"""

from __future__ import annotations

import dataclasses
from pathlib import Path
from typing import Any, cast

import numpy as np
import pytest
from PIL import Image

from app.core.config import Config
from app.services.ai import video_sampling
from app.services.ai.category_classifier_service import (
    CategoryClassifierService,
    CategoryResult,
)
from app.services.ai.encoder_protocol import VisionEncoder

# 4-D space: dims 0–2 are the three test categories, dim 3 is the anchor axis.
_BASIS = {
    "food": [1.0, 0.0, 0.0, 0.0],
    "nature": [0.0, 1.0, 0.0, 0.0],
    "people": [0.0, 0.0, 1.0, 0.0],
}
_ANCHOR_VEC = [0.0, 0.0, 0.0, 1.0]


def _save_jpg(path: Path) -> Path:
    Image.new("RGB", (32, 32), color=(120, 180, 90)).save(path, format="JPEG")
    return path


class _FakeEmbedder:
    """Deterministic stand-in for the shared encoder.

    ``embed_texts`` returns, per prompt, the one-hot basis vector of whichever
    category name appears in the prompt (so the prompt *ensemble* of templates +
    descriptions all collapse to the same category vector), or ``_ANCHOR_VEC``
    for the background-anchor prompts. ``embed_image`` returns a fixed vector.
    """

    def __init__(
        self,
        basis: dict[str, list[float]],
        image_vec: list[float] | None,
        *,
        text_returns_none: bool = False,
        image_raises: bool = False,
    ) -> None:
        self._basis = basis
        self._image_vec = image_vec
        self._text_returns_none = text_returns_none
        self._image_raises = image_raises
        self.available = not text_returns_none

    categorize_floor = 0.1

    @property
    def categorize_scale(self) -> float:
        return 40.0

    def embed_texts(self, texts: list[str]) -> Any | None:
        if self._text_returns_none:
            return None
        rows = []
        for t in texts:
            low = t.lower()
            vec = next((v for key, v in self._basis.items() if key in low), _ANCHOR_VEC)
            rows.append(vec)
        return np.asarray(rows, dtype=np.float32)

    def embed_image(self, image: Any) -> Any | None:
        if self._image_raises:
            raise RuntimeError("inference boom")
        if self._image_vec is None:
            return None
        return np.asarray(self._image_vec, dtype=np.float32)


def _service(image_vec: list[float] | None, **cfg: Any) -> CategoryClassifierService:
    config = Config(
        categorize_enabled=True,
        categorize_categories=["food", "nature", "people"],
        **cfg,
    )
    return CategoryClassifierService(
        config, cast("VisionEncoder", _FakeEmbedder(_BASIS, image_vec))
    )


# ------------------------------------------------------------------ #
# categories() — sanitization + de-dup                                  #
# ------------------------------------------------------------------ #


def test_categories_sanitizes_and_dedupes() -> None:
    svc = CategoryClassifierService(
        Config(categorize_enabled=True, categorize_categories=["Food", "food", "../food", "a/b"]),
        cast("VisionEncoder", _FakeEmbedder({}, None)),
    )
    # "Food"/"food"/"../food" all collapse to the same folder (case-insensitive);
    # first wins. "a/b" → "ab".
    assert svc.categories() == ["Food", "ab"]


# ------------------------------------------------------------------ #
# classify_file — image path                                            #
# ------------------------------------------------------------------ #


def test_top1_selected_when_confident(tmp_path: Path) -> None:
    p = _save_jpg(tmp_path / "x.jpg")
    result = _service([1.0, 0.0, 0.0, 0.0]).classify_file(p)  # aligns with "food"
    assert result.category == "food"
    assert result.confidence > 0.9


def test_uniform_image_falls_below_threshold(tmp_path: Path) -> None:
    p = _save_jpg(tmp_path / "x.jpg")
    # Equal cosine to every category → flat softmax → top1 ≈ 1/3 < 0.55.
    result = _service([1.0, 1.0, 1.0, 0.0]).classify_file(p)
    assert result.category is None
    assert result.confidence == pytest.approx(1 / 3, abs=0.02)


def test_out_of_vocab_image_routes_to_uncategorized(tmp_path: Path) -> None:
    # An image aligned to the anchor axis (nothing the user defined) must land in
    # _uncategorized: both the floor (best cosine ≈ 0) and the anchors reject it.
    p = _save_jpg(tmp_path / "x.jpg")
    result = _service([0.0, 0.0, 0.0, 1.0]).classify_file(p)
    assert result.category is None


def test_disabled_returns_uncategorized(tmp_path: Path) -> None:
    p = _save_jpg(tmp_path / "x.jpg")
    config = Config(categorize_enabled=False, categorize_categories=["food"])
    svc = CategoryClassifierService(
        config, cast("VisionEncoder", _FakeEmbedder(_BASIS, [1.0, 0.0, 0.0, 0.0]))
    )
    assert svc.classify_file(p).category is None


def test_empty_categories_returns_uncategorized(tmp_path: Path) -> None:
    p = _save_jpg(tmp_path / "x.jpg")
    config = Config(categorize_enabled=True, categorize_categories=[])
    svc = CategoryClassifierService(
        config, cast("VisionEncoder", _FakeEmbedder(_BASIS, [1.0, 0.0, 0.0, 0.0]))
    )
    assert svc.classify_file(p).category is None


def test_embedder_unavailable_returns_uncategorized(tmp_path: Path) -> None:
    p = _save_jpg(tmp_path / "x.jpg")
    config = Config(categorize_enabled=True, categorize_categories=["food", "nature", "people"])
    svc = CategoryClassifierService(
        config,
        cast("VisionEncoder", _FakeEmbedder(_BASIS, [1.0, 0.0, 0.0, 0.0], text_returns_none=True)),
    )
    assert svc.classify_file(p).category is None


def test_unsupported_type_returns_uncategorized(tmp_path: Path) -> None:
    p = tmp_path / "notes.txt"
    p.write_text("hello")
    assert _service([1.0, 0.0, 0.0, 0.0]).classify_file(p).category is None


def test_never_raises_on_inference_error(tmp_path: Path) -> None:
    p = _save_jpg(tmp_path / "x.jpg")
    config = Config(categorize_enabled=True, categorize_categories=["food", "nature", "people"])
    embedder = cast("VisionEncoder", _FakeEmbedder(_BASIS, [1.0, 0.0, 0.0, 0.0], image_raises=True))
    svc = CategoryClassifierService(config, embedder)
    assert svc.classify_file(p).category is None  # swallowed → uncategorized


# ------------------------------------------------------------------ #
# classify_file — video path                                            #
# ------------------------------------------------------------------ #


def test_video_aggregates_frames(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = tmp_path / "clip.mp4"
    p.write_bytes(b"\x00")
    monkeypatch.setattr(video_sampling, "_probe", lambda _p, _s: 9.0)
    monkeypatch.setattr(video_sampling, "_frame", lambda _p, _t, _s: Image.new("RGB", (8, 8)))
    result = _service([0.0, 1.0, 0.0, 0.0]).classify_file(p)  # aligns with "nature"
    assert result.category == "nature"


def test_video_no_duration_returns_uncategorized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    p = tmp_path / "clip.mp4"
    p.write_bytes(b"\x00")
    monkeypatch.setattr(video_sampling, "_probe", lambda _p, _s: None)
    assert _service([0.0, 1.0, 0.0, 0.0]).classify_file(p).category is None


# ------------------------------------------------------------------ #
# _gate — floor + native-scale softmax + confidence + margin            #
# ------------------------------------------------------------------ #

_CATS = ["food", "nature", "people"]


def test_gate_passes_a_clear_winner() -> None:
    svc = _service(None, categorize_confidence_threshold=0.55, categorize_min_margin=0.15)
    result = svc._gate(np.asarray([0.32, 0.18, 0.16], dtype=np.float32), _CATS)

    assert result.category == "food"
    assert result.confidence > 0.9
    assert result.rejection is None


@pytest.mark.parametrize(
    ("sims", "threshold", "rejection"),
    [
        # Clear lead, but the best category is below the encoder's floor (0.1).
        ([0.09, 0.0, 0.0], 0.3, "weak_match"),
        # Above the floor, but nothing is confident enough.
        ([0.20, 0.19, 0.18], 0.55, "confidence"),
        # Confident enough, yet two categories are tied.
        ([0.30, 0.30, 0.10], 0.30, "margin"),
    ],
)
def test_a_rejection_names_the_gate_that_failed(
    sims: list[float], threshold: float, rejection: str
) -> None:
    """AI-NEW-5: Review blamed confidence for every rejection, even a margin miss."""
    svc = _service(None, categorize_confidence_threshold=threshold, categorize_min_margin=0.15)
    result = svc._gate(np.asarray(sims, dtype=np.float32), _CATS)

    assert result.category is None
    assert result.rejection == rejection


def test_each_category_scores_its_best_prompt(tmp_path: Path) -> None:
    """One strong phrasing decides; weak sibling phrasings no longer dilute it."""
    from app.services.ai.category_classifier_service import category_similarities

    strong = np.asarray([[1.0, 0.0], [0.0, 1.0], [0.0, 1.0]], dtype=np.float32)
    weak = np.asarray([[0.6, 0.8]], dtype=np.float32)
    sims = category_similarities([strong, weak], np.asarray([1.0, 0.0], dtype=np.float32))

    assert sims.tolist() == pytest.approx([1.0, 0.6])


def test_bundled_german_categories_are_scored_with_english_prompts() -> None:
    """The German folder 'Sport' is the category 'sports', scored in English."""
    seen: list[str] = []

    class _Recorder(_FakeEmbedder):
        def embed_texts(self, texts: list[str]) -> Any | None:
            seen.extend(texts)
            return super().embed_texts(texts)

    config = Config(language="de", categorize_enabled=True)
    svc = CategoryClassifierService(config, cast("VisionEncoder", _Recorder(_BASIS, None)))
    cats = svc.categories()
    groups = svc._prompt_groups(cats)

    assert "Sport" in cats
    assert groups is not None and len(groups) == len(cats)
    assert any("athletic competition" in prompt for prompt in seen)
    assert not any(prompt.startswith("ein Foto") for prompt in seen)


def test_custom_categories_keep_the_interface_language() -> None:
    seen: list[str] = []

    class _Recorder(_FakeEmbedder):
        model_id = "siglip-test"

        def embed_texts(self, texts: list[str]) -> Any | None:
            seen.extend(texts)
            return super().embed_texts(texts)

    config = Config(
        language="de",
        categorize_enabled=True,
        categorize_categories=["Urlaub"],
        categorize_categories_provenance="custom",
    )
    CategoryClassifierService(config, cast("VisionEncoder", _Recorder({}, None)))._prompt_groups(
        ["Urlaub"]
    )

    assert "ein Foto von Urlaub" in seen


def test_category_result_is_frozen() -> None:
    r = CategoryResult("food", 0.9, 0.8)
    with pytest.raises(dataclasses.FrozenInstanceError):
        r.category = "nature"  # type: ignore[misc]
