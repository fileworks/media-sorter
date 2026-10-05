"""WebView2 profile cleanup contracts, executed by the Windows CI job."""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts/release_integrity.py"
SPEC = importlib.util.spec_from_file_location("release_integrity_windows", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
release_integrity = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = release_integrity
SPEC.loader.exec_module(release_integrity)


@pytest.mark.skipif(sys.platform != "win32", reason="WebView2 sharing locks are Windows-specific")
def test_webview_profile_cleanup_retries_sharing_locks(monkeypatch: pytest.MonkeyPatch) -> None:
    original = release_integrity.tempfile.TemporaryDirectory.cleanup
    attempts: list[int] = []
    delays: list[float] = []

    def cleanup(temporary: TemporaryDirectory[str]) -> None:
        attempts.append(len(attempts))
        if len(attempts) < 3:
            raise PermissionError(13, "fixture WebView2 sharing lock", None, 32)
        original(temporary)

    monkeypatch.setattr(release_integrity.tempfile.TemporaryDirectory, "cleanup", cleanup)
    monkeypatch.setattr(release_integrity.time, "sleep", delays.append)
    with release_integrity._webview_smoke_state() as directory:
        assert directory.is_dir()
    assert not directory.exists()
    assert len(attempts) == 3
    assert delays == [0.25, 0.25]


@pytest.mark.skipif(sys.platform != "win32", reason="WebView2 sharing locks are Windows-specific")
def test_webview_profile_cleanup_does_not_hide_permission_denial(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    denied = PermissionError(13, "fixture permission denial", None, 5)

    def cleanup(_temporary: object) -> None:
        raise denied

    monkeypatch.setattr(release_integrity.tempfile.TemporaryDirectory, "cleanup", cleanup)
    with pytest.raises(PermissionError) as caught, release_integrity._webview_smoke_state():
        pass
    assert caught.value is denied


@pytest.mark.skipif(sys.platform != "win32", reason="WebView2 metrics locks are Windows-specific")
def test_webview_profile_cleanup_retries_mapped_metrics(monkeypatch: pytest.MonkeyPatch) -> None:
    original = release_integrity.tempfile.TemporaryDirectory.cleanup
    attempts: list[int] = []
    delays: list[float] = []

    def cleanup(temporary: TemporaryDirectory[str]) -> None:
        attempts.append(len(attempts))
        if len(attempts) < 3:
            metrics = Path(temporary.name) / "webview/EBWebView/BrowserMetrics/test.pma"
            raise PermissionError(13, "fixture mapped metrics", str(metrics), 5)
        original(temporary)

    monkeypatch.setattr(release_integrity.tempfile.TemporaryDirectory, "cleanup", cleanup)
    monkeypatch.setattr(release_integrity.time, "sleep", delays.append)
    with release_integrity._webview_smoke_state() as directory:
        assert directory.is_dir()
    assert not directory.exists()
    assert len(attempts) == 3
    assert delays == [0.25, 0.25]


@pytest.mark.skipif(sys.platform != "win32", reason="WebView2 metrics locks are Windows-specific")
@pytest.mark.parametrize(
    "relative", ["config/test.pma", "webview/EBWebView/BrowserMetrics/test.json"]
)
def test_webview_profile_cleanup_rejects_other_access_denials(
    monkeypatch: pytest.MonkeyPatch, relative: str
) -> None:
    attempts: list[int] = []
    delays: list[float] = []

    def cleanup(temporary: TemporaryDirectory[str]) -> None:
        attempts.append(len(attempts))
        raise PermissionError(
            13,
            "fixture unrelated permission denial",
            str(Path(temporary.name) / relative),
            5,
        )

    monkeypatch.setattr(release_integrity.tempfile.TemporaryDirectory, "cleanup", cleanup)
    monkeypatch.setattr(release_integrity.time, "sleep", delays.append)
    with pytest.raises(PermissionError), release_integrity._webview_smoke_state():
        pass
    assert len(attempts) == 1
    assert not delays


@pytest.mark.skipif(sys.platform != "win32", reason="WebView2 metrics locks are Windows-specific")
def test_webview_profile_cleanup_still_fails_persistent_metrics_lock(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    attempts: list[int] = []
    delays: list[float] = []

    def cleanup(temporary: TemporaryDirectory[str]) -> None:
        attempts.append(len(attempts))
        metrics = Path(temporary.name) / "webview/EBWebView/BrowserMetrics/test.pma"
        raise PermissionError(13, "fixture permanent metrics lock", str(metrics), 5)

    monkeypatch.setattr(release_integrity.tempfile.TemporaryDirectory, "cleanup", cleanup)
    monkeypatch.setattr(release_integrity.time, "sleep", delays.append)
    with pytest.raises(PermissionError), release_integrity._webview_smoke_state():
        pass
    assert len(attempts) == 41
    assert delays == [0.25] * 40
