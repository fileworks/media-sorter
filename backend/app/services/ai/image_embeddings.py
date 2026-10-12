"""One image embedding per file per operation, shared by tagging and categorization.

Preview classifies a file and then proposes its tags; both used to decode the
full-resolution image and run the vision tower separately (AI-07). This cache
keys an embedding by the file's identity and modification evidence, the model
and the preprocessing version, so the second consumer, and any exact copy
reached by the same path again, reuses the first result.

It is deliberately in memory and bounded by bytes. An embedding is derived
personal data; nothing is written to disk. The bound keeps the cache useful for
the consumers of one file (and their neighbours) without growing with the
library: 64 MB holds about 21,000 768-dimension vectors, and the least recently
used are dropped first. Each encoder has its own cache, so changing the model
starts empty.
"""

from __future__ import annotations

import threading
import weakref
from collections import OrderedDict
from pathlib import Path
from typing import Any

from app.core.paths import path_identity_key
from app.services.ai.encoder_protocol import VisionEncoder
from app.services.filesystem_service import open_image

#: Changes whenever image preprocessing changes, so old vectors are never reused.
PREPROCESSING_VERSION = "full-decode-exif-upright-srgb-v2"
CACHE_BYTES = 64 * 1024 * 1024

CacheKey = tuple[str, int, int, int, str, str]


class EmbeddingCache:
    """A thread-safe LRU of read-only vectors, bounded by total bytes."""

    def __init__(self, max_bytes: int = CACHE_BYTES) -> None:
        self._max_bytes = max_bytes
        self._entries: OrderedDict[CacheKey, Any] = OrderedDict()
        self._bytes = 0
        self._lock = threading.Lock()

    def __len__(self) -> int:
        return len(self._entries)

    @property
    def size_bytes(self) -> int:
        return self._bytes

    def get(self, key: CacheKey) -> Any | None:
        with self._lock:
            vector = self._entries.get(key)
            if vector is not None:
                self._entries.move_to_end(key)
            return vector

    def put(self, key: CacheKey, vector: Any) -> None:
        size = int(vector.nbytes)
        if size > self._max_bytes:
            return
        with self._lock:
            previous = self._entries.pop(key, None)
            if previous is not None:
                self._bytes -= int(previous.nbytes)
            self._entries[key] = vector
            self._bytes += size
            while self._bytes > self._max_bytes and self._entries:
                _, dropped = self._entries.popitem(last=False)
                self._bytes -= int(dropped.nbytes)


_caches: weakref.WeakKeyDictionary[VisionEncoder, EmbeddingCache] = weakref.WeakKeyDictionary()
_caches_lock = threading.Lock()


def cache_for(encoder: VisionEncoder) -> EmbeddingCache:
    with _caches_lock:
        cache = _caches.get(encoder)
        if cache is None:
            cache = EmbeddingCache()
            _caches[encoder] = cache
        return cache


def _key(encoder: VisionEncoder, path: Path) -> CacheKey | None:
    try:
        observed = path.stat()
    except OSError:
        return None
    return (
        path_identity_key(str(path)),
        observed.st_size,
        observed.st_mtime_ns,
        getattr(observed, "st_ino", 0),
        str(getattr(encoder, "model_id", "unknown")),
        PREPROCESSING_VERSION,
    )


def file_embedding(encoder: VisionEncoder, path: Path) -> Any | None:
    """The raw image embedding for *path*, decoded and embedded at most once."""
    import numpy as np

    key = _key(encoder, path)
    cache = cache_for(encoder)
    if key is not None:
        cached = cache.get(key)
        if cached is not None:
            return cached
    with open_image(path) as image:
        if image is None:
            return None
        raw = encoder.embed_image(image)
    if raw is None:
        return None
    vector = np.array(np.asarray(raw, dtype=np.float32).reshape(-1), copy=True)
    vector.setflags(write=False)
    if key is not None:
        cache.put(key, vector)
    return vector
