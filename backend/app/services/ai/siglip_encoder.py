"""SigLIP 2 vision+text encoder backed by onnxruntime ("Standard" / "Max" tier).

This is the higher-quality local encoder that replaces the CLIP ViT-B/32
placeholder for the ``standard`` and ``max`` model tiers. It implements the same
:class:`~app.services.ai.encoder_protocol.VisionEncoder` contract as
:class:`~app.services.ai.clip_embedder.ClipEmbedder`, so AI tagging and Smart
Categorization consume it without caring which model is loaded.

Why SigLIP 2 (Google, 2025): substantially stronger zero-shot than CLIP ViT-B/32
(~79% vs ~63% ImageNet) at the *exact* task both features use (image↔text-label
matching), with a sigmoid training objective that matches the multi-label tagger.
ONNX weights live at ``onnx-community/siglip2-base-patch16-256-ONNX`` (Apache-2.0)
and quantize to ~100 MB per tower, so it runs on a moderate laptop CPU.

Design notes
------------
* **Everything is lazy and best-effort.** The heavy imports (onnxruntime,
  tokenizers, huggingface_hub), the model download and the session construction
  only happen on first real use. Any failure flips :pyattr:`available` to
  ``False`` so the factory falls back to CLIP — a sort is never broken by a
  missing/broken model.
* **Runtime-adaptive I/O.** Input names (``pixel_values`` / ``input_ids`` /
  ``attention_mask``) and the pooled-embedding output name are resolved from the
  loaded graph rather than hardcoded, so a slightly different export still works.
* **Injectable** vision/text sessions + tokenizer (any object exposing the small
  duck-typed interface used below) so tests run without a real download.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.core.logging_config import get_logger
from app.services.ai.encoder_protocol import VisionEncoder

if TYPE_CHECKING:
    from PIL.Image import Image

logger = get_logger(__name__)

# onnx-community SigLIP 2 base/16 @256 (Apache-2.0). Pinned by repo id; the q8
# ("quantized") tower variants are ~100 MB each and CPU-friendly.
SIGLIP2_REPO = "onnx-community/siglip2-base-patch16-256-ONNX"
_VISION_FILE = "onnx/vision_model_quantized.onnx"
_TEXT_FILE = "onnx/text_model_quantized.onnx"
_TOKENIZER_FILE = "tokenizer.json"

# SigLIP 2 image preprocessing (from the model's preprocessor_config.json):
# resize the whole image to a square (no crop), rescale to 0..1, normalise with
# mean/std 0.5. ``resample=2`` is PIL bilinear, matching the reference processor.
_IMAGE_SIZE = 256
_IMAGE_MEAN = 0.5
_IMAGE_STD = 0.5

# SigLIP text towers are trained with a fixed 64-token context (pad to length,
# no attention mask). The Gemma tokenizer lower-cases and appends <eos>.
_MAX_TOKENS = 64
_PAD_TOKEN = "<pad>"

# Candidate output names for the pooled, similarity-ready embedding, most- to
# least-specific. Tower-only exports expose ``pooler_output``.
_EMBED_OUTPUT_CANDIDATES = ("pooler_output", "image_embeds", "text_embeds", "embeds")


def _model_cache_dir() -> Path | None:
    """Resolve where the SigLIP ONNX files are cached / bundled.

    Order: explicit ``MEDIASORT_SIGLIP_MODEL_DIR`` → a ``siglip/`` resource next
    to the frozen backend (PyInstaller release) → ``None`` (let huggingface_hub
    use its own cache and download on first use — the dev/desktop path).
    """
    env = os.environ.get("MEDIASORT_SIGLIP_MODEL_DIR")
    if env:
        return Path(env)
    if getattr(sys, "frozen", False):
        candidate = Path(sys.executable).resolve().parent.parent / "siglip"
        if candidate.is_dir():
            return candidate
    return None


def _upright_rgb(image: Image) -> Image:
    """Apply EXIF orientation and convert to RGB (best-effort, never raises)."""
    from PIL import ImageOps

    try:
        img = ImageOps.exif_transpose(image)
    except Exception:
        img = image
    if img is None:  # pragma: no cover - only in PIL in-place mode
        img = image
    if img.mode != "RGB":
        try:
            img = img.convert("RGB")
        except Exception:
            return image
    return img


class SiglipOnnxEncoder(VisionEncoder):
    """SigLIP 2 base/16 image+text encoder via onnxruntime.

    Returns raw (un-normalised) ``float32`` embedding vectors from each tower's
    pooled output; the tagging/categorization consumers L2-normalise and score
    them, exactly as they do for CLIP. Text embeddings are memoised by the tuple
    of input strings so a stable label/category vocabulary is encoded once.
    """

    def __init__(
        self,
        *,
        repo: str = SIGLIP2_REPO,
        allow_gpu: bool = True,
        image_size: int = _IMAGE_SIZE,
        vision_session: Any | None = None,
        text_session: Any | None = None,
        tokenizer: Any | None = None,
    ) -> None:
        self._repo = repo
        self._allow_gpu = allow_gpu
        self._image_size = image_size
        self._vision_session: Any | None = vision_session
        self._text_session: Any | None = text_session
        self._tokenizer: Any | None = tokenizer
        self._load_failed = False
        self._text_cache: dict[tuple[str, ...], Any] = {}
        # Resolved lazily from the loaded graphs.
        self._vision_input: str | None = None
        self._text_inputs: tuple[str, ...] = ()
        self._vision_output: str | None = None
        self._text_output: str | None = None

    # ------------------------------------------------------------------ #
    # VisionEncoder protocol metadata                                     #
    # ------------------------------------------------------------------ #

    @property
    def model_id(self) -> str:
        return "siglip2-base-patch16-256"

    @property
    def tagger_slope(self) -> float:
        # Per-label sigmoid slope. SigLIP 2 base's cosines sit in a narrow, low
        # band (matching pairs ≈0.05–0.14, generic anchors ≈0.03–0.06), so the
        # anchor-relative gap is small; slope 40 maps a confident +0.06 gap to
        # ≈0.92 and a marginal +0.015 gap to ≈0.65 while keeping non-matches
        # (negative gap) below the 0.5 threshold. Empirically calibrated on
        # SigLIP 2 base/16 @256 (CLIP uses 100 for its wider cosine spread).
        return 40.0

    @property
    def categorize_scale(self) -> float:
        # Softmax temperature for the top-1 categoriser. SigLIP's cosines are
        # *lower* in absolute terms than CLIP's (≈0.02–0.14 vs ≈0.20–0.26), so it
        # needs a HIGHER temperature than CLIP's 40 to produce confident top-1
        # probabilities: at 60 a clear match clears the 0.55 gate while genuinely
        # ambiguous images stay below it (route to _uncategorized). Prompt
        # ensembling sharpens real categories further.
        return 60.0

    @property
    def available(self) -> bool:
        return self._ensure_loaded()

    # ------------------------------------------------------------------ #
    # Lazy load                                                           #
    # ------------------------------------------------------------------ #

    def _ensure_loaded(self) -> bool:
        """Build the onnxruntime sessions + tokenizer once. False if unavailable."""
        if (
            self._vision_session is not None
            and self._text_session is not None
            and (self._tokenizer is not None)
        ):
            self._resolve_io()
            return True
        if self._load_failed:
            return False
        try:
            self._load()
            self._resolve_io()
            return True
        except Exception as exc:  # pragma: no cover - depends on optional deps/network
            self._load_failed = True
            logger.warning(
                "SigLIP 2 encoder unavailable; falling back to CLIP",
                error=str(exc),
                repo=self._repo,
            )
            return False

    def _load(self) -> None:
        import onnxruntime as ort
        from huggingface_hub import hf_hub_download
        from tokenizers import Tokenizer

        cache = _model_cache_dir()
        cache_dir = str(cache) if cache is not None else None

        def fetch(filename: str) -> str:
            # When the model is bundled (frozen release / explicit dir) prefer the
            # local copy so a packaged app never needs the network; only reach out
            # if the file isn't already cached. The dev/desktop path (no cache_dir)
            # downloads on first use.
            #
            # str() is load-bearing: huggingface_hub ships with the optional
            # `local-ai` extra, so under CI's `.[dev]`-only install mypy resolves
            # it to Any (ignore_missing_imports) and strict mode rejects the
            # implicit Any return.
            if cache_dir is not None:
                try:
                    return str(
                        hf_hub_download(
                            self._repo, filename, cache_dir=cache_dir, local_files_only=True
                        )
                    )
                except Exception:
                    pass
            return str(hf_hub_download(self._repo, filename, cache_dir=cache_dir))

        providers = self._select_providers(ort)
        opts = ort.SessionOptions()
        # Local interactive workloads: cap intra-op threads to the physical core
        # count to avoid oversubscription on hyper-threaded CPUs.
        opts.intra_op_num_threads = max(1, (os.cpu_count() or 2) // 2)

        if self._vision_session is None:
            self._vision_session = ort.InferenceSession(
                fetch(_VISION_FILE), sess_options=opts, providers=providers
            )
        if self._text_session is None:
            self._text_session = ort.InferenceSession(
                fetch(_TEXT_FILE), sess_options=opts, providers=providers
            )
        if self._tokenizer is None:
            tok = Tokenizer.from_file(fetch(_TOKENIZER_FILE))
            pad_id = tok.token_to_id(_PAD_TOKEN) or 0
            tok.enable_truncation(max_length=_MAX_TOKENS)
            tok.enable_padding(length=_MAX_TOKENS, pad_id=pad_id, pad_token=_PAD_TOKEN)
            self._tokenizer = tok

        logger.info("SigLIP 2 encoder ready", providers=providers, repo=self._repo)

    def _select_providers(self, ort: Any) -> list[str]:
        """Pick onnxruntime execution providers, honouring ``allow_gpu``."""
        available = list(ort.get_available_providers())
        if not self._allow_gpu:
            return ["CPUExecutionProvider"]
        # Prefer an accelerator EP when present, always keep CPU as the fallback.
        preferred = [
            ep
            for ep in (
                "CUDAExecutionProvider",
                "CoreMLExecutionProvider",
                "DmlExecutionProvider",
                "ROCMExecutionProvider",
            )
            if ep in available
        ]
        return [*preferred, "CPUExecutionProvider"]

    def _resolve_io(self) -> None:
        """Resolve input/output tensor names from the loaded graphs (idempotent)."""
        if self._vision_input is None and self._vision_session is not None:
            self._vision_input = self._vision_session.get_inputs()[0].name
            self._vision_output = self._pick_output(self._vision_session)
        if not self._text_inputs and self._text_session is not None:
            self._text_inputs = tuple(i.name for i in self._text_session.get_inputs())
            self._text_output = self._pick_output(self._text_session)

    @staticmethod
    def _pick_output(session: Any) -> str:
        names = [str(o.name) for o in session.get_outputs()]
        lookup = {n.lower(): n for n in names}
        for candidate in _EMBED_OUTPUT_CANDIDATES:
            if candidate in lookup:
                return lookup[candidate]
        # Fall back to the last output — tower exports list pooled output last.
        return names[-1]

    # ------------------------------------------------------------------ #
    # Image side                                                          #
    # ------------------------------------------------------------------ #

    def _preprocess(self, image: Image) -> Any:
        """SigLIP pixel tensor: ``(1, 3, S, S)`` float32, normalised to mean/std 0.5."""
        import numpy as np
        from PIL import Image as PILImage

        img = _upright_rgb(image)
        if img.size != (self._image_size, self._image_size):
            img = img.resize((self._image_size, self._image_size), PILImage.Resampling.BILINEAR)
        arr = np.asarray(img, dtype=np.float32) / 255.0
        arr = (arr - _IMAGE_MEAN) / _IMAGE_STD
        # HWC → CHW → NCHW
        return np.ascontiguousarray(arr.transpose(2, 0, 1)[None, ...], dtype=np.float32)

    def embed_image(self, image: Image) -> Any | None:
        if not self._ensure_loaded():
            return None
        import numpy as np

        try:
            pixel_values = self._preprocess(image)
            assert self._vision_session is not None and self._vision_input is not None
            out = self._vision_session.run(
                [self._vision_output], {self._vision_input: pixel_values}
            )
            return np.asarray(out[0], dtype=np.float32).reshape(-1)
        except Exception as exc:
            logger.warning("SigLIP image embedding failed", error=str(exc))
            return None

    # ------------------------------------------------------------------ #
    # Text side                                                           #
    # ------------------------------------------------------------------ #

    def _tokenize(self, texts: list[str]) -> dict[str, Any]:
        import numpy as np

        assert self._tokenizer is not None
        # SigLIP's Gemma tokenizer is configured do_lower_case=True; apply it
        # explicitly so the fast tokenizer matches the reference processor.
        encodings = self._tokenizer.encode_batch([t.lower() for t in texts])
        input_ids = np.asarray([e.ids for e in encodings], dtype=np.int64)
        feeds: dict[str, Any] = {}
        for name in self._text_inputs:
            if "mask" in name.lower():
                feeds[name] = np.asarray([e.attention_mask for e in encodings], dtype=np.int64)
            else:
                feeds[name] = input_ids
        return feeds

    def embed_texts(self, texts: list[str]) -> Any | None:
        if not texts:
            return None
        if not self._ensure_loaded():
            return None
        import numpy as np

        key = tuple(texts)
        cached = self._text_cache.get(key)
        if cached is not None:
            return cached
        try:
            feeds = self._tokenize(list(texts))
            assert self._text_session is not None
            out = self._text_session.run([self._text_output], feeds)
            mat = np.asarray(out[0], dtype=np.float32)
            if mat.ndim == 1:
                mat = mat.reshape(1, -1)
            self._text_cache[key] = mat
            return mat
        except Exception as exc:
            logger.warning("SigLIP text embedding failed", error=str(exc))
            return None
