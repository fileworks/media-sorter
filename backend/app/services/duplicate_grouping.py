"""Building review groups from the catalog, one group at a time.

Groups are produced by walking indexed queries, not by loading a library into
memory, so a two-million-file destination yields its first group as fast as its
last. Every member carries the facts a person would compare copies by — and
where a fact could not be extracted, it carries *that*, because a fabricated
zero is how "keep the highest resolution" throws away the only good copy.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterator, Sequence
from typing import Any, Literal

from app.core.duplicate_plans import (
    DuplicateGroup,
    FactValue,
    GroupMember,
    MemberEvidence,
    MemberFacts,
)
from app.core.logging_config import get_logger
from app.services.catalog import FileRecord, MediaCatalog
from app.services.catalog_duplicates import (
    CatalogDuplicateIndex,
    DuplicateCandidate,
    LookupTelemetry,
    RootRole,
)

logger = get_logger(__name__)

EXACT_RULE_VERSION = "exact-1"
SIMILAR_RULE_VERSION = "similar-1"

#: Distance at which a perceptual match stops being confidently a match. Inside
#: half the threshold it is `medium`; beyond that it is `low` and stays in review.
CONFIDENT_FRACTION = 0.5


def member_id(record: FileRecord) -> str:
    """A stable identity that survives a rename inside the same root."""
    return f"{record.root_id}:{record.file_id}"


def group_id_for(kind: str, key: str) -> str:
    digest = hashlib.sha256(f"{kind}:{key}".encode()).hexdigest()[:24]
    return f"{kind}_{digest}"


def _facts(catalog: MediaCatalog, record: FileRecord) -> MemberFacts:
    """Read stored facts, marking anything the extractor never produced."""
    stored: dict[str, Any] | None = catalog.media_facts_for(record)
    if stored is None:
        unknown = FactValue.unknown("no media facts have been extracted for this file")
        return MemberFacts(
            size_bytes=record.size_bytes,
            modified_at=FactValue.of(record.mtime_ns),
            captured_at=unknown,
            width=unknown,
            height=unknown,
            duration_seconds=unknown,
            codec=unknown,
        )
    return MemberFacts(
        size_bytes=record.size_bytes,
        modified_at=FactValue.of(record.mtime_ns),
        captured_at=_fact(stored.get("captured_at"), "no capture date in this file's metadata"),
        width=_fact(stored.get("width"), "dimensions could not be read"),
        height=_fact(stored.get("height"), "dimensions could not be read"),
        duration_seconds=_fact(stored.get("duration_seconds"), "duration could not be read"),
        codec=_fact(stored.get("codec"), "codec was not reported"),
        media_kind=str(stored.get("kind") or "unknown"),
    )


def _fact(value: Any, issue: str) -> FactValue:
    return FactValue.of(value) if value is not None else FactValue.unknown(issue)


def _observed_path(catalog: MediaCatalog, record: FileRecord) -> str:
    root_path = catalog.root_path(record.root_id)
    return str(root_path / record.relative_path) if root_path else record.relative_path


def _member(
    catalog: MediaCatalog,
    candidate: DuplicateCandidate,
    evidence: MemberEvidence,
) -> GroupMember:
    record = candidate.record
    return GroupMember(
        member_id=member_id(record),
        root_id=record.root_id,
        role=candidate.role,
        relative_path=record.relative_path,
        observed_path=_observed_path(catalog, record),
        facts=_facts(catalog, record),
        evidence=evidence,
    )


def exact_groups(
    catalog: MediaCatalog,
    index: CatalogDuplicateIndex,
    *,
    roles: Sequence[RootRole] = ("input", "destination", "reference"),
    generation: int = 0,
    limit: int | None = None,
) -> Iterator[DuplicateGroup]:
    """Yield content-identical groups, newest evidence first, one at a time."""
    for produced, (sha256, members) in enumerate(index.iter_exact_groups(roles=roles), start=1):
        evidence = MemberEvidence(
            algorithm="sha256",
            algorithm_version=EXACT_RULE_VERSION,
            sha256=sha256,
            confidence="high",
        )
        built = tuple(_member(catalog, candidate, evidence) for candidate in members)
        yield DuplicateGroup(
            group_id=group_id_for("exact", sha256),
            kind="exact",
            catalog_generation=generation,
            rule_version=EXACT_RULE_VERSION,
            member_count=len(built),
            total_bytes=sum(item.facts.size_bytes for item in built),
            members=built,
            evidence_summary=f"identical content (sha256 {sha256[:12]}…)",
        )
        if limit is not None and produced >= limit:
            return


def similar_groups(
    catalog: MediaCatalog,
    index: CatalogDuplicateIndex,
    *,
    max_distance: int,
    kind: str = "phash",
    roles: Sequence[RootRole] = ("input", "destination", "reference"),
    generation: int = 0,
    limit: int | None = None,
    exclude_exact: bool = True,
) -> Iterator[DuplicateGroup]:
    """Yield perceptual groups, each anchored on the file that seeded it.

    A file already accounted for by another group is not used as a new seed, so
    a run of near-identical frames produces one group rather than one per frame.
    Byte-identical members are dropped by default: they belong to an exact group,
    where the evidence is stronger and the keeper rules are stricter.
    """
    seen: set[str] = set()
    produced = 0
    for record in _signature_records(catalog, index, kind, roles):
        anchor_id = member_id(record.record)
        if anchor_id in seen:
            continue
        signature = record.signature or ""
        telemetry = LookupTelemetry()
        candidates = index.perceptual_candidates(
            signature,
            max_distance=max_distance,
            kind=kind,
            roles=roles,
            telemetry=telemetry,
        )
        members: list[GroupMember] = []
        for candidate in candidates:
            identity = member_id(candidate.record)
            if identity in seen and identity != anchor_id:
                continue
            if exclude_exact and candidate.distance == 0 and identity != anchor_id:
                # Identical signatures with identical bytes are an exact group's
                # business; a perceptual group claiming them would double-count.
                stored = catalog.hash_for(candidate.record)
                anchor_hash = catalog.hash_for(record.record)
                if stored is not None and stored == anchor_hash:
                    continue
            members.append(
                _member(
                    catalog,
                    candidate,
                    MemberEvidence(
                        algorithm=kind,
                        algorithm_version=SIMILAR_RULE_VERSION,
                        signature=candidate.signature,
                        distance=candidate.distance,
                        threshold=max_distance,
                        confidence=_confidence(candidate.distance, max_distance, telemetry),
                        extraction_issues=(
                            (telemetry.degraded_reason,) if telemetry.degraded_reason else ()
                        ),
                    ),
                )
            )
        if len(members) < 2:
            continue
        for item in members:
            seen.add(item.member_id)
        yield DuplicateGroup(
            group_id=group_id_for("similar", anchor_id),
            kind="similar",
            catalog_generation=generation,
            rule_version=SIMILAR_RULE_VERSION,
            member_count=len(members),
            total_bytes=sum(item.facts.size_bytes for item in members),
            anchor_member_id=anchor_id if any(m.member_id == anchor_id for m in members) else None,
            members=tuple(members),
            evidence_summary=f"{kind} within {max_distance} bits",
        )
        produced += 1
        if limit is not None and produced >= limit:
            return


def _confidence(
    distance: int | None,
    threshold: int,
    telemetry: LookupTelemetry,
) -> Literal["high", "medium", "low", "unknown"]:
    """How much a perceptual match is worth, stated conservatively."""
    if telemetry.degraded or distance is None:
        return "unknown"
    if distance == 0:
        return "high"
    return "medium" if distance <= max(1, int(threshold * CONFIDENT_FRACTION)) else "low"


def _signature_records(
    catalog: MediaCatalog,
    index: CatalogDuplicateIndex,
    kind: str,
    roles: Sequence[RootRole],
) -> Iterator[DuplicateCandidate]:
    """Every file that has a current signature, as a seed candidate."""
    for row in index._scan_signatures(kind, roles):  # noqa: SLF001 - same package boundary
        from app.services.catalog import _to_record

        yield DuplicateCandidate(
            record=_to_record(row),
            role=str(row["role"]),  # type: ignore[arg-type]
            signature=str(row["value"]),
        )
