"""Smart Category Name Suggestions.

Samples images from the user's source directory, clusters them with k-means
(pure numpy), and names each cluster by matching the centroid to a curated
vocabulary via cosine similarity.
"""

from __future__ import annotations

import random
from pathlib import Path
from typing import TYPE_CHECKING

from app.core.config import Config
from app.core.logging_config import get_logger
from app.services.ai.encoder_protocol import VisionEncoder
from app.services.analysis_service import AnalysisService
from app.services.filesystem_service import open_image
from app.utils.media_utils import is_image

if TYPE_CHECKING:
    import numpy as np
    from numpy.typing import NDArray

logger = get_logger(__name__)

_MAX_SAMPLES = 150
_KMEANS_ITERS = 15

_VOCABULARY: tuple[str, ...] = (
    "nature",
    "landscape",
    "mountains",
    "beach",
    "forest",
    "ocean",
    "sunset",
    "travel",
    "city",
    "architecture",
    "street",
    "buildings",
    "urban",
    "family",
    "friends",
    "portrait",
    "selfie",
    "people",
    "baby",
    "wedding",
    "birthday",
    "celebration",
    "party",
    "holidays",
    "christmas",
    "food",
    "cooking",
    "restaurant",
    "coffee",
    "drinks",
    "animals",
    "pets",
    "dogs",
    "cats",
    "birds",
    "wildlife",
    "sports",
    "fitness",
    "hiking",
    "cycling",
    "cars",
    "vehicles",
    "transportation",
    "art",
    "music",
    "concert",
    "work",
    "documents",
    "screenshots",
    "vacation",
    "summer",
    "winter",
    "flowers",
    "garden",
    "plants",
    "home",
    "interior",
    "decor",
    "kids",
    "school",
)


def _kmeans_centroids(X: NDArray[np.float32], k: int, n_iter: int) -> NDArray[np.float32]:
    """Lloyd's k-means on unit-normed rows of *X*, returning *k* centroids."""
    import numpy as np

    n = X.shape[0]
    k = min(k, n)
    rng = np.random.default_rng(42)
    centroids: NDArray[np.float32] = X[rng.choice(n, size=k, replace=False)].copy()

    for _ in range(n_iter):
        labels = np.argmax(X @ centroids.T, axis=1)
        new_c = np.zeros_like(centroids)
        for j in range(k):
            mask = labels == j
            new_c[j] = X[mask].mean(axis=0) if mask.any() else X[rng.integers(n)]
        centroids = new_c

    return centroids


class CategorySuggestionService:
    """Suggest folder names by clustering a sample of source images."""

    def __init__(self, config: Config, encoder: VisionEncoder | None) -> None:
        self._config = config
        self._encoder = encoder
        self._vocab_cache: NDArray[np.float32] | None = None

    def _vocab_embeddings(self) -> NDArray[np.float32] | None:
        if self._vocab_cache is not None:
            return self._vocab_cache
        encoder = self._encoder
        if encoder is None:
            return None
        import numpy as np

        raw = encoder.embed_texts([f"a photo of {w}" for w in _VOCABULARY])
        if raw is None:
            return None
        arr = np.asarray(raw, dtype=np.float32)
        norms = np.linalg.norm(arr, axis=1, keepdims=True) + 1e-8
        self._vocab_cache = arr / norms
        return self._vocab_cache

    def suggest(self, n: int) -> list[str]:
        """Return *n* deduplicated category name suggestions, or [] on failure."""
        if self._encoder is None:
            return []
        source = self._config.source_directory
        if not source:
            return []
        source_path = Path(source)
        if not source_path.is_dir():
            return []
        try:
            return self._suggest_sync(source_path, n)
        except Exception as exc:
            logger.warning("Category suggestion failed", error=str(exc))
            return []

    def _suggest_sync(self, source: Path, n: int) -> list[str]:
        import numpy as np

        encoder = self._encoder
        if encoder is None:
            return []

        candidates = [
            p
            for p in AnalysisService._iter_candidate_files(
                source,
                recursive=self._config.recursive_scan,
                max_depth=self._config.max_recursion_depth,
                exclude_patterns=self._config.exclude_patterns or [],
            )
            if p.is_file() and is_image(p)
        ]
        if not candidates:
            return []
        random.shuffle(candidates)
        samples = candidates[:_MAX_SAMPLES]

        vecs: list[NDArray[np.float32]] = []
        for path in samples:
            try:
                with open_image(path) as img:
                    if img is None:
                        continue
                    emb = encoder.embed_image(img)
                    if emb is None:
                        continue
                    v = np.asarray(emb, dtype=np.float32).reshape(-1)
                    norm = float(np.linalg.norm(v))
                    if norm > 1e-8:
                        vecs.append(v / norm)
            except Exception:
                continue

        if len(vecs) < 2:
            return []

        X = np.stack(vecs)
        k = min(n, len(vecs))
        centroids = _kmeans_centroids(X, k, _KMEANS_ITERS)
        norms = np.linalg.norm(centroids, axis=1, keepdims=True) + 1e-8
        centroids_n = centroids / norms

        vocab_embs = self._vocab_embeddings()
        if vocab_embs is None:
            return []

        best_idx = np.argmax(centroids_n @ vocab_embs.T, axis=1)

        labels: list[str] = []
        seen: set[str] = set()
        for idx in best_idx:
            label = _VOCABULARY[int(idx)]
            if label not in seen:
                seen.add(label)
                labels.append(label)
        return labels
