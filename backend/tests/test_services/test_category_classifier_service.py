"""Tests for the Smart Categorization classifier.

These never load a real CLIP model: a deterministic fake embedder drives the
prompt-ensemble → cosine → softmax math. Category prompts map (by substring) to
a one-hot basis; the background-anchor prompts map to a dedicated "anchor" axis,
so the floor/anchor/threshold/margin gate can be exercised on synthetic vectors.
"""

from __future__ import annotations

import dataclasses
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from app.core.config import Config
from app.services.ai import category_classifier_service as mod
from app.services.ai.category_classifier_service import (
    CategoryClassifierService,
    CategoryResult,
)

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
    """Deterministic stand-in for ClipEmbedder.

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
    return CategoryClassifierService(config, _FakeEmbedder(_BASIS, image_vec))


# ------------------------------------------------------------------ #
# categories() — sanitization + de-dup                                  #
# ------------------------------------------------------------------ #


def test_categories_sanitizes_and_dedupes() -> None:
    svc = CategoryClassifierService(
        Config(categorize_enabled=True, categorize_categories=["Food", "food", "../food", "a/b"]),
        _FakeEmbedder({}, None),
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
    svc = CategoryClassifierService(config, _FakeEmbedder(_BASIS, [1.0, 0.0, 0.0, 0.0]))
    assert svc.classify_file(p).category is None


def test_empty_categories_returns_uncategorized(tmp_path: Path) -> None:
    p = _save_jpg(tmp_path / "x.jpg")
    config = Config(categorize_enabled=True, categorize_categories=[])
    svc = CategoryClassifierService(config, _FakeEmbedder(_BASIS, [1.0, 0.0, 0.0, 0.0]))
    assert svc.classify_file(p).category is None


def test_embedder_unavailable_returns_uncategorized(tmp_path: Path) -> None:
    p = _save_jpg(tmp_path / "x.jpg")
    config = Config(categorize_enabled=True, categorize_categories=["food", "nature", "people"])
    svc = CategoryClassifierService(
        config, _FakeEmbedder(_BASIS, [1.0, 0.0, 0.0, 0.0], text_returns_none=True)
    )
    assert svc.classify_file(p).category is None


def test_unsupported_type_returns_uncategorized(tmp_path: Path) -> None:
    p = tmp_path / "notes.txt"
    p.write_text("hello")
    assert _service([1.0, 0.0, 0.0, 0.0]).classify_file(p).category is None


def test_never_raises_on_inference_error(tmp_path: Path) -> None:
    p = _save_jpg(tmp_path / "x.jpg")
    config = Config(categorize_enabled=True, categorize_categories=["food", "nature", "people"])
    embedder = _FakeEmbedder(_BASIS, [1.0, 0.0, 0.0, 0.0], image_raises=True)
    svc = CategoryClassifierService(config, embedder)
    assert svc.classify_file(p).category is None  # swallowed → uncategorized


# ------------------------------------------------------------------ #
# classify_file — video path                                            #
# ------------------------------------------------------------------ #


def test_video_aggregates_frames(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    p = tmp_path / "clip.mp4"
    p.write_bytes(b"\x00")
    monkeypatch.setattr(mod, "probe_duration", lambda _p: 9.0)
    monkeypatch.setattr(mod, "extract_frame", lambda _p, _t: Image.new("RGB", (8, 8)))
    result = _service([0.0, 1.0, 0.0, 0.0]).classify_file(p)  # aligns with "nature"
    assert result.category == "nature"


def test_video_no_duration_returns_uncategorized(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    p = tmp_path / "clip.mp4"
    p.write_bytes(b"\x00")
    monkeypatch.setattr(mod, "probe_duration", lambda _p: None)
    assert _service([0.0, 1.0, 0.0, 0.0]).classify_file(p).category is None


# ------------------------------------------------------------------ #
# _gate — floor + anchors + confidence + margin                         #
# ------------------------------------------------------------------ #

_CATS = ["food", "nature", "people"]


def test_gate_floor_rejects_below_anchor_background() -> None:
    # The best category wins decisively *among categories* (and clears the
    # threshold + margin), but its raw cosine is below the generic-anchor
    # background — a plain "a photo" prompt explains the image at least as well —
    # so the anchor-relative floor routes it to _uncategorized.
    svc = _service(None, categorize_confidence_threshold=0.30, categorize_min_margin=0.15)
    cat_sims = np.asarray([0.30, 0.10, 0.05], dtype=np.float32)
    anchor_sims = np.asarray([0.31], dtype=np.float32)
    assert svc._gate(cat_sims, anchor_sims, _CATS).category is None
    # Same categories, no anchors → the floor is a no-op → categorised.
    assert svc._gate(cat_sims, None, _CATS).category == "food"


def test_gate_margin_rejects_close_runner_up() -> None:
    # Two near-tied categories above the floor → margin ≈ 0 → uncategorized.
    svc = _service(None, categorize_confidence_threshold=0.30, categorize_min_margin=0.15)
    sims = np.asarray([0.30, 0.30, 0.10], dtype=np.float32)
    result = svc._gate(sims, None, _CATS)
    assert result.category is None
    assert result.margin == pytest.approx(0.0, abs=0.01)


def test_gate_passes_clear_winner() -> None:
    svc = _service(None, categorize_confidence_threshold=0.55, categorize_min_margin=0.15)
    cat_sims = np.asarray([0.32, 0.18, 0.16], dtype=np.float32)
    anchor_sims = np.asarray([0.18] * 5, dtype=np.float32)
    result = svc._gate(cat_sims, anchor_sims, _CATS)
    assert result.category == "food"
    assert result.confidence > 0.9


def test_gate_anchors_absorb_out_of_vocab() -> None:
    # The best category would win a category-only softmax, but a background anchor
    # scores higher: its mass goes to the anchor → top-1 category prob collapses,
    # and the anchor-relative floor (0.24 < 0.32) also rejects it → uncategorized.
    svc = _service(None, categorize_confidence_threshold=0.30, categorize_min_margin=0.0)
    cat_sims = np.asarray([0.24, 0.10, 0.05], dtype=np.float32)

    with_anchor = svc._gate(cat_sims, np.asarray([0.32, 0.18], dtype=np.float32), _CATS)
    without_anchor = svc._gate(cat_sims, None, _CATS)

    assert with_anchor.category is None  # anchor stole the probability mass
    assert without_anchor.category == "food"  # same sims, no anchor → categorised


def test_category_result_is_frozen() -> None:
    r = CategoryResult("food", 0.9, 0.8)
    with pytest.raises(dataclasses.FrozenInstanceError):
        r.category = "nature"  # type: ignore[misc]
