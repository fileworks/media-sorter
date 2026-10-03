"""Authenticated, loopback-only container health probe without secret output."""

from __future__ import annotations

import os
import urllib.request

HEALTH_URL = "http://127.0.0.1:8000/api/health"


def is_healthy(url: str = HEALTH_URL) -> bool:
    capability = os.environ.get("MEDIASORT_API_CAPABILITY", "")
    if len(capability) < 32:
        return False
    request = urllib.request.Request(url, headers={"X-MediaSorter-Capability": capability})
    # The loopback probe must never send its capability through an environment proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(request, timeout=3) as response:
            return bool(response.status == 200)
    except OSError:
        return False


if __name__ == "__main__":
    raise SystemExit(0 if is_healthy() else 1)
