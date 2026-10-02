"""Local, redacted diagnostics export the user chooses to create.

Nothing here is sent anywhere. The user asks for a bundle, previews exactly
which categories it will contain, and gets a local archive. Media contents,
thumbnails, credentials, and full paths are excluded by construction rather
than by filtering afterwards — and the finished archive is scanned before it is
handed back, so a leak is a failure to produce a bundle, not a surprise inside
one.
"""

from __future__ import annotations

import json
import platform
import re
import sys
import zipfile
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app._version import __version__
from app.core.action_journal import (
    JOURNAL_DIRECTORY_NAME,
    MANIFEST_DIRECTORY_NAME,
    list_journals,
    read_journal,
)
from app.core.events import PathTokenizer, sanitize_context
from app.core.integrity import EVENT_SCHEMA_VERSION, MANIFEST_SCHEMA_VERSION
from app.core.logging_config import LOG_FILE_MAX_BYTES, logging_health
from app.core.optimization_contracts import CONTRACTS
from app.services.operation_execution import REPORT_DIRECTORY_NAME

#: Hard cap on any single log excerpt so a bundle stays sendable.
MAX_LOG_BYTES = 512 * 1024

#: Config keys whose values never leave the machine, whatever the caller asks
#: for. Matched as substrings, like the logging and event redactors.
NEVER_INCLUDED = ("api_key", "apikey", "secret", "token", "password", "credential")

#: Patterns the finished archive is scanned for. A hit means the bundle is not
#: produced at all.
_LEAK_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{8,}"),
    re.compile(r"(?i)\b(api[_-]?key|secret|password|bearer)\b\s*[:=]\s*\S+"),
)


@dataclass(frozen=True)
class BundleCategory:
    """One inclusion the user can see before anything is written."""

    name: str
    description: str
    included: bool = True
    detail: str | None = None


@dataclass(frozen=True)
class BundlePreview:
    """Exactly what an export would contain, shown before it is created."""

    categories: tuple[BundleCategory, ...]
    excluded: tuple[str, ...]
    include_paths: bool = False
    operation_id: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "categories": [
                {
                    "name": item.name,
                    "description": item.description,
                    "included": item.included,
                    "detail": item.detail,
                }
                for item in self.categories
            ],
            "excluded": list(self.excluded),
            "include_paths": self.include_paths,
            "operation_id": self.operation_id,
        }


class SupportBundleLeakError(RuntimeError):
    """The finished archive contained something it must never contain."""


ALWAYS_EXCLUDED = (
    "Media file contents",
    "Thumbnails and previews",
    "API keys, tokens, and other credentials",
    "Full filesystem paths and filenames (unless explicitly requested)",
    "Arbitrary environment variables",
)


def preview_bundle(
    state_root: Path,
    *,
    operation_id: str | None = None,
    include_paths: bool = False,
) -> BundlePreview:
    """Describe the archive without creating it."""
    journals = list_journals(state_root)
    reports = _existing(state_root / REPORT_DIRECTORY_NAME, "*.integrity.json")
    return BundlePreview(
        categories=(
            BundleCategory(
                "manifest",
                "App, backend, schema, and algorithm versions plus platform facts",
            ),
            BundleCategory(
                "configuration_shape",
                "Which settings are set and their types — never their secret values",
            ),
            BundleCategory(
                "operation_timeline",
                "Journal stages for interrupted or selected operations",
                detail=f"{len(journals)} journal(s)",
            ),
            BundleCategory(
                "integrity_reports",
                "Per-action hashes, byte counts, outcomes, and warnings",
                detail=f"{len(reports)} report(s)",
            ),
            BundleCategory(
                "logging_health",
                "Log location, rotation, active sinks, drops, and failures",
            ),
            BundleCategory(
                "optimization_contracts",
                "Declared format contracts and their validation status",
            ),
            BundleCategory(
                "paths",
                "Real filesystem paths",
                included=include_paths,
                detail=None if include_paths else "tokenized by default",
            ),
        ),
        excluded=ALWAYS_EXCLUDED,
        include_paths=include_paths,
        operation_id=operation_id,
    )


