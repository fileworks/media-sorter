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
webview_profile = sys.modules["webview_profile"]


windows_only = pytest.mark.skipif(
    sys.platform != "win32", reason="WebView2 profile locks are Windows-specific"
)


class FakeClock:
    """Advance monotonic time only when the cleanup sleeps."""

    def __init__(self) -> None:
        self.now = 0.0
        self.delays: list[float] = []

    def monotonic(self) -> float:
        return self.now

    def sleep(self, delay: float) -> None:
        self.delays.append(delay)
        self.now += delay


@pytest.fixture
def clock(monkeypatch: pytest.MonkeyPatch) -> FakeClock:
    fake = FakeClock()
    monkeypatch.setattr(webview_profile.time, "monotonic", fake.monotonic)
    monkeypatch.setattr(webview_profile.time, "sleep", fake.sleep)
    monkeypatch.setattr(webview_profile, "_webview_profile_processes", lambda *_, **__: [])
    return fake


def failing_cleanup(
    monkeypatch: pytest.MonkeyPatch, relative: str | None, winerror: int, failures: int
) -> list[int]:
    """Fail the first `failures` cleanups with a Win32 error at `relative`."""
    original = release_integrity.tempfile.TemporaryDirectory.cleanup
    attempts: list[int] = []

    def cleanup(temporary: TemporaryDirectory[str]) -> None:
        attempts.append(len(attempts))
        if len(attempts) <= failures:
            filename = None if relative is None else str(Path(temporary.name) / relative)
            raise OSError(13, "fixture profile lock", filename, winerror)
        original(temporary)

    monkeypatch.setattr(release_integrity.tempfile.TemporaryDirectory, "cleanup", cleanup)
    return attempts


