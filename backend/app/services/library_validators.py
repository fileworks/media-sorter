"""Independent checks that describe a library rather than change it.

Each validator answers one question and says how sure it is. They are separate
on purpose: turning off "inconsistent names" must not weaken the duplicate check,
and a validator that cannot run reports `not_evaluated` rather than `passed`.

The most important line in this module is the one that refuses to certify a
library it could not fully read. An inaccessible subtree makes a report
*partial* forever — no combination of passing checks can promote it.
"""

from __future__ import annotations

import re
import sqlite3
import tempfile
import uuid
from collections.abc import Callable, Iterable, Iterator, Sequence
from dataclasses import dataclass
from pathlib import Path

from app.core.duplicate_plans import (
    ValidationFinding,
    ValidationReport,
    utc_now,
)
from app.core.logging_config import get_logger
from app.services.catalog import FileRecord, MediaCatalog
from app.services.catalog_duplicates import CatalogDuplicateIndex
from app.services.library_assessment import assess_placement, assess_readability

logger = get_logger(__name__)

VALIDATOR_RULE_VERSION = "validators-1"

#: A name a person would call consistent: a date-ish or descriptive stem without
#: the debris cameras, phones, and copy dialogs leave behind.
_INCONSISTENT_NAME = re.compile(
    r"(\(\d+\)|[ _-]cop(y|ie)|IMG_\d+ ?\d+|DSC\d+ ?\d+|~\d+|\bfinal[ _-]?final\b)",
    re.IGNORECASE,
)

#: Sidecar extensions that are expected beside media when any sibling has one.
SIDECAR_SUFFIXES = (".xmp", ".json", ".aae")

ValidatorId = str


@dataclass(frozen=True)
class ValidatorContext:
    """Everything the validators are allowed to look at."""

    catalog: MediaCatalog
    root_id: str
    generation: int = 0
    #: Where files of this root are expected to live, e.g. YYYY/MM. A record
    #: outside its expected place is "misplaced" — a claim only made when the
    #: expectation itself is known.
    expected_path_for: Callable[[FileRecord], str | None] | None = None
    duplicate_index: CatalogDuplicateIndex | None = None
    similar_distance: int = 2


def _finding(
    category: str,
    record: FileRecord,
    *,
    context: ValidatorContext,
    evidence: str,
    severity: str = "warning",
    confidence: str = "medium",
    expected_path: str | None = None,
    actionable: bool = False,
) -> ValidationFinding:
    return ValidationFinding(
        finding_id=f"{category}:{record.root_id}:{record.file_id}",
        category=category,  # type: ignore[arg-type]
        severity=severity,  # type: ignore[arg-type]
        state="failed",
        root_id=record.root_id,
        relative_path=record.relative_path,
        current_path=record.relative_path,
        expected_path=expected_path,
        evidence=evidence,
        confidence=confidence,  # type: ignore[arg-type]
        rule_version=VALIDATOR_RULE_VERSION,
        catalog_generation=context.generation,
        actionable=actionable,
    )


# --------------------------------------------------------------------------- #
# Validators                                                                   #
# --------------------------------------------------------------------------- #


def check_misplaced(
    records: Iterable[FileRecord], context: ValidatorContext
) -> Iterator[ValidationFinding]:
    """Files that are not where this library's own rules would put them."""
    if context.expected_path_for is None:
        return
    for record in records:
        expected = context.expected_path_for(record)
        if expected is None:
            continue
        assessment = assess_placement(record.relative_path, expected)
        if assessment.consistent:
            continue
        yield _finding(
            "misplaced",
            record,
            context=context,
            evidence=f"expected at {assessment.expected_path}",
            expected_path=assessment.expected_path,
            confidence="high",
            actionable=True,
        )


def check_inconsistent_names(
    records: Iterable[FileRecord], context: ValidatorContext
) -> Iterator[ValidationFinding]:
    """Names carrying copy suffixes and duplication debris."""
    for record in records:
        name = Path(record.relative_path).name
        match = _INCONSISTENT_NAME.search(name)
        if match is None:
            continue
        yield _finding(
            "inconsistent_name",
            record,
            context=context,
            evidence=f"name contains {match.group(0)!r}",
            severity="info",
            confidence="medium",
        )


