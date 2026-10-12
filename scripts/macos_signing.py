"""macOS code-signature sealing and verification for release packages.

Split from ``release_integrity.py`` so that module stays within its reviewed
size; the release flow imports these helpers from there.
"""

from __future__ import annotations

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
    return sorted(
        (path for path in root.rglob("*") if path.is_file() and _is_macho(path)),
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


def _verify_macos_seal(app: Path) -> list[Path]:
    """Strictly verify every nested Mach-O, then the whole bundle seal."""
    files = _macho_inside_out(app)
    for path in files:
        subprocess.run(["codesign", "--verify", "--strict", "--verbose=2", str(path)], check=True)
    subprocess.run(
        ["codesign", "--verify", "--deep", "--strict", "--verbose=2", str(app)], check=True
    )
    return files
