#!/usr/bin/env python3
"""Prepare, sign, and verify MediaSorter release payloads.

The script is deliberately stdlib-only so the same contract works on clean
GitHub-hosted macOS and Windows runners. Signing is optional, but ambiguous
credential state is not: no credentials produces an explicitly unsigned build,
a complete set enables mandatory signing and verification, and a partial set
fails before packaging.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import plistlib
import re
import shutil
import socket
import stat
import struct
import subprocess
import sys
import tempfile
import time
import urllib.request
import zipfile
from collections.abc import Mapping, Sequence
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
TAURI_DIR = REPO_ROOT / "frontend" / "src-tauri"
RESOURCES_DIR = TAURI_DIR / "resources"
TARGET_RELEASE = TAURI_DIR / "target" / "release"
BUNDLE_DIR = TARGET_RELEASE / "bundle"

APPLE_REQUIRED = (
    "APPLE_CERTIFICATE",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_ID",
    "APPLE_PASSWORD",
    "APPLE_TEAM_ID",
)
WINDOWS_COMMON_REQUIRED = (
    "WINDOWS_SIGNING_PROVIDER",
    "WINDOWS_SIGN_COMMAND_JSON",
    "WINDOWS_VERIFY_COMMAND_JSON",
    "WINDOWS_TIMESTAMP_URL",
)
WINDOWS_PROVIDER_REQUIRED = {
    "microsoft-artifact-signing": (
        "AZURE_TENANT_ID",
        "AZURE_CLIENT_ID",
        "AZURE_CLIENT_SECRET",
        "AZURE_CODE_SIGNING_ENDPOINT",
        "AZURE_CODE_SIGNING_ACCOUNT",
        "AZURE_CODE_SIGNING_PROFILE",
    ),
    "signpath-oss": (
        "SIGNPATH_API_TOKEN",
        "SIGNPATH_ORGANIZATION_ID",
        "SIGNPATH_PROJECT_SLUG",
        "SIGNPATH_SIGNING_POLICY_SLUG",
    ),
    "ca-backed": (
        "WINDOWS_CERTIFICATE_BASE64",
        "WINDOWS_CERTIFICATE_PASSWORD",
    ),
}
MACHO_MAGICS = {
    b"\xfe\xed\xfa\xce",
    b"\xce\xfa\xed\xfe",
    b"\xfe\xed\xfa\xcf",
    b"\xcf\xfa\xed\xfe",
    b"\xca\xfe\xba\xbe",
    b"\xbe\xba\xfe\xca",
    b"\xca\xfe\xba\xbf",
    b"\xbf\xba\xfe\xca",
}
ENV_PLACEHOLDER = re.compile(r"\{env:([A-Z][A-Z0-9_]*)\}")
WINDOWS_GUI_SUBSYSTEM = 2


class ReleaseIntegrityError(RuntimeError):
    """A safe-to-display release preparation or verification failure."""


@dataclass(frozen=True)
class SigningState:
    platform: str
    mode: str
    provider: str
    required_variables: tuple[str, ...]
    missing_variables: tuple[str, ...] = ()


def _has_value(environment: Mapping[str, str], name: str) -> bool:
    return bool(environment.get(name, "").strip())


def classify_signing(
    platform_name: str, environment: Mapping[str, str] | None = None
) -> SigningState:
    """Classify a platform credential set without returning secret values."""
    env = os.environ if environment is None else environment
    if platform_name == "macos":
        required = APPLE_REQUIRED
        provider = "apple-developer-id"
    elif platform_name == "windows":
        provider = env.get("WINDOWS_SIGNING_PROVIDER", "").strip()
        provider_required = WINDOWS_PROVIDER_REQUIRED.get(provider, ())
        required = WINDOWS_COMMON_REQUIRED + provider_required
    else:
        return SigningState(platform_name, "unsigned", "none", ())

    common_present = [name for name in required if _has_value(env, name)]
    if not common_present:
        return SigningState(platform_name, "unsigned", "none", required)

    if platform_name == "windows" and provider not in WINDOWS_PROVIDER_REQUIRED:
        supported = ", ".join(sorted(WINDOWS_PROVIDER_REQUIRED))
        raise ReleaseIntegrityError(
            "WINDOWS_SIGNING_PROVIDER must be one of: "
            f"{supported}; no secret values were inspected or printed"
        )

    missing = tuple(name for name in required if not _has_value(env, name))
    if missing:
        return SigningState(platform_name, "partial", provider, required, missing)
    return SigningState(platform_name, "signed", provider, required)


def _atomic_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    with temporary.open("w", encoding="utf-8") as handle:
        json.dump(value, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


def write_signing_state(state: SigningState, output: Path) -> None:
    value = asdict(state)
    value["required_variables"] = list(state.required_variables)
    value["missing_variables"] = list(state.missing_variables)
    _atomic_json(output, value)


def read_signing_state(path: Path) -> SigningState:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        return SigningState(
            platform=str(raw["platform"]),
            mode=str(raw["mode"]),
            provider=str(raw["provider"]),
            required_variables=tuple(raw.get("required_variables", [])),
            missing_variables=tuple(raw.get("missing_variables", [])),
        )
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ReleaseIntegrityError(
            f"invalid signing-state file {path}: {error}"
        ) from error


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def normalize_payload_modes(root: Path, platform_name: str) -> None:
    if not root.is_dir():
        raise ReleaseIntegrityError(f"bundled resource directory is missing: {root}")
    if platform_name == "windows":
        return

    executable_names = {"mediasort-backend", "ffmpeg", "ffprobe"}
    for path in sorted(root.rglob("*")):
        if path.is_dir():
            path.chmod(0o755)
        elif path.is_file():
            mode = 0o755 if path.name in executable_names else 0o644
            path.chmod(mode)


def create_snapshot(root: Path, output: Path) -> None:
    if not root.is_dir():
        raise ReleaseIntegrityError(f"snapshot root is missing: {root}")
    files = {}
    for path in sorted(item for item in root.rglob("*") if item.is_file()):
        relative = path.relative_to(root).as_posix()
        files[relative] = {
            "sha256": _sha256(path),
            "mode": stat.S_IMODE(path.stat().st_mode),
            "size": path.stat().st_size,
        }
    if not files:
        raise ReleaseIntegrityError(f"snapshot root contains no files: {root}")
    _atomic_json(output, {"version": 1, "root": str(root), "files": files})


def verify_snapshot(root: Path, snapshot: Path) -> None:
    try:
        raw = json.loads(snapshot.read_text(encoding="utf-8"))
        expected = raw["files"]
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise ReleaseIntegrityError(
            f"invalid payload snapshot {snapshot}: {error}"
        ) from error

    current = {
        path.relative_to(root).as_posix(): {
            "sha256": _sha256(path),
            "mode": stat.S_IMODE(path.stat().st_mode),
            "size": path.stat().st_size,
        }
        for path in sorted(item for item in root.rglob("*") if item.is_file())
    }
    if current != expected:
        changed = sorted(set(current) | set(expected))
        changed = [name for name in changed if current.get(name) != expected.get(name)]
        preview = ", ".join(changed[:10])
        raise ReleaseIntegrityError(
            "bundled payload changed after the signing snapshot"
            + (f": {preview}" if preview else "")
        )


def _is_macho(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return handle.read(4) in MACHO_MAGICS
    except OSError:
        return False


def _is_pe(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return handle.read(2) == b"MZ"
    except OSError:
        return False


def _load_command(name: str, environment: Mapping[str, str]) -> list[str]:
    raw = environment.get(name, "")
    try:
        value = json.loads(raw)
    except ValueError as error:
        raise ReleaseIntegrityError(
            f"{name} must contain a JSON argument array"
        ) from error
    if (
        not isinstance(value, list)
        or not value
        or not all(isinstance(item, str) for item in value)
    ):
        raise ReleaseIntegrityError(
            f"{name} must contain a non-empty JSON argument array"
        )
    if not any("{file}" in item for item in value):
        raise ReleaseIntegrityError(f"{name} must contain a {{file}} placeholder")
    return value


def render_command(
    template: Sequence[str], path: Path, environment: Mapping[str, str]
) -> list[str]:
    timestamp_url = environment.get("WINDOWS_TIMESTAMP_URL", "")

    def replace_environment(match: re.Match[str]) -> str:
        name = match.group(1)
        value = environment.get(name, "")
        if not value:
            raise ReleaseIntegrityError(
                f"signing command requires missing variable {name}"
            )
        return value

    rendered = []
    for argument in template:
        value = argument.replace("{file}", str(path)).replace(
            "{timestamp_url}", timestamp_url
        )
        rendered.append(ENV_PLACEHOLDER.sub(replace_environment, value))
    return rendered


def _run_safe(
    template_name: str,
    path: Path,
    environment: Mapping[str, str],
    *,
    purpose: str,
) -> None:
    template = _load_command(template_name, environment)
    command = render_command(template, path, environment)
    print(f"  {purpose}: {path}", flush=True)
    try:
        subprocess.run(command, check=True)
    except (OSError, subprocess.CalledProcessError) as error:
        raise ReleaseIntegrityError(
            f"{purpose} failed for {path}; command arguments and secrets are redacted"
        ) from error


def sign_nested_payloads(
    root: Path,
    state: SigningState,
    environment: Mapping[str, str] | None = None,
) -> list[Path]:
    env = os.environ if environment is None else environment
    if state.mode == "unsigned":
        print(f"Signing mode: explicitly unsigned ({state.platform})", flush=True)
        return []
    if state.mode != "signed":
        raise ReleaseIntegrityError(
            "partial credentials: missing " + ", ".join(state.missing_variables)
        )

    if state.platform == "macos":
        identity = env["APPLE_SIGNING_IDENTITY"]
        files = sorted(
            (path for path in root.rglob("*") if path.is_file() and _is_macho(path)),
            key=lambda path: len(path.parts),
            reverse=True,
        )
        for path in files:
            print(f"  sign nested Mach-O: {path}", flush=True)
            subprocess.run(
                [
                    "codesign",
                    "--force",
                    "--options",
                    "runtime",
                    "--timestamp",
                    "--sign",
                    identity,
                    str(path),
                ],
                check=True,
            )
        return files

    if state.platform == "windows":
        files = sorted(
            path
            for path in root.rglob("*")
            if path.is_file()
            and path.suffix.lower() in {".exe", ".dll"}
            and _is_pe(path)
        )
        for path in files:
            _run_safe("WINDOWS_SIGN_COMMAND_JSON", path, env, purpose="sign nested PE")
            _run_safe(
                "WINDOWS_VERIFY_COMMAND_JSON", path, env, purpose="verify nested PE"
            )
        return files

    return []


def _glob_files(patterns: Sequence[str]) -> list[Path]:
    found: set[Path] = set()
    for pattern in patterns:
        found.update(path for path in BUNDLE_DIR.glob(pattern) if path.is_file())
    return sorted(found)


def _windows_shell() -> Path:
    candidates = [
        TARGET_RELEASE / "MediaSorter.exe",
        TARGET_RELEASE / "media-sorter.exe",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    matches = sorted(TARGET_RELEASE.glob("*.exe"))
    if len(matches) == 1:
        return matches[0]
    raise ReleaseIntegrityError(
        f"could not identify the Windows Tauri shell under {TARGET_RELEASE}"
    )


def _macos_shell(app: Path) -> Path:
    executable_dir = app / "Contents" / "MacOS"
    for name in ("MediaSorter", "media-sorter"):
        candidate = executable_dir / name
        if candidate.is_file():
            return candidate
    matches = sorted(path for path in executable_dir.glob("*") if path.is_file())
    if len(matches) == 1:
        return matches[0]
    raise ReleaseIntegrityError(
        f"could not identify the macOS shell under {executable_dir}"
    )


def sign_outer_artifacts(
    state: SigningState, environment: Mapping[str, str] | None = None
) -> list[Path]:
    env = os.environ if environment is None else environment
    if state.mode == "unsigned":
        print(
            f"Outer artifacts remain explicitly unsigned ({state.platform})", flush=True
        )
        return []
    if state.mode != "signed":
        raise ReleaseIntegrityError(
            "partial credentials: missing " + ", ".join(state.missing_variables)
        )

    if state.platform == "windows":
        paths = [_windows_shell()]
        paths.extend(_glob_files(("msi/*.msi", "nsis/*-setup.exe")))
        if len(paths) < 3:
            raise ReleaseIntegrityError(
                "Windows shell, MSI, and NSIS artifacts are required"
            )
        for path in paths:
            _run_safe(
                "WINDOWS_SIGN_COMMAND_JSON", path, env, purpose="sign outer artifact"
            )
            _run_safe(
                "WINDOWS_VERIFY_COMMAND_JSON",
                path,
                env,
                purpose="verify outer artifact",
            )
        return paths

    if state.platform == "macos":
        app = BUNDLE_DIR / "macos" / "MediaSorter.app"
        dmgs = _glob_files(("dmg/*.dmg",))
        if not app.is_dir() or len(dmgs) != 1:
            raise ReleaseIntegrityError(
                "exactly one DMG and the packaged app are required"
            )
        subprocess.run(
            ["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)],
            check=True,
        )
        subprocess.run(
            ["spctl", "--assess", "--type", "execute", "--verbose=2", str(app)],
            check=True,
        )
        dmg = dmgs[0]
        subprocess.run(
            [
                "codesign",
                "--force",
                "--timestamp",
                "--sign",
                env["APPLE_SIGNING_IDENTITY"],
                str(dmg),
            ],
            check=True,
        )
        subprocess.run(
            [
                "xcrun",
                "notarytool",
                "submit",
                str(dmg),
                "--apple-id",
                env["APPLE_ID"],
                "--password",
                env["APPLE_PASSWORD"],
                "--team-id",
                env["APPLE_TEAM_ID"],
                "--wait",
            ],
            check=True,
        )
        subprocess.run(["xcrun", "stapler", "staple", str(dmg)], check=True)
        subprocess.run(["xcrun", "stapler", "validate", str(dmg)], check=True)
        subprocess.run(["codesign", "--verify", "--verbose=2", str(dmg)], check=True)
        subprocess.run(
            ["spctl", "--assess", "--type", "open", "--verbose=2", str(dmg)], check=True
        )
        return [dmg]

    return []


def sign_windows_file(path: Path, environment: Mapping[str, str] | None = None) -> None:
    """Tauri v1 custom-sign-command entry point for shell/package ordering."""
    env = os.environ if environment is None else environment
    state = classify_signing("windows", env)
    if state.mode == "unsigned":
        print(f"Explicitly unsigned Tauri artifact: {path}", flush=True)
        return
    if state.mode == "partial":
        raise ReleaseIntegrityError(
            "partial signing credentials; missing: "
            + ", ".join(state.missing_variables)
        )
    _run_safe("WINDOWS_SIGN_COMMAND_JSON", path, env, purpose="sign Tauri artifact")
    _run_safe("WINDOWS_VERIFY_COMMAND_JSON", path, env, purpose="verify Tauri artifact")


def _require_file(path: Path, minimum_size: int = 1) -> None:
    if not path.is_file():
        raise ReleaseIntegrityError(f"required artifact is missing: {path}")
    if path.stat().st_size < minimum_size:
        raise ReleaseIntegrityError(
            f"artifact is too small: {path} ({path.stat().st_size} < {minimum_size} bytes)"
        )


def _require_magic(path: Path, expected: bytes, *, offset: int = 0) -> None:
    with path.open("rb") as handle:
        if offset < 0:
            handle.seek(offset, os.SEEK_END)
        else:
            handle.seek(offset)
        actual = handle.read(len(expected))
    if actual != expected:
        raise ReleaseIntegrityError(f"unexpected file type for {path}")


def _require_windows_gui_subsystem(path: Path) -> None:
    """Require a packaged PE executable that does not allocate a console."""
    _require_magic(path, b"MZ")
    try:
        with path.open("rb") as handle:
            handle.seek(0x3C)
            pe_offset_bytes = handle.read(4)
            if len(pe_offset_bytes) != 4:
                raise ValueError("truncated DOS header")
            pe_offset = struct.unpack("<I", pe_offset_bytes)[0]
            handle.seek(pe_offset)
            if handle.read(4) != b"PE\0\0":
                raise ValueError("missing PE signature")
            coff_header = handle.read(20)
            if len(coff_header) != 20:
                raise ValueError("truncated COFF header")
            optional_size = struct.unpack_from("<H", coff_header, 16)[0]
            optional_header = handle.read(optional_size)
            if len(optional_header) != optional_size or optional_size < 70:
                raise ValueError("truncated optional header")
            magic = struct.unpack_from("<H", optional_header)[0]
            if magic not in (0x10B, 0x20B):
                raise ValueError("unsupported optional-header format")
            subsystem = struct.unpack_from("<H", optional_header, 68)[0]
    except (OSError, ValueError, struct.error) as error:
        raise ReleaseIntegrityError(f"invalid Windows PE header: {path}") from error
    if subsystem != WINDOWS_GUI_SUBSYSTEM:
        raise ReleaseIntegrityError(
            f"packaged Windows shell would allocate a console: {path}"
        )


def _smoke_program(path: Path, arguments: Sequence[str]) -> None:
    try:
        subprocess.run(
            [str(path), *arguments],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
            timeout=30,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        raise ReleaseIntegrityError(f"smoke invocation failed: {path}") from error


def _smoke_backend(path: Path) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    with tempfile.TemporaryDirectory(prefix="mediasorter-backend-smoke-") as temporary:
        temp = Path(temporary)
        env = os.environ.copy()
        env.update(
            {
                "MEDIASORT_PORT": str(port),
                "MEDIASORT_CONFIG_DIR": str(temp / "config"),
                "MEDIASORT_DATA_DIR": str(temp / "data"),
                "MEDIASORT_LOG_DIR": str(temp / "logs"),
            }
        )
        process = subprocess.Popen(
            [str(path)],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + 30
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    raise ReleaseIntegrityError(
                        f"packaged backend exited before health check: {path}"
                    )
                try:
                    with urllib.request.urlopen(
                        f"http://127.0.0.1:{port}/api/health", timeout=1
                    ) as response:
                        if response.status == 200:
                            return
                except OSError:
                    time.sleep(0.25)
            raise ReleaseIntegrityError(
                f"packaged backend health check timed out: {path}"
            )
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)


def _smoke_launcher(path: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="mediasorter-launcher-smoke-") as temporary:
        log_dir = Path(temporary)
        env = os.environ.copy()
        env.update(
            {
                "MEDIASORT_LOG_DIR": str(log_dir),
                "MEDIASORT_STARTUP_SMOKE_FAIL": "1",
                "MEDIASORT_STARTUP_SMOKE_NONINTERACTIVE": "1",
            }
        )
        result = subprocess.run(
            [str(path)],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=30,
        )
        if result.returncode == 0:
            raise ReleaseIntegrityError(
                "controlled launcher failure exited successfully"
            )
        log_path = log_dir / "mediasort.log"
        _require_file(log_path)
        log_text = log_path.read_text(encoding="utf-8")
        for marker in (
            "MEDIASORT_STARTUP_SMOKE_FAIL=1",
            "native_dialog_recovery_reached",
        ):
            if marker not in log_text:
                raise ReleaseIntegrityError(
                    f"controlled launcher recovery marker is missing: {marker}"
                )


def _zip_required(zip_path: Path) -> tuple[str, dict[str, str]]:
    with zipfile.ZipFile(zip_path) as archive:
        names = set(archive.namelist())
        roots = {name.split("/", 1)[0] for name in names if "/" in name}
        if len(roots) != 1:
            raise ReleaseIntegrityError(
                f"portable ZIP needs one root directory: {zip_path}"
            )
        root = roots.pop()
        required = {
            "shell": f"{root}/app/MediaSorter.exe",
            "backend": f"{root}/app/resources/backend/mediasort-backend.exe",
            "ffmpeg": f"{root}/app/resources/ffmpeg/ffmpeg.exe",
            "ffprobe": f"{root}/app/resources/ffmpeg/ffprobe.exe",
        }
        missing = [name for name in required.values() if name not in names]
        if missing:
            raise ReleaseIntegrityError(
                "portable ZIP is missing required payloads: " + ", ".join(missing)
            )
    return root, required


@contextmanager
def _mounted_dmg(dmg: Path):
    try:
        result = subprocess.run(
            ["hdiutil", "attach", "-nobrowse", "-readonly", "-plist", str(dmg)],
            check=True,
            capture_output=True,
        )
        document = plistlib.loads(result.stdout)
        mount_points = [
            entity["mount-point"]
            for entity in document.get("system-entities", [])
            if "mount-point" in entity
        ]
        if len(mount_points) != 1:
            raise ReleaseIntegrityError(f"could not identify mounted DMG volume: {dmg}")
        mount_point = Path(mount_points[0])
        yield mount_point
    finally:
        if "mount_point" in locals():
            last_error = ""
            for attempt in range(5):
                detached = subprocess.run(
                    ["hdiutil", "detach", str(mount_point)],
                    check=False,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    text=True,
                )
                if detached.returncode == 0:
                    break
                last_error = detached.stderr.strip()
                if attempt < 4:
                    time.sleep(0.5 * (attempt + 1))
            else:
                raise ReleaseIntegrityError(
                    f"could not detach verified DMG volume {mount_point} "
                    f"after bounded retries: {last_error}"
                )


def _write_checksums(paths: Sequence[Path], output: Path) -> None:
    lines = [f"{_sha256(path)}  {path.name}" for path in sorted(paths)]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")


def verify_release(
    platform_name: str,
    state: SigningState,
    *,
    minimum_size: int,
    run_smoke: bool,
    environment: Mapping[str, str] | None = None,
) -> list[Path]:
    env = os.environ if environment is None else environment
    verified: list[Path] = []
    if platform_name == "macos":
        dmgs = _glob_files(("dmg/*.dmg",))
        if len(dmgs) != 1:
            raise ReleaseIntegrityError("exactly one macOS DMG is required")
        dmg = dmgs[0]
        _require_file(dmg, minimum_size)
        _require_magic(dmg, b"koly", offset=-512)
        with _mounted_dmg(dmg) as mount_point:
            app = mount_point / "MediaSorter.app"
            shell = _macos_shell(app)
            payload = app / "Contents" / "Resources" / "resources"
            backend = payload / "backend" / "mediasort-backend"
            ffmpeg = payload / "ffmpeg" / "ffmpeg"
            ffprobe = payload / "ffmpeg" / "ffprobe"
            for path in (shell, backend, ffmpeg, ffprobe):
                _require_file(path)
                if not os.access(path, os.X_OK):
                    raise ReleaseIntegrityError(
                        f"packaged executable mode is missing: {path}"
                    )
            if state.mode == "signed":
                for path in sorted(
                    (
                        item
                        for item in app.rglob("*")
                        if item.is_file() and _is_macho(item)
                    ),
                    key=lambda item: len(item.parts),
                    reverse=True,
                ):
                    subprocess.run(
                        ["codesign", "--verify", "--strict", "--verbose=2", str(path)],
                        check=True,
                    )
                subprocess.run(
                    ["codesign", "--verify", "--deep", "--strict", str(app)],
                    check=True,
                )
                subprocess.run(["xcrun", "stapler", "validate", str(dmg)], check=True)
            if run_smoke:
                _smoke_program(ffmpeg, ("-version",))
                _smoke_program(ffprobe, ("-version",))
                _smoke_backend(backend)
                _smoke_launcher(shell)
        verified.append(dmg)

    elif platform_name == "windows":
        msis = _glob_files(("msi/*.msi",))
        nsis = _glob_files(("nsis/*-setup.exe",))
        zips = _glob_files(("portable/*.zip",))
        if len(msis) != 1 or len(nsis) != 1 or len(zips) != 1:
            raise ReleaseIntegrityError(
                "one MSI, NSIS installer, and portable ZIP are required"
            )
        for path in (msis[0], nsis[0], zips[0]):
            _require_file(path, minimum_size)
        _require_magic(msis[0], b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")
        _require_magic(nsis[0], b"MZ")
        _require_magic(zips[0], b"PK")
        shell = _windows_shell()
        _require_windows_gui_subsystem(shell)
        _, required = _zip_required(zips[0])
        if state.mode == "signed":
            for path in (shell, msis[0], nsis[0]):
                _run_safe(
                    "WINDOWS_VERIFY_COMMAND_JSON",
                    path,
                    env,
                    purpose="verify signed artifact",
                )
        if run_smoke:
            with tempfile.TemporaryDirectory(
                prefix="mediasorter-portable-smoke-"
            ) as temporary:
                with zipfile.ZipFile(zips[0]) as archive:
                    archive.extractall(temporary)
                extracted = Path(temporary)
                portable = {key: extracted / value for key, value in required.items()}
                _require_windows_gui_subsystem(portable["shell"])
                _smoke_program(portable["ffmpeg"], ("-version",))
                _smoke_program(portable["ffprobe"], ("-version",))
                _smoke_backend(portable["backend"])
                _smoke_launcher(portable["shell"])
                if state.mode == "signed":
                    signed_payloads = sorted(
                        path
                        for path in extracted.rglob("*")
                        if path.is_file()
                        and path.suffix.lower() in {".exe", ".dll"}
                        and _is_pe(path)
                    )
                    for path in signed_payloads:
                        _run_safe(
                            "WINDOWS_VERIFY_COMMAND_JSON",
                            path,
                            env,
                            purpose="verify portable signature",
                        )
        verified.extend((msis[0], nsis[0], zips[0]))
    elif platform_name == "linux":
        debs = _glob_files(("deb/*.deb",))
        appimages = _glob_files(("appimage/*.AppImage", "appimage/*.appimage"))
        if len(debs) != 1 or len(appimages) != 1:
            raise ReleaseIntegrityError("one DEB and one AppImage are required")
        for path in (debs[0], appimages[0]):
            _require_file(path, minimum_size)
        _require_magic(debs[0], b"!<arch>\n")
        _require_magic(appimages[0], b"\x7fELF")
        verified.extend((debs[0], appimages[0]))
    else:
        raise ReleaseIntegrityError(f"unsupported release platform: {platform_name}")

    _write_checksums(verified, BUNDLE_DIR / "SHA256SUMS")
    shutil.copy2(
        BUNDLE_DIR / "release-signing-state.json",
        BUNDLE_DIR / f"release-signing-state-{platform_name}.json",
    )
    print(
        f"Verified {len(verified)} {platform_name} artifact(s); signing mode={state.mode}",
        flush=True,
    )
    return verified


def _default_platform() -> str:
    if sys.platform == "darwin":
        return "macos"
    if os.name == "nt":
        return "windows"
    return "linux"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)

    preflight = subparsers.add_parser("preflight")
    preflight.add_argument("--platform", default=_default_platform())
    preflight.add_argument(
        "--output", type=Path, default=BUNDLE_DIR / "release-signing-state.json"
    )
    preflight.add_argument("--github-output", type=Path)

    normalize = subparsers.add_parser("normalize")
    normalize.add_argument("--platform", default=_default_platform())
    normalize.add_argument("--root", type=Path, default=RESOURCES_DIR)

    snapshot = subparsers.add_parser("snapshot")
    snapshot.add_argument("--root", type=Path, default=RESOURCES_DIR)
    snapshot.add_argument("--output", type=Path, required=True)

    check_snapshot = subparsers.add_parser("verify-snapshot")
    check_snapshot.add_argument("--root", type=Path, default=RESOURCES_DIR)
    check_snapshot.add_argument("--snapshot", type=Path, required=True)

    sign_nested = subparsers.add_parser("sign-nested")
    sign_nested.add_argument("--state", type=Path, required=True)
    sign_nested.add_argument("--root", type=Path, default=RESOURCES_DIR)

    sign_outer = subparsers.add_parser("sign-outer")
    sign_outer.add_argument("--state", type=Path, required=True)

    sign_windows = subparsers.add_parser("sign-windows-file")
    sign_windows.add_argument("--file", type=Path, required=True)

    verify = subparsers.add_parser("verify")
    verify.add_argument("--platform", default=_default_platform())
    verify.add_argument("--state", type=Path, required=True)
    verify.add_argument("--minimum-size", type=int, default=20 * 1024 * 1024)
    verify.add_argument("--skip-smoke", action="store_true")
    return parser


def main(arguments: Sequence[str] | None = None) -> int:
    args = build_parser().parse_args(arguments)
    try:
        if args.command == "preflight":
            state = classify_signing(args.platform)
            if state.mode == "partial":
                raise ReleaseIntegrityError(
                    "partial signing credentials; missing: "
                    + ", ".join(state.missing_variables)
                )
            write_signing_state(state, args.output)
            if args.github_output:
                with args.github_output.open("a", encoding="utf-8") as handle:
                    handle.write(f"mode={state.mode}\nprovider={state.provider}\n")
            print(
                f"Signing preflight: platform={state.platform} "
                f"mode={state.mode} provider={state.provider}",
                flush=True,
            )
        elif args.command == "normalize":
            normalize_payload_modes(args.root, args.platform)
        elif args.command == "snapshot":
            create_snapshot(args.root, args.output)
        elif args.command == "verify-snapshot":
            verify_snapshot(args.root, args.snapshot)
        elif args.command == "sign-nested":
            sign_nested_payloads(args.root, read_signing_state(args.state))
        elif args.command == "sign-outer":
            sign_outer_artifacts(read_signing_state(args.state))
        elif args.command == "sign-windows-file":
            sign_windows_file(args.file)
        elif args.command == "verify":
            verify_release(
                args.platform,
                read_signing_state(args.state),
                minimum_size=args.minimum_size,
                run_smoke=not args.skip_smoke,
            )
        else:  # pragma: no cover - argparse enforces the choices.
            raise ReleaseIntegrityError(f"unknown command: {args.command}")
    except (ReleaseIntegrityError, OSError, subprocess.CalledProcessError) as error:
        print(f"ERROR: {error}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
