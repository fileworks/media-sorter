"""Path matching helpers shared by the filesystem and analysis services."""

import fnmatch
import re
from pathlib import Path

# Characters that are illegal in a path segment on Windows (a superset of what
# POSIX forbids), plus ASCII control characters. Stripped from any user-supplied
# folder name before it becomes a directory.
_INVALID_SEGMENT_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')

# Reserved Windows device names — a folder named exactly one of these (optionally
# with an extension) is unusable on Windows, so we reject it outright.
_RESERVED_SEGMENT_NAMES: frozenset[str] = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{i}" for i in range(1, 10)}
    | {f"LPT{i}" for i in range(1, 10)}
)

# Cap a sanitized segment so a pathological category/camera name can't blow past
# filesystem name limits (255 is the common max; 64 is generous for a label).
_MAX_SEGMENT_LENGTH = 64


def sanitize_path_segment(name: str, max_length: int = _MAX_SEGMENT_LENGTH) -> str:
    """Return a filesystem-safe single path segment derived from *name*, or ``""``.

    Used for user-supplied folder names (Smart Categorization categories, the
    camera-model subfolder) at both validation time (reject bad input) and build
    time (defence in depth). The transform is deterministic and idempotent:

    - strip surrounding whitespace;
    - drop characters illegal on Windows/POSIX and ASCII control chars;
    - neutralise ``..`` parent-traversal sequences;
    - collapse internal whitespace to single spaces;
    - strip leading/trailing dots and spaces (invalid/awkward on Windows);
    - reject reserved Windows device names (``CON``, ``COM1`` …) → ``""``;
    - cap the length to *max_length*.

    Returns ``""`` when nothing safe remains, so callers can fall back to a fixed
    constant (e.g. ``_uncategorized``).
    """
    if not name:
        return ""
    s = _INVALID_SEGMENT_CHARS.sub("", name.strip())
    s = s.replace("..", "")  # neutralise parent-traversal even after char stripping
    s = re.sub(r"\s+", " ", s)  # collapse internal whitespace
    s = s.strip(" .")  # leading/trailing dots and spaces are invalid on Windows
    if not s:
        return ""
    # Reserved device names are matched on the stem (the part before any ".").
    if s.split(".", 1)[0].upper() in _RESERVED_SEGMENT_NAMES:
        return ""
    return s[:max_length].strip(" .")


def is_excluded_by_pattern(path: Path, source_root: Path, patterns: list[str]) -> bool:
    """Return True if any component of *path* (relative to *source_root*) matches a glob.

    Each component of the path *relative to* ``source_root`` is tested against
    every glob in ``patterns`` with :func:`fnmatch.fnmatch`, so a pattern like
    ``"thumbnails"`` excludes both ``thumbnails/a.jpg`` and ``a/thumbnails/b.jpg``.

    Behaviour notes (the single source of truth previously duplicated in
    ``FileSystemService`` and ``AnalysisService``):

    - An empty ``patterns`` list short-circuits to ``False`` (nothing excluded).
    - If *path* is not under *source_root* (``relative_to`` raises ``ValueError``)
      the file is treated as **not** excluded. In every real call site files are
      enumerated from within ``source_root``, so this branch is defensive only.
    """
    if not patterns:
        return False
    try:
        rel = path.relative_to(source_root)
    except ValueError:
        return False
    return any(fnmatch.fnmatch(part, pattern) for part in rel.parts for pattern in patterns)
