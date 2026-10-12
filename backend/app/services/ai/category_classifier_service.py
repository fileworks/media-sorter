"""Smart Categorization classifier.

Routes a single media file into exactly one of the user's topic categories
(top-1 CLIP zero-shot) or leaves it ``None`` (→ ``_uncategorized``) when the
model is not confident enough. This is a *placement* decision (it changes where
a file lands) and is deliberately independent of AI tagging, though both share
the one shared local encoder.

Scoring follows the evaluated contract in ``docs/local-ai-evaluation.md``
(public held-out fixtures, 2026-10-12):

* **Best prompt per category** — each category is described by several
  phrasings (templates plus an enriched description); its score is the best
  single phrasing's cosine, which separated categories better than the
  averaged ensemble.
* **SigLIP's own scale** — the softmax over categories uses the model's learned
  logit scale (the encoder's ``categorize_scale``), so the user's confidence
  and margin settings act on probabilities in the model's native units.
* **An absolute floor** — the winning category must reach the encoder's
  ``categorize_floor`` cosine; below it nothing fits clearly enough and the file
  stays in ``_uncategorized``. This replaced generic "a photo" anchors, which
  rejected almost everything (coverage 5 % in English, 0 % in German).
* **English prompts for bundled categories** — the folder keeps the interface
  language's name, but the bundled concepts are scored with their English
  prompts, which held out at 95 % accuracy against 89 % with German prompts.
  Custom categories are scored in the interface language.

The service is *synchronous* and strictly best-effort: it is invoked from the
worker-thread per-file paths of ``SortingService`` and ``PreviewService`` and
never raises — any failure (disabled, no categories, embedder unavailable,
unsupported type, below the confidence bar, unreadable file) yields a
``CategoryResult`` with ``category=None`` so a sort/preview is never broken.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from app.core.concepts import bundled_labels
from app.core.config import Config
from app.core.logging_config import get_logger
from app.services.ai.encoder_protocol import VisionEncoder
from app.services.ai.image_embeddings import file_embedding
from app.services.ai.prompts import prompt_group
from app.services.ai.video_sampling import (
    VIDEO_FRAME_SAMPLES,
    FrameSampling,
    InferenceCancelled,
    StopCheck,
    log_sampling,
    raise_if_stopped,
    sample_frames,
)
from app.utils.media_utils import is_image, is_video

if TYPE_CHECKING:
    import numpy as np
    from numpy.typing import NDArray

logger = get_logger(__name__)

# Keyframes sampled per video — kept identical to AITaggingService so the two
# features see the same frames. 5 frames improves scene-change coverage.
_VIDEO_FRAME_SAMPLES = 5

#: Why a classified file stayed uncategorized: no category fitted clearly
#: enough (below the encoder's floor), its confidence missed the threshold, or
#: it did not lead the next category by the minimum margin.
CategoryRejection = Literal["weak_match", "confidence", "margin"]


@dataclass(frozen=True)
class CategoryResult:
    """Outcome of classifying one file.

    ``category`` is the chosen (already path-safe) folder name, or ``None`` when
    the file is uncategorized. ``confidence`` is the top-1 softmax probability
    over the categories and ``margin`` is ``top1 - top2``. ``rejection`` names
    the first gate an uncategorized result failed, so Review can say why.
    """

    category: str | None
    confidence: float
    margin: float
    rejection: CategoryRejection | None = None


_UNCATEGORIZED = CategoryResult(None, 0.0, 0.0)


class CategoryClassifierService:
    """Classify a media file into one user-defined topic category, or ``None``."""

    def __init__(self, config: Config, embedder: VisionEncoder | None) -> None:
        self._config = config
        self._embedder = embedder

    def for_operation(self, config: Config) -> CategoryClassifierService:
        """Reuse the loaded encoder while freezing config and locale for one operation."""
        return CategoryClassifierService(config, self._embedder)

    def categories(self) -> list[str]:
        """Return the de-duplicated, path-sanitized category folder names.

        Sanitizing here (not only at build time) means the names used as CLIP
        labels are exactly the folder names that will be created, so the
        prediction and the placement can never disagree.
        """
        from app.utils.path_utils import sanitize_path_segment

        out: list[str] = []
        seen: set[str] = set()
        for raw in self._config.resolved_categories():
            safe = sanitize_path_segment(raw)
            if not safe:
                continue
            key = safe.lower()
            if key in seen:
                continue
            seen.add(key)
            out.append(safe)
        return out

    def classify_file(self, path: Path, should_stop: StopCheck | None = None) -> CategoryResult:
        """Classify *path* into one category or ``None``.

        Never raises, except :class:`InferenceCancelled` once *should_stop* says so.
        """
        if self._embedder is None or not self._config.categorize_enabled:
            return _UNCATEGORIZED
        cats = self.categories()
        if not cats:
            return _UNCATEGORIZED
        raise_if_stopped(should_stop)
        try:
            import numpy as np

            groups = self._prompt_groups(cats)
            if groups is None:  # embedder unavailable / model missing
                return _UNCATEGORIZED

            if is_image(path):
                img_emb = self._image_embedding(path)
            elif is_video(path):
                img_emb = self._video_embedding(path, should_stop)
            else:
                return _UNCATEGORIZED
            if img_emb is None:
                return _UNCATEGORIZED

            img = np.asarray(img_emb, dtype=np.float32).reshape(-1)
            img_n = img / (np.linalg.norm(img) + 1e-8)
            return self._gate(category_similarities(groups, img_n), cats)
        except InferenceCancelled:
            raise
        except Exception as exc:  # pragma: no cover - defensive catch-all
            logger.warning("Categorization failed", path=str(path), error=str(exc))
            return _UNCATEGORIZED

    # ------------------------------------------------------------------ #
    # Text-side: every category's prompt vectors                           #
    # ------------------------------------------------------------------ #

    def _prompt_groups(self, cats: list[str]) -> list[NDArray[np.float32]] | None:
        """Unit prompt vectors per category, in *cats* order, or ``None``.

        Bundled categories are scored with their English concept prompts (see
        the module docstring); custom ones in the interface language. All
        prompts go through the encoder's text cache in one call.
        """
        import numpy as np

        embedder = self._embedder
        if embedder is None:
            return None
        model_id = str(getattr(embedder, "model_id", "unknown"))
        bundled = self._config.categorize_categories_provenance == "bundled"
        english = (
            dict(
                zip(
                    bundled_labels("category", self._config.language),
                    bundled_labels("category", "en"),
                    strict=True,
                )
            )
            if bundled
            else {}
        )
        prompts: list[str] = []
        sizes: list[int] = []
        for name in cats:
            label = english.get(name)
            group = prompt_group(
                label if label is not None else name,
                operation_locale="en" if label is not None else self._config.language,
                model_id=model_id,
                bundled=label is not None,
            )
            prompts.extend(group)
            sizes.append(len(group))
        raw = embedder.embed_texts(prompts)
        if raw is None:
            return None
        unit = np.asarray(raw, dtype=np.float32)
        unit = unit / (np.linalg.norm(unit, axis=1, keepdims=True) + 1e-8)
        groups: list[NDArray[np.float32]] = []
        start = 0
        for size in sizes:
            groups.append(unit[start : start + size])
            start += size
        return groups

    # ------------------------------------------------------------------ #
    # Image-side: a single (averaged) embedding per file                   #
    # ------------------------------------------------------------------ #

    def _image_embedding(self, path: Path) -> Any | None:
        """Raw image embedding for a file, shared with tagging (AI-07), or ``None``."""
        embedder = self._embedder
        if embedder is None:
            return None
        return file_embedding(embedder, path)

    def _video_embedding(self, path: Path, should_stop: StopCheck | None = None) -> Any | None:
        """Unit mean of the sampled frames' unit embeddings, or ``None``.

        Each frame is normalised before averaging, so a frame with a larger raw
        embedding norm no longer outweighs the others (AI-09).
        """
        import numpy as np

        embedder = self._embedder
        if embedder is None:
            return None
        sampling = FrameSampling(VIDEO_FRAME_SAMPLES)
        acc: Any | None = None
        n = 0
        for frame in sample_frames(path, sampling, should_stop=should_stop):
            try:
                emb = embedder.embed_image(frame)
            except Exception:
                continue
            if emb is None:
                continue
            vec = np.asarray(emb, dtype=np.float32).reshape(-1)
            norm = float(np.linalg.norm(vec))
            if not np.isfinite(norm) or norm == 0.0:
                continue
            unit = vec / norm
            acc = unit if acc is None else acc + unit
            n += 1
        log_sampling(path, sampling, purpose="categorization")
        if n == 0 or acc is None:
            return None
        mean = acc / float(n)
        return mean / (float(np.linalg.norm(mean)) + 1e-8)

    # ------------------------------------------------------------------ #
    # Confidence gate                                                       #
    # ------------------------------------------------------------------ #

    def _gate(self, cat_sims: Any, cats: list[str]) -> CategoryResult:
        """Apply the floor, the native-scale softmax and the confidence/margin gate.

        *cat_sims* are the per-category cosine similarities (best prompt each).
        """
        import numpy as np

        cat = np.asarray(cat_sims, dtype=np.float32).reshape(-1)
        embedder = self._embedder
        if embedder is None or cat.size == 0:
            return _UNCATEGORIZED
        logits = embedder.categorize_scale * cat
        logits = logits - logits.max()
        exp = np.exp(logits)
        probs = exp / (exp.sum() + 1e-8)

        order = np.argsort(probs)[::-1]
        top1 = float(probs[order[0]])
        top2 = float(probs[order[1]]) if order.shape[0] > 1 else 0.0
        margin = top1 - top2
        best_cosine = float(cat[order[0]])

        rejection: CategoryRejection | None = None
        if best_cosine < float(getattr(embedder, "categorize_floor", -1.0)):
            rejection = "weak_match"
        elif top1 < self._config.categorize_confidence_threshold:
            rejection = "confidence"
        elif margin < self._config.categorize_min_margin:
            rejection = "margin"
        if rejection is None:
            return CategoryResult(cats[int(order[0])], top1, margin)
        return CategoryResult(None, top1, margin, rejection)


def category_similarities(groups: list[NDArray[np.float32]], image: Any) -> NDArray[np.float32]:
    """Each category's best prompt cosine against a unit image vector."""
    import numpy as np

    return np.asarray([float((rows @ image).max()) for rows in groups], dtype=np.float32)
