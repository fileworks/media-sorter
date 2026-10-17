"""Unit tests for the SigLIP 2 ONNX encoder.

These exercise the encoder's logic — preprocessing shape/normalisation, runtime
I/O name resolution, tokenisation feed building, output selection and text
caching — with lightweight fakes for the onnxruntime sessions and tokenizer, so
no model download or onnxruntime is required.
"""

from __future__ import annotations

import threading
import time
from typing import Any

import numpy as np
import pytest
from PIL import Image

from app.services.ai import siglip_encoder
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
        emit=text_emit or (lambda feeds: np.ones((len(feeds["input_ids"]), 4), dtype=np.float32)),
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
    # Calibration evaluated on held-out public fixtures (scripts/evaluate_local_ai.py).
    assert enc.tagger_slope == 40.0
    assert enc.tagger_offset("en") == 0.005
    assert enc.tagger_offset("de") == 0.007
    # The checkpoint's own logit scale, and the cosine at which its sigmoid
    # (with the learned bias) reaches 0.0003.
    assert enc.categorize_scale == pytest.approx(112.90118)
    assert enc.categorize_floor == pytest.approx(0.0767, abs=1e-4)


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


def test_embed_texts_is_cached_per_text() -> None:
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
    # failure is sticky (so callers degrade to no AI without retry storms).
    enc = SiglipOnnxEncoder()

    def boom() -> None:
        raise RuntimeError("no onnxruntime")

    monkeypatch.setattr(enc, "_load", boom)
    assert enc.available is False
    assert enc.available is False
    assert enc.embed_image(Image.new("RGB", (4, 4))) is None


# --------------------------------------------------------------------------- #
# AI-NEW-1 / AI-NEW-2 / AI-12: load once, bounded cache, single-text encoding #
# --------------------------------------------------------------------------- #


def test_concurrent_first_use_loads_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """Two threads racing on first use used to enter the loader twice."""
    enc = SiglipOnnxEncoder()
    barrier = threading.Barrier(2)
    calls: list[int] = []
    vision = _FakeSession(["pixel_values"], ["pooler_output"], lambda _f: np.ones((1, 4)))
    text = _FakeSession(["input_ids"], ["pooler_output"], lambda _f: np.ones((1, 4)))

    def slow_load() -> None:
        calls.append(1)
        time.sleep(0.05)
        enc._vision_session, enc._text_session, enc._tokenizer = vision, text, _FakeTokenizer()

    monkeypatch.setattr(enc, "_load", slow_load)
    results: list[bool] = []

    def use() -> None:
        barrier.wait()
        results.append(enc.available)

    threads = [threading.Thread(target=use) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert calls == [1]
    assert results == [True, True]


def test_each_text_is_encoded_alone_so_its_vector_ignores_its_neighbours() -> None:
    """The int8 text tower quantizes per batch; a label must not depend on the others."""
    batch_sizes: list[int] = []

    def emit(feeds: Any) -> Any:
        batch_sizes.append(len(feeds["input_ids"]))
        return np.ones((len(feeds["input_ids"]), 4), dtype=np.float32)

    enc, *_ = _make_encoder(text_emit=emit)
    out = enc.embed_texts(["a", "b", "c"])

    assert batch_sizes == [1, 1, 1]
    assert out is not None and out.shape == (3, 4)


def test_returned_text_vectors_are_read_only() -> None:
    enc, *_ = _make_encoder()
    out = enc.embed_texts(["a", "b"])

    assert out is not None
    with pytest.raises(ValueError):
        out[0, 0] = 5.0
    again = enc.embed_texts(["a"])
    assert again is not None and float(again[0, 0]) == 1.0


def test_the_text_cache_is_bounded_and_keeps_recent_texts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(siglip_encoder, "TEXT_CACHE_ENTRIES", 3)
    calls: list[str] = []

    def emit(feeds: Any) -> Any:
        calls.append("run")
        return np.ones((1, 4), dtype=np.float32)

    enc, *_ = _make_encoder(text_emit=emit)
    enc.embed_texts(["a", "b", "c"])
    enc.embed_texts(["a"])  # refresh "a"; "b" is now the oldest
    enc.embed_texts(["d"])  # evicts "b"

    assert list(enc._text_cache) == ["c", "a", "d"]
    runs = len(calls)
    enc.embed_texts(["a", "c", "d"])
    assert len(calls) == runs
    enc.embed_texts(["b"])
    assert len(calls) == runs + 1


def test_an_injected_text_session_is_never_released() -> None:
    enc, _vision, text, _tok = _make_encoder()
    enc.embed_texts(["a"])
    enc.release_text_session()

    assert enc._text_session is text


def test_a_released_text_tower_reloads_only_for_new_texts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import sys
    import types

    built: list[str] = []
    text = _FakeSession(["input_ids"], ["pooler_output"], lambda f: np.ones((1, 4)))

    class _Ort(types.SimpleNamespace):
        @staticmethod
        def InferenceSession(path: str, **_kwargs: Any) -> _FakeSession:
            built.append(path)
            return text

    monkeypatch.setitem(sys.modules, "onnxruntime", _Ort())
    monkeypatch.setattr(siglip_encoder, "TEXT_SESSION_IDLE_SECONDS", 0)
    vision = _FakeSession(["pixel_values"], ["pooler_output"], lambda _f: np.ones((1, 4)))
    enc = SiglipOnnxEncoder(vision_session=vision, tokenizer=_FakeTokenizer())

    def load() -> None:
        enc._text_session = text
        enc._text_model_path = "text_model_quantized.onnx"

    monkeypatch.setattr(enc, "_load", load)
    enc.embed_texts(["a"])
    enc.release_text_session()
    assert enc._text_session is None

    enc.embed_texts(["a"])  # cached: no reload
    assert built == []
    enc.embed_texts(["b"])  # miss: the tower comes back
    assert built == ["text_model_quantized.onnx"]


def test_idle_text_tower_is_released_automatically(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(siglip_encoder, "TEXT_SESSION_IDLE_SECONDS", 0.05)
    text = _FakeSession(["input_ids"], ["pooler_output"], lambda f: np.ones((1, 4)))
    vision = _FakeSession(["pixel_values"], ["pooler_output"], lambda _f: np.ones((1, 4)))
    enc = SiglipOnnxEncoder(vision_session=vision, tokenizer=_FakeTokenizer())

    def load() -> None:
        enc._text_session = text
        enc._text_model_path = "text_model_quantized.onnx"

    monkeypatch.setattr(enc, "_load", load)
    enc.embed_texts(["a"])
    deadline = time.monotonic() + 5
    while enc._text_session is not None and time.monotonic() < deadline:
        time.sleep(0.01)

    assert enc._text_session is None
    assert enc.embed_image(Image.new("RGB", (8, 8))) is not None


def test_each_pack_loads_its_own_vision_tower() -> None:
    from app.services.ai import siglip_encoder as module

    assert module._VISION_FILES["siglip-standard-v2"] == "onnx/vision_model.onnx"
    assert module._VISION_FILES["siglip-standard-v1"] == "onnx/vision_model_quantized.onnx"
    assert SiglipOnnxEncoder()._pack_id == "siglip-standard-v2"
    with pytest.raises(ValueError):
        SiglipOnnxEncoder(pack_id="unknown-pack")
