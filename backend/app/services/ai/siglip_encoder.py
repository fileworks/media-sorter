"""SigLIP 2 vision+text encoder backed by onnxruntime (the "Standard" tier).

The one shipped local encoder. It implements the
:class:`~app.services.ai.encoder_protocol.VisionEncoder` contract, so AI tagging
and Smart Categorization consume it without caring which model is loaded.

Why SigLIP 2 (Google, 2025): substantially stronger zero-shot than CLIP ViT-B/32
(~79% vs ~63% ImageNet) at the *exact* task both features use (image↔text-label
matching), with a sigmoid training objective that matches the multi-label tagger.
ONNX weights live at ``onnx-community/siglip2-base-patch16-256-ONNX`` (Apache-2.0)
and quantize to ~100 MB per tower, so it runs on a moderate laptop CPU.

Design notes
------------
* **Inference loading is lazy and offline.** Heavy imports and session
  construction happen only on first real use. Downloads are handled separately
  by the explicit, verified model installer; this class never contacts a network.
  A load failure flips :pyattr:`available` to ``False``.
* **Runtime-adaptive I/O.** Input names (``pixel_values`` / ``input_ids`` /
  ``attention_mask``) and the pooled-embedding output name are resolved from the
  loaded graph rather than hardcoded, so a slightly different export still works.
* **Loaded once, published whole.** A lock makes concurrent first use load the
  sessions once; they become visible only when vision, text and tokenizer are
  all ready (AI-NEW-1).
* **One text at a time.** The int8 text tower quantizes activations per batch,
  so a label's vector used to depend on which other labels shared its batch
  (cosine as low as 0.998 against encoding it alone). Encoding each text alone
  makes every label's vector deterministic and avoids the ~340 MB activation
  peak an 80-prompt batch caused, at the same speed.
* **Bounded text cache, released text tower.** Text vectors are cached per text
  in a bounded LRU of read-only arrays (AI-NEW-2). The text tower (~280 MB
  resident) is only needed on a cache miss, so it is released after
  ``TEXT_SESSION_IDLE_SECONDS`` without text work and reloaded on demand (AI-12).
* **Injectable** vision/text sessions + tokenizer (any object exposing the small
  duck-typed interface used below) so tests run without a real download.
"""

from __future__ import annotations

import os
import threading
from collections import OrderedDict
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.core.logging_config import get_logger
from app.services.ai.encoder_protocol import VisionEncoder
from app.services.ai.model_installation import AiModelStore

if TYPE_CHECKING:
    from PIL.Image import Image

logger = get_logger(__name__)

# onnx-community SigLIP 2 base/16 @256 (Apache-2.0). Its immutable commit and
# file digests live in ai-models.json; these names only address installed files.
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

