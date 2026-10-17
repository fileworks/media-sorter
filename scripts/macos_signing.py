"""macOS code-signature sealing and verification for release packages.

Split from ``release_integrity.py`` so that module stays within its reviewed
size; the release flow imports these helpers from there.
"""

from __future__ import annotations

import hashlib
import subprocess
from collections.abc import Sequence
from pathlib import Path

from native_provenance import ReleaseIntegrityError

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


def _is_macho(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return handle.read(4) in MACHO_MAGICS
    except OSError:
        return False


def _macho_inside_out(root: Path) -> list[Path]:
    """Every real Mach-O file under ``root``, deepest first.

    Symlinks are skipped: their target is listed itself, and ``codesign``
    refuses a framework-root link such as PyInstaller's
    ``Python.framework/Python`` as an ambiguous bundle, which failed the
    release seal check on the final DMG.
    """
    return sorted(
        (
            path
            for path in root.rglob("*")
            if not path.is_symlink() and path.is_file() and _is_macho(path)
        ),
        key=lambda path: (-len(path.parts), str(path)),
    )


def _ad_hoc_sign_macho(root: Path) -> list[Path]:
    """Give every nested Mach-O a structural ad-hoc signature (identity ``-``).

    This proves bundle integrity, not publisher identity: Gatekeeper still shows
    its normal prompt for an app downloaded without notarization.
    """
    print("Signing mode: ad hoc (no Developer ID configured) (macos)", flush=True)
    files = _macho_inside_out(root)
    for path in files:
        print(f"  ad-hoc sign nested Mach-O: {path}", flush=True)
        subprocess.run(["codesign", "--force", "--sign", "-", str(path)], check=True)
    return files


def _expected_macos_architecture(dmg: Path) -> str:
    """The CPU architecture a DMG promises in its name (Tauri's suffix)."""
    name = dmg.name.lower()
    if "aarch64" in name or "arm64" in name:
        return "arm64"
    if "x64" in name or "x86_64" in name:
        return "x86_64"
    raise ReleaseIntegrityError(f"cannot tell the target architecture of {dmg.name}")


def _require_architecture(paths: Sequence[Path], architecture: str) -> None:
    """Every Mach-O must contain the architecture the DMG is named for."""
    wrong: list[str] = []
    for path in paths:
        result = subprocess.run(
            ["lipo", "-archs", str(path)], check=True, capture_output=True, text=True
        )
        if architecture not in result.stdout.split():
            wrong.append(f"{path.name} ({result.stdout.strip() or 'none'})")
    if wrong:
        raise ReleaseIntegrityError(
            f"Mach-O files lack the {architecture} architecture: " + ", ".join(wrong)
        )


def _digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _verify_macos_seal(app: Path) -> list[Path]:
    """Strictly verify every nested Mach-O, then the whole bundle seal.

    Tauri copies resources with symlinks dereferenced, so the packaged
    ``Python.framework/Python`` is a real copy of ``Versions/<v>/Python``.
    ``codesign`` cannot verify a binary at a framework root on its own ("bundle
    format is ambiguous"); such a copy must instead be byte-identical to a
    Mach-O that was verified at an unambiguous path.
    """
    files = _macho_inside_out(app)
    verified: set[str] = set()
    framework_roots: list[Path] = []
    for path in files:
        if path.parent.suffix == ".framework":
            framework_roots.append(path)
            continue
        subprocess.run(["codesign", "--verify", "--strict", "--verbose=2", str(path)], check=True)
        verified.add(_digest(path))
    unmatched = [path for path in framework_roots if _digest(path) not in verified]
    if unmatched:
        raise ReleaseIntegrityError(
            "framework-root Mach-O files match no verified copy: "
            + ", ".join(str(path) for path in unmatched)
        )
    subprocess.run(
        ["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)], check=True
    )
    return files
