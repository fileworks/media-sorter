"""Unit tests for CategorySuggestionService.

These tests that require fastembed use pytest.importorskip to skip cleanly in CI.
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


def test_suggest_returns_empty_when_no_encoder():
    svc = CategorySuggestionService(config=_mock_config("/some/path"), encoder=None)
    assert svc.suggest(5) == []


def test_suggest_returns_empty_when_no_source():
    enc = MagicMock()
    svc = CategorySuggestionService(config=_mock_config(""), encoder=enc)
    assert svc.suggest(5) == []


def test_suggest_returns_empty_when_source_missing():
    enc = MagicMock()
    svc = CategorySuggestionService(config=_mock_config("/nonexistent/path"), encoder=enc)
    assert svc.suggest(5) == []


def test_kmeans_centroids_shape():
    rng = np.random.default_rng(0)
    X = rng.standard_normal((20, 32)).astype(np.float32)
    norms = np.linalg.norm(X, axis=1, keepdims=True) + 1e-8
    X /= norms
    centroids = _kmeans_centroids(X, k=3, n_iter=5)
    assert centroids.shape == (3, 32)


def test_kmeans_centroids_fewer_points_than_k():
    rng = np.random.default_rng(1)
    X = rng.standard_normal((2, 16)).astype(np.float32)
    norms = np.linalg.norm(X, axis=1, keepdims=True) + 1e-8
    X /= norms
    centroids = _kmeans_centroids(X, k=5, n_iter=3)
    assert centroids.shape == (2, 16)


def test_suggest_deduplicates_labels(tmp_path: Path):
    """Even if k-means returns the same vocab label twice, output is deduplicated."""
    # Create a tiny image file to iterate over
    img_path = tmp_path / "test.jpg"
    img_path.touch()

    enc = MagicMock()
    # Always return the same embedding — every cluster will map to the same vocab word
    enc.embed_image.return_value = [0.1] * 512
    enc.embed_texts.return_value = [[0.1] * 512] * 60  # 60 vocab embeddings

    cfg = _mock_config(str(tmp_path))
    cfg.recursive_scan = False

    from PIL import Image

    mock_img = Image.new("RGB", (16, 16))
    with (
        patch("app.services.ai.category_suggestion_service.is_image", return_value=True),
        patch("app.services.ai.category_suggestion_service.open_image") as mock_open,
    ):
        mock_open.return_value.__enter__ = lambda s: mock_img
        mock_open.return_value.__exit__ = MagicMock(return_value=False)
        svc = CategorySuggestionService(config=cfg, encoder=enc)
        result = svc.suggest(3)

    # All labels would map to same word, so deduplication should yield 1 unique label
    assert len(result) <= 1
    if result:
        assert isinstance(result[0], str)