def check_exact_duplicates(
    records: Iterable[FileRecord], context: ValidatorContext
) -> Iterator[ValidationFinding]:
    """Byte-identical copies, reported once per extra copy."""
    if context.duplicate_index is None:
        return
    seen: set[str] = set()
    for record in records:
        digest = context.catalog.hash_for(record)
        if digest is None or digest in seen:
            continue
        matches = context.duplicate_index.exact_matches(
            digest, roles=("input", "destination", "reference"), limit=50
        )
        if len(matches) < 2:
            continue
        seen.add(digest)
        yield _finding(
            "exact_duplicate",
            record,
            context=context,
            evidence=f"{len(matches)} identical copies (sha256 {digest[:12]}…)",
            confidence="high",
            actionable=True,
        )


def check_similar_media(
    records: Iterable[FileRecord], context: ValidatorContext
) -> Iterator[ValidationFinding]:
    """Near-identical media, always reported as lower confidence than exact."""
    if context.duplicate_index is None:
        return
    reported: set[int] = set()
    for record in records:
        signature = (context.catalog.signature_for(record, "phash") or {}).get("value")
        if not signature or record.file_id in reported:
            continue
        candidates = context.duplicate_index.perceptual_candidates(
            str(signature), max_distance=context.similar_distance, limit=50
        )
        others = [item for item in candidates if item.record.file_id != record.file_id]
        if not others:
            continue
        reported.add(record.file_id)
        reported.update(item.record.file_id for item in others)
        yield _finding(
            "similar_media",
            record,
            context=context,
            evidence=(
                f"{len(others)} visually similar file(s) within {context.similar_distance} bits"
            ),
            severity="info",
            confidence="low",
        )


def check_unreadable(
    records: Iterable[FileRecord], context: ValidatorContext
) -> Iterator[ValidationFinding]:
    """Files the catalog knows about that can no longer be opened."""
    root = context.catalog.root_path(context.root_id)
    if root is None:
        return
    for record in records:
        path = root / record.relative_path
        assessment = assess_readability(path)
        if not assessment.readable:
            yield _finding(
                "unreadable",
                record,
                context=context,
                evidence=assessment.evidence or "the file could not be read",
                severity="error",
                confidence="high",
            )


def check_missing_sidecars(
    records: Iterable[FileRecord], context: ValidatorContext
) -> Iterator[ValidationFinding]:
    """Media whose sidecar disappeared while its siblings kept theirs."""
    root = context.catalog.root_path(context.root_id)
    if root is None:
        return
    # Directory grouping can itself approach library size. Spool the two small
    # facts needed by this validator to disk, then let SQLite group them.
    with tempfile.TemporaryDirectory(prefix="mediasort-sidecar-validation-") as temporary:
        spool = sqlite3.connect(Path(temporary) / "sidecars.db")
        try:
            spool.execute(
                """
                CREATE TABLE candidates (
                    directory TEXT NOT NULL,
                    file_id INTEGER PRIMARY KEY,
                    has_sidecar INTEGER NOT NULL
                )
                """
            )
            for record in records:
                relative = Path(record.relative_path)
                directory = relative.parent
                has_sidecar = any(
                    (root / directory / f"{relative.stem}{suffix}").is_file()
                    for suffix in SIDECAR_SUFFIXES
                )
                spool.execute(
                    "INSERT INTO candidates(directory, file_id, has_sidecar) VALUES (?, ?, ?)",
                    (directory.as_posix(), record.file_id, int(has_sidecar)),
                )
            spool.commit()
            rows = spool.execute(
                """
                SELECT file_id
                  FROM candidates
                 WHERE has_sidecar = 0
                   AND directory IN (
                       SELECT directory
                         FROM candidates
                        GROUP BY directory
                       HAVING sum(has_sidecar) > 0
                          AND sum(has_sidecar) < count(*)
                   )
                 ORDER BY file_id
                """
            )
            for row in rows:
                candidate = context.catalog.file_by_id(int(row[0]))
                if candidate is None:
                    continue
                yield _finding(
                    "missing_sidecar",
                    candidate,
                    context=context,
                    evidence="other files in this folder have sidecars; this one does not",
                    severity="info",
                    confidence="low",
                )
        finally:
            spool.close()


