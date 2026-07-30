"""Standalone, read-only audit of an already organized media library."""

from __future__ import annotations

import csv
import hashlib
import io
import os
import sqlite3
import uuid
from collections.abc import Callable, Iterator
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.core.config import Config
from app.core.config_fingerprint import config_fingerprint
from app.core.integrity import MutationManifest
from app.core.media_units import ROLE_BEARING_EXTENSIONS, bind_media_units
from app.services.extraction_service import DateExtractionService
from app.services.filesystem_service import open_image
from app.services.library_assessment import assess_placement, assess_readability
from app.services.mutation_planner import build_placement_action
from app.services.verified_transfer import stream_sha256
from app.utils.ffmpeg_utils import run_ffprobe_json
from app.utils.media_utils import is_image, is_media, is_video

AuditClass = Literal[
    "unreadable",
    "structurally_invalid",
    "content_extension_mismatch",
    "checksum_divergence",
    "missing_companion",
    "placement_inconsistency",
]
HISTORY_LIMIT = 24


class AuditScope(BaseModel):
    model_config = ConfigDict(frozen=True)

    subtree: str | None = None
    date_from: date | None = None
    date_to: date | None = None
    sample_proportion: float = Field(default=1.0, gt=0, le=1)
    sample_seed: str = Field(default="mediasort-audit-v1", min_length=1, max_length=128)

    @model_validator(mode="after")
    def ordered_dates(self) -> AuditScope:
        if self.date_from and self.date_to and self.date_from > self.date_to:
            raise ValueError("date_from must not be after date_to")
        return self

    @property
    def sampled(self) -> bool:
        return self.sample_proportion < 1

    def key(self) -> str:
        return hashlib.sha256(self.model_dump_json(exclude_none=True).encode("utf-8")).hexdigest()


class AuditFinding(BaseModel):
    model_config = ConfigDict(frozen=True)

    finding_id: str
    category: AuditClass
    relative_path: str
    evidence: str
    actionable: bool = False
    newly_appeared: bool = False
    suggested_path: str | None = None


class AuditReport(BaseModel):
    model_config = ConfigDict(frozen=True)

    audit_id: str
    root: str
    started_at: datetime
    finished_at: datetime
    scope: AuditScope
    selection_method: str
    coverage: Literal["full", "sample", "partial"]
    scanned_files: int
    baseline_established: int
    findings: tuple[AuditFinding, ...]
    issues: tuple[str, ...] = ()
    cancelled: bool = False

    @property
    def new_findings(self) -> int:
        return sum(item.newly_appeared for item in self.findings)


@dataclass
class _Observed:
    relative_path: str
    sha256: str
    unit_id: str | None
    companion_role: str | None


class AuditStore:
    """Application-data persistence; never opens the audited root for writing."""

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.connection = sqlite3.connect(path)
        self.connection.execute("PRAGMA journal_mode=WAL")
        self.connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS audit_reports (
                audit_id TEXT PRIMARY KEY,
                root TEXT NOT NULL,
                scope_key TEXT NOT NULL,
                finished_at TEXT NOT NULL,
                payload TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_audit_comparable
                ON audit_reports(root, scope_key, finished_at DESC);
            CREATE TABLE IF NOT EXISTS audit_baselines (
                root TEXT NOT NULL,
                relative_path TEXT NOT NULL,
                sha256 TEXT NOT NULL,
                unit_id TEXT,
                companion_role TEXT,
                recorded_at TEXT NOT NULL,
                PRIMARY KEY(root, relative_path)
            );
            """
        )

    def baseline(self, root: str) -> dict[str, _Observed]:
        rows = self.connection.execute(
            """
            SELECT relative_path, sha256, unit_id, companion_role
              FROM audit_baselines WHERE root = ?
            """,
            (root,),
        )
        return {
            str(row[0]): _Observed(
                relative_path=str(row[0]),
                sha256=str(row[1]),
                unit_id=None if row[2] is None else str(row[2]),
                companion_role=None if row[3] is None else str(row[3]),
            )
            for row in rows
        }

    def establish(self, root: str, observed: _Observed) -> None:
        self.connection.execute(
            """
            INSERT OR IGNORE INTO audit_baselines
                (root, relative_path, sha256, unit_id, companion_role, recorded_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                root,
                observed.relative_path,
                observed.sha256,
                observed.unit_id,
                observed.companion_role,
                datetime.now(timezone.utc).isoformat(),
            ),
        )

    def previous_finding_ids(self, root: str, scope_key: str) -> set[str]:
        row = self.connection.execute(
            """
            SELECT payload FROM audit_reports
             WHERE root = ? AND scope_key = ?
             ORDER BY finished_at DESC LIMIT 1
            """,
            (root, scope_key),
        ).fetchone()
        if row is None:
            return set()
        report = AuditReport.model_validate_json(str(row[0]))
        return {item.finding_id for item in report.findings}

    def save(self, report: AuditReport) -> None:
        self.connection.execute(
            """
            INSERT INTO audit_reports (audit_id, root, scope_key, finished_at, payload)
            VALUES (?, ?, ?, ?, ?)
            """,
            (
                report.audit_id,
                report.root,
                report.scope.key(),
                report.finished_at.isoformat(),
                report.model_dump_json(),
            ),
        )
        stale = self.connection.execute(
            """
            SELECT audit_id FROM audit_reports
             ORDER BY finished_at DESC LIMIT -1 OFFSET ?
            """,
            (HISTORY_LIMIT,),
        ).fetchall()
        self.connection.executemany(
            "DELETE FROM audit_reports WHERE audit_id = ?",
            [(str(row[0]),) for row in stale],
        )
        self.connection.commit()

    def get(self, audit_id: str) -> AuditReport | None:
        row = self.connection.execute(
            "SELECT payload FROM audit_reports WHERE audit_id = ?", (audit_id,)
        ).fetchone()
        return None if row is None else AuditReport.model_validate_json(str(row[0]))

    def history(self, limit: int = HISTORY_LIMIT) -> tuple[AuditReport, ...]:
        rows = self.connection.execute(
            "SELECT payload FROM audit_reports ORDER BY finished_at DESC LIMIT ?",
            (min(max(limit, 1), HISTORY_LIMIT),),
        )
        return tuple(AuditReport.model_validate_json(str(row[0])) for row in rows)

    def close(self) -> None:
        self.connection.close()


