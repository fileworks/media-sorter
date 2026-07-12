"""Tests for UpdateService."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.services.update_service import UpdateService, _is_newer, _parse_semver

# ──────────────────────────────────────────────────────────── helpers ──


def _fake_release(tag: str = "v1.0.0", html_url: str | None = None) -> dict:
    return {
        "tag_name": tag,
        "html_url": html_url or f"https://github.com/fileworks/media-sorter/releases/tag/{tag}",
        "body": "## Changelog\n- cool stuff",
        "published_at": "2026-01-01T00:00:00Z",
        "assets": [
            {
                "name": "MediaSorter_1.0.0_x64.dmg",
                "browser_download_url": "https://example.com/app.dmg",
            },
        ],
    }


# ──────────────────────────────────────────────── unit: semver helpers ──


def test_parse_semver_basic() -> None:
    assert _parse_semver("v1.2.3") == (1, 2, 3)
    assert _parse_semver("1.2.3") == (1, 2, 3)
    assert _parse_semver("garbage") is None


def test_is_newer_higher() -> None:
    assert _is_newer("v1.2.0", "1.1.0") is True


def test_is_newer_equal() -> None:
    assert _is_newer("v1.1.0", "1.1.0") is False


def test_is_newer_lower() -> None:
    assert _is_newer("v1.0.0", "1.1.0") is False


def test_is_newer_prerelease_tag() -> None:
    # A pre-release latest should not be flagged as an update.
    assert _is_newer("v1.2.0-rc.1", "1.1.0") is False
    assert _is_newer("v1.2.0+meta", "1.1.0") is False


# ────────────────────────────────────────────────── service behaviour ──


@pytest.fixture()
def svc() -> UpdateService:
    return UpdateService(current_version="0.1.0", enabled=True)


@pytest.mark.asyncio
async def test_update_available(svc: UpdateService) -> None:
    release = _fake_release("v1.0.0")
    with patch.object(svc, "_fetch_sync", return_value=svc._fetch_sync):
        # Patch _fetch_sync directly by replacing it with a closure
        pass

    mock_resp = MagicMock()
    mock_resp.json.return_value = release
    mock_resp.raise_for_status.return_value = None

    with patch("httpx.Client") as mock_client_cls:
        mock_client_cls.return_value.__enter__.return_value.get.return_value = mock_resp
        info = await svc.check(force=True)

    assert info.update_available is True
    assert info.latest_version == "1.0.0"
    assert info.release_url is not None


@pytest.mark.asyncio
async def test_same_version_no_update(svc: UpdateService) -> None:
    release = _fake_release("v0.1.0")
    mock_resp = MagicMock()
    mock_resp.json.return_value = release
    mock_resp.raise_for_status.return_value = None

    with patch("httpx.Client") as mock_client_cls:
        mock_client_cls.return_value.__enter__.return_value.get.return_value = mock_resp
        info = await svc.check(force=True)

    assert info.update_available is False


@pytest.mark.asyncio
async def test_network_error_returns_false(svc: UpdateService) -> None:
    with patch("httpx.Client") as mock_client_cls:
        mock_client_cls.return_value.__enter__.return_value.get.side_effect = OSError("offline")
        info = await svc.check(force=True)

    assert info.update_available is False
    assert info.latest_version is None


@pytest.mark.asyncio
async def test_cache_hit_avoids_second_request(svc: UpdateService) -> None:
    release = _fake_release("v1.0.0")
    mock_resp = MagicMock()
    mock_resp.json.return_value = release
    mock_resp.raise_for_status.return_value = None

    with patch("httpx.Client") as mock_client_cls:
        client = mock_client_cls.return_value.__enter__.return_value
        client.get.return_value = mock_resp

        await svc.check(force=True)
        await svc.check()  # second call — should use cache

    # httpx.Client context-managed once per force=True + _fetch_sync call
    assert client.get.call_count == 1


@pytest.mark.asyncio
async def test_force_bypasses_cache(svc: UpdateService) -> None:
    release = _fake_release("v1.0.0")
    mock_resp = MagicMock()
    mock_resp.json.return_value = release
    mock_resp.raise_for_status.return_value = None

    with patch("httpx.Client") as mock_client_cls:
        client = mock_client_cls.return_value.__enter__.return_value
        client.get.return_value = mock_resp

        await svc.check(force=True)
        await svc.check(force=True)  # both forced

    assert client.get.call_count == 2


@pytest.mark.asyncio
async def test_disabled_returns_unavailable() -> None:
    svc = UpdateService(enabled=False)
    info = await svc.check()
    assert info.update_available is False
    assert info.latest_version is None


@pytest.mark.asyncio
async def test_bad_url_rejected(svc: UpdateService) -> None:
    release = _fake_release("v1.0.0", html_url="https://evil.example.com/release")
    mock_resp = MagicMock()
    mock_resp.json.return_value = release
    mock_resp.raise_for_status.return_value = None

    with patch("httpx.Client") as mock_client_cls:
        mock_client_cls.return_value.__enter__.return_value.get.return_value = mock_resp
        info = await svc.check(force=True)

    # The spoofed URL should be silently rejected.
    assert info.release_url is None
