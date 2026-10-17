"""Isolated WebView2 profile lifecycle for packaged Windows smoke checks.

Split from ``release_integrity.py`` so that module stays within its reviewed
size; the release flow imports the smoke state from there.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import time
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path

from native_provenance import ReleaseIntegrityError

# Win32 errors that a just-exited browser can leave behind in its profile:
# access denied (pending deletion), sharing violation and directory not empty
# (a file disappearing or appearing while the tree is removed).
_TRANSIENT_PROFILE_ERRORS = frozenset({5, 32, 145})
_WEBVIEW_EXIT_TIMEOUT = 60.0
_PROFILE_CLEANUP_TIMEOUT = 30.0
_CLEANUP_POLL = 0.25
_WEBVIEW_PROCESS = "msedgewebview2.exe"
_USER_DATA_DIR = re.compile(r'--user-data-dir=(?:"([^"]*)"|(\S+))')


def _inside_webview_profile(path: str | os.PathLike[str], directory: Path) -> bool:
    try:
        candidate = Path(path).resolve()
        profile = (directory / "webview").resolve()
    except OSError:
        return False
    return candidate == profile or profile in candidate.parents


def _retryable_webview_cleanup_error(error: OSError, directory: Path) -> bool:
    # Only the isolated browser profile may race with shutdown. Configuration,
    # data and logs belong to the app, so their errors always fail the gate.
    return (
        getattr(error, "winerror", None) in _TRANSIENT_PROFILE_ERRORS
        and bool(error.filename)
        and _inside_webview_profile(error.filename, directory)
    )


def _webview_profile_processes(directory: Path, timeout: float = 30.0) -> list[int]:
    """Return the WebView2 processes whose user-data folder is this smoke profile."""
    script = (
        "$ErrorActionPreference = 'Stop'; "
        "[Console]::OutputEncoding = [Text.Encoding]::UTF8; "
        "$filter = \"Name = '$env:MEDIASORT_WEBVIEW_PROCESS'\"; "
        "$found = @(Get-CimInstance Win32_Process -Filter $filter | "
        "Select-Object ProcessId, CommandLine); "
        "ConvertTo-Json -InputObject $found -Compress"
    )
    env = os.environ.copy()
    env["MEDIASORT_WEBVIEW_PROCESS"] = _WEBVIEW_PROCESS
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
            env=env,
            capture_output=True,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=timeout,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ReleaseIntegrityError("could not list WebView2 smoke processes") from error
    if result.returncode != 0:
        raise ReleaseIntegrityError(
            f"could not list WebView2 smoke processes: {result.stderr.strip()}"
        )
    try:
        processes = json.loads(result.stdout or "[]")
    except json.JSONDecodeError as error:
        raise ReleaseIntegrityError("WebView2 process listing was not JSON") from error
    matches = []
    for process in processes:
        argument = _USER_DATA_DIR.search(process.get("CommandLine") or "")
        # Resolving the argument expands 8.3 names, so either spelling matches.
        if argument and _inside_webview_profile(argument.group(1) or argument.group(2), directory):
            matches.append(int(process["ProcessId"]))
    return matches


def _wait_for_webview_exit(directory: Path) -> None:
    """Wait until WebView2 has released the profile that the app just closed."""
    deadline = time.monotonic() + _WEBVIEW_EXIT_TIMEOUT
    reported = False
    processes: list[int] = []
    while True:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise ReleaseIntegrityError(
                f"WebView2 processes outlived the packaged app by "
                f"{_WEBVIEW_EXIT_TIMEOUT:.0f}s: {processes}"
            )
        processes = _webview_profile_processes(directory, timeout=min(30.0, remaining))
        if not processes:
            return
        if not reported:
            print(f"  waiting for WebView2 shutdown: {processes}", flush=True)
            reported = True
        time.sleep(min(_CLEANUP_POLL, max(0.0, deadline - time.monotonic())))


def _release_webview_profile(temporary: tempfile.TemporaryDirectory[str], directory: Path) -> None:
    if os.name == "nt":
        _wait_for_webview_exit(directory)
    deadline = time.monotonic() + _PROFILE_CLEANUP_TIMEOUT
    reported = False
    while True:
        try:
            temporary.cleanup()
            return
        except OSError as error:
            # Once its processes are gone, the browser profile may still
            # briefly hold pending deletions. Retry only inside that profile
            # and only for a bounded time; anything else fails the gate.
            if (
                os.name != "nt"
                or not _retryable_webview_cleanup_error(error, directory)
                or time.monotonic() >= deadline
            ):
                raise
            if not reported:
                print(f"  retrying WebView2 profile cleanup: {error}", flush=True)
                reported = True
            time.sleep(_CLEANUP_POLL)


@contextmanager
def _webview_smoke_state() -> Iterator[Path]:
    """Allow WebView2 to release its isolated profile after launcher shutdown."""
    temporary = tempfile.TemporaryDirectory(prefix="mediasorter-webview-smoke-")
    directory = Path(temporary.name).resolve()
    if directory.parent != Path(tempfile.gettempdir()).resolve():
        raise ReleaseIntegrityError("WebView smoke state escaped its temporary directory")
    try:
        yield directory
    except BaseException:
        # The smoke failure is the finding; report cleanup trouble beside it.
        try:
            _release_webview_profile(temporary, directory)
        except Exception as cleanup_error:
            print(f"  WebView2 smoke cleanup also failed: {cleanup_error}", flush=True)
        raise
    _release_webview_profile(temporary, directory)