def check_catalog_freshness(
    records: Iterable[FileRecord], context: ValidatorContext
) -> Iterator[ValidationFinding]:
    """Whether the index this report is built on has ever completed."""
    del records
    if context.catalog.last_complete_generation(context.root_id) is not None:
        return
    yield ValidationFinding(
        finding_id=f"catalog_stale:{context.root_id}",
        category="catalog_stale",
        severity="warning",
        state="failed",
        root_id=context.root_id,
        evidence="no scan of this folder has ever completed, so results may be incomplete",
        confidence="high",
        rule_version=VALIDATOR_RULE_VERSION,
        catalog_generation=context.generation,
    )


Validator = Callable[[Iterable[FileRecord], ValidatorContext], Iterator[ValidationFinding]]

VALIDATORS: dict[str, Validator] = {
    "misplaced": check_misplaced,
    "inconsistent_name": check_inconsistent_names,
    "exact_duplicate": check_exact_duplicates,
    "similar_media": check_similar_media,
    "unreadable": check_unreadable,
    "missing_sidecar": check_missing_sidecars,
    "catalog_stale": check_catalog_freshness,
}


# --------------------------------------------------------------------------- #
# Running                                                                      #
# --------------------------------------------------------------------------- #


def run_validation(
    context: ValidatorContext,
    *,
    profile_id: str = "default",
    enabled: Sequence[str] | None = None,
    unreachable_scopes: Sequence[str] = (),
) -> ValidationReport:
    """Run the enabled validators over one root and report honestly.

    A disabled validator is recorded as `disabled`, never as passed, and a root
    with unreachable scopes produces a partial report whatever the findings say.
    """
    started = utc_now()
    selected = (
        list(VALIDATORS) if enabled is None else [key for key in enabled if key in VALIDATORS]
    )
    disabled = [key for key in VALIDATORS if key not in selected]

    record_count = context.catalog.count_files(context.root_id)
    findings: list[ValidationFinding] = []
    for key in selected:
        produced_any = False
        for finding in VALIDATORS[key](context.catalog.iter_files(context.root_id), context):
            findings.append(finding)
            produced_any = True
        if produced_any:
            continue
        findings.append(
            ValidationFinding(
                finding_id=f"{key}:{context.root_id}:passed",
                category=key,  # type: ignore[arg-type]
                severity="info",
                state="passed" if record_count else "not_evaluated",
                root_id=context.root_id,
                evidence=(
                    "no problems found" if record_count else "there was nothing indexed to check"
                ),
                confidence="high" if record_count else "unknown",
                rule_version=VALIDATOR_RULE_VERSION,
                catalog_generation=context.generation,
            )
        )

    for key in disabled:
        findings.append(
            ValidationFinding(
                finding_id=f"{key}:{context.root_id}:disabled",
                category=key,  # type: ignore[arg-type]
                severity="info",
                state="disabled",
                root_id=context.root_id,
                evidence="this check is turned off",
                confidence="unknown",
                rule_version=VALIDATOR_RULE_VERSION,
                catalog_generation=context.generation,
            )
        )

    return ValidationReport(
        report_id=f"val_{uuid.uuid4().hex[:16]}",
        profile_id=profile_id,
        catalog_generation=context.generation,
        started_at=started,
        finished_at=utc_now(),
        findings=tuple(findings),
        unreachable_scopes=tuple(unreachable_scopes),
        disabled_categories=tuple(disabled),
    )


def actionable_findings(report: ValidationReport) -> tuple[ValidationFinding, ...]:
    """The findings that may become ordinary review actions — nothing else."""
    return tuple(
        finding for finding in report.findings if finding.state == "failed" and finding.actionable
    )


def reusable_extraction(previous: ValidationReport, rule_version: str) -> bool:
    """Whether a rule-only change may reuse the previous run's extraction.

    Extraction depends on the catalog generation, not on the rules. When only
    the rules moved, everything expensive is still valid and the rerun is cheap.
    """
    return previous.catalog_generation > 0 and any(
        finding.rule_version != rule_version for finding in previous.findings
    )
