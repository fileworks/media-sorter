"""Junk / thumbnail detection — tiny previews and cache debris routed to `_junk/`.

Pure classification: nothing here touches the filesystem beyond a stat and an
image-header read. The sort/preview pipelines quarantine matches into `_junk/`
(never delete), so a false positive is always recoverable.
"""

from __future__ import annotations

import fnmatch
from pathlib import Path

from app.core.config import Config
from app.services.filesystem_service import image_dimensions
from app.utils.media_utils import is_image


def classify_junk(file_path: Path, config: Config) -> str | None:
    """Return a human-readable reason if *file_path* looks like junk, else None.

    Checks, cheapest first:
    1. filename / parent-directory patterns (``Thumbs.db``, ``.thumbnails/``…),
    2. file-size floor (``junk_min_file_size_kb``),
    3. image-resolution floor (``junk_min_image_dimension``, shorter side) —
       header read only; unreadable dimensions are *not* junk (never guess).
    """
    if not config.junk_filter_enabled:
        return None

    for pattern in config.junk_filename_patterns:
        if fnmatch.fnmatch(file_path.name.lower(), pattern.lower()):
            return f"filename matches junk pattern {pattern!r}"
        for parent in file_path.parents:
            if fnmatch.fnmatch(parent.name.lower(), pattern.lower()) and parent.name:
                return f"inside junk directory {parent.name!r}"

    if config.junk_min_file_size_kb > 0:
        try:
            size = file_path.stat().st_size
        except OSError:
            size = None
        if size is not None and size < config.junk_min_file_size_kb * 1024:
            return f"file size {size}B below floor ({config.junk_min_file_size_kb}KB)"

    if config.junk_min_image_dimension > 0 and is_image(file_path):
        dims = image_dimensions(file_path)
        if dims is not None and min(dims) < config.junk_min_image_dimension:
            return (
                f"resolution {dims[0]}x{dims[1]} below floor "
                f"({config.junk_min_image_dimension}px shorter side)"
            )

    return None
