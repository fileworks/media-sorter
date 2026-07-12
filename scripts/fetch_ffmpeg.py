#!/usr/bin/env python3
"""Download static, self-contained ffmpeg + ffprobe into the Tauri resources dir.

This is the SINGLE source of truth for ffmpeg bundling across every platform and
every entry point (local ``make bundle-ffmpeg`` *and* the GitHub Actions release
workflow). It deliberately depends only on the Python standard library so it can
run before the project's virtualenv exists and on a bare CI runner.

Why bundle at all?
    End users must NOT need a system ffmpeg/ffprobe. We ship statically-linked
    binaries (no Homebrew dylibs, no system DLLs) so the app is self-contained.
    The backend uses BOTH binaries — ffmpeg for convert/repair, ffprobe for
    metadata, date extraction, video duplicate detection and validation — so we
    always fetch both.

Sources (static builds, arch-aware):
    macOS arm64   osxexperts.net   (ffmpeg + ffprobe, separate zips)
    macOS x86_64  evermeet.cx      (ffmpeg + ffprobe, separate zips)
    Windows x64   BtbN/FFmpeg-Builds (single zip containing both .exe)
    Linux x86_64  johnvansickle.com static (single tarball with both)
    Linux aarch64 johnvansickle.com static (single tarball with both)

Usage:
    python scripts/fetch_ffmpeg.py [--dest DIR] [--skip-smoke-test]

Overrides (env vars):
    FFMPEG_MAC_VER   macOS ffmpeg version tag (default: 7.1.1)
    FFMPEG_WIN_TAG   Windows BtbN release tag (default: latest — set to a dated
                     tag like "autobuild-2025-01-30-12-56" for reproducible builds)
    FFMPEG_URL       explicit ffmpeg archive URL  (advanced; skips the table)
    FFPROBE_URL      explicit ffprobe archive URL (advanced; skips the table)
"""

from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path

# Repo root = parent of this script's directory (scripts/ -> repo root).
REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DEST = REPO_ROOT / "frontend" / "src-tauri" / "resources" / "ffmpeg"

MAC_VER = os.environ.get("FFMPEG_MAC_VER", "7.1.1")
MAC_VER_COMPACT = MAC_VER.replace(".", "")
WIN_TAG = os.environ.get("FFMPEG_WIN_TAG", "latest")

# A "source" is one downloadable archive plus the binaries to pull out of it.
#   url:      archive to download
#   binaries: archive-internal base names to locate (without dest renaming)
# For Windows/Linux a single archive carries both binaries; for macOS each
# binary has its own archive.
_USER_AGENT = "mediasort-ffmpeg-fetcher/1.0 (+https://github.com/)"


def log(msg: str) -> None:
    print(msg, flush=True)


def detect_platform() -> tuple[str, str]:
    """Return (os_key, arch_key) in {darwin,windows,linux} x {arm64,x86_64}."""
    system = platform.system().lower()
    if system.startswith("win"):
        os_key = "windows"
    elif system == "darwin":
        os_key = "darwin"
    else:
        os_key = "linux"

    machine = platform.machine().lower()
    if machine in ("arm64", "aarch64"):
        arch_key = "arm64"
    elif machine in ("x86_64", "amd64", "x64"):
        arch_key = "x86_64"
    else:
        # Unknown arch: best-effort fall back to x86_64 builds.
        log(f"  ! Unrecognised arch '{machine}', assuming x86_64")
        arch_key = "x86_64"
    return os_key, arch_key


def build_sources(os_key: str, arch_key: str) -> list[dict]:
    """Resolve the download plan for the current platform."""
    # Explicit URL overrides win (advanced/manual use; macOS-style two-archive).
    url_override = os.environ.get("FFMPEG_URL")
    probe_override = os.environ.get("FFPROBE_URL")
    if url_override and probe_override:
        return [
            {"url": url_override, "binaries": ["ffmpeg"]},
            {"url": probe_override, "binaries": ["ffprobe"]},
        ]

    if os_key == "darwin":
        if arch_key == "arm64":
            return [
                {
                    "url": f"https://www.osxexperts.net/ffmpeg{MAC_VER_COMPACT}arm.zip",
                    "binaries": ["ffmpeg"],
                },
                {
                    "url": f"https://www.osxexperts.net/ffprobe{MAC_VER_COMPACT}arm.zip",
                    "binaries": ["ffprobe"],
                },
            ]
        return [
            {"url": f"https://evermeet.cx/ffmpeg/ffmpeg-{MAC_VER}.zip", "binaries": ["ffmpeg"]},
            {"url": f"https://evermeet.cx/ffmpeg/ffprobe-{MAC_VER}.zip", "binaries": ["ffprobe"]},
        ]

    if os_key == "windows":
        # BtbN ships a single zip with both binaries under .../bin/.
        # WIN_TAG defaults to "latest" (the continuously-updated BtbN release).
        # Set FFMPEG_WIN_TAG to a dated tag (e.g. "autobuild-2025-01-30-12-56")
        # for reproducible builds — the filename stays the same regardless of tag.
        return [
            {
                "url": f"https://github.com/BtbN/FFmpeg-Builds/releases/download/{WIN_TAG}/ffmpeg-master-latest-win64-gpl.zip",
                "binaries": ["ffmpeg.exe", "ffprobe.exe"],
            }
        ]

    # Linux (dev / Docker). johnvansickle ships a single static tarball with both.
    suffix = "arm64" if arch_key == "arm64" else "amd64"
    return [
        {
            "url": f"https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-{suffix}-static.tar.xz",
            "binaries": ["ffmpeg", "ffprobe"],
        }
    ]