def export_bundle(
    state_root: Path,
    destination: Path,
    *,
    config: Mapping[str, Any] | None = None,
    operation_id: str | None = None,
    include_paths: bool = False,
    log_excerpt: str | None = None,
) -> Path:
    """Write a redacted diagnostics archive and verify it before returning it."""
    preview = preview_bundle(state_root, operation_id=operation_id, include_paths=include_paths)
    tokenizer = PathTokenizer()
    destination.parent.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("README.md", _readme(preview))
        archive.writestr("manifest.json", _dump(_manifest(preview)))
        archive.writestr(
            "configuration-shape.json",
            _dump(_configuration_shape(config or {}, tokenizer, include_paths=include_paths)),
        )
        archive.writestr("logging-health.json", _dump(_safe(logging_health(), tokenizer)))
        archive.writestr("optimization-contracts.json", _dump(_contract_summary()))
        for name, payload in _timelines(state_root, operation_id, tokenizer):
            archive.writestr(f"{JOURNAL_DIRECTORY_NAME}/{name}", _dump(payload))
        for name, payload in _reports(state_root, operation_id, tokenizer):
            archive.writestr(f"{REPORT_DIRECTORY_NAME}/{name}", _dump(payload))
        if log_excerpt:
            archive.writestr("logs/excerpt.log", log_excerpt[:MAX_LOG_BYTES])

    _assert_no_leak(destination)
    return destination


# ---------------------------------------------------------------------- #
# Content builders                                                        #
# ---------------------------------------------------------------------- #


def _manifest(preview: BundlePreview) -> dict[str, Any]:
    return {
        "application": "MediaSorter",
        "version": __version__,
        "python": sys.version.split()[0],
        "platform": {
            "system": platform.system(),
            "release": platform.release(),
            "machine": platform.machine(),
        },
        "schema_versions": {
            "manifest": MANIFEST_SCHEMA_VERSION,
            "event": EVENT_SCHEMA_VERSION,
        },
        "log_rotation_max_bytes": LOG_FILE_MAX_BYTES,
        "categories": preview.to_dict()["categories"],
        "excluded": list(preview.excluded),
    }


def _configuration_shape(
    config: Mapping[str, Any],
    tokenizer: PathTokenizer,
    *,
    include_paths: bool,
) -> dict[str, Any]:
    """Describe settings by name, type, and whether they are set — not by value.

    A support reader needs to know that conversion is on and that an API key is
    configured. They never need the key, and rarely need the value.
    """
    shape: dict[str, Any] = {}
    for key, value in sorted(config.items()):
        lowered = str(key).lower()
        if any(marker in lowered for marker in NEVER_INCLUDED):
            shape[key] = {"type": type(value).__name__, "configured": value not in (None, "")}
            continue
        if isinstance(value, bool) or value is None or isinstance(value, (int, float)):
            shape[key] = {"type": type(value).__name__, "value": value}
        elif isinstance(value, str):
            looks_like_path = "/" in value or "\\" in value
            shape[key] = {
                "type": "str",
                "value": (
                    value
                    if include_paths or not looks_like_path
                    else tokenizer.token(value)
                    if value
                    else ""
                ),
            }
        else:
            shape[key] = {"type": type(value).__name__, "size": _length(value)}
    return shape


def _timelines(
    state_root: Path,
    operation_id: str | None,
    tokenizer: PathTokenizer,
) -> Iterable[tuple[str, dict[str, Any]]]:
    for path in list_journals(state_root):
        try:
            journal = read_journal(path)
        except (OSError, ValueError):
            continue
        if operation_id is not None and journal.operation_id != operation_id:
            continue
        yield (
            f"{journal.operation_id}.json",
            {
                "operation_id": journal.operation_id,
                "manifest_id": journal.manifest_id,
                "state": journal.state,
                "entries": [
                    {
                        "sequence": entry.sequence,
                        "action_id": entry.action_id,
                        "stage": entry.stage,
                        "source_safety": entry.source_safety,
                        "diagnostic_code": entry.diagnostic_code,
                        "staged_path": (
                            None
                            if entry.staged_path is None
                            else tokenizer.token(entry.staged_path)
                        ),
                        "integrity": (
                            None
                            if entry.integrity is None
                            else json.loads(entry.integrity.model_dump_json())
                        ),
                    }
                    for entry in journal.entries
                ],
            },
        )


