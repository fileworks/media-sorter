#!/usr/bin/env python3
"""Create a Windows portable ZIP containing MediaSorter plus its bundled resources.

The portable layout mirrors the path-resolution logic in the Rust shell
(src-tauri/src/main.rs): the main exe lives in an ``app/`` subdirectory so that
``app_dir + "../resources/resources/*"`` resolves to siblings of ``app/``:

    MediaSorter-portable/
        app/
            MediaSorter.exe          ← double-click or run from terminal
        resources/
            resources/               ← preserved from src-tauri/resources/**
                backend/
                    mediasort-backend.exe
                    _internal/       ← PyInstaller support files
                    ...
                ffmpeg/
                    ffmpeg.exe
                    ffprobe.exe

This layout intentionally mirrors the Tauri resource-glob pattern
``"resources/**"`` in tauri.conf.json, which bundles files as
``resources/<source-path>``, producing the ``resources/resources/...`` double-
prefix seen both here and in the NSIS installer.

Usage:
    python scripts/make_portable_zip.py [--out-dir DIR] [--name NAME]

This script is stdlib-only so it runs on a bare CI runner without a virtualenv.
"""

from __future__ import annotations

import argparse
import sys
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
FRONTEND = REPO_ROOT / "frontend"
SRC_TAURI = FRONTEND / "src-tauri"
TARGET_RELEASE = SRC_TAURI / "target" / "release"
RESOURCES_SRC = SRC_TAURI / "resources"


def log(msg: str) -> None:
    print(msg, flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Create Windows portable ZIP.")
    parser.add_argument(
        "--out-dir",
        type=Path,
        default=TARGET_RELEASE / "bundle" / "portable",
        help="directory for the output ZIP (default: target/release/bundle/portable)",
    )
    parser.add_argument(
        "--name",
        default="MediaSorter-portable",
        help="stem used for the ZIP filename and its root directory inside the archive",
    )
    args = parser.parse_args()

    # ── Pre-flight checks ──────────────────────────────────────────────────────
    exe_src = TARGET_RELEASE / "MediaSorter.exe"
    if not exe_src.exists():
        log(f"ERROR: {exe_src} not found — run 'make build-tauri' first.")
        return 1

    if not RESOURCES_SRC.exists():
        log(
            f"ERROR: {RESOURCES_SRC} not found — "
            "run 'make bundle-backend && make bundle-ffmpeg' first."
        )
        return 1

    backend_exe = RESOURCES_SRC / "backend" / "mediasort-backend.exe"
    if not backend_exe.exists():
        log(f"ERROR: {backend_exe} not found — run 'make bundle-backend' first.")
        return 1

    for bin_name in ("ffmpeg.exe", "ffprobe.exe"):
        if not (RESOURCES_SRC / "ffmpeg" / bin_name).exists():
            log(
                f"ERROR: {RESOURCES_SRC / 'ffmpeg' / bin_name} not found — "
                "run 'make bundle-ffmpeg' first."
            )
            return 1

    # ── Build the ZIP ─────────────────────────────────────────────────────────
    out_dir: Path = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    root = args.name
    zip_path = out_dir / f"{root}.zip"

    log(f"==> Creating portable ZIP: {zip_path}")

    file_count = 0
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        # Main executable in app/ so that the Rust shell's path resolution
        # (app_dir + "../resources/resources/*") finds the siblings.
        zf.write(exe_src, f"{root}/app/MediaSorter.exe")
        log(f"  + app/MediaSorter.exe")

        # Resources: src-tauri/resources/** → <root>/resources/resources/**
        # rel_to_tauri = "resources/backend/..." so arc_path gets the
        # "resources/resources/..." double-prefix that both the Tauri NSIS
        # bundle and main.rs expect on Windows.
        for path in sorted(RESOURCES_SRC.rglob("*")):
            if not path.is_file():
                continue
            rel_to_tauri = path.relative_to(SRC_TAURI)
            arc_path = f"{root}/resources/{rel_to_tauri}"
            zf.write(path, arc_path)
            file_count += 1

    log(f"  + resources/ ({file_count} files from {RESOURCES_SRC})")
    size_mb = zip_path.stat().st_size / (1024 * 1024)
    log(f"✓ Portable ZIP: {zip_path} ({size_mb:.1f} MB)")

    # ── Integrity check ───────────────────────────────────────────────────────
    # Verify the key paths that the Rust shell and backend expect are present.
    required = [
        f"{root}/app/MediaSorter.exe",
        f"{root}/resources/resources/backend/mediasort-backend.exe",
        f"{root}/resources/resources/ffmpeg/ffmpeg.exe",
        f"{root}/resources/resources/ffmpeg/ffprobe.exe",
    ]
    log("==> Verifying ZIP integrity …")
    with zipfile.ZipFile(zip_path) as zf:
        names = set(zf.namelist())
    missing = [r for r in required if r not in names]
    if missing:
        log("ERROR: the following required entries are missing from the ZIP:")
        for m in missing:
            log(f"  ✗ {m}")
        return 1
    for r in required:
        log(f"  ✓ {r}")
    log("✓ Integrity check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
