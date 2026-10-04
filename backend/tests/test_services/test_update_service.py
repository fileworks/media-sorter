"""Tests for UpdateService."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from unittest.mock import MagicMock, patch

import pytest

from app.core.bootstrap import ServiceContainer
from app.core.config import Config
from app.services.update_service import UpdateService, _is_newer, _parse_semver, _pick_asset

# ──────────────────────────────────────────────────────────── helpers ──


def _fake_release(tag: str = "v1.0.0", html_url: str | None = None) -> dict[str, Any]:
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


@pytest.mark.parametrize("tag", ["v1.2.3oops", "vv1.2.3", "v01.2.3", "1.2.3.4"])
def test_malformed_version_is_not_an_update(tag: str) -> None:
    assert _parse_semver(tag) is None
    assert not _is_newer(tag, "1.0.0")


@pytest.mark.parametrize(
    ("system", "machine", "expected"),
    [
        ("Darwin", "arm64", "aarch64.dmg"),
        ("Darwin", "x86_64", "x64.dmg"),
        ("Windows", "AMD64", "x64-setup.exe"),
        ("Windows", "ARM64", None),
    ],
)
def test_asset_selection_matches_architecture_and_prefers_setup(
    system: str, machine: str, expected: str | None
) -> None:
    names = [
        "MediaSorter_1.1.0_x64_en-US.msi",
        "MediaSorter_1.1.0_x64.dmg",
        "MediaSorter_1.1.0_aarch64.dmg",
        "MediaSorter_1.1.0_x64-setup.exe",
    ]
    prefix = "https://github.com/fileworks/media-sorter/releases/download/v1.1.0/"
    assets = [{"name": name, "browser_download_url": prefix + name} for name in names]
    result = _pick_asset(assets, system, "v1.1.0", machine)
    assert result is None if expected is None else result is not None and result.endswith(expected)


def test_asset_link_outside_the_release_is_rejected() -> None:
    assets = [
        {
            "name": "MediaSorter_1.1.0_x64-setup.exe",
            "browser_download_url": "https://evil.example/setup.exe",
        }
    ]
    assert _pick_asset(assets, "Windows", "v1.1.0", "AMD64") is None


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
async def test_live_enable_disable_invalidates_cache_and_changes_network_policy() -> None:
    svc = UpdateService(enabled=False)
    with patch.object(svc, "_fetch_sync", return_value=svc._make_unavailable()) as fetch:
        await svc.check(force=True)
        fetch.assert_not_called()

        svc.set_enabled(True)
        await svc.check(force=True)
        fetch.assert_called_once()

        svc.set_enabled(False)
        await svc.check(force=True)
        assert fetch.call_count == 1


def test_service_container_propagates_live_update_setting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MEDIASORT_DB_PATH", str(tmp_path / "test.db"))
    container = ServiceContainer(Config(update_check_enabled=False))
    service = container.update_service
    assert service._enabled is False

    container.set_config(Config(update_check_enabled=True))
    assert container.update_service is service
    assert service._enabled is True


@pytest.mark.asyncio
@pytest.mark.parametrize("html_url", [None, "", "https://evil.example.com/release"])
async def test_bad_url_rejected(svc: UpdateService, html_url: str | None) -> None:
    release = {**_fake_release("v1.0.0"), "html_url": html_url}
    mock_resp = MagicMock()
    mock_resp.json.return_value = release
    mock_resp.raise_for_status.return_value = None

    with patch("httpx.Client") as mock_client_cls:
        mock_client_cls.return_value.__enter__.return_value.get.return_value = mock_resp
        info = await svc.check(force=True)

    # The spoofed URL should be silently rejected.
    assert info.release_url is None
    assert info.update_available is False


@pytest.mark.asyncio
async def test_repository_prefix_spoof_is_not_trusted(svc: UpdateService) -> None:
    release = _fake_release(
        "v1.1.0", "https://github.com/fileworks/media-sorter-evil/releases/tag/v1.1.0"
    )
    with patch("httpx.Client") as client:
        response = client.return_value.__enter__.return_value.get.return_value
        response.json.return_value = release
        info = await svc.check(force=True)
    assert not info.update_available
    assert info.release_url is None


@pytest.mark.asyncio
@pytest.mark.parametrize("flag", ["draft", "prerelease"])
async def test_unpublished_or_prerelease_is_not_offered(svc: UpdateService, flag: str) -> None:
    release = {**_fake_release("v1.1.0"), flag: True}
    with patch("httpx.Client") as client:
        client.return_value.__enter__.return_value.get.return_value.json.return_value = release
        info = await svc.check(force=True)
    assert not info.update_available


@pytest.mark.asyncio
async def test_inflight_result_cannot_repopulate_disabled_cache(svc: UpdateService) -> None:
    def finish_after_disable() -> Any:
        svc.set_enabled(False)
        return svc._make_unavailable()

    with patch.object(svc, "_fetch_sync", side_effect=finish_after_disable):
        await svc.check(force=True)
    assert svc._cache is None
