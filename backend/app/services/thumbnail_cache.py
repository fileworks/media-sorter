"""Delete-safe, bounded thumbnail cache with opportunistic LRU eviction."""

from __future__ import annotations

import contextlib
import hashlib
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from app.core.logging_config import get_logger
from app.core.paths import resolve_app_paths

logger = get_logger(__name__)
THUMBNAIL_RENDERER_VERSION = 1
DEFAULT_THUMBNAIL_CACHE_BYTES = 512 * 1024 * 1024
_SAMPLE_BYTES = 64 * 1024


@dataclass(frozen=True)
class ThumbnailCacheKey:
    value: str

    @property
    def etag(self) -> str:
        return f'"{self.value}"'


class ThumbnailCache:
    """Filesystem cache whose files are disposable and whose work is request-driven."""

    def __init__(
        self,
        *,
        root: Path | None = None,
        enabled: bool = True,
        budget_bytes: int = DEFAULT_THUMBNAIL_CACHE_BYTES,
        renderer_version: int = THUMBNAIL_RENDERER_VERSION,
    ) -> None:
        self.root = root or resolve_app_paths().data_dir / "thumbnail-cache"
        self.enabled = enabled
        self.budget_bytes = max(0, budget_bytes)
        self.renderer_version = renderer_version
        self._lock = threading.RLock()
        self._hits = 0
        self._misses = 0
        self._last_eviction: str | None = None
        self._logged_failures: set[str] = set()

    def configure(self, *, enabled: bool, budget_bytes: int) -> None:
        with self._lock:
            self.enabled = enabled
            self.budget_bytes = max(0, budget_bytes)

    def key_for(self, source: Path, longest_edge: int) -> ThumbnailCacheKey:
        """Use stat identity plus sampled bytes so same-stat replacement is never stale."""
        canonical = source.resolve(strict=True)
        observed = canonical.stat()
        content_sample = hashlib.sha256()
        with canonical.open("rb") as stream:
            content_sample.update(stream.read(_SAMPLE_BYTES))
            if observed.st_size > _SAMPLE_BYTES:
                stream.seek(max(0, observed.st_size - _SAMPLE_BYTES))
                content_sample.update(stream.read(_SAMPLE_BYTES))
        payload = "\0".join(
            (
                "v2:cache_hint",
                str(canonical),
                str(observed.st_size),
                str(observed.st_mtime_ns),
                str(getattr(observed, "st_ctime_ns", 0)),
                str(getattr(observed, "st_ino", 0)),
                content_sample.hexdigest(),
                str(longest_edge),
                str(self.renderer_version),
            )
        )
        return ThumbnailCacheKey(hashlib.sha256(payload.encode()).hexdigest())

    def get(self, key: ThumbnailCacheKey) -> bytes | None:
        if not self.enabled:
            return None
        entry = self._entry(key)
        try:
            data = entry.read_bytes()
            if not data.startswith(b"\xff\xd8"):
                raise ValueError("cache entry is not a JPEG")
            os.utime(entry, None)
        except FileNotFoundError:
            with self._lock:
                self._misses += 1
            return None
        except (OSError, ValueError) as exc:
            with self._lock:
                self._misses += 1
            self._log_once("read", exc)
            return None
        with self._lock:
            self._hits += 1
        return data

    def put(self, key: ThumbnailCacheKey, data: bytes) -> None:
        if not self.enabled or self.budget_bytes <= 0:
            return
        entry = self._entry(key)
        temporary = entry.with_suffix(f".{threading.get_ident()}.tmp")
        try:
            with self._lock:
                entry.parent.mkdir(parents=True, exist_ok=True)
                temporary.write_bytes(data)
                os.replace(temporary, entry)
                self._evict_locked()
        except OSError as exc:
            self._log_once("write", exc)
        finally:
            with contextlib.suppress(OSError):
                temporary.unlink(missing_ok=True)

    def diagnostics(self) -> dict[str, object]:
        entries = self._entries()
        hits, misses = self._hits, self._misses
        requests = hits + misses
        return {
            "enabled": self.enabled,
            "location": str(self.root),
            "budget_bytes": self.budget_bytes,
            "size_bytes": sum(path.stat().st_size for path in entries),
            "entry_count": len(entries),
            "hit_rate": round(hits / requests, 4) if requests else 0.0,
            "last_eviction": self._last_eviction,
            "renderer_version": self.renderer_version,
        }

    def _entry(self, key: ThumbnailCacheKey) -> Path:
        return self.root / f"v{self.renderer_version}" / key.value[:2] / f"{key.value}.jpg"

    def _entries(self) -> list[Path]:
        try:
            return [path for path in self.root.rglob("*.jpg") if path.is_file()]
        except OSError as exc:
            self._log_once("scan", exc)
            return []

    def _evict_locked(self) -> None:
        entries = self._entries()
        sized = [(path.stat().st_atime_ns, path.stat().st_size, path) for path in entries]
        total = sum(item[1] for item in sized)
        evicted = False
        for _atime, size, path in sorted(sized):
            if total <= self.budget_bytes:
                break
            path.unlink(missing_ok=True)
            total -= size
            evicted = True
        if evicted:
            self._last_eviction = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())

    def _log_once(self, operation: str, exc: Exception) -> None:
        key = f"{operation}:{type(exc).__name__}"
        with self._lock:
            if key in self._logged_failures:
                return
            self._logged_failures.add(key)
        logger.warning(
            "Thumbnail cache degraded; rendering on demand",
            operation=operation,
            error_class=type(exc).__name__,
        )