class LibraryAuditService:
    def __init__(
        self,
        store_path: Path,
        extraction: DateExtractionService | None = None,
    ) -> None:
        self.store_path = store_path
        self.extraction = extraction or DateExtractionService()

    def run(
        self,
        root: Path,
        *,
        scope: AuditScope | None = None,
        config: Config | None = None,
        cancel: Callable[[], bool] | None = None,
        progress: Callable[[int], None] | None = None,
    ) -> AuditReport:
        """Read and hash files without mutating any content under ``root``."""
        started = datetime.now(timezone.utc)
        root = root.expanduser().resolve(strict=True)
        if not root.is_dir():
            raise ValueError("audit root must be a readable directory")
        selected_scope = scope or AuditScope()
        start = _scoped_root(root, selected_scope.subtree)
        root_key = str(root)
        findings: list[AuditFinding] = []
        issues: list[str] = []
        observed: dict[str, _Observed] = {}
        scanned = 0
        baseline_established = 0
        cancelled = False

        with _store(self.store_path) as store:
            baseline = store.baseline(root_key)
            previous = store.previous_finding_ids(root_key, selected_scope.key())
            for _directory, paths, walk_issues in _walk_directories(start, root):
                issues.extend(walk_issues)
                if cancel and cancel():
                    cancelled = True
                    break
                units, _unmatched = bind_media_units(paths, root)
                membership = {
                    member.path: (unit.unit_id, member.companion_role)
                    for unit in units
                    for member in unit.members
                }
                for path in paths:
                    if cancel and cancel():
                        cancelled = True
                        break
                    relative = path.relative_to(root).as_posix()
                    if not _selected(relative, selected_scope):
                        continue
                    extracted = self.extraction.extract_detailed(path)
                    if not _in_date_range(extracted.extracted_date, selected_scope):
                        continue
                    scanned += 1
                    if progress:
                        progress(scanned)
                    unit_id, role = membership.get(path, (None, None))
                    readability = assess_readability(path)
                    if not readability.readable:
                        findings.append(
                            _finding(
                                "unreadable",
                                relative,
                                readability.evidence or "the file could not be read",
                                actionable=False,
                            )
                        )
                        continue
                    try:
                        digest, _size = stream_sha256(path)
                    except (OSError, ValueError) as exc:
                        findings.append(
                            _finding("unreadable", relative, type(exc).__name__, actionable=False)
                        )
                        continue
                    current = _Observed(relative, digest, unit_id, role)
                    observed[relative] = current
                    prior = baseline.get(relative)
                    if prior is None:
                        store.establish(root_key, current)
                        baseline_established += 1
                    elif prior.sha256 != digest:
                        findings.append(
                            _finding(
                                "checksum_divergence",
                                relative,
                                (
                                    "content differs from the recorded audit baseline "
                                    f"{prior.sha256[:12]}…"
                                ),
                                actionable=False,
                            )
                        )
                    findings.extend(_media_findings(path, relative))
                    placement = _placement_finding(relative, extracted.extracted_date, config)
                    if placement is not None:
                        findings.append(placement)
                if cancelled:
                    break

            if not selected_scope.sampled and not cancelled:
                current_paths = set(observed)
                for relative, prior in baseline.items():
                    if (
                        prior.unit_id
                        and prior.companion_role
                        and relative not in current_paths
                        and any(item.unit_id == prior.unit_id for item in observed.values())
                    ):
                        findings.append(
                            _finding(
                                "missing_companion",
                                relative,
                                (
                                    f"{prior.companion_role} previously belonged to media unit "
                                    f"{prior.unit_id} but is now absent"
                                ),
                                actionable=False,
                            )
                        )

            findings = [
                item.model_copy(update={"newly_appeared": item.finding_id not in previous})
                for item in findings
            ]
            coverage: Literal["full", "sample", "partial"] = (
                "partial" if cancelled or issues else "sample" if selected_scope.sampled else "full"
            )
            report = AuditReport(
                audit_id=f"audit_{uuid.uuid4().hex[:16]}",
                root=root_key,
                started_at=started,
                finished_at=datetime.now(timezone.utc),
                scope=selected_scope,
                selection_method=(
                    f"sha256(relative_path + seed) < {selected_scope.sample_proportion:.6f}"
                    if selected_scope.sampled
                    else "all files in scope"
                ),
                coverage=coverage,
                scanned_files=scanned,
                baseline_established=baseline_established,
                findings=tuple(findings),
                issues=tuple(issues),
                cancelled=cancelled,
            )
            store.save(report)
            return report

    def get(self, audit_id: str) -> AuditReport | None:
        with _store(self.store_path) as store:
            return store.get(audit_id)

    def history(self, limit: int = HISTORY_LIMIT) -> tuple[AuditReport, ...]:
        with _store(self.store_path) as store:
            return store.history(limit)

    def export(self, report: AuditReport, format: Literal["json", "csv"]) -> bytes:
        if format == "json":
            return report.model_dump_json(indent=2).encode()
        output = io.StringIO()
        writer = csv.writer(output)
        writer.writerow(["audit_id", "category", "relative_path", "evidence", "actionable", "new"])
        for item in report.findings:
            writer.writerow(
                [
                    report.audit_id,
                    item.category,
                    item.relative_path,
                    item.evidence,
                    item.actionable,
                    item.newly_appeared,
                ]
            )
        return output.getvalue().encode()

    def plan(
        self,
        report: AuditReport,
        finding_ids: tuple[str, ...],
        *,
        config: Config,
    ) -> MutationManifest:
        """Freeze selected safe corrections as ordinary verified moves."""
        selected = {
            item.finding_id: item for item in report.findings if item.finding_id in finding_ids
        }
        if len(selected) != len(set(finding_ids)):
            raise ValueError("one or more audit findings are stale or unknown")
        root = Path(report.root).resolve(strict=True)
        actions = []
        for finding in selected.values():
            if not finding.actionable or not finding.suggested_path:
                raise ValueError("the selected audit finding has no safe automatic action")
            source = (root / finding.relative_path).resolve(strict=True)
            source.relative_to(root)
            destination = (root / finding.suggested_path).resolve(strict=False)
            destination.relative_to(root)
            if destination.exists():
                raise ValueError("the suggested audit destination already exists")
            actions.append(
                build_placement_action(
                    source,
                    destination,
                    kind="move",
                    move=True,
                    preservation=config.preservation_profile,
                    root_id="audited-library",
                    relative_path=finding.relative_path,
                )
            )
        if not actions:
            raise ValueError("no actionable audit findings selected")
        return MutationManifest(
            manifest_id=f"manifest_{uuid.uuid4().hex[:16]}",
            operation_id=f"audit_fix_{uuid.uuid4().hex[:16]}",
            plan_id=report.audit_id,
            profile_id=config.preservation_profile.profile_id,
            effective_config_sha256=config_fingerprint(config),
            actions=tuple(actions),
        )


