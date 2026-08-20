"""What the bundled ffmpeg binaries are, and whether the bundle says so truthfully.

Split out of `release_integrity.py` when adding the manifest-version check
pushed that file past its documented review baseline. The growth policy asks
for a cohesive home rather than a raised number, and this is one: everything
here answers a single question — do the native tools in a packaged artifact
match the tracked record of what a release is allowed to fetch?

That record is `scripts/ffmpeg-sources.json`. The GPL notice shipped beside the
binaries is generated from it, so a provenance describing a different manifest
is a licence document describing something other than what shipped (`F-10`).
"""

from __future__ import annotations

import hashlib
import json
import re
import zipfile
from collections.abc import Mapping
from pathlib import Path

#: Written by `scripts/fetch_ffmpeg.py` beside the binaries it downloads.
NATIVE_PROVENANCE_FILE = "native-tools-provenance.json"

#: The tracked record of what a release is allowed to fetch (`DEC-06`).
REPO_ROOT = Path(__file__).resolve().parent.parent
SOURCES_MANIFEST = REPO_ROOT / "scripts" / "ffmpeg-sources.json"


class ReleaseIntegrityError(RuntimeError):
    """A packaged artifact does not match what the repository says it should be."""


def _require_file(path: Path) -> None:
    if not path.is_file():
        raise ReleaseIntegrityError(f"missing required file: {path}")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _validate_manifest_version(document: Mapping[str, object]) -> None:
    """The shipped provenance must describe the manifest this checkout declares.

    `F-10`. The provenance is generated at fetch time and the manifest is
    tracked, so a release built from a stale fetch shipped binaries whose
    recorded origin was two manifest revisions old — and nothing said so,
    because nothing compared them. The GPL notice beside these binaries names
    versions taken from the manifest, so a mismatch is a licence document
    describing something other than what shipped.
    """
    declared = document.get("source_manifest_version")
    try:
        manifest = json.loads((SOURCES_MANIFEST).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseIntegrityError(f"cannot read {SOURCES_MANIFEST.name}: {exc}") from exc
    expected = manifest.get("manifest_version")
    if declared != expected:
        raise ReleaseIntegrityError(
            "native tool provenance was generated from a different source manifest: "
            f"provenance says {declared!r}, {SOURCES_MANIFEST.name} says {expected!r}. "
            "Re-run scripts/fetch_ffmpeg.py so the bundle and its licence notice agree."
        )


def _validate_native_provenance(
    document: object,
    *,
    expected_platform: str,
    observed_hashes: Mapping[str, str],
) -> None:
    if not isinstance(document, dict) or document.get("schema_version") != 1:
        raise ReleaseIntegrityError("native tool provenance has an unsupported schema")
    if document.get("platform") != expected_platform:
        raise ReleaseIntegrityError(
            "native tool provenance platform mismatch: "
            f"expected {expected_platform}, observed {document.get('platform')!r}"
        )
    sources = document.get("sources")
    if not isinstance(sources, list) or not sources:
        raise ReleaseIntegrityError("native tool provenance has no source inventory")
    for source in sources:
        if (
            not isinstance(source, dict)
            or not isinstance(source.get("url"), str)
            or "/latest/" in source["url"]
            or re.fullmatch(r"[0-9a-f]{64}", str(source.get("sha256", ""))) is None
        ):
            raise ReleaseIntegrityError("native tool provenance contains a mutable source")
    _validate_manifest_version(document)
    bundled = document.get("bundled_binaries")
    if not isinstance(bundled, dict) or set(bundled) != set(observed_hashes):
        raise ReleaseIntegrityError("native tool provenance binary inventory is incomplete")
    for name, observed in observed_hashes.items():
        entry = bundled.get(name)
        if not isinstance(entry, dict) or entry.get("sha256") != observed:
            raise ReleaseIntegrityError(f"packaged native binary does not match provenance: {name}")


def _verify_native_provenance(root: Path, expected_platform: str) -> None:
    provenance = root / NATIVE_PROVENANCE_FILE
    _require_file(provenance)
    try:
        document = json.loads(provenance.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ReleaseIntegrityError(f"cannot read native tool provenance: {exc}") from exc
    names = (
        ("ffmpeg.exe", "ffprobe.exe")
        if expected_platform == "windows"
        else (
            "ffmpeg",
            "ffprobe",
        )
    )
    _validate_native_provenance(
        document,
        expected_platform=expected_platform,
        observed_hashes={name: _sha256(root / name) for name in names},
    )


def _verify_zip_native_provenance(zip_path: Path, required: Mapping[str, str]) -> None:
    with zipfile.ZipFile(zip_path) as archive:
        try:
            document = json.loads(archive.read(required["provenance"]))
        except (KeyError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ReleaseIntegrityError(
                f"cannot read portable native tool provenance: {exc}"
            ) from exc
        observed: dict[str, str] = {}
        for key in ("ffmpeg", "ffprobe"):
            digest = hashlib.sha256()
            with archive.open(required[key]) as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            observed[Path(required[key]).name] = digest.hexdigest()
    _validate_native_provenance(document, expected_platform="windows", observed_hashes=observed)