@windows_only
def test_webview_profile_cleanup_retries_sharing_locks(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    attempts = failing_cleanup(monkeypatch, "webview/EBWebView/Default/Cookies", 32, failures=2)
    with release_integrity._webview_smoke_state() as directory:
        assert directory.is_dir()
    assert not directory.exists()
    assert len(attempts) == 3
    assert clock.delays == [0.25, 0.25]


@windows_only
@pytest.mark.parametrize(
    ("relative", "winerror"),
    [
        ("webview/EBWebView/BrowserMetrics/test.pma", 5),
        ("webview/EBWebView/Default/Code Cache/js/index-dir/test.tmp", 5),
        # A release candidate's NSIS smoke hit this while a cache file vanished.
        ("webview/EBWebView/Default", 145),
        ("webview/EBWebView/Local State", 5),
    ],
)
def test_webview_profile_cleanup_retries_transient_profile_errors(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock, relative: str, winerror: int
) -> None:
    attempts = failing_cleanup(monkeypatch, relative, winerror, failures=2)
    with release_integrity._webview_smoke_state() as directory:
        assert directory.is_dir()
    assert not directory.exists()
    assert len(attempts) == 3
    assert clock.delays == [0.25, 0.25]


@windows_only
@pytest.mark.parametrize(
    ("relative", "winerror"),
    [
        (None, 5),
        (None, 32),
        ("config/settings.json", 32),
        ("config/test.pma", 5),
        ("config/test.tmp", 5),
        ("data", 145),
        ("webview/EBWebView/Default/test.tmp", 2),
    ],
)
def test_webview_profile_cleanup_rejects_errors_outside_the_profile(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock, relative: str | None, winerror: int
) -> None:
    attempts = failing_cleanup(monkeypatch, relative, winerror, failures=1)
    with pytest.raises(OSError), release_integrity._webview_smoke_state():
        pass
    assert len(attempts) == 1
    assert not clock.delays


@windows_only
def test_webview_profile_cleanup_still_fails_a_persistent_lock(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    attempts = failing_cleanup(
        monkeypatch, "webview/EBWebView/BrowserMetrics/test.pma", 5, failures=10_000
    )
    with pytest.raises(OSError), release_integrity._webview_smoke_state():
        pass
    expected = int(webview_profile._PROFILE_CLEANUP_TIMEOUT / webview_profile._CLEANUP_POLL)
    assert len(attempts) == expected + 1
    assert clock.now == pytest.approx(webview_profile._PROFILE_CLEANUP_TIMEOUT)


@windows_only
def test_webview_cleanup_waits_for_profile_processes_first(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    observed = [[4242, 4243], [4242], []]
    events: list[str] = []

    def processes(_directory: Path, timeout: float = 30.0) -> list[int]:
        events.append("poll")
        return observed.pop(0)

    original = release_integrity.tempfile.TemporaryDirectory.cleanup

    def cleanup(temporary: TemporaryDirectory[str]) -> None:
        events.append("cleanup")
        original(temporary)

    monkeypatch.setattr(webview_profile, "_webview_profile_processes", processes)
    monkeypatch.setattr(release_integrity.tempfile.TemporaryDirectory, "cleanup", cleanup)
    with release_integrity._webview_smoke_state() as directory:
        pass
    assert not directory.exists()
    assert events == ["poll", "poll", "poll", "cleanup"]
    assert clock.delays == [0.25, 0.25]


@windows_only
def test_webview_cleanup_fails_when_profile_processes_never_exit(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    monkeypatch.setattr(webview_profile, "_webview_profile_processes", lambda *_, **__: [4242])
    with (
        pytest.raises(release_integrity.ReleaseIntegrityError, match="outlived"),
        release_integrity._webview_smoke_state(),
    ):
        pass
    assert clock.now == pytest.approx(webview_profile._WEBVIEW_EXIT_TIMEOUT)


@windows_only
def test_webview_cleanup_keeps_the_smoke_failure_when_cleanup_also_fails(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock, capsys: pytest.CaptureFixture[str]
) -> None:
    def processes(_directory: Path, timeout: float = 30.0) -> list[int]:
        raise release_integrity.ReleaseIntegrityError("fixture process listing failure")

    monkeypatch.setattr(webview_profile, "_webview_profile_processes", processes)
    with (
        pytest.raises(release_integrity.ReleaseIntegrityError, match="fixture smoke failure"),
        release_integrity._webview_smoke_state(),
    ):
        raise release_integrity.ReleaseIntegrityError("fixture smoke failure")
    assert "cleanup also failed: fixture process listing failure" in capsys.readouterr().out


@windows_only
def test_webview_exit_wait_counts_slow_process_queries(
    monkeypatch: pytest.MonkeyPatch, clock: FakeClock
) -> None:
    budgets: list[float] = []

    def slow_processes(_directory: Path, timeout: float) -> list[int]:
        budgets.append(timeout)
        clock.now += min(29.0, timeout)  # a real query is cut off at its budget
        return [4242]

    monkeypatch.setattr(webview_profile, "_webview_profile_processes", slow_processes)
    with pytest.raises(release_integrity.ReleaseIntegrityError, match="outlived"):
        webview_profile._wait_for_webview_exit(Path("unused"))
    assert clock.now <= webview_profile._WEBVIEW_EXIT_TIMEOUT
    assert all(budget <= 30.0 for budget in budgets)
    assert budgets[-1] < 30.0


@windows_only
def test_webview_profile_process_query_matches_only_this_profile(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    # Narrows the platform for type checkers on Linux, where ctypes.windll and
    # CREATE_NO_WINDOW do not exist.
    if sys.platform != "win32":
        pytest.skip("WebView2 profile locks are Windows-specific")
    import ctypes
    import subprocess

    directory = tmp_path / "mediasorter-webview-smoke-fixture"
    profile = directory / "webview" / "EBWebView"
    profile.mkdir(parents=True)
    buffer = ctypes.create_unicode_buffer(32768)
    ctypes.windll.kernel32.GetShortPathNameW(str(profile), buffer, len(buffer))
    arguments = {
        "long": f'--user-data-dir="{profile}"',
        "short": f"--user-data-dir={buffer.value}",
        "unrelated": f'--user-data-dir="{tmp_path}" --log-file="{profile / "x.log"}"',
    }
    # Stand-in processes: the query looks for this interpreter's image name. A
    # virtual environment's python.exe is a launcher, so start the base one.
    interpreter = getattr(sys, "_base_executable", sys.executable)
    monkeypatch.setattr(webview_profile, "_WEBVIEW_PROCESS", Path(interpreter).name)
    # A string command line reaches Windows verbatim, quoted as WebView2 quotes it.
    children = {
        label: subprocess.Popen(
            f'"{interpreter}" -c "import time; time.sleep(60)" {argument}',
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
        for label, argument in arguments.items()
    }
    try:
        found = webview_profile._webview_profile_processes(directory)
    finally:
        for child in children.values():
            child.kill()
            child.wait(timeout=10)
    assert children["long"].pid in found
    assert children["short"].pid in found
    assert children["unrelated"].pid not in found


@windows_only
def test_webview_profile_process_query_runs_on_windows() -> None:
    with TemporaryDirectory(prefix="mediasorter-webview-smoke-") as name:
        assert webview_profile._webview_profile_processes(Path(name)) == []