def _reports(
    state_root: Path,
    operation_id: str | None,
    tokenizer: PathTokenizer,
) -> Iterable[tuple[str, dict[str, Any]]]:
    for path in _existing(state_root / REPORT_DIRECTORY_NAME, "*.integrity.json"):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if operation_id is not None and payload.get("operation_id") != operation_id:
            continue
        yield path.name, _safe(payload, tokenizer)


def _contract_summary() -> dict[str, Any]:
    return {
        contract_id: {
            "mode": declared.mode,
            "status": declared.status,
            "tool": declared.tool,
            "minimum_tool_version": declared.minimum_tool_version,
        }
        for contract_id, declared in CONTRACTS.items()
    }


def _readme(preview: BundlePreview) -> str:
    included = "\n".join(
        f"- **{item.name}** — {item.description}" for item in preview.categories if item.included
    )
    excluded = "\n".join(f"- {item}" for item in preview.excluded)
    paths_note = (
        "Real paths were included at your explicit request."
        if preview.include_paths
        else (
            "Paths and filenames are replaced with stable tokens such as "
            "`<root1>/…3/9a3c1d2f4b5e`. Two files under the same root share a "
            "root token, so structure is readable without exposing names."
        )
    )
    return (
        "# MediaSorter diagnostics bundle\n\n"
        "This archive was created locally, on request. It was not uploaded "
        "anywhere, and MediaSorter never sends it on its own.\n\n"
        f"## Included\n\n{included}\n\n"
        f"## Never included\n\n{excluded}\n\n"
        f"## About paths\n\n{paths_note}\n\n"
        "## Before you share it\n\n"
        "The archive is scanned for credential-shaped strings before it is "
        "produced; if any had been found, no bundle would exist. You are still "
        "welcome to open it — it is plain JSON and Markdown.\n"
    )


# ---------------------------------------------------------------------- #
# Helpers                                                                 #
# ---------------------------------------------------------------------- #


def _safe(payload: Mapping[str, Any], tokenizer: PathTokenizer) -> dict[str, Any]:
    return sanitize_context(payload, tokenizer=tokenizer)


def _dump(payload: Any) -> str:
    return json.dumps(payload, indent=2, sort_keys=True, default=str)


def _existing(directory: Path, pattern: str) -> list[Path]:
    if not directory.is_dir():
        return []
    return sorted(directory.glob(pattern))


def _length(value: Any) -> int:
    try:
        return len(value)
    except TypeError:
        return 0


def _assert_no_leak(archive_path: Path) -> None:
    """Scan the finished archive and refuse to hand over a leaking bundle."""
    findings: list[str] = []
    with zipfile.ZipFile(archive_path) as archive:
        for name in archive.namelist():
            try:
                text = archive.read(name).decode("utf-8", errors="ignore")
            except KeyError:  # pragma: no cover - defensive
                continue
            findings.extend(
                f"{name}: {pattern.pattern}" for pattern in _LEAK_PATTERNS if pattern.search(text)
            )
    if findings:
        archive_path.unlink(missing_ok=True)
        raise SupportBundleLeakError(
            "Diagnostics bundle withheld; it matched: " + "; ".join(sorted(set(findings)))
        )


__all__ = [
    "ALWAYS_EXCLUDED",
    "MANIFEST_DIRECTORY_NAME",
    "BundleCategory",
    "BundlePreview",
    "SupportBundleLeakError",
    "export_bundle",
    "preview_bundle",
]
