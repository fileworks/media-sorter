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
from dataclasses import dataclass
from datetime import datetime
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
    hamming,
)

logger = get_logger(__name__)

EXACT_RULE_VERSION = "exact-1"
SIMILAR_RULE_VERSION = "similar-1"
BURST_RULE_VERSION = "burst-1"

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


def burst_groups(
    catalog: MediaCatalog,
    index: CatalogDuplicateIndex,
    *,
    time_window_seconds: float,
    max_perceptual_distance: int,
    require_camera_identity: bool = True,
    kind: str = "phash",
    roles: Sequence[RootRole] = ("input", "destination", "reference"),
    generation: int = 0,
    limit: int | None = None,
) -> Iterator[DuplicateGroup]:
    """Yield burst groups as stacks, in the same shape as exact and similar.

    A burst is a run of frames taken within seconds of each other, by the same
    camera, that look alike. It is the same *thing* as a duplicate stack — a set
    of near-copies with one to keep — so it is served as a third ``kind`` rather
    than through a second set of endpoints with their own decision vocabulary.

    Mirrors ``BurstDetectionService.detect``: the chain grows while consecutive
    frames stay inside the window, keep the camera, and stay within the
    perceptual distance. Reading it from the catalog rather than from the
    filesystem is what lets Review page it alongside the other two kinds.
    """
    candidates = sorted(
        _burst_candidates(catalog, index, kind, roles, require_camera_identity),
        key=lambda item: (item.captured_at, item.candidate.record.relative_path),
    )

    for produced, run in enumerate(
        _burst_runs(
            candidates,
            catalog=catalog,
            time_window_seconds=time_window_seconds,
            max_perceptual_distance=max_perceptual_distance,
            require_camera_identity=require_camera_identity,
        ),
        start=1,
    ):
        anchor = run[0]
        members = tuple(
            _member(
                catalog,
                item.candidate,
                MemberEvidence(
                    algorithm=kind,
                    algorithm_version=BURST_RULE_VERSION,
                    signature=item.candidate.signature,
                    distance=item.distance,
                    threshold=max_perceptual_distance,
                    # A burst frame is a deliberate near-copy, never a
                    # byte-identical one; claiming "high" would overstate what
                    # three agreeing signals actually prove.
                    confidence="medium",
                ),
            )
            for item in run
        )
        anchor_id = member_id(anchor.candidate.record)
        yield DuplicateGroup(
            group_id=group_id_for("burst", anchor_id),
            kind="burst",
            catalog_generation=generation,
            rule_version=BURST_RULE_VERSION,
            member_count=len(members),
            total_bytes=sum(item.facts.size_bytes for item in members),
            anchor_member_id=anchor_id,
            members=members,
            evidence_summary=(
                f"{len(members)} frames within {time_window_seconds:g}s"
                f"{f' from {anchor.camera}' if anchor.camera else ''}"
            ),
        )
        if limit is not None and produced >= limit:
            return


@dataclass(frozen=True)
class _BurstCandidate:
    candidate: DuplicateCandidate
    captured_at: datetime
    camera: str
    distance: int | None = None


def _burst_candidates(
    catalog: MediaCatalog,
    index: CatalogDuplicateIndex,
    kind: str,
    roles: Sequence[RootRole],
    require_camera_identity: bool,
) -> Iterator[_BurstCandidate]:
    """Signature-bearing files that also have the capture time a burst needs."""
    for candidate in _signature_records(catalog, index, kind, roles):
        facts = catalog.media_facts_for(candidate.record)
        if facts is None:
            continue
        captured = _parse_captured_at(facts.get("captured_at"))
        camera = str(facts.get("camera_model") or "")
        if captured is None:
            continue
        if require_camera_identity and not camera:
            continue
        yield _BurstCandidate(candidate=candidate, captured_at=captured, camera=camera)


def _parse_captured_at(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _burst_runs(
    candidates: Sequence[_BurstCandidate],
    *,
    catalog: MediaCatalog,
    time_window_seconds: float,
    max_perceptual_distance: int,
    require_camera_identity: bool,
) -> Iterator[list[_BurstCandidate]]:
    """Split the ordered candidates into runs of two or more agreeing frames."""
    current: list[_BurstCandidate] = []
    for candidate in candidates:
        if not current:
            current = [candidate]
            continue
        previous = current[-1]
        seconds = (candidate.captured_at - previous.captured_at).total_seconds()
        camera_agrees = candidate.camera == previous.camera or (
            not require_camera_identity and not candidate.camera
        )
        distance = hamming(previous.candidate.signature or "", candidate.candidate.signature or "")
        identical = _byte_identical(catalog, previous.candidate, candidate.candidate)
        if (
            seconds < 0
            or seconds > time_window_seconds
            or not camera_agrees
            or distance is None
            or distance > max_perceptual_distance
            # Byte-identical frames are an exact group's business, where the
            # evidence is stronger; a burst claiming them would double-count.
            or identical
        ):
            if len(current) > 1:
                yield current
            current = [candidate]
            continue
        current.append(
            _BurstCandidate(candidate.candidate, candidate.captured_at, candidate.camera, distance)
        )
    if len(current) > 1:
        yield current


def _byte_identical(
    catalog: MediaCatalog,
    left: DuplicateCandidate,
    right: DuplicateCandidate,
) -> bool:
    left_hash = catalog.hash_for(left.record)
    right_hash = catalog.hash_for(right.record)
    return left_hash is not None and left_hash == right_hash


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
