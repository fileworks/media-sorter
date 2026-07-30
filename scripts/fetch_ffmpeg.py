#!/usr/bin/env python3
"""Fetch verified ffmpeg/ffprobe resources for MediaSorter packages.

The script is deliberately standard-library-only: release runners execute it
before the application environment exists. Every source comes from the reviewed
``ffmpeg-sources.json`` manifest, is SHA-256 verified before extraction, and is
fully path-validated before any archive member is written.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from collections.abc import Iterable, Mapping
from pathlib import Path, PurePosixPath
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DEST = REPO_ROOT / "frontend" / "src-tauri" / "resources" / "ffmpeg"
DEFAULT_MANIFEST = Path(__file__).with_name("ffmpeg-sources.json")
PROVENANCE_FILE = "native-tools-provenance.json"
_USER_AGENT = "mediasort-ffmpeg-fetcher/2.0 (+https://github.com/fileworks/media-sorter)"
_DRIVE_PATH = re.compile(r"^[A-Za-z]:")
_ARCHIVE_SUFFIXES = (".tar.xz", ".tar.gz", ".tar.bz2", ".tgz", ".txz", ".tar", ".zip")


def log(message: str) -> None:
    print(message, flush=True)


def detect_platform() -> tuple[str, str]:
    """Return a supported manifest platform key; unknown targets fail closed."""
    system = platform.system().lower()
    if system.startswith("win"):
        os_key = "windows"
    elif system == "darwin":
        os_key = "darwin"
    elif system == "linux":
        os_key = "linux"
    else:
        raise SystemExit(f"ERROR: unsupported operating system: {platform.system()!r}")

    machine = platform.machine().lower()
    if machine in {"arm64", "aarch64"}:
        arch_key = "arm64"
    elif machine in {"x86_64", "amd64", "x64"}:
        arch_key = "x86_64"
    else:
        raise SystemExit(f"ERROR: unsupported architecture: {platform.machine()!r}")
    return os_key, arch_key


def load_sources(
    os_key: str,
    arch_key: str,
    *,
    manifest_path: Path = DEFAULT_MANIFEST,
) -> tuple[str, list[dict[str, Any]]]:
    """Load and validate one immutable platform/architecture source plan."""
    try:
        document = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest_version = str(document["manifest_version"])
        sources = document["targets"][f"{os_key}-{arch_key}"]
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise SystemExit(
            f"ERROR: invalid or missing ffmpeg source manifest entry for {os_key}/{arch_key}: {exc}"
        ) from exc
    if not isinstance(sources, list) or not sources:
        raise SystemExit(f"ERROR: empty ffmpeg source plan for {os_key}/{arch_key}")

    binaries: set[str] = set()
    normalized: list[dict[str, Any]] = []
    for position, raw in enumerate(sources):
        if not isinstance(raw, Mapping):
            raise SystemExit(f"ERROR: source {position} is not an object")
        url = raw.get("url")
        digest = raw.get("sha256")
        names = raw.get("binaries")
        if not isinstance(url, str) or not url.startswith("https://"):
            raise SystemExit(f"ERROR: source {position} does not use an HTTPS URL")
        if "/latest/" in url or url.endswith("/latest"):
            raise SystemExit(f"ERROR: source {position} uses a mutable latest URL")
        if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
            raise SystemExit(f"ERROR: source {position} has no valid SHA-256")
        if not isinstance(names, list) or not names or not all(isinstance(n, str) for n in names):
            raise SystemExit(f"ERROR: source {position} has no binary inventory")
        binaries.update(name.lower() for name in names)
        normalized.append(dict(raw))

    expected = {"ffmpeg.exe", "ffprobe.exe"} if os_key == "windows" else {"ffmpeg", "ffprobe"}
    if binaries != expected:
        raise SystemExit(
            f"ERROR: source plan for {os_key}/{arch_key} provides "
            f"{sorted(binaries)}, expected {sorted(expected)}"
        )
    return manifest_version, normalized


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def download(url: str, expected_sha256: str, destination: Path, attempts: int = 3) -> None:
    """Stream one source to a temporary file and verify it before returning."""
    log(f"  ↓ {url}")
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        digest = hashlib.sha256()
        try:
            request = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
            with (
                urllib.request.urlopen(request, timeout=300) as response,
                destination.open("wb") as output,
            ):
                while chunk := response.read(1024 * 1024):
                    output.write(chunk)
                    digest.update(chunk)
            if destination.stat().st_size == 0:
                raise OSError("downloaded file is empty")
            observed = digest.hexdigest()
            if observed != expected_sha256:
                raise OSError(f"SHA-256 mismatch: expected {expected_sha256}, observed {observed}")
            return
        except Exception as exc:  # noqa: BLE001 - preserve network/IO context
            last_error = exc
            destination.unlink(missing_ok=True)
            log(f"  ! attempt {attempt}/{attempts} failed: {exc}")
    raise SystemExit(f"ERROR: failed to download verified source {url}: {last_error}")


def _safe_destination(root: Path, member_name: str) -> Path:
    """Map an archive name below *root*, treating both slash styles as separators."""
    normalized = member_name.replace("\\", "/")
    if not normalized or normalized.startswith(("/", "//")) or _DRIVE_PATH.match(normalized):
        raise ValueError(f"unsafe absolute archive member: {member_name!r}")
    relative = PurePosixPath(normalized)
    if any(part in {"", ".", ".."} for part in relative.parts):
        raise ValueError(f"unsafe archive member path: {member_name!r}")
    root_resolved = root.resolve()
    destination = root.joinpath(*relative.parts).resolve(strict=False)
    try:
        destination.relative_to(root_resolved)
    except ValueError as exc:
        raise ValueError(f"archive member escapes staging: {member_name!r}") from exc
    return destination


def _validate_zip(archive: zipfile.ZipFile, root: Path) -> list[tuple[zipfile.ZipInfo, Path]]:
    plan: list[tuple[zipfile.ZipInfo, Path]] = []
    for member in archive.infolist():
        destination = _safe_destination(root, member.filename)
        mode = member.external_attr >> 16
        file_type = stat.S_IFMT(mode)
        if file_type not in {0, stat.S_IFREG, stat.S_IFDIR}:
            raise ValueError(f"unsupported zip member type: {member.filename!r}")
        plan.append((member, destination))
    return plan


def _validate_tar(archive: tarfile.TarFile, root: Path) -> list[tuple[tarfile.TarInfo, Path]]:
    plan: list[tuple[tarfile.TarInfo, Path]] = []
    for member in archive.getmembers():
        destination = _safe_destination(root, member.name)
        if member.issym() or member.islnk():
            # Native tool archives do not need links. Rejecting all links avoids
            # platform-specific link-target resolution and hard-link races.
            raise ValueError(f"archive links are forbidden: {member.name!r}")
        if not (member.isfile() or member.isdir()):
            raise ValueError(f"unsupported tar member type: {member.name!r}")
        plan.append((member, destination))
    return plan


def extract(archive_path: Path, destination_root: Path) -> None:
    """Validate an entire archive, then extract regular files/directories only."""
    lowered = archive_path.name.lower()
    if lowered.endswith(".zip"):
        with zipfile.ZipFile(archive_path) as archive:
            plan = _validate_zip(archive, destination_root)
            destination_root.mkdir(parents=True, exist_ok=True)
            for member, destination in plan:
                if member.is_dir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                destination.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(member) as source, destination.open("xb") as output:
                    shutil.copyfileobj(source, output)
        return

    if lowered.endswith((".tar", ".tar.xz", ".txz", ".tar.gz", ".tgz", ".tar.bz2")):
        with tarfile.open(archive_path) as archive:
            plan = _validate_tar(archive, destination_root)
            destination_root.mkdir(parents=True, exist_ok=True)
            for member, destination in plan:
                if member.isdir():
                    destination.mkdir(parents=True, exist_ok=True)
                    continue
                source = archive.extractfile(member)
                if source is None:
                    raise ValueError(f"cannot read archive member: {member.name!r}")
                destination.parent.mkdir(parents=True, exist_ok=True)
                with source, destination.open("xb") as output:
                    shutil.copyfileobj(source, output)
        return
    raise SystemExit(f"ERROR: unsupported archive format: {archive_path.name}")


def find_binary(root: Path, base_name: str) -> Path:
    target = base_name.lower()
    matches = [
        path
        for path in root.rglob("*")
        if path.is_file()
        and "__macosx" not in {part.lower() for part in path.parts}
        and path.name.lower() == target
    ]
    if len(matches) != 1:
        raise SystemExit(
            f"ERROR: expected exactly one {base_name!r} in verified archive, found {len(matches)}"
        )
    return matches[0]


def post_process(binary: Path, os_key: str) -> None:
    if os_key != "windows":
        binary.chmod(0o755)
    if os_key == "darwin":
        subprocess.run(
            ["xattr", "-dr", "com.apple.quarantine", str(binary)],
            check=False,
            capture_output=True,
        )
        subprocess.run(
            ["codesign", "--force", "--sign", "-", str(binary)],
            check=False,
            capture_output=True,
        )


def smoke_test(binary: Path) -> None:
    try:
        result = subprocess.run(
            [str(binary), "-version"], capture_output=True, text=True, timeout=30
        )
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"ERROR: {binary.name} failed to execute: {exc}") from exc
    if result.returncode != 0:
        raise SystemExit(
            f"ERROR: bundled {binary.name} failed its -version smoke test\n{result.stderr[:500]}"
        )
    first_line = (result.stdout or "").splitlines()[:1]
    log(f"  ✓ {binary.name}: {first_line[0] if first_line else 'ok'}")


def _archive_suffix(url: str) -> str:
    lowered = url.lower()
    return next((suffix for suffix in _ARCHIVE_SUFFIXES if lowered.endswith(suffix)), ".zip")


def _write_provenance(
    bundle: Path,
    *,
    manifest_version: str,
    os_key: str,
    arch_key: str,
    sources: Iterable[Mapping[str, Any]],
    binaries: Iterable[Path],
) -> None:
    document = {
        "schema_version": 1,
        "source_manifest_version": manifest_version,
        "platform": os_key,
        "architecture": arch_key,
        "sources": list(sources),
        "bundled_binaries": {
            binary.name: {"sha256": sha256_file(binary), "size_bytes": binary.stat().st_size}
            for binary in sorted(binaries)
        },
    }
    (bundle / PROVENANCE_FILE).write_text(
        json.dumps(document, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )


def _publish_bundle(staged_bundle: Path, destination: Path) -> None:
    """Replace the resource directory, retaining the old bundle until the new one exists."""
    destination.parent.mkdir(parents=True, exist_ok=True)
    previous = destination.with_name(f".{destination.name}.previous")
    if previous.exists():
        shutil.rmtree(previous)
    if destination.exists():
        os.replace(destination, previous)
    try:
        os.replace(staged_bundle, destination)
    except BaseException:
        if previous.exists() and not destination.exists():
            os.replace(previous, destination)
        raise
    if previous.exists():
        shutil.rmtree(previous)


def main() -> int:
    parser = argparse.ArgumentParser(description="Bundle verified static ffmpeg + ffprobe.")
    parser.add_argument("--dest", type=Path, default=DEFAULT_DEST)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--skip-smoke-test", action="store_true")
    args = parser.parse_args()

    os_key, arch_key = detect_platform()
    manifest_version, sources = load_sources(
        os_key, arch_key, manifest_path=args.manifest.resolve()
    )
    destination = args.dest.resolve()
    log(f"==> Bundling verified ffmpeg + ffprobe for {os_key}/{arch_key}")
    log(f"    destination: {destination}")

    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(
        prefix=".mediasort-ffmpeg-", dir=destination.parent
    ) as temporary:
        workspace = Path(temporary)
        bundle = workspace / "bundle"
        bundle.mkdir()
        placed: list[Path] = []
        extension = ".exe" if os_key == "windows" else ""
        for index, source in enumerate(sources):
            url = str(source["url"])
            archive_path = workspace / f"source-{index}{_archive_suffix(url)}"
            download(url, str(source["sha256"]), archive_path)
            extracted = workspace / f"source-{index}"
            extract(archive_path, extracted)
            for base_name in source["binaries"]:
                found = find_binary(extracted, str(base_name))
                stem = "ffprobe" if "ffprobe" in str(base_name).lower() else "ffmpeg"
                target = bundle / f"{stem}{extension}"
                if target.exists():
                    raise SystemExit(f"ERROR: source plan duplicates {target.name}")
                shutil.copy2(found, target)
                post_process(target, os_key)
                placed.append(target)

        if not args.skip_smoke_test:
            for binary in placed:
                smoke_test(binary)
        _write_provenance(
            bundle,
            manifest_version=manifest_version,
            os_key=os_key,
            arch_key=arch_key,
            sources=sources,
            binaries=placed,
        )
        _publish_bundle(bundle, destination)

    log(f"✓ verified native tools published with {PROVENANCE_FILE}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
