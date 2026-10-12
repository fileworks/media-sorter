"""Strict parser for the bundled, immutable local-AI model manifest."""

from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass
from importlib.resources import files
from pathlib import PurePosixPath
from urllib.parse import urlparse

MANIFEST_NAME = "ai-models.json"
_HEX_40 = re.compile(r"^[0-9a-f]{40}$")
_HEX_64 = re.compile(r"^[0-9a-f]{64}$")
_REPOSITORY = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")


class ModelManifestError(ValueError):
    """The bundled model manifest is unsafe or internally inconsistent."""


@dataclass(frozen=True)
class ModelFile:
    path: str
    size: int
    sha256: str


@dataclass(frozen=True)
class ModelComponent:
    name: str
    repository: str
    revision: str
    files: tuple[ModelFile, ...]


@dataclass(frozen=True)
class ModelPack:
    pack_id: str
    model_id: str
    display_name: str
    license: str
    license_url: str
    total_size: int
    components: tuple[ModelComponent, ...]
    digest: str
    #: No longer selectable; kept only so an installed copy can be removed.
    retired: bool = False


def _safe_relative(value: object) -> str:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ModelManifestError(f"unsafe model file path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts):
        raise ModelManifestError(f"unsafe model file path: {value!r}")
    return value


def load_manifest() -> tuple[str, dict[str, ModelPack]]:
    raw = files("app.resources").joinpath(MANIFEST_NAME).read_text(encoding="utf-8")
    return parse_manifest(raw)


def parse_manifest(raw: str) -> tuple[str, dict[str, ModelPack]]:
    """Parse and fully validate a manifest document.

    Kept separate from resource loading so malicious or malformed manifests can
    be tested directly without replacing package resources.
    """
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ModelManifestError("AI model manifest is not valid JSON") from exc
    if not isinstance(document, dict) or document.get("schema_version") != 1:
        raise ModelManifestError("unsupported AI model manifest")
    raw_source = document.get("default_source")
    source = raw_source if isinstance(raw_source, str) else ""
    parsed_source = urlparse(source)
    if parsed_source.scheme != "https" or parsed_source.netloc != "huggingface.co":
        raise ModelManifestError("default AI model source must be https://huggingface.co")
    raw_packs = document.get("packs")
    if not isinstance(raw_packs, dict) or not raw_packs:
        raise ModelManifestError("AI model manifest has no packs")

    # Names and retirement are presentation, kept outside the hashed pack entries:
    # the pack digest names the install directory, so editing a label inside a
    # pack would make every existing install look missing and re-download it.
    raw_presentation = document.get("presentation", {})
    if not isinstance(raw_presentation, dict):
        raise ModelManifestError("invalid AI model presentation")

    packs: dict[str, ModelPack] = {}
    for pack_id, raw_pack in raw_packs.items():
        if not isinstance(pack_id, str) or not re.fullmatch(r"[a-z0-9-]+", pack_id):
            raise ModelManifestError(f"unsafe model pack id: {pack_id!r}")
        if not isinstance(raw_pack, dict):
            raise ModelManifestError(f"invalid model pack: {pack_id}")
        components, measured_total = _parse_components(pack_id, raw_pack.get("components"))
        declared_total = raw_pack.get("total_size")
        if declared_total != measured_total:
            raise ModelManifestError(
                f"model pack size mismatch for {pack_id}: {declared_total!r} != {measured_total}"
            )
        canonical = json.dumps(raw_pack, sort_keys=True, separators=(",", ":")).encode()
        presentation = raw_presentation.get(pack_id, {})
        if not isinstance(presentation, dict):
            raise ModelManifestError(f"invalid presentation for {pack_id}")
        packs[pack_id] = ModelPack(
            pack_id=pack_id,
            model_id=str(raw_pack.get("model_id", "")),
            display_name=str(presentation.get("display_name") or raw_pack.get("display_name", "")),
            license=str(raw_pack.get("license", "")),
            license_url=str(raw_pack.get("license_url", "")),
            total_size=measured_total,
            components=components,
            digest=hashlib.sha256(canonical).hexdigest(),
            retired=presentation.get("retired") is True,
        )
    return source.rstrip("/"), packs


def _parse_components(
    pack_id: str, raw_components: object
) -> tuple[tuple[ModelComponent, ...], int]:
    if not isinstance(raw_components, dict) or not raw_components:
        raise ModelManifestError(f"model pack has no components: {pack_id}")
    components: list[ModelComponent] = []
    measured_total = 0
    for name, raw_component in raw_components.items():
        if not isinstance(name, str) or not re.fullmatch(r"[a-z0-9-]+", name):
            raise ModelManifestError(f"unsafe model component: {name!r}")
        component, component_size = _parse_component(name, raw_component)
        components.append(component)
        measured_total += component_size
    return tuple(components), measured_total


def _parse_component(name: str, raw_component: object) -> tuple[ModelComponent, int]:
    if not isinstance(raw_component, dict):
        raise ModelManifestError(f"invalid model component: {name}")
    repository = raw_component.get("repository")
    revision = raw_component.get("revision")
    if not isinstance(repository, str) or not _REPOSITORY.fullmatch(repository):
        raise ModelManifestError(f"unsafe model repository: {repository!r}")
    if not isinstance(revision, str) or not _HEX_40.fullmatch(revision):
        raise ModelManifestError(f"model revision is not an immutable commit: {revision!r}")
    raw_files = raw_component.get("files")
    if not isinstance(raw_files, list) or not raw_files:
        raise ModelManifestError(f"model component has no files: {name}")
    component_files: list[ModelFile] = []
    seen: set[str] = set()
    measured_size = 0
    for raw_file in raw_files:
        if not isinstance(raw_file, dict):
            raise ModelManifestError(f"invalid model file in {name}")
        relative = _safe_relative(raw_file.get("path"))
        size = raw_file.get("size")
        digest = raw_file.get("sha256")
        if relative in seen:
            raise ModelManifestError(f"duplicate model path: {relative}")
        if not isinstance(size, int) or size <= 0:
            raise ModelManifestError(f"invalid model size: {relative}")
        if not isinstance(digest, str) or not _HEX_64.fullmatch(digest):
            raise ModelManifestError(f"invalid model digest: {relative}")
        seen.add(relative)
        measured_size += size
        component_files.append(ModelFile(relative, size, digest))
    return (
        ModelComponent(name, repository, revision, tuple(component_files)),
        measured_size,
    )


#: The pack each tier installs. v2 carries the full-precision vision tower: on
#: the held-out fixtures it raised tag F1 to 0.92 in English and German for
#: about 13 ms more per image (docs/local-ai-evaluation.md).
CURRENT_PACK = "siglip-standard-v2"
#: Installed packs a tier may keep using until its current pack is installed,
#: so an upgrade never switches local AI off.
FALLBACK_PACKS: tuple[str, ...] = ("siglip-standard-v1",)


def pack_for_tier(tier: str) -> str | None:
    # "lite" and "max" are saved-setting aliases for the one shipped model.
    if tier in ("standard", "lite", "max"):
        return CURRENT_PACK
    return None


def candidate_packs_for_tier(tier: str) -> tuple[str, ...]:
    """The current pack first, then installed predecessors that still work."""
    current = pack_for_tier(tier)
    return () if current is None else (current, *FALLBACK_PACKS)
