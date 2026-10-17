"""AI-07 — one decode and vision run per file, shared by categorization and tagging."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import numpy as np
import pytest
from PIL import Image

from app.core.config import Config
from app.services.ai import image_embeddings
from app.services.ai.ai_tagging_service import AITaggingService
from app.services.ai.base_tagger import ZeroShotTagger
from app.services.ai.category_classifier_service import CategoryClassifierService
from app.services.ai.encoder_protocol import VisionEncoder
from app.services.ai.image_embeddings import EmbeddingCache, file_embedding


class _CountingEncoder(VisionEncoder):
    def __init__(self) -> None:
        self.image_runs = 0

    @property
    def available(self) -> bool:
        return True

    @property
    def model_id(self) -> str:
        return "counting"

    def embed_image(self, image: Any) -> Any:
        self.image_runs += 1
        return np.asarray([1.0, 0.0], dtype=np.float32)

    def embed_texts(self, texts: list[str]) -> Any:
        return np.tile(np.asarray([1.0, 0.0], dtype=np.float32), (len(texts), 1))


def _photo(path: Path) -> Path:
    Image.new("RGB", (32, 32), "teal").save(path, format="JPEG")
    return path


def test_categorization_and_tagging_share_one_vision_run(tmp_path: Path) -> None:
    photo = _photo(tmp_path / "a.jpg")
    encoder = _CountingEncoder()
    config = Config(
        ai_tagging_enabled=True,
        categorize_enabled=True,
        categorize_categories=["nature", "food"],
    )
    classifier = CategoryClassifierService(config, encoder)
    tagger = AITaggingService(config, encoder)
    tagger._provider = ZeroShotTagger(["beach"], encoder)
    tagger._provider_built = True

    classifier.classify_file(photo)
    tagger.tag_file(photo)

    assert encoder.image_runs == 1


def test_a_changed_file_is_embedded_again(tmp_path: Path) -> None:
    photo = _photo(tmp_path / "a.jpg")
    encoder = _CountingEncoder()

    file_embedding(encoder, photo)
    Image.new("RGB", (40, 40), "red").save(photo, format="JPEG")
    stat = photo.stat()
    os.utime(photo, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000_000))
    file_embedding(encoder, photo)

    assert encoder.image_runs == 2


def test_each_encoder_has_its_own_cache(tmp_path: Path) -> None:
    photo = _photo(tmp_path / "a.jpg")
    first, second = _CountingEncoder(), _CountingEncoder()

    file_embedding(first, photo)
    file_embedding(second, photo)

    assert (first.image_runs, second.image_runs) == (1, 1)


def test_cached_vectors_are_read_only(tmp_path: Path) -> None:
    vector = file_embedding(_CountingEncoder(), _photo(tmp_path / "a.jpg"))

    assert vector is not None
    with pytest.raises(ValueError):
        vector[0] = 3.0


def test_an_unreadable_file_is_not_cached(tmp_path: Path) -> None:
    broken = tmp_path / "broken.jpg"
    broken.write_bytes(b"not an image")
    encoder = _CountingEncoder()

    assert file_embedding(encoder, broken) is None
    assert len(image_embeddings.cache_for(encoder)) == 0


def test_the_cache_is_bounded_by_bytes_and_drops_the_oldest() -> None:
    vector = np.zeros(256, dtype=np.float32)  # 1 KiB
    cache = EmbeddingCache(max_bytes=3 * vector.nbytes)
    keys = [(f"/p/{index}", 1, 1, 1, "m", "v") for index in range(4)]
    for key in keys[:3]:
        cache.put(key, vector)
    assert cache.get(keys[0]) is not None  # now the most recent

    cache.put(keys[3], vector)

    assert len(cache) == 3
    assert cache.size_bytes == 3 * vector.nbytes
    assert cache.get(keys[1]) is None
    assert cache.get(keys[0]) is not None
