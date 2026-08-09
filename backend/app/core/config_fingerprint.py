"""Stable identity for the effective configuration behind a reviewed plan."""

from __future__ import annotations

import hashlib
import json

from app.core.config import Config

_NON_OPERATIONAL_FIELDS = {
    "saved_recipes",
    "thumbnail_cache_enabled",
    "thumbnail_cache_budget_bytes",
    "update_check_enabled",
}


def config_fingerprint(config: Config) -> str:
    """Hash fields that can change a plan or its execution.

    Presentation, recipe-library and cache preferences do not affect planned
    file actions. Including them made a locale switch or cache toggle reject an
    otherwise unchanged reviewed plan as stale.
    """
    effective = {
        key: value for key, value in config.to_dict().items() if key not in _NON_OPERATIONAL_FIELDS
    }
    payload = json.dumps(effective, sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