class _store:
    def __init__(self, path: Path) -> None:
        self.value = AuditStore(path)

    def __enter__(self) -> AuditStore:
        return self.value

    def __exit__(self, *_exc: object) -> None:
        self.value.close()


def _scoped_root(root: Path, subtree: str | None) -> Path:
    if not subtree:
        return root
    candidate = (root / subtree).resolve(strict=True)
    candidate.relative_to(root)
    if not candidate.is_dir():
        raise ValueError("audit subtree must be a directory")
    return candidate


def _walk_directories(start: Path, root: Path) -> Iterator[tuple[Path, list[Path], list[str]]]:
    stack = [start]
    while stack:
        current = stack.pop()
        paths: list[Path] = []
        issues: list[str] = []
        try:
            entries = sorted(os.scandir(current), key=lambda item: item.name.casefold())
        except OSError as exc:
            yield current, [], [f"{current.relative_to(root)}: {type(exc).__name__}"]
            continue
        for entry in entries:
            try:
                if entry.is_symlink():
                    continue
                path = Path(entry.path)
                if entry.is_dir():
                    stack.append(path)
                elif entry.is_file() and (
                    is_media(path) or path.suffix.casefold() in ROLE_BEARING_EXTENSIONS
                ):
                    paths.append(path)
            except OSError as exc:
                issues.append(f"{entry.path}: {type(exc).__name__}")
        yield current, paths, issues