def download(url: str, dest_file: Path, attempts: int = 3) -> None:
    log(f"  ↓ {url}")
    last_err: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": _USER_AGENT})
            with urllib.request.urlopen(req, timeout=300) as resp, open(dest_file, "wb") as out:
                shutil.copyfileobj(resp, out)
            if dest_file.stat().st_size == 0:
                raise OSError("downloaded file is empty")
            return
        except Exception as exc:  # noqa: BLE001 — surface any network/IO failure
            last_err = exc
            log(f"  ! attempt {attempt}/{attempts} failed: {exc}")
    raise SystemExit(f"ERROR: failed to download {url}: {last_err}")


def extract(archive: Path, into: Path) -> None:
    into.mkdir(parents=True, exist_ok=True)
    name = archive.name.lower()
    if name.endswith(".zip"):
        with zipfile.ZipFile(archive) as zf:
            zf.extractall(into)
    elif name.endswith((".tar.xz", ".txz", ".tar.gz", ".tgz", ".tar.bz2")):
        with tarfile.open(archive) as tf:
            # filter='data' (Python 3.12+) strips dangerous tar members (absolute
            # paths, symlinks outside the dest). Fall back silently on older Python.
            if sys.version_info >= (3, 12):
                tf.extractall(into, filter="data")
            else:
                tf.extractall(into)  # noqa: S202
    else:
        raise SystemExit(f"ERROR: don't know how to extract {archive.name}")


def find_binary(root: Path, base_name: str) -> Path:
    """Locate *base_name* anywhere under *root* (case-insensitive), skip junk."""
    target = base_name.lower()
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        if "__macosx" in str(path).lower():
            continue
        if path.name.lower() == target:
            return path
    raise SystemExit(f"ERROR: '{base_name}' not found inside the downloaded archive")


def post_process(binary: Path, os_key: str) -> None:
    """Make the binary runnable from the bundle on the current OS."""
    if os_key != "windows":
        binary.chmod(0o755)
    if os_key == "darwin":
        # Strip the quarantine xattr and apply an ad-hoc signature so Gatekeeper
        # lets the bundled binary run. Both are best-effort.
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
            [str(binary), "-version"],
            capture_output=True,
            text=True,
            timeout=30,
        )
    except Exception as exc:  # noqa: BLE001
        raise SystemExit(f"ERROR: {binary.name} failed to execute: {exc}")
    if result.returncode != 0:
        raise SystemExit(
            f"ERROR: bundled {binary.name} failed its -version smoke test "
            f"(wrong arch/corrupt download?)\n{result.stderr[:500]}"
        )
    first_line = (result.stdout or "").splitlines()[:1]
    log(f"  ✓ {binary.name}: {first_line[0] if first_line else 'ok'}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Bundle static ffmpeg + ffprobe.")
    parser.add_argument(
        "--dest",
        type=Path,
        default=DEFAULT_DEST,
        help=f"output directory (default: {DEFAULT_DEST})",
    )
    parser.add_argument(
        "--skip-smoke-test",
        action="store_true",
        help="skip running -version on the downloaded binaries",
    )
    args = parser.parse_args()

    os_key, arch_key = detect_platform()
    dest: Path = args.dest
    dest.mkdir(parents=True, exist_ok=True)

    exe_ext = ".exe" if os_key == "windows" else ""
    log(f"==> Bundling static ffmpeg + ffprobe for {os_key}/{arch_key}")
    log(f"    dest: {dest}")

    sources = build_sources(os_key, arch_key)
    placed: list[Path] = []

    with tempfile.TemporaryDirectory(prefix="mediasort-ffmpeg-") as tmp:
        tmp_path = Path(tmp)
        for idx, source in enumerate(sources):
            url = source["url"]
            archive = tmp_path / f"src{idx}{_archive_suffix(url)}"
            download(url, archive)
            extract_dir = tmp_path / f"src{idx}.d"
            extract(archive, extract_dir)

            for base in source["binaries"]:
                found = find_binary(extract_dir, base)
                # Normalise the destination name (always ffmpeg/ffprobe[.exe]).
                stem = "ffprobe" if "ffprobe" in base.lower() else "ffmpeg"
                target = dest / f"{stem}{exe_ext}"
                if target.exists():
                    target.unlink()
                shutil.copy2(found, target)
                post_process(target, os_key)
                placed.append(target)
                log(f"  • {found.name} → {target}")

    if not args.skip_smoke_test:
        log("==> Verifying bundled binaries run standalone …")
        for binary in placed:
            smoke_test(binary)

    log("✓ ffmpeg bundling complete:")
    for binary in placed:
        log(f"    {binary}")
    return 0


def _archive_suffix(url: str) -> str:
    lowered = url.lower()
    for suffix in (".tar.xz", ".tar.gz", ".tar.bz2", ".tgz", ".txz", ".zip"):
        if lowered.endswith(suffix):
            return suffix
    return ".zip"


if __name__ == "__main__":
    sys.exit(main())
