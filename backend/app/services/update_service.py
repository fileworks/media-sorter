"""Update checker: queries the GitHub Releases API and caches the result.

Best-effort — a network failure, rate-limit, or parse error never raises; it
yields update_available=False with a logged reason so a failed check is
invisible to the user and never breaks a sort.
"""

import asyncio
import platform
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import httpx
import structlog

from app._version import __version__

logger = structlog.get_logger(__name__)

_REPO = "fileworks/media-sorter"
_API_URL = f"https://api.github.com/repos/{_REPO}/releases/latest"
_CACHE_TTL = timedelta(hours=6)
_REQUEST_TIMEOUT = 5.0


@dataclass(frozen=True)
class UpdateInfo:
    current_version: str
    latest_version: str | None
    update_available: bool
    release_url: str | None
    release_notes: str | None
    published_at: str | None
    checked_at: str
    asset_url: str | None  # best-guess direct download for this OS


def _parse_semver(tag: str) -> tuple[int, int, int] | None:
    """Strip leading 'v', return (major, minor, patch) or None on failure."""
    cleaned = tag.lstrip("v")
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)", cleaned)
    if not m:
        return None
    return int(m.group(1)), int(m.group(2)), int(m.group(3))


def _is_newer(latest_tag: str, current: str) -> bool:
    """Return True iff latest_tag represents a strictly newer stable release."""
    cleaned = latest_tag.lstrip("v")
    # Pre-release / build-metadata suffixes → not a stable update.
    # e.g. "1.2.0-rc.1", "1.2.0+build.1", "1.2.0-beta"
    if re.search(r"[-+]", cleaned):
        return False
    parsed_latest = _parse_semver(latest_tag)
    parsed_current = _parse_semver(current)
    if parsed_latest is None or parsed_current is None:
        return False
    return parsed_latest > parsed_current


def _pick_asset(assets: list[dict[str, str]], system: str) -> str | None:
    """Pick the best download URL for this OS from the release assets list."""
    sys_lower = system.lower()
    suffixes: tuple[str, ...]
    if sys_lower == "darwin":
        suffixes = (".dmg",)
    elif sys_lower == "windows":
        suffixes = (".msi", ".exe")
    else:
        suffixes = (".appimage", ".deb", ".tar.gz")
    for asset in assets:
        name = asset.get("name", "").lower()
        if any(name.endswith(s) for s in suffixes):
            return asset.get("browser_download_url")
    return None


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class UpdateService:
    """Check for app updates via the GitHub Releases API."""

    def __init__(self, current_version: str = __version__, enabled: bool = True) -> None:
        self._current = current_version
        self._enabled = enabled
        self._cache: UpdateInfo | None = None
        self._cache_time: datetime | None = None

    def _cached(self) -> UpdateInfo | None:
        if self._cache is None or self._cache_time is None:
            return None
        if datetime.now(timezone.utc) - self._cache_time < _CACHE_TTL:
            return self._cache
        return None

    def _make_unavailable(self) -> UpdateInfo:
        return UpdateInfo(
            current_version=self._current,
            latest_version=None,
            update_available=False,
            release_url=None,
            release_notes=None,
            published_at=None,
            checked_at=_now_iso(),
            asset_url=None,
        )

    async def check(self, *, force: bool = False) -> UpdateInfo:
        """Return update info. Never raises; best-effort network call."""
        if not self._enabled:
            return self._make_unavailable()

        if not force:
            cached = self._cached()
            if cached is not None:
                return cached

        try:
            result = await asyncio.to_thread(self._fetch_sync)
        except Exception as exc:
            logger.warning("Update check failed", error=str(exc))
            # Return stale cache if available, else unavailable
            return self._cache or self._make_unavailable()

        self._cache = result
        self._cache_time = datetime.now(timezone.utc)
        return result

    def _fetch_sync(self) -> UpdateInfo:
        """Blocking HTTP fetch — called via asyncio.to_thread."""
        headers = {
            "User-Agent": f"MediaSorter/{self._current}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }
        with httpx.Client(timeout=_REQUEST_TIMEOUT) as client:
            resp = client.get(_API_URL, headers=headers)
            resp.raise_for_status()
            data = resp.json()

        tag: str = data.get("tag_name", "")
        html_url: str | None = data.get("html_url")
        body: str | None = data.get("body")
        published_at: str | None = data.get("published_at")
        assets: list[dict[str, str]] = data.get("assets", [])

        # Validate that the release URL belongs to our repo (supply-chain hygiene).
        if html_url and not html_url.startswith(f"https://github.com/{_REPO}"):
            logger.warning("Unexpected release URL; ignoring", url=html_url)
            html_url = None

        available = bool(tag) and _is_newer(tag, self._current)
        latest = tag.lstrip("v") if tag else None
        asset_url = _pick_asset(assets, platform.system()) if available else None

        # Truncate release notes to avoid storing huge payloads.
        if body and len(body) > 4000:
            body = body[:4000] + "\n…"

        return UpdateInfo(
            current_version=self._current,
            latest_version=latest,
            update_available=available,
            release_url=html_url if available else None,
            release_notes=body if available else None,
            published_at=published_at,
            checked_at=_now_iso(),
            asset_url=asset_url,
        )