def _selected(relative: str, scope: AuditScope) -> bool:
    if not scope.sampled:
        return True
    digest = hashlib.sha256(f"{scope.sample_seed}\0{relative}".encode()).digest()
    value = int.from_bytes(digest[:8], "big") / (2**64 - 1)
    return value < scope.sample_proportion


def _in_date_range(value: date | None, scope: AuditScope) -> bool:
    if scope.date_from is None and scope.date_to is None:
        return True
    if value is None:
        return False
    return (scope.date_from is None or value >= scope.date_from) and (
        scope.date_to is None or value <= scope.date_to
    )


def _finding(
    category: AuditClass,
    relative: str,
    evidence: str,
    *,
    actionable: bool,
    suggested_path: str | None = None,
) -> AuditFinding:
    return AuditFinding(
        finding_id=f"{category}:{relative}",
        category=category,
        relative_path=relative,
        evidence=evidence,
        actionable=actionable,
        suggested_path=suggested_path,
    )


def _media_findings(path: Path, relative: str) -> list[AuditFinding]:
    findings: list[AuditFinding] = []
    if path.stat().st_size == 0:
        return [_finding("structurally_invalid", relative, "file is empty", actionable=False)]
    if is_image(path):
        with open_image(path) as image:
            if image is None:
                findings.append(
                    _finding(
                        "structurally_invalid",
                        relative,
                        "image decoder could not read the structure",
                        actionable=False,
                    )
                )
            else:
                detected = (image.format or "").casefold()
                try:
                    image.verify()
                except Exception as exc:
                    findings.append(
                        _finding(
                            "structurally_invalid",
                            relative,
                            f"image verification failed: {type(exc).__name__}",
                            actionable=False,
                        )
                    )
                expected = {
                    ".jpg": "jpeg",
                    ".jpeg": "jpeg",
                    ".png": "png",
                    ".gif": "gif",
                    ".webp": "webp",
                    ".tif": "tiff",
                    ".tiff": "tiff",
                    ".bmp": "bmp",
                }.get(path.suffix.casefold())
                if expected and detected and detected != expected:
                    extension = {
                        "jpeg": ".jpg",
                        "png": ".png",
                        "gif": ".gif",
                        "webp": ".webp",
                        "tiff": ".tiff",
                        "bmp": ".bmp",
                    }.get(detected)
                    findings.append(
                        _finding(
                            "content_extension_mismatch",
                            relative,
                            f"extension expects {expected}, decoder detected {detected}",
                            actionable=extension is not None,
                            suggested_path=(
                                str(Path(relative).with_suffix(extension))
                                if extension is not None
                                else None
                            ),
                        )
                    )
    elif is_video(path):
        probe = run_ffprobe_json(path, "format=format_name,duration", timeout=10)
        if not probe or not probe.get("format"):
            findings.append(
                _finding(
                    "structurally_invalid",
                    relative,
                    "video container could not be probed",
                    actionable=False,
                )
            )
    return findings


def _placement_finding(
    relative: str,
    extracted: date | None,
    config: Config | None,
) -> AuditFinding | None:
    if extracted is None or config is None:
        return None
    parts = {
        "year": str(extracted.year),
        "month": f"{extracted.month:02d}",
        "day": f"{extracted.day:02d}",
    }
    expected = tuple(parts[item] for item in config.sort_criteria)
    assessment = assess_placement(
        relative,
        Path(*expected).as_posix(),
        expected_is_prefix=True,
    )
    if assessment.consistent:
        return None
    return _finding(
        "placement_inconsistency",
        relative,
        (
            f"date metadata implies {'/'.join(expected)} under sort criteria "
            f"{','.join(config.sort_criteria)}"
        ),
        actionable=True,
        suggested_path=(Path(*expected) / Path(relative).name).as_posix(),
    )
