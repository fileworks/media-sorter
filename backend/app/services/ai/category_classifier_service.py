"""Smart Categorization classifier.

Routes a single media file into exactly one of the user's topic categories
(top-1 CLIP zero-shot) or leaves it ``None`` (→ ``_uncategorized``) when the
model is not confident enough. This is a *placement* decision (it changes where
a file lands) and is deliberately independent of AI tagging, though both share
the one :class:`~app.services.ai.clip_embedder.ClipEmbedder`.

Robustness against "nothing really fits" (a settings screenshot landing in
``nature``) comes from three compounding defences:

* **Prompt ensembling + descriptions** — each category is embedded from several
  template phrasings (and an enriched description for well-known topics),
  sharpening separation.
* **Background anchors** — generic distractor prompts sit in the softmax
  denominator only, so an out-of-vocabulary image sends its probability mass to
  the anchors instead of the least-wrong category.
* **An anchor-relative cosine floor** plus a categoriser-specific (un-saturated)
  softmax temperature, so the dual confidence/margin gate is actually meaningful
  rather than pinned at ≈1.0. The floor requires the winning category to explain
  the image at least as well as a generic "a photo" anchor — a model-agnostic
  bar rather than a hand-tuned absolute cosine.

The service is *synchronous* and strictly best-effort: it is invoked from the
worker-thread per-file paths of ``SortingService`` and ``PreviewService`` and
never raises — any failure (disabled, no categories, embedder unavailable,
unsupported type, below the confidence bar, unreadable file) yields a
``CategoryResult`` with ``category=None`` so a sort/preview is never broken.
"""

from __future__ import annotations

import contextlib
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.core.config import Config
from app.core.logging_config import get_logger
from app.services.ai.encoder_protocol import VisionEncoder
from app.services.ai.prompts import ANCHOR_PROMPTS, category_prompts, pool_normalized
from app.services.filesystem_service import open_image
from app.utils.ffmpeg_utils import extract_frame, probe_duration, sample_fractions
from app.utils.media_utils import is_image, is_video

if TYPE_CHECKING:
    import numpy as np
    from numpy.typing import NDArray

logger = get_logger(__name__)

# Keyframes sampled per video — kept identical to AITaggingService so the two
# features see the same frames. 5 frames improves scene-change coverage.
_VIDEO_FRAME_SAMPLES = 5

# Anchor-relative cosine floor. The winning category must be at least as similar
# to the image as the best generic "a photo" background anchor — otherwise a
# generic prompt explains the image better than any category, so route to
# ``_uncategorized``. Measuring against the image's own anchor cosine cancels the
# per-model cosine offset (correct CLIP ViT-B/32 matches and the anchors both sit
# near ≈0.20–0.26, so a fixed absolute floor wrongly rejects borderline-correct
# matches). This directly catches the "nothing really fits" case the softmax
# alone hides, without a hand-tuned, model-specific constant.


@dataclass(frozen=True)
class CategoryResult:
    """Outcome of classifying one file.

    ``category`` is the chosen (already path-safe) folder name, or ``None`` when
    the file is uncategorized. ``confidence`` is the top-1 softmax probability
    (over categories *and* background anchors) and ``margin`` is ``top1 - top2``
    among the categories — both surfaced for logging/diagnostics.
    """

    category: str | None
    confidence: float
    margin: float


_UNCATEGORIZED = CategoryResult(None, 0.0, 0.0)


