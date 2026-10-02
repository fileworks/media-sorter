"""Shared row serializers for database records.

Centralises SQLite → API/JSON type coercions so every call site gets the same
normalised shape. SQLite stores booleans as 0/1 integers; left uncoerced they
evaluate incorrectly in the frontend (``1 === true`` is ``false``).
"""

import json
from typing import Any


def _deserialize_tags(raw: Any) -> list[str]:
    """Parse the tags column — new rows store JSON; old rows store CSV."""
    if not raw:
        return []
    if isinstance(raw, str):
        stripped = raw.strip()
        if stripped.startswith("["):
            try:
                parsed = json.loads(stripped)
                if isinstance(parsed, list):
                    return [str(t) for t in parsed if t]
            except (json.JSONDecodeError, ValueError):
                pass
        # Backward-compat: comma-separated (old format). Strip each token —
        # old rows were often written as "beach, sunset".
        return [t.strip() for t in raw.split(",") if t.strip()]
    return []


def serialize_file_operation(row: dict[str, Any]) -> dict[str, Any]:
    """Normalise a raw ``file_operations`` row for API/JSON consumption.

    - ``suspicious``: 0/1 integer → real ``bool``.
    - ``tags``: JSON array or legacy comma-joined string → ``list[str]``.

    Returns a new dict; the input is not mutated.
    """
    result = dict(row)
    result["tags"] = _deserialize_tags(result.get("tags"))
    result["suspicious"] = bool(result.get("suspicious", 0))
    return result
