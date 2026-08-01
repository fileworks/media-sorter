"""Directional, read-only comparison of inputs against an organized destination."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import threading
import uuid
from collections.abc import Callable, Iterator
from contextlib import closing, suppress
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.config import Config
from app.core.config_fingerprint import config_fingerprint as effective_config_fingerprint
from app.core.integrity import MutationManifest
from app.core.media_units import (
    ROLE_BEARING_EXTENSIONS,
    CompanionRole,
    MediaUnit,
    MediaUnitMember,
    bind_media_units,
)
from app.services.catalog_views import CursorError, decode_cursor, encode_cursor
from app.services.destination import (
    build_dest_dir,
    companion_destination,
    predicted_filename,
)
from app.services.duplicate_service import DuplicateService
from app.services.extraction_service import DateExtractionService
from app.services.mutation_planner import build_placement_action
from app.services.verified_transfer import stream_sha256
from app.utils.media_utils import is_image, is_media

FindingClass = Literal["missing", "misplaced", "extra", "matched", "unknown"]
IdentityConfidence = Literal["confirmed", "probable", "unrelated", "unknown"]


class ReconciliationFinding(BaseModel):
    model_config = ConfigDict(frozen=True)

    finding_id: str
    classification: FindingClass
    identity: IdentityConfidence
    input_path: str | None = None
    destination_path: str | None = None
    expected_path: str | None = None
    content_hash: str | None = None
    perceptual_distance: int | None = Field(default=None, ge=0)
    metadata_agreement: bool | None = None
    measured_against: str
    actionable: bool
    requires_explicit_confirmation: bool = False
    source_fingerprint: str | None = None
    destination_fingerprint: str | None = None
    unit_members: tuple[str, ...] = ()
    unit_id: str | None = None
    unit_member_roles: dict[str, CompanionRole | None] = Field(default_factory=dict)
    unit_member_fingerprints: dict[str, str] = Field(default_factory=dict)


class ReconciliationReport(BaseModel):
    model_config = ConfigDict(frozen=True)

    report_id: str
    created_at: datetime
    findings: tuple[ReconciliationFinding, ...]
    input_coverage: Literal["full", "partial", "unavailable"]
    destination_coverage: Literal["full", "partial", "unavailable"]
    issues: tuple[str, ...] = ()
    config_fingerprint: str

    def counts(self) -> dict[str, int]:
        counts = dict.fromkeys(("missing", "misplaced", "extra", "matched", "unknown"), 0)
        for finding in self.findings:
            counts[finding.classification] += 1
        return counts


class ReconciliationPage(BaseModel):
    """A bounded window over a disk-backed reconciliation report."""

    model_config = ConfigDict(frozen=True)

    report_id: str
    created_at: datetime
    findings: tuple[ReconciliationFinding, ...]
    next_cursor: str | None = None
    counts: dict[str, int]
    input_coverage: Literal["full", "partial", "unavailable"]
    destination_coverage: Literal["full", "partial", "unavailable"]
    issues: tuple[str, ...] = ()
    config_fingerprint: str


@dataclass
class _UnitFacts:
    unit: MediaUnit
    digest: str
    signature: str | None
    date: date | None
    camera: str
    fingerprint: str


class DestinationReconciliationService:
    def __init__(self) -> None:
        self.duplicates = DuplicateService()
        self.extraction = DateExtractionService()
        self._result_directory = Path(tempfile.mkdtemp(prefix="mediasort-reconciliation-"))
        # Content/signature extraction dominates repeated reconciliation cost.
        # Keep the cache on disk so a large destination can be reused without
        # retaining one Python object per media unit.
        self._facts_database = self._result_directory / "unit-facts.sqlite3"
        self._cache_lock = threading.Lock()
        self._cache_connection = sqlite3.connect(self._facts_database, check_same_thread=False)
        self._cache_connection.execute(
            """
            CREATE TABLE unit_facts (
                primary_path TEXT PRIMARY KEY,
                unit_fingerprint TEXT NOT NULL,
                payload TEXT NOT NULL
            )
            """
        )
        self._cache_connection.commit()
        self._report_headers: dict[str, ReconciliationReport] = {}

    def close(self) -> None:
        """Release disk-backed report pages without waiting for finalization."""
        connection = getattr(self, "_cache_connection", None)
        if connection is not None:
            with suppress(sqlite3.Error):
                connection.close()
        directory = getattr(self, "_result_directory", None)
        if directory is not None:
            shutil.rmtree(directory, ignore_errors=True)

    def __del__(self) -> None:
        with suppress(Exception):
            self.close()

    def compare(
        self,
        input_root: Path,
        destination_root: Path,
        config: Config,
        *,
        input_available: bool = True,
        probable_distance: int = 8,
        cancel: Callable[[], bool] | None = None,
    ) -> ReconciliationReport:
        """Compare without opening either tree for writing."""
        findings: list[ReconciliationFinding] = []
        header = self._compute(
            input_root,
            destination_root,
            config,
            input_available=input_available,
            probable_distance=probable_distance,
            cancel=cancel,
            emit=findings.append,
        )
        return header.model_copy(update={"findings": tuple(sorted(findings, key=_finding_order))})

    def compare_paged(
        self,
        input_root: Path,
        destination_root: Path,
        config: Config,
        *,
        input_available: bool = True,
        probable_distance: int = 8,
        page_size: int = 100,
        cancel: Callable[[], bool] | None = None,
    ) -> ReconciliationPage:
        """Compute into SQLite and return only the first cursor page."""
        report_id = f"recon_{uuid.uuid4().hex[:16]}"
        database = self._report_path(report_id)
        with closing(sqlite3.connect(database)) as connection, connection:
            connection.execute(
                """
                CREATE TABLE findings (
                    finding_id TEXT PRIMARY KEY,
                    class_order INTEGER NOT NULL,
                    classification TEXT NOT NULL,
                    input_key TEXT NOT NULL,
                    destination_key TEXT NOT NULL,
                    payload TEXT NOT NULL
                )
                """
            )
            connection.execute(
                """
                CREATE INDEX findings_order
                ON findings(class_order, input_key, destination_key, finding_id)
                """
            )

            def store(finding: ReconciliationFinding) -> None:
                connection.execute(
                    """
                    INSERT INTO findings
                        (finding_id, class_order, classification, input_key,
                         destination_key, payload)
                    VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        finding.finding_id,
                        _classification_order(finding.classification),
                        finding.classification,
                        finding.input_path or "",
                        finding.destination_path or "",
                        finding.model_dump_json(),
                    ),
                )

            header = self._compute(
                input_root,
                destination_root,
                config,
                input_available=input_available,
                probable_distance=probable_distance,
                cancel=cancel,
                emit=store,
                report_id=report_id,
            )
            connection.commit()
        self._report_headers[report_id] = header
        return self.page(report_id, page_size=page_size)

    def page(
        self,
        report_id: str,
        *,
        cursor: str | None = None,
        classification: FindingClass | None = None,
        page_size: int = 100,
    ) -> ReconciliationPage:
        header = self._report_headers.get(report_id)
        database = self._report_path(report_id)
        if header is None or not database.is_file():
            raise KeyError(report_id)
        size = max(1, min(page_size, 500))
        conditions: list[str] = []
        parameters: list[object] = []
        if classification is not None:
            conditions.append("classification = ?")
            parameters.append(classification)
        if cursor:
            decoded = decode_cursor(cursor)
            if (
                decoded.get("report") != report_id
                or decoded.get("classification") != classification
            ):
                raise CursorError("this page marker belongs to a different reconciliation view")
            conditions.append(
                """
                (class_order, input_key, destination_key, finding_id)
                    > (?, ?, ?, ?)
                """
            )
            parameters.extend(
                [
                    decoded["class_order"],
                    decoded["input_key"],
                    decoded["destination_key"],
                    decoded["finding_id"],
                ]
            )
        where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
        with closing(sqlite3.connect(database)) as connection:
            connection.row_factory = sqlite3.Row
            rows = connection.execute(
                f"""
                SELECT *
                FROM findings
                {where}
                ORDER BY class_order, input_key, destination_key, finding_id
                LIMIT ?
                """,
                [*parameters, size + 1],
            ).fetchall()
            count_rows = connection.execute(
                """
                SELECT classification, COUNT(*) AS count
                FROM findings
                GROUP BY classification
                """
            ).fetchall()
        visible = rows[:size]
        next_cursor = None
        if len(rows) > size and visible:
            last = visible[-1]
            next_cursor = encode_cursor(
                {
                    "report": report_id,
                    "classification": classification,
                    "class_order": last["class_order"],
                    "input_key": last["input_key"],
                    "destination_key": last["destination_key"],
                    "finding_id": last["finding_id"],
                }
            )
        counts = dict.fromkeys(("missing", "misplaced", "extra", "matched", "unknown"), 0)
        counts.update({str(row["classification"]): int(row["count"]) for row in count_rows})
        return ReconciliationPage(
            report_id=header.report_id,
            created_at=header.created_at,
            findings=tuple(
                ReconciliationFinding.model_validate(json.loads(str(row["payload"])))
                for row in visible
            ),
            next_cursor=next_cursor,
            counts=counts,
            input_coverage=header.input_coverage,
            destination_coverage=header.destination_coverage,
            issues=header.issues,
            config_fingerprint=header.config_fingerprint,
        )

    def plan_saved(
        self,
        report_id: str,
        finding_ids: tuple[str, ...],
        *,
        config: Config,
        confirm_probable: tuple[str, ...] = (),
    ) -> MutationManifest:
        """Resolve selected IDs server-side; the client never reposts a full report."""
        header = self._report_headers.get(report_id)
        if header is None:
            raise ValueError("reconciliation report is stale or unknown")
        unique_ids = tuple(dict.fromkeys(finding_ids))
        if not unique_ids:
            raise ValueError("no reconciliation findings selected")
        placeholders = ",".join("?" for _ in unique_ids)
        with closing(sqlite3.connect(self._report_path(report_id))) as connection:
            rows = connection.execute(
                f"SELECT payload FROM findings WHERE finding_id IN ({placeholders})",
                unique_ids,
            ).fetchall()
        findings = tuple(
            ReconciliationFinding.model_validate(json.loads(str(row[0]))) for row in rows
        )
        report = header.model_copy(update={"findings": findings})
        return self.plan(
            report,
            unique_ids,
            config=config,
            confirm_probable=confirm_probable,
        )

    def _compute(
        self,
        input_root: Path,
        destination_root: Path,
        config: Config,
        *,
        input_available: bool,
        probable_distance: int,
        cancel: Callable[[], bool] | None,
        emit: Callable[[ReconciliationFinding], None],
        report_id: str | None = None,
    ) -> ReconciliationReport:
        """Emit findings incrementally and return report metadata only."""
        config_fingerprint = hashlib.sha256(
            repr(
                (
                    tuple(config.sort_criteria),
                    config.rename,
                    config.rename_pattern,
                    config.categorize_enabled,
                    config.camera_subfolder_enabled,
                )
            ).encode()
        ).hexdigest()[:16]
        if not input_available or not input_root.is_dir():
            return ReconciliationReport(
                report_id=report_id or f"recon_{uuid.uuid4().hex[:16]}",
                created_at=datetime.now(timezone.utc),
                findings=(),
                input_coverage="unavailable",
                destination_coverage="full" if destination_root.is_dir() else "unavailable",
                issues=("input root is unavailable; its units are unknown, never missing",),
                config_fingerprint=config_fingerprint,
            )
        if not destination_root.is_dir():
            return ReconciliationReport(
                report_id=report_id or f"recon_{uuid.uuid4().hex[:16]}",
                created_at=datetime.now(timezone.utc),
                findings=(),
                input_coverage="full",
                destination_coverage="unavailable",
                issues=("destination root is unavailable",),
                config_fingerprint=config_fingerprint,
            )

        input_issues: list[str] = []
        destination_issues: list[str] = []
        cancelled = False
        index_path = self._result_directory / f"destination-{uuid.uuid4().hex}.sqlite3"
        try:
            with closing(sqlite3.connect(index_path)) as index, index:
                index.executescript(
                    """
                    CREATE TABLE destination_units (
                        primary_path TEXT PRIMARY KEY,
                        digest TEXT NOT NULL,
                        signature TEXT,
                        captured_date TEXT,
                        camera TEXT NOT NULL,
                        payload TEXT NOT NULL,
                        used INTEGER NOT NULL DEFAULT 0
                    );
                    CREATE INDEX destination_hash
                        ON destination_units(digest, used, primary_path);
                    CREATE INDEX destination_metadata
                        ON destination_units(captured_date, camera, used, primary_path);
                    """
                )
                for unit in _iter_units(destination_root, destination_issues, cancel):
                    try:
                        facts = self._facts(unit)
                    except OSError as error:
                        destination_issues.append(
                            f"{unit.primary}: {type(error).__name__} while reading destination"
                        )
                        continue
                    index.execute(
                        """
                        INSERT INTO destination_units
                            (primary_path, digest, signature, captured_date, camera, payload)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (
                            str(unit.primary),
                            facts.digest,
                            facts.signature,
                            None if facts.date is None else facts.date.isoformat(),
                            facts.camera,
                            _facts_payload(facts),
                        ),
                    )
                if cancel is not None and cancel():
                    cancelled = True

                if not cancelled:
                    for unit in _iter_units(input_root, input_issues, cancel):
                        try:
                            source = self._facts(unit)
                            expected = self._expected(
                                source.unit.primary,
                                input_root,
                                destination_root,
                                config,
                                source.date,
                            )
                        except OSError as error:
                            input_issues.append(
                                f"{unit.primary}: {type(error).__name__} while reading input"
                            )
                            continue
                        exact_row = index.execute(
                            """
                            SELECT payload FROM destination_units
                             WHERE digest = ? AND used = 0
                             ORDER BY primary_path LIMIT 1
                            """,
                            (source.digest,),
                        ).fetchone()
                        if exact_row is not None:
                            exact = _facts_from_payload(str(exact_row[0]))
                            index.execute(
                                "UPDATE destination_units SET used = 1 WHERE primary_path = ?",
                                (str(exact.unit.primary),),
                            )
                            complete = len(source.unit.members) == len(exact.unit.members)
                            actual = exact.unit.primary.resolve(strict=False)
                            classification: FindingClass = (
                                "matched"
                                if complete and actual == expected.resolve(strict=False)
                                else "misplaced"
                            )
                            emit(
                                self._finding(
                                    classification,
                                    "confirmed",
                                    source,
                                    exact,
                                    expected,
                                    config_fingerprint,
                                    actionable=classification == "misplaced",
                                )
                            )
                            continue

                        probable = self._probable(
                            source,
                            index,
                            probable_distance,
                        )
                        if probable is not None:
                            match, distance = probable
                            index.execute(
                                "UPDATE destination_units SET used = 1 WHERE primary_path = ?",
                                (str(match.unit.primary),),
                            )
                            emit(
                                self._finding(
                                    "misplaced",
                                    "probable",
                                    source,
                                    match,
                                    expected,
                                    config_fingerprint,
                                    actionable=True,
                                    distance=distance,
                                    explicit=True,
                                )
                            )
                            continue
                        emit(
                            self._finding(
                                "missing",
                                "unrelated",
                                source,
                                None,
                                expected,
                                config_fingerprint,
                                actionable=True,
                            )
                        )
                    if cancel is not None and cancel():
                        cancelled = True

                # Do not call unseen destination content “extra” if either side
                # stopped early; incomplete coverage makes that claim unsafe.
                if not cancelled and not input_issues and not destination_issues:
                    for row in index.execute(
                        """
                        SELECT payload FROM destination_units
                         WHERE used = 0 ORDER BY primary_path
                        """
                    ):
                        destination = _facts_from_payload(str(row[0]))
                        emit(
                            self._finding(
                                "extra",
                                "unrelated",
                                None,
                                destination,
                                None,
                                config_fingerprint,
                                actionable=False,
                            )
                        )
        finally:
            index_path.unlink(missing_ok=True)

        if cancelled:
            input_issues.append("reconciliation was cancelled; partial findings were retained")
            destination_issues.append("reconciliation was cancelled before complete coverage")
        issues = (*input_issues, *destination_issues)
        return ReconciliationReport(
            report_id=report_id or f"recon_{uuid.uuid4().hex[:16]}",
            created_at=datetime.now(timezone.utc),
            findings=(),
            input_coverage="partial" if input_issues or cancelled else "full",
            destination_coverage="partial" if destination_issues or cancelled else "full",
            issues=issues,
            config_fingerprint=config_fingerprint,
        )

    def _report_path(self, report_id: str) -> Path:
        safe = "".join(
            character for character in report_id if character.isalnum() or character in "-_"
        )
        return self._result_directory / f"{safe}.sqlite3"

    def plan(
        self,
        report: ReconciliationReport,
        finding_ids: tuple[str, ...],
        *,
        config: Config,
        confirm_probable: tuple[str, ...] = (),
    ) -> MutationManifest:
        """Convert safe selections into the ordinary immutable manifest."""
        selected = {
            item.finding_id: item for item in report.findings if item.finding_id in finding_ids
        }
        if len(selected) != len(set(finding_ids)):
            raise ValueError("one or more reconciliation findings are stale or unknown")
        actions = []
        for finding in selected.values():
            if not finding.actionable or finding.classification == "extra":
                raise ValueError("informational extra/unknown findings cannot become actions")
            if finding.identity == "probable" and finding.finding_id not in confirm_probable:
                raise ValueError("probable matches require explicit per-finding confirmation")
            if not finding.input_path or not finding.expected_path:
                raise ValueError("finding has no safe directional source and destination")
            source = Path(finding.input_path)
            destination = Path(finding.expected_path)
            if _fingerprint(source) != finding.source_fingerprint:
                raise ValueError("input changed after reconciliation; compute it again")
            if (
                finding.destination_path
                and Path(finding.destination_path).exists()
                and _fingerprint(Path(finding.destination_path)) != finding.destination_fingerprint
            ):
                raise ValueError("destination changed after reconciliation; compute it again")
            members = tuple(Path(path) for path in finding.unit_members) or (source,)
            for member in members:
                expected_fingerprint = finding.unit_member_fingerprints.get(str(member))
                if expected_fingerprint is None or _fingerprint(member) != expected_fingerprint:
                    raise ValueError(
                        "input media unit changed after reconciliation; compute it again"
                    )
                is_primary = member == source
                if not is_primary and config.companion_handling == "leave_in_place":
                    continue
                member_destination = (
                    destination if is_primary else companion_destination(destination, member)
                )
                if member_destination.is_file():
                    source_digest = stream_sha256(member)[0]
                    destination_digest = stream_sha256(member_destination)[0]
                    if source_digest == destination_digest:
                        continue
                actions.append(
                    build_placement_action(
                        member,
                        member_destination,
                        kind="copy",
                        move=False,
                        preservation=config.preservation_profile,
                        root_id="reconciliation-input",
                        relative_path=member.name,
                        unit_id=finding.unit_id,
                        companion_role=finding.unit_member_roles.get(str(member)),
                        unit_primary_path=str(source),
                    )
                )
        if not actions:
            raise ValueError("no actionable findings selected")
        return MutationManifest(
            manifest_id=f"manifest_{uuid.uuid4().hex[:16]}",
            operation_id=f"reconcile_{uuid.uuid4().hex[:16]}",
            plan_id=report.report_id,
            profile_id=config.preservation_profile.profile_id,
            effective_config_sha256=effective_config_fingerprint(config),
            actions=tuple(actions),
        )

    def _facts(self, unit: MediaUnit) -> _UnitFacts:
        primary = unit.primary
        unit_fingerprint = "|".join(
            f"{member.path}:{_fingerprint(member.path)}" for member in unit.members
        )
        with self._cache_lock:
            cached = self._cache_connection.execute(
                """
                SELECT payload FROM unit_facts
                 WHERE primary_path = ? AND unit_fingerprint = ?
                """,
                (str(primary), unit_fingerprint),
            ).fetchone()
        if cached is not None:
            return _facts_from_payload(str(cached[0]))
        digest = stream_sha256(primary)[0]
        image_signature = self.duplicates.image_signature(primary) if is_image(primary) else None
        signature = None if image_signature is None else str(image_signature.phash)
        extraction = self.extraction.extract_detailed(primary)
        facts = _UnitFacts(
            unit=unit,
            digest=digest,
            signature=signature,
            date=extraction.extracted_date,
            camera=self.extraction.extract_camera_model(primary) or "",
            fingerprint=_fingerprint(primary),
        )
        with self._cache_lock, self._cache_connection:
            self._cache_connection.execute(
                """
                INSERT INTO unit_facts(primary_path, unit_fingerprint, payload)
                VALUES (?, ?, ?)
                ON CONFLICT(primary_path) DO UPDATE SET
                    unit_fingerprint = excluded.unit_fingerprint,
                    payload = excluded.payload
                """,
                (str(primary), unit_fingerprint, _facts_payload(facts)),
            )
        return facts

    def _probable(
        self,
        source: _UnitFacts,
        index: sqlite3.Connection,
        max_distance: int,
    ) -> tuple[_UnitFacts, int] | None:
        if source.signature is None or source.date is None or not source.camera:
            return None
        best: tuple[int, _UnitFacts] | None = None
        rows = index.execute(
            """
            SELECT payload FROM destination_units
             WHERE captured_date = ? AND camera = ? AND signature IS NOT NULL AND used = 0
             ORDER BY primary_path
            """,
            (source.date.isoformat(), source.camera),
        )
        for row in rows:
            destination = _facts_from_payload(str(row[0]))
            assert destination.signature is not None
            distance = _hamming_distance(source.signature, destination.signature)
            if distance <= max_distance:
                candidate = (distance, destination)
                if best is None or (distance, str(destination.unit.primary)) < (
                    best[0],
                    str(best[1].unit.primary),
                ):
                    best = candidate
        return None if best is None else (best[1], best[0])

    def _expected(
        self,
        source: Path,
        input_root: Path,
        destination_root: Path,
        config: Config,
        extracted: date | None = None,
    ) -> Path:
        extracted = extracted or self.extraction.extract_detailed(source).extracted_date
        if extracted is None:
            return destination_root / "_unknown_dates" / source.name
        directory = build_dest_dir(source, extracted, input_root, destination_root, config)
        return directory / predicted_filename(source, extracted, config)

    @staticmethod
    def _finding(
        classification: FindingClass,
        identity: IdentityConfidence,
        source: _UnitFacts | None,
        destination: _UnitFacts | None,
        expected: Path | None,
        config_fingerprint: str,
        *,
        actionable: bool,
        distance: int | None = None,
        explicit: bool = False,
    ) -> ReconciliationFinding:
        source_path = None if source is None else str(source.unit.primary)
        destination_path = None if destination is None else str(destination.unit.primary)
        key = f"{classification}:{source_path or destination_path}"
        return ReconciliationFinding(
            finding_id=hashlib.sha256(key.encode()).hexdigest()[:24],
            classification=classification,
            identity=identity,
            input_path=source_path,
            destination_path=destination_path,
            expected_path=None if expected is None else str(expected),
            content_hash=source.digest if source is not None and identity == "confirmed" else None,
            perceptual_distance=distance,
            metadata_agreement=True if identity == "probable" else None,
            measured_against=f"configuration {config_fingerprint}",
            actionable=actionable,
            requires_explicit_confirmation=explicit,
            source_fingerprint=None if source is None else source.fingerprint,
            destination_fingerprint=None if destination is None else destination.fingerprint,
            unit_members=(
                () if source is None else tuple(str(member.path) for member in source.unit.members)
            ),
            unit_id=None if source is None else source.unit.unit_id,
            unit_member_roles=(
                {}
                if source is None
                else {str(member.path): member.companion_role for member in source.unit.members}
            ),
            unit_member_fingerprints=(
                {}
                if source is None
                else {str(member.path): _fingerprint(member.path) for member in source.unit.members}
            ),
        )


def _iter_units(
    root: Path,
    issues: list[str],
    cancel: Callable[[], bool] | None,
) -> Iterator[MediaUnit]:
    """Yield one directory's units at a time, retaining no library-sized list."""

    def record_walk_error(error: OSError) -> None:
        issues.append(f"{error.filename or root}: {type(error).__name__}")

    for directory, _subdirs, filenames in os.walk(root, onerror=record_walk_error):
        if cancel is not None and cancel():
            return
        paths: list[Path] = []
        for name in filenames:
            if cancel is not None and cancel():
                return
            path = Path(directory) / name
            try:
                if not path.is_symlink() and (
                    is_media(path) or path.suffix.casefold() in ROLE_BEARING_EXTENSIONS
                ):
                    paths.append(path)
            except OSError as exc:
                issues.append(f"{path}: {type(exc).__name__}")
        units, _unmatched = bind_media_units(paths, root)
        yield from units


def _facts_payload(facts: _UnitFacts) -> str:
    return json.dumps(
        {
            "unit_id": facts.unit.unit_id,
            "primary": str(facts.unit.primary),
            "members": [
                {
                    "path": str(member.path),
                    "role": member.companion_role,
                    "primary": member.is_primary,
                }
                for member in facts.unit.members
            ],
            "digest": facts.digest,
            "signature": facts.signature,
            "date": None if facts.date is None else facts.date.isoformat(),
            "camera": facts.camera,
            "fingerprint": facts.fingerprint,
        },
        separators=(",", ":"),
    )


def _facts_from_payload(payload: str) -> _UnitFacts:
    item = json.loads(payload)
    return _UnitFacts(
        unit=MediaUnit(
            unit_id=str(item["unit_id"]),
            primary=Path(str(item["primary"])),
            members=tuple(
                MediaUnitMember(
                    path=Path(str(member["path"])),
                    companion_role=member["role"],
                    is_primary=bool(member["primary"]),
                )
                for member in item["members"]
            ),
        ),
        digest=str(item["digest"]),
        signature=None if item["signature"] is None else str(item["signature"]),
        date=None if item["date"] is None else date.fromisoformat(str(item["date"])),
        camera=str(item["camera"]),
        fingerprint=str(item["fingerprint"]),
    )


def _hamming_distance(left: str, right: str) -> int:
    return (int(left, 16) ^ int(right, 16)).bit_count()


def _fingerprint(path: Path) -> str:
    observed = path.stat()
    return f"{observed.st_size}:{observed.st_mtime_ns}:{observed.st_ino}"


def _finding_order(item: ReconciliationFinding) -> tuple[int, str, str]:
    return (
        _classification_order(item.classification),
        item.input_path or "",
        item.destination_path or "",
    )


def _classification_order(classification: FindingClass) -> int:
    return {"unknown": 0, "missing": 1, "misplaced": 2, "extra": 3, "matched": 4}[classification]