class CategoryClassifierService:
    """Classify a media file into one user-defined topic category, or ``None``."""

    def __init__(self, config: Config, embedder: VisionEncoder | None) -> None:
        self._config = config
        self._embedder = embedder

    def categories(self) -> list[str]:
        """Return the de-duplicated, path-sanitized category folder names.

        Sanitizing here (not only at build time) means the names used as CLIP
        labels are exactly the folder names that will be created, so the
        prediction and the placement can never disagree.
        """
        from app.utils.path_utils import sanitize_path_segment

        out: list[str] = []
        seen: set[str] = set()
        for raw in self._config.categorize_categories:
            safe = sanitize_path_segment(raw)
            if not safe:
                continue
            key = safe.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(safe)
        return out

    def classify_file(self, path: Path) -> CategoryResult:
        """Classify *path* into one category or ``None``. Never raises."""
        if self._embedder is None or not self._config.categorize_enabled:
            return _UNCATEGORIZED
        cats = self.categories()
        if not cats:
            return _UNCATEGORIZED
        try:
            import numpy as np

            vecs = self._prompt_matrix(cats)
            if vecs is None:  # embedder unavailable / model missing
                return _UNCATEGORIZED
            cat_vecs, anchor_vecs = vecs

            if is_image(path):
                img_emb = self._image_embedding(path)
            elif is_video(path):
                img_emb = self._video_embedding(path)
            else:
                return _UNCATEGORIZED
            if img_emb is None:
                return _UNCATEGORIZED

            img = np.asarray(img_emb, dtype=np.float32).reshape(-1)
            img_n = img / (np.linalg.norm(img) + 1e-8)
            cat_sims = cat_vecs @ img_n
            anchor_sims = anchor_vecs @ img_n if anchor_vecs.size else None
            return self._gate(cat_sims, anchor_sims, cats)
        except Exception as exc:  # pragma: no cover - defensive catch-all
            logger.warning("Categorization failed", path=str(path), error=str(exc))
            return _UNCATEGORIZED

    # ------------------------------------------------------------------ #
    # Text-side: ensembled category + anchor vectors                       #
    # ------------------------------------------------------------------ #

    def _prompt_matrix(
        self, cats: list[str]
    ) -> tuple[NDArray[np.float32], NDArray[np.float32]] | None:
        """Return ``(category_vectors, anchor_vectors)`` as unit-row matrices.

        Each category vector is the ensemble (mean of normalised embeddings) of
        its template + description prompts; each anchor is a single prompt. All
        prompts are embedded in one cached call. Returns ``None`` when the
        embedder is unavailable.
        """
        import numpy as np

        cat_prompts: list[str] = []
        cat_sizes: list[int] = []
        for c in cats:
            prompts = category_prompts(c)
            cat_prompts.extend(prompts)
            cat_sizes.append(len(prompts))

        anchor_prompts = list(ANCHOR_PROMPTS)
        embedder = self._embedder
        if embedder is None:
            return None
        raw = embedder.embed_texts(cat_prompts + anchor_prompts)
        if raw is None:
            return None
        raw_arr = np.asarray(raw, dtype=np.float32)
        split = len(cat_prompts)
        cat_vecs = pool_normalized(raw_arr[:split], cat_sizes)
        anchor_vecs = pool_normalized(raw_arr[split:], [1] * len(anchor_prompts))
        return cat_vecs, anchor_vecs

    # ------------------------------------------------------------------ #
    # Image-side: a single (averaged) embedding per file                   #
    # ------------------------------------------------------------------ #

    def _image_embedding(self, path: Path) -> Any | None:
        """Raw CLIP embedding for an image file, or ``None``."""
        embedder = self._embedder
        if embedder is None:
            return None
        with open_image(path) as img:
            if img is None:
                return None
            return embedder.embed_image(img)

    def _video_embedding(self, path: Path) -> Any | None:
        """Mean raw embedding across sampled keyframes, or ``None``."""
        import numpy as np

        duration = probe_duration(path)
        if duration is None or duration <= 0:
            return None
        embedder = self._embedder
        if embedder is None:
            return None
        acc: Any | None = None
        n = 0
        for frac in sample_fractions(_VIDEO_FRAME_SAMPLES):
            frame = extract_frame(path, duration * frac)
            if frame is None:
                continue
            try:
                emb = embedder.embed_image(frame)
                if emb is None:
                    continue
                vec = np.asarray(emb, dtype=np.float32).reshape(-1)
                acc = vec if acc is None else acc + vec
                n += 1
            except Exception:
                pass
            finally:
                with contextlib.suppress(Exception):
                    frame.close()
        if n == 0 or acc is None:
            return None
        return acc / float(n)

    # ------------------------------------------------------------------ #
    # Confidence gate                                                       #
    # ------------------------------------------------------------------ #

    def _gate(self, cat_sims: Any, anchor_sims: Any, cats: list[str]) -> CategoryResult:
        """Apply the floor + temperature-scaled softmax + dual (threshold, margin) gate.

        *cat_sims* are the per-category cosine similarities; *anchor_sims* (or
        ``None``) the background-anchor similarities, included in the softmax
        denominator only so an out-of-vocabulary image can't be forced into a
        category.
        """
        import numpy as np

        cat = np.asarray(cat_sims, dtype=np.float32).reshape(-1)
        anchors = (
            np.asarray(anchor_sims, dtype=np.float32).reshape(-1)
            if anchor_sims is not None
            else np.empty(0, dtype=np.float32)
        )

        embedder = self._embedder
        if embedder is None:
            return _UNCATEGORIZED
        logits = embedder.categorize_scale * np.concatenate([cat, anchors])
        logits = logits - logits.max()
        exp = np.exp(logits)
        probs = exp / (exp.sum() + 1e-8)
        cat_probs = probs[: cat.shape[0]]

        order = np.argsort(cat_probs)[::-1]
        top1 = float(cat_probs[order[0]])
        top2 = float(cat_probs[order[1]]) if order.shape[0] > 1 else 0.0
        margin = top1 - top2
        best_cosine = float(cat[order[0]])
        # Background level: best generic-anchor cosine (−inf when no anchors, so
        # the floor is a no-op and the softmax/threshold/margin gate alone decides).
        background = float(anchors.max()) if anchors.size else float("-inf")

        if (
            best_cosine >= background
            and top1 >= self._config.categorize_confidence_threshold
            and margin >= self._config.categorize_min_margin
        ):
            return CategoryResult(cats[int(order[0])], top1, margin)
        return CategoryResult(None, top1, margin)
