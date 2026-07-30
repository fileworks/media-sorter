"""Thumbnail cache identity, eviction, and delete-safe degradation."""

from __future__ import annotations

import os
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from app.services.thumbnail_cache import ThumbnailCache


def test_key_changes_for_content_replacement_even_with_same_path_size_and_mtime(
    tmp_path: Path,
) -> None:
    source = tmp_path / "photo.jpg"
    source.write_bytes(b"AAAA")
    observed = source.stat()
    cache = ThumbnailCache(root=tmp_path / "cache")
    first = cache.key_for(source, 160)

    source.write_bytes(b"BBBB")
    os.utime(source, ns=(observed.st_atime_ns, observed.st_mtime_ns))

    assert cache.key_for(source, 160) != first


def test_requested_size_and_renderer_version_are_part_of_identity(tmp_path: Path) -> None:
    source = tmp_path / "photo.jpg"
    source.write_bytes(b"content")

    v1 = ThumbnailCache(root=tmp_path / "cache", renderer_version=1)
    v2 = ThumbnailCache(root=tmp_path / "cache", renderer_version=2)

    assert v1.key_for(source, 160) != v1.key_for(source, 320)
    assert v1.key_for(source, 160) != v2.key_for(source, 160)


def test_hits_need_no_renderer_and_corrupt_entries_become_misses(tmp_path: Path) -> None:
    source = tmp_path / "photo.jpg"
    source.write_bytes(b"content")
    cache = ThumbnailCache(root=tmp_path / "cache")
    key = cache.key_for(source, 160)
    jpeg = b"\xff\xd8" + b"x" * 20

    cache.put(key, jpeg)
    assert cache.get(key) == jpeg
    cache._entry(key).write_bytes(b"corrupt")  # noqa: SLF001 - fault-injection boundary
    assert cache.get(key) is None


def test_concurrent_writes_never_leave_cache_over_budget(tmp_path: Path) -> None:
    root = tmp_path / "cache"
    cache = ThumbnailCache(root=root, budget_bytes=220)
    sources = []
    for index in range(12):
        source = tmp_path / f"{index}.jpg"
        source.write_bytes(bytes([index]) * 10)
        sources.append(source)

    def write(source: Path) -> None:
        cache.put(cache.key_for(source, 160), b"\xff\xd8" + b"x" * 70)

    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(write, sources))

    diagnostics = cache.diagnostics()
    assert diagnostics["size_bytes"] <= 220
    assert diagnostics["last_eviction"] is not None


def test_disabled_cache_creates_no_directory_or_background_work(tmp_path: Path) -> None:
    root = tmp_path / "cache"
    source = tmp_path / "photo.jpg"
    source.write_bytes(b"content")
    cache = ThumbnailCache(root=root, enabled=False)
    key = cache.key_for(source, 160)

    cache.put(key, b"\xff\xd8jpeg")

    assert cache.get(key) is None
    assert not root.exists()
