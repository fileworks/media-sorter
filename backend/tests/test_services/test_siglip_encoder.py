"""Unit tests for the SigLIP 2 ONNX encoder.

These exercise the encoder's logic — preprocessing shape/normalisation, runtime
I/O name resolution, tokenisation feed building, output selection and text
caching — with lightweight fakes for the onnxruntime sessions and tokenizer, so
no model download or onnxruntime is required.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pytest
from PIL import Image

from app.services.ai.siglip_encoder import SiglipOnnxEncoder


class _FakeIO:
    def __init__(self, name: str) -> None:
        self.name = name


class _FakeSession:
    """Mimics onnxruntime.InferenceSession.run with recorded inputs/outputs."""

    def __init__(self, inputs: list[str], outputs: list[str], emit: Any) -> None:
        self._inputs = [_FakeIO(n) for n in inputs]
        self._outputs = [_FakeIO(n) for n in outputs]
        self._emit = emit
        self.last_feeds: dict[str, Any] | None = None
        self.last_output_names: list[str] | None = None

    def get_inputs(self) -> list[_FakeIO]:
        return self._inputs

    def get_outputs(self) -> list[_FakeIO]:
        return self._outputs

    def run(self, output_names: list[str], feeds: dict[str, Any]) -> list[Any]:
        self.last_feeds = feeds
        self.last_output_names = output_names
        return [self._emit(feeds)]


class _FakeEncoding:
    def __init__(self, ids: list[int]) -> None:
        self.ids = ids
        self.attention_mask = [1] * len(ids)


class _FakeTokenizer:
    """Records the (already lower-cased) texts it was asked to encode."""

    def __init__(self) -> None:
        self.seen: list[str] = []

    def encode_batch(self, texts: list[str]) -> list[_FakeEncoding]:
        self.seen.extend(texts)
        return [_FakeEncoding([1, 2, 3, 0]) for _ in texts]


def _make_encoder(
    *,
    text_inputs: list[str] | None = None,
    vision_emit: Any = None,
    text_emit: Any = None,
) -> tuple[SiglipOnnxEncoder, _FakeSession, _FakeSession, _FakeTokenizer]:
    vision = _FakeSession(
        inputs=["pixel_values"],
        outputs=["last_hidden_state", "pooler_output"],
        emit=vision_emit or (lambda feeds: np.ones((1, 4), dtype=np.float32)),
    )
    text = _FakeSession(
        inputs=text_inputs or ["input_ids"],
        outputs=["last_hidden_state", "pooler_output"],
        emit=text_emit or (lambda feeds: np.ones((2, 4), dtype=np.float32)),
    )
    tok = _FakeTokenizer()
    enc = SiglipOnnxEncoder(vision_session=vision, text_session=text, tokenizer=tok)
    return enc, vision, text, tok


def test_available_with_injected_components() -> None:
    enc, *_ = _make_encoder()
    assert enc.available is True


def test_model_id_and_calibration_constants() -> None:
    enc, *_ = _make_encoder()
    assert enc.model_id == "siglip2-base-patch16-256"
    # SigLIP-specific calibration (distinct from CLIP's 100/40).
    assert enc.tagger_slope == 40.0
    assert enc.categorize_scale == 60.0


def test_preprocess_shape_and_normalisation() -> None:
    enc, vision, *_ = _make_encoder()
    img = Image.new("RGB", (64, 32), color=(255, 255, 255))
    enc.embed_image(img)

    feeds = vision.last_feeds
    assert feeds is not None
    pixel_values = feeds["pixel_values"]
    # NCHW, square-resized to the model input size.
    assert pixel_values.shape == (1, 3, 256, 256)
    assert pixel_values.dtype == np.float32
    # A pure-white image normalises to (1.0 - 0.5) / 0.5 == 1.0 on every channel.
    assert np.allclose(pixel_values, 1.0)


def test_embed_image_picks_pooler_output_and_flattens() -> None:
    enc, vision, *_ = _make_encoder(
        vision_emit=lambda feeds: np.arange(4, dtype=np.float32).reshape(1, 4)
    )
    out = enc.embed_image(Image.new("RGB", (10, 10)))
    assert vision.last_output_names == ["pooler_output"]
    assert out is not None
    assert out.shape == (4,)


def test_embed_texts_lowercases_and_feeds_input_ids_only() -> None:
    enc, _vision, text, tok = _make_encoder(text_inputs=["input_ids"])
    out = enc.embed_texts(["A Beach", "Sunset"])

    # Texts are lower-cased before tokenisation (Gemma do_lower_case=True).
    assert tok.seen == ["a beach", "sunset"]
    # Only input_ids is fed (SigLIP text tower takes no attention mask).
    assert text.last_feeds is not None
    assert set(text.last_feeds.keys()) == {"input_ids"}
    assert text.last_feeds["input_ids"].dtype == np.int64
    assert out is not None and out.shape == (2, 4)


def test_embed_texts_supplies_attention_mask_when_model_wants_it() -> None:
    enc, _vision, text, _tok = _make_encoder(
        text_inputs=["input_ids", "attention_mask"],
        text_emit=lambda feeds: np.ones((1, 4), dtype=np.float32),
    )
    enc.embed_texts(["hello"])
    assert text.last_feeds is not None
    assert set(text.last_feeds.keys()) == {"input_ids", "attention_mask"}


def test_embed_texts_is_cached_by_input_tuple() -> None:
    calls = {"n": 0}

    def emit(feeds: Any) -> Any:
        calls["n"] += 1
        return np.ones((1, 4), dtype=np.float32)

    enc, _vision, _text, _tok = _make_encoder(text_emit=emit)
    enc.embed_texts(["a"])
    enc.embed_texts(["a"])  # served from cache
    assert calls["n"] == 1
    enc.embed_texts(["b"])  # different key → recomputed
    assert calls["n"] == 2


def test_embed_texts_empty_returns_none() -> None:
    enc, *_ = _make_encoder()
    assert enc.embed_texts([]) is None


def test_load_failure_marks_unavailable(monkeypatch: pytest.MonkeyPatch) -> None:
    # No injected components and the lazy load raises → available is False and the
    # failure is sticky (so callers fall back to CLIP without retry storms).
    enc = SiglipOnnxEncoder()

    def boom() -> None:
        raise RuntimeError("no onnxruntime")

    monkeypatch.setattr(enc, "_load", boom)
    assert enc.available is False
    assert enc.available is False
    assert enc.embed_image(Image.new("RGB", (4, 4))) is None
