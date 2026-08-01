from __future__ import annotations

import hashlib
import importlib.util
import json
import stat
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "release_integrity.py"
REPO_ROOT = SCRIPT_PATH.parents[1]
SPEC = importlib.util.spec_from_file_location("release_integrity", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
release_integrity = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = release_integrity
SPEC.loader.exec_module(release_integrity)

PORTABLE_SCRIPT_PATH = SCRIPT_PATH.with_name("make_portable_zip.py")
PORTABLE_SPEC = importlib.util.spec_from_file_location("make_portable_zip", PORTABLE_SCRIPT_PATH)
assert PORTABLE_SPEC is not None and PORTABLE_SPEC.loader is not None
make_portable_zip = importlib.util.module_from_spec(PORTABLE_SPEC)
sys.modules[PORTABLE_SPEC.name] = make_portable_zip
PORTABLE_SPEC.loader.exec_module(make_portable_zip)


def complete_apple_environment() -> dict[str, str]:
    return {name: f"value-for-{name}" for name in release_integrity.APPLE_REQUIRED}


def complete_windows_environment(provider: str = "ca-backed") -> dict[str, str]:
    required = (
        release_integrity.WINDOWS_COMMON_REQUIRED
        + release_integrity.WINDOWS_PROVIDER_REQUIRED[provider]
    )
    environment = {name: f"value-for-{name}" for name in required}
    environment["WINDOWS_SIGNING_PROVIDER"] = provider
    environment["WINDOWS_SIGN_COMMAND_JSON"] = json.dumps(["signer", "{file}"])
    environment["WINDOWS_VERIFY_COMMAND_JSON"] = json.dumps(["verifier", "{file}"])
    return environment


@pytest.mark.parametrize("platform_name", ["macos", "windows"])
def test_absent_credentials_are_explicitly_unsigned(platform_name: str) -> None:
    state = release_integrity.classify_signing(platform_name, {})

    assert state.mode == "unsigned"
    assert state.provider == "none"


def test_complete_apple_credentials_enable_signing() -> None:
    state = release_integrity.classify_signing("macos", complete_apple_environment())

    assert state.mode == "signed"
    assert state.provider == "apple-developer-id"
    assert not state.missing_variables


@pytest.mark.parametrize(
    "provider",
    ["microsoft-artifact-signing", "signpath-oss", "ca-backed"],
)
def test_each_complete_windows_provider_enables_signing(provider: str) -> None:
    state = release_integrity.classify_signing("windows", complete_windows_environment(provider))

    assert state.mode == "signed"
    assert state.provider == provider


def test_partial_credentials_report_names_without_values() -> None:
    environment = complete_apple_environment()
    secret = environment.pop("APPLE_PASSWORD")

    state = release_integrity.classify_signing("macos", environment)
    message = "partial signing credentials; missing: " + ", ".join(state.missing_variables)

    assert state.mode == "partial"
    assert "APPLE_PASSWORD" in message
    assert secret not in message


def test_unknown_windows_provider_fails_safely() -> None:
    with pytest.raises(release_integrity.ReleaseIntegrityError) as caught:
        release_integrity.classify_signing(
            "windows", {"WINDOWS_SIGNING_PROVIDER": "mystery-provider"}
        )

    assert "mystery-provider" not in str(caught.value)
    assert "microsoft-artifact-signing" in str(caught.value)


def test_signing_state_round_trip(tmp_path: Path) -> None:
    state = release_integrity.classify_signing("macos", {})
    output = tmp_path / "state.json"

    release_integrity.write_signing_state(state, output)

    assert release_integrity.read_signing_state(output) == state
    assert "APPLE_CERTIFICATE" in output.read_text(encoding="utf-8")


def test_tauri_and_makefile_keep_signing_in_packaging_order() -> None:
    tauri_config = json.loads(
        (REPO_ROOT / "frontend" / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
    )
    sign_command = tauri_config["tauri"]["bundle"]["windows"]["signCommand"]
    assert sign_command == ("python -m scripts.release_integrity sign-windows-file --file %1")
    assert tauri_config["tauri"]["bundle"]["macOS"]["hardenedRuntime"] is True

    makefile = (REPO_ROOT / "Makefile").read_text(encoding="utf-8")
    release_line = next(line for line in makefile.splitlines() if line.startswith("release:"))
    dependencies = release_line.split()[1:]
    assert dependencies.index("release-prepare") < dependencies.index("build-tauri")
    assert dependencies.index("build-tauri") < dependencies.index("release-finalize")
    assert "Fixed executable permissions in .app bundle" not in makefile
    assert 'PATH="$(CURDIR)/$(BACKEND)/.venv/$(VENV_BIN):$(DEV_PATH)"' in makefile
    assert (
        'if [ -z "$$APPLE_SIGNING_IDENTITY" ]; then unset APPLE_SIGNING_IDENTITY; fi;' in makefile
    )


def test_snapshot_detects_content_and_mode_mutation(tmp_path: Path) -> None:
    root = tmp_path / "payload"
    root.mkdir()
    payload = root / "backend"
    payload.write_bytes(b"original")
    payload.chmod(0o755)
    snapshot = tmp_path / "snapshot.json"
    release_integrity.create_snapshot(root, snapshot)
    release_integrity.verify_snapshot(root, snapshot)

    payload.write_bytes(b"changed")
    with pytest.raises(release_integrity.ReleaseIntegrityError, match="changed"):
        release_integrity.verify_snapshot(root, snapshot)

    payload.write_bytes(b"original")
    payload.chmod(0o644)
    with pytest.raises(release_integrity.ReleaseIntegrityError, match="changed"):
        release_integrity.verify_snapshot(root, snapshot)


def test_normalize_finishes_modes_before_snapshot(tmp_path: Path) -> None:
    root = tmp_path / "resources"
    backend = root / "backend" / "mediasort-backend"
    regular = root / "backend" / "data.json"
    backend.parent.mkdir(parents=True)
    backend.write_bytes(b"executable")
    regular.write_bytes(b"data")

    release_integrity.normalize_payload_modes(root, "macos")

    assert stat.S_IMODE(backend.stat().st_mode) == 0o755
    assert stat.S_IMODE(regular.stat().st_mode) == 0o644
    assert stat.S_IMODE(backend.parent.stat().st_mode) == 0o755


def test_unsigned_nested_signing_runs_no_commands(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    root = tmp_path / "resources"
    root.mkdir()
    (root / "payload.exe").write_bytes(b"MZpayload")
    called = False

    def unexpected_run(*args: object, **kwargs: object) -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(subprocess, "run", unexpected_run)
    state = release_integrity.classify_signing("windows", {})

    assert release_integrity.sign_nested_payloads(root, state, {}) == []
    assert not called


def test_packaged_backend_smoke_uses_launch_capability(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    observed: dict[str, object] = {}

    class Listener:
        def __enter__(self) -> Listener:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def bind(self, address: tuple[str, int]) -> None:
            assert address == ("127.0.0.1", 0)

        def getsockname(self) -> tuple[str, int]:
            return ("127.0.0.1", 43123)

    class Process:
        def poll(self) -> None:
            return None

        def terminate(self) -> None:
            return None

        def wait(self, *, timeout: int) -> int:
            assert timeout == 10
            return 0

    class Response:
        status = 200

        def __enter__(self) -> Response:
            return self

        def __exit__(self, *_args: object) -> None:
            return None

    def popen(
        command: list[str],
        *,
        env: dict[str, str],
        stdout: object,
        stderr: object,
    ) -> Process:
        observed["command"] = command
        observed["capability"] = env["MEDIASORT_API_CAPABILITY"]
        assert stdout is subprocess.DEVNULL
        assert stderr is subprocess.DEVNULL
        return Process()

    def urlopen(request: object, *, timeout: int) -> Response:
        assert isinstance(request, release_integrity.urllib.request.Request)
        observed["header"] = request.get_header("X-mediasorter-capability")
        assert request.full_url == "http://127.0.0.1:43123/api/health"
        assert timeout == 1
        return Response()

    backend = tmp_path / "mediasort-backend"
    monkeypatch.setattr(release_integrity.socket, "socket", lambda *_args: Listener())
    monkeypatch.setattr(release_integrity.subprocess, "Popen", popen)
    monkeypatch.setattr(release_integrity.urllib.request, "urlopen", urlopen)

    release_integrity._smoke_backend(backend)

    assert observed["command"] == [str(backend)]
    assert observed["header"] == observed["capability"]
    assert len(str(observed["capability"])) >= 32


def test_packaged_webview_smoke_requires_frontend_ready_marker(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    launcher = tmp_path / "MediaSorter"

    def run(
        command: list[str],
        *,
        env: dict[str, str],
        stdout: object,
        stderr: object,
        check: bool,
        timeout: int,
    ) -> subprocess.CompletedProcess[bytes]:
        assert command == [str(launcher)]
        assert env["MEDIASORT_WEBVIEW_SMOKE"] == "1"
        assert env["MEDIASORT_STARTUP_SMOKE_NONINTERACTIVE"] == "1"
        assert stdout is subprocess.DEVNULL
        assert stderr is subprocess.DEVNULL
        assert check is False
        assert timeout == 60
        log_dir = Path(env["MEDIASORT_LOG_DIR"])
        (log_dir / "mediasort.log").write_text(
            "backend ready\npackaged_webview_frontend_ready\n",
            encoding="utf-8",
        )
        return subprocess.CompletedProcess(command, 0)

    monkeypatch.setattr(release_integrity.subprocess, "run", run)

    release_integrity._smoke_packaged_webview(launcher)


def test_packaged_webview_smoke_rejects_a_blank_shell(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def run(*_args: object, **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        environment = kwargs["env"]
        assert isinstance(environment, dict)
        log_dir = Path(str(environment["MEDIASORT_LOG_DIR"]))
        (log_dir / "mediasort.log").write_text("backend ready\n", encoding="utf-8")
        return subprocess.CompletedProcess([], 0)

    monkeypatch.setattr(release_integrity.subprocess, "run", run)

    with pytest.raises(release_integrity.ReleaseIntegrityError, match="never acknowledged"):
        release_integrity._smoke_packaged_webview(tmp_path / "MediaSorter")


def test_tauri_sign_command_is_unsigned_noop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    artifact = tmp_path / "MediaSorter.exe"
    artifact.write_bytes(b"MZpayload")

    def unexpected_run(*args: object, **kwargs: object) -> None:
        pytest.fail("unsigned mode must not invoke a signer")

    monkeypatch.setattr(subprocess, "run", unexpected_run)
    release_integrity.sign_windows_file(artifact, {})


def test_windows_command_contract_uses_no_shell_and_redacts_secrets(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = tmp_path / "payload.exe"
    payload.write_bytes(b"MZpayload")
    environment = complete_windows_environment()
    environment["WINDOWS_SIGN_COMMAND_JSON"] = json.dumps(
        ["signer", "--password", "{env:WINDOWS_CERTIFICATE_PASSWORD}", "{file}"]
    )
    state = release_integrity.classify_signing("windows", environment)
    commands: list[list[str]] = []

    def record_run(command: list[str], *, check: bool) -> None:
        assert check is True
        commands.append(command)

    monkeypatch.setattr(subprocess, "run", record_run)
    release_integrity.sign_nested_payloads(tmp_path, state, environment)

    assert len(commands) == 2
    assert commands[0][0] == "signer"
    assert commands[0][-1] == str(payload)
    assert environment["WINDOWS_CERTIFICATE_PASSWORD"] in commands[0]


def test_invalid_command_failure_never_displays_secret(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    payload = tmp_path / "payload.exe"
    payload.write_bytes(b"MZpayload")
    environment = complete_windows_environment()
    secret = environment["WINDOWS_CERTIFICATE_PASSWORD"]
    environment["WINDOWS_SIGN_COMMAND_JSON"] = json.dumps(
        ["signer", "{env:WINDOWS_CERTIFICATE_PASSWORD}", "{file}"]
    )
    state = release_integrity.classify_signing("windows", environment)

    def fail(*args: object, **kwargs: object) -> None:
        raise subprocess.CalledProcessError(1, ["redacted"])

    monkeypatch.setattr(subprocess, "run", fail)
    with pytest.raises(release_integrity.ReleaseIntegrityError) as caught:
        release_integrity.sign_nested_payloads(tmp_path, state, environment)

    assert secret not in str(caught.value)
    assert "redacted" in str(caught.value)


def test_file_type_checks_reject_wrong_magic(tmp_path: Path) -> None:
    artifact = tmp_path / "installer.exe"
    artifact.write_bytes(b"not-an-executable")

    with pytest.raises(release_integrity.ReleaseIntegrityError, match="file type"):
        release_integrity._require_magic(artifact, b"MZ")


def _write_pe_fixture(path: Path, subsystem: int) -> None:
    pe_offset = 0x80
    optional_size = 0xF0
    payload = bytearray(pe_offset + 4 + 20 + optional_size)
    payload[:2] = b"MZ"
    release_integrity.struct.pack_into("<I", payload, 0x3C, pe_offset)
    payload[pe_offset : pe_offset + 4] = b"PE\0\0"
    coff_offset = pe_offset + 4
    release_integrity.struct.pack_into("<H", payload, coff_offset + 16, optional_size)
    optional_offset = coff_offset + 20
    release_integrity.struct.pack_into("<H", payload, optional_offset, 0x20B)
    release_integrity.struct.pack_into("<H", payload, optional_offset + 68, subsystem)
    path.write_bytes(payload)


def test_windows_shell_requires_gui_subsystem(tmp_path: Path) -> None:
    shell = tmp_path / "MediaSorter.exe"
    _write_pe_fixture(shell, release_integrity.WINDOWS_GUI_SUBSYSTEM)

    release_integrity._require_windows_gui_subsystem(shell)

    _write_pe_fixture(shell, 3)
    with pytest.raises(release_integrity.ReleaseIntegrityError, match="allocate a console"):
        release_integrity._require_windows_gui_subsystem(shell)


@pytest.mark.parametrize("payload", [b"", b"MZ", b"MZ" + b"\0" * 0x100])
def test_windows_shell_rejects_invalid_pe_headers(tmp_path: Path, payload: bytes) -> None:
    shell = tmp_path / "MediaSorter.exe"
    shell.write_bytes(payload)

    with pytest.raises(release_integrity.ReleaseIntegrityError):
        release_integrity._require_windows_gui_subsystem(shell)


def test_dmg_mount_contract_detaches_verified_volume(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mount_point = tmp_path / "MediaSorter"
    mount_point.mkdir()
    plist = release_integrity.plistlib.dumps(
        {"system-entities": [{"mount-point": str(mount_point)}]}
    )
    calls: list[list[str]] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes]:
        calls.append(command)
        return subprocess.CompletedProcess(command, 0, stdout=plist)

    monkeypatch.setattr(subprocess, "run", fake_run)

    with release_integrity._mounted_dmg(tmp_path / "MediaSorter.dmg") as mounted:
        assert mounted == mount_point

    assert calls[0][:2] == ["hdiutil", "attach"]
    assert calls[-1][:2] == ["hdiutil", "detach"]


def test_dmg_detach_retries_a_transient_busy_volume(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    mount_point = tmp_path / "MediaSorter"
    mount_point.mkdir()
    plist = release_integrity.plistlib.dumps(
        {"system-entities": [{"mount-point": str(mount_point)}]}
    )
    detach_attempts = 0
    sleeps: list[float] = []

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[bytes | str]:
        nonlocal detach_attempts
        if command[:2] == ["hdiutil", "attach"]:
            return subprocess.CompletedProcess(command, 0, stdout=plist)
        detach_attempts += 1
        if detach_attempts == 1:
            return subprocess.CompletedProcess(command, 16, stdout="", stderr="busy")
        return subprocess.CompletedProcess(command, 0, stdout="", stderr="")

    monkeypatch.setattr(subprocess, "run", fake_run)
    monkeypatch.setattr(release_integrity.time, "sleep", sleeps.append)

    with release_integrity._mounted_dmg(tmp_path / "MediaSorter.dmg"):
        pass

    assert detach_attempts == 2
    assert sleeps == [0.5]


def test_portable_zip_requires_all_native_payloads(tmp_path: Path) -> None:
    archive_path = tmp_path / "portable.zip"
    with release_integrity.zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr("MediaSorter-portable/app/MediaSorter.exe", b"MZ")

    with pytest.raises(release_integrity.ReleaseIntegrityError, match="missing"):
        release_integrity._zip_required(archive_path)


def test_portable_builder_matches_launcher_resource_layout(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    target = tmp_path / "target" / "release"
    resources = tmp_path / "resources"
    target.mkdir(parents=True)
    (target / "media-sorter.exe").write_bytes(b"MZshell")
    (resources / "backend").mkdir(parents=True)
    (resources / "backend" / "mediasort-backend.exe").write_bytes(b"MZbackend")
    (resources / "ffmpeg").mkdir()
    (resources / "ffmpeg" / "ffmpeg.exe").write_bytes(b"MZffmpeg")
    (resources / "ffmpeg" / "ffprobe.exe").write_bytes(b"MZffprobe")
    (resources / "ffmpeg" / "native-tools-provenance.json").write_text(
        json.dumps(
            {
                "schema_version": 1,
                "source_manifest_version": "fixture",
                "platform": "windows",
                "architecture": "x86_64",
                "sources": [
                    {
                        "url": "https://example.test/releases/v1/ffmpeg.zip",
                        "sha256": "a" * 64,
                    }
                ],
                "bundled_binaries": {
                    "ffmpeg.exe": {
                        "sha256": hashlib.sha256(b"MZffmpeg").hexdigest(),
                        "size_bytes": 8,
                    },
                    "ffprobe.exe": {
                        "sha256": hashlib.sha256(b"MZffprobe").hexdigest(),
                        "size_bytes": 9,
                    },
                },
            }
        ),
        encoding="utf-8",
    )
    (resources / "clip").mkdir()
    (resources / "clip" / "stale-model.onnx").write_bytes(b"must-not-ship")
    output = tmp_path / "output"
    monkeypatch.setattr(make_portable_zip, "TARGET_RELEASE", target)
    monkeypatch.setattr(make_portable_zip, "RESOURCES_SRC", resources)
    monkeypatch.setattr(
        sys,
        "argv",
        [
            "make_portable_zip.py",
            "--out-dir",
            str(output),
        ],
    )

    assert make_portable_zip.main() == 0

    archive_path = output / "MediaSorter-portable.zip"
    _, required = release_integrity._zip_required(archive_path)
    release_integrity._verify_zip_native_provenance(archive_path, required)
    with release_integrity.zipfile.ZipFile(archive_path) as archive:
        assert set(required.values()) <= set(archive.namelist())
        assert not any("/clip/" in name for name in archive.namelist())