#: Distinct texts whose vectors stay cached: 4096 x 768 float32 is about 12.6 MB,
#: far more than the bundled vocabularies and a generous custom one need.
TEXT_CACHE_ENTRIES = 4096
#: Seconds without text work before the text tower is released.
TEXT_SESSION_IDLE_SECONDS = 30.0


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
    them. Returned text matrices are read-only: their rows are shared via the cache.
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
        model_store: AiModelStore | None = None,
    ) -> None:
        self._repo = repo
        self._allow_gpu = allow_gpu
        self._image_size = image_size
        self._vision_session: Any | None = vision_session
        self._text_session: Any | None = text_session
        self._tokenizer: Any | None = tokenizer
        self._model_store = model_store
        self._load_failed = False
        self._lock = threading.RLock()
        self._ready = False
        # Only a text session this encoder built can be released and rebuilt.
        self._owns_text_session = text_session is None
        self._text_model_path: str | None = None
        self._session_options: Any | None = None
        self._providers: list[str] = []
        self._text_cache: OrderedDict[str, Any] = OrderedDict()
        self._idle_timer: threading.Timer | None = None
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
        if self._ready:
            return True
        with self._lock:
            if self._ready:
                return True
            if self._load_failed:
                return False
            try:
                if (
                    self._vision_session is None
                    or self._text_session is None
                    or self._tokenizer is None
                ):
                    self._load()
                self._resolve_io()
                self._ready = True
                return True
            except Exception as exc:  # pragma: no cover - depends on optional runtime/deps
                self._load_failed = True
                logger.warning(
                    "SigLIP 2 encoder unavailable",
                    error=str(exc),
                    repo=self._repo,
                )
                return False

    def _load(self) -> None:
        """Build every missing part, then publish them together (caller holds the lock)."""
        import onnxruntime as ort
        from tokenizers import Tokenizer

        components = (
            self._model_store.component_paths("siglip-standard-v1", verify=True)
            if self._model_store is not None
            else None
        )
        if components is None:
            raise FileNotFoundError("the verified SigLIP model pack is not installed")
        model_root = components["model"]

        def installed(filename: str) -> str:
            candidate = model_root.joinpath(*Path(filename).parts)
            candidate.relative_to(model_root)
            if not candidate.is_file():
                raise FileNotFoundError(candidate)
            return str(candidate)

        providers = self._select_providers(ort)
        opts = ort.SessionOptions()
        # Local interactive workloads: cap intra-op threads to the physical core
        # count to avoid oversubscription on hyper-threaded CPUs.
        opts.intra_op_num_threads = max(1, (os.cpu_count() or 2) // 2)
        text_path = installed(_TEXT_FILE)

        vision = self._vision_session or ort.InferenceSession(
            installed(_VISION_FILE), sess_options=opts, providers=providers
        )
        text = self._text_session or ort.InferenceSession(
            text_path, sess_options=opts, providers=providers
        )
        tokenizer = self._tokenizer
        if tokenizer is None:
            tokenizer = Tokenizer.from_file(installed(_TOKENIZER_FILE))
            pad_id = tokenizer.token_to_id(_PAD_TOKEN) or 0
            tokenizer.enable_truncation(max_length=_MAX_TOKENS)
            tokenizer.enable_padding(length=_MAX_TOKENS, pad_id=pad_id, pad_token=_PAD_TOKEN)

        self._vision_session, self._text_session, self._tokenizer = vision, text, tokenizer
        self._text_model_path, self._session_options, self._providers = text_path, opts, providers
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

        try:
            rows = [self._text_vector(text) for text in texts]
        except Exception as exc:
            logger.warning("SigLIP text embedding failed", error=str(exc))
            return None
        matrix = np.vstack(rows)
        matrix.setflags(write=False)
        return matrix

    def _text_vector(self, text: str) -> Any:
        """One text's read-only vector, from the cache or encoded alone."""
        import numpy as np

        with self._lock:
            cached = self._text_cache.get(text)
            if cached is not None:
                self._text_cache.move_to_end(text)
                return cached
            session = self._text_session_for_use()
            out = session.run([self._text_output], self._tokenize([text]))
            vector = np.array(np.asarray(out[0], dtype=np.float32).reshape(-1), copy=True)
            vector.setflags(write=False)
            self._text_cache[text] = vector
            while len(self._text_cache) > TEXT_CACHE_ENTRIES:
                self._text_cache.popitem(last=False)
            self._schedule_text_release()
            return vector

    def _text_session_for_use(self) -> Any:
        """The text session, rebuilt if it was released (caller holds the lock)."""
        if self._text_session is None:
            import onnxruntime as ort

            if self._text_model_path is None:
                raise RuntimeError("the SigLIP text model was released and cannot be reloaded")
            self._text_session = ort.InferenceSession(
                self._text_model_path,
                sess_options=self._session_options,
                providers=self._providers,
            )
            logger.info("SigLIP 2 text model reloaded")
        return self._text_session

    def _schedule_text_release(self) -> None:
        if not self._owns_text_session or TEXT_SESSION_IDLE_SECONDS <= 0:
            return
        if self._idle_timer is not None:
            self._idle_timer.cancel()
        timer = threading.Timer(TEXT_SESSION_IDLE_SECONDS, self.release_text_session)
        timer.daemon = True
        self._idle_timer = timer
        timer.start()

    def release_text_session(self) -> None:
        """Free the text tower; cached vectors stay and a miss reloads it."""
        with self._lock:
            if self._idle_timer is not None:
                self._idle_timer.cancel()
                self._idle_timer = None
            if self._owns_text_session and self._text_session is not None:
                self._text_session = None
                logger.info("SigLIP 2 text model released", cached_texts=len(self._text_cache))
