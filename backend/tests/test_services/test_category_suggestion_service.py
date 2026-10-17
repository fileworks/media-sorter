"""Unit tests for CategorySuggestionService.

A deterministic stand-in encoder maps each vocabulary word to its own axis, so
clustering and naming can be checked without a model.
"""

from pathlib import Path
from unittest.mock import MagicMock, patch

import numpy as np

from app.core.config import Config
from app.services.ai.category_suggestion_service import (
    CategorySuggestionService,
    _kmeans_centroids,
)


def _mock_config(source: str = "") -> Config:
    cfg = Config()
    cfg.source_directory = source
    cfg.recursive_scan = False
    cfg.max_recursion_depth = None
    cfg.exclude_patterns = []
    return cfg


def test_suggest_returns_empty_when_no_encoder() -> None:
    svc = CategorySuggestionService(config=_mock_config("/some/path"), encoder=None)
    assert svc.suggest(5) == []


def test_suggest_returns_empty_when_no_source() -> None:
    enc = MagicMock()
    svc = CategorySuggestionService(config=_mock_config(""), encoder=enc)
    assert svc.suggest(5) == []


def test_suggest_returns_empty_when_source_missing() -> None:
    enc = MagicMock()
    svc = CategorySuggestionService(config=_mock_config("/nonexistent/path"), encoder=enc)
    assert svc.suggest(5) == []


def test_kmeans_centroids_shape() -> None:
    rng = np.random.default_rng(0)
    X = rng.standard_normal((20, 32)).astype(np.float32)
    norms = np.linalg.norm(X, axis=1, keepdims=True) + 1e-8
    X /= norms
    centroids = _kmeans_centroids(X, k=3, n_iter=5)
    assert centroids.shape == (3, 32)


def test_kmeans_centroids_fewer_points_than_k() -> None:
    rng = np.random.default_rng(1)
    X = rng.standard_normal((2, 16)).astype(np.float32)
    norms = np.linalg.norm(X, axis=1, keepdims=True) + 1e-8
    X /= norms
    centroids = _kmeans_centroids(X, k=5, n_iter=3)
    assert centroids.shape == (2, 16)


def _one_hot_encoder() -> MagicMock:
    from app.services.ai.category_suggestion_service import _VOCABULARY

    enc = MagicMock()
    enc.embed_texts.side_effect = lambda texts: np.eye(
        len(texts), len(_VOCABULARY), dtype=np.float32
    )
    return enc


def _axis(word: str) -> np.ndarray:
    from app.services.ai.category_suggestion_service import _VOCABULARY

    vector = np.zeros(len(_VOCABULARY), dtype=np.float32)
    vector[_VOCABULARY.index(word)] = 1.0
    return vector


def _suggest(tmp_path: Path, words: list[str], cfg: Config, n: int = 3) -> list[str]:
    for index in range(len(words)):
        (tmp_path / f"{index}.jpg").touch()
    by_name = {f"{index}.jpg": _axis(word) for index, word in enumerate(words)}
    with (
        patch("app.services.ai.category_suggestion_service.is_image", return_value=True),
        patch(
            "app.services.ai.category_suggestion_service.file_embedding",
            side_effect=lambda _enc, path: by_name[path.name],
        ),
    ):
        return CategorySuggestionService(config=cfg, encoder=_one_hot_encoder()).suggest(n)


def test_suggest_deduplicates_labels(tmp_path: Path) -> None:
    """Every sample shows the same subject: one suggestion, not three copies."""
    cfg = _mock_config(str(tmp_path))
    cfg.categorize_categories = ["work"]
    cfg.categorize_categories_provenance = "custom"

    assert _suggest(tmp_path, ["coffee"] * 4, cfg) == ["coffee"]


def test_suggestions_skip_categories_the_user_already_has(tmp_path: Path) -> None:
    cfg = _mock_config(str(tmp_path))
    cfg.categorize_categories = ["Coffee"]
    cfg.categorize_categories_provenance = "custom"

    assert _suggest(tmp_path, ["coffee"] * 4, cfg) == []


def test_german_interfaces_get_german_folder_names(tmp_path: Path) -> None:
    cfg = _mock_config(str(tmp_path))
    cfg.language = "de"
    cfg.categorize_categories = ["Arbeit"]
    cfg.categorize_categories_provenance = "custom"

    assert _suggest(tmp_path, ["coffee"] * 4, cfg) == ["Kaffee"]
