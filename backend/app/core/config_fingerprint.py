"""Stable identity for the effective configuration behind a reviewed plan."""

from __future__ import annotations

import hashlib
import json

from app.core.config import Config


def config_fingerprint(config: Config) -> str:
    """Hash all effective fields so stale previews cannot authorize a new plan."""
    payload = json.dumps(config.to_dict(), sort_keys=True, default=str)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()
