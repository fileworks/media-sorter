"""Duplicate lookup that lives on disk instead of in the process.

An in-memory registry is fine until the destination has two million files, at
which point it is the reason the app dies. Everything here answers the same
questions from the persistent catalog, in bounded pages, using indexes.

The perceptual side uses the pigeonhole principle rather than a heuristic: two
signatures within Hamming distance *d* must agree exactly on at least one of
*k* bands whenever *k > d*, so querying the bands finds every true match. When a
threshold is loose enough to break that guarantee, the query says so — it
reports degraded selectivity and scans, instead of quietly missing pairs.
"""

from __future__ import annotations

import sqlite3
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

from app.core.logging_config import get_logger
from app.services.catalog import FileRecord, MediaCatalog, _to_record

if TYPE_CHECKING:
    from app.services.duplicate_service import DuplicateRegistry

logger = get_logger(__name__)

RootRole = Literal["input", "reference", "destination"]

#: Bands the signature is split into. Four bands make exact-band lookup exact
#: for distances up to three, which covers every threshold the UI offers.
SIGNATURE_BANDS = 4

DEFAULT_PAGE_SIZE = 500

#: Indexes the duplicate queries need. Created on first use rather than in the
#: base schema so an existing catalog gains them without a migration step.
_BAND_INDEXES = tuple(
    f"CREATE INDEX IF NOT EXISTS idx_signatures_band{band} "
    f"ON signatures(kind, substr(value, {band * 4 + 1}, 4))"
    for band in range(SIGNATURE_BANDS)
)


@dataclass(frozen=True)
class DuplicateCandidate:
    """One catalogued file offered as a possible match, with its evidence."""

    record: FileRecord
    role: RootRole
    sha256: str | None = None
    signature: str | None = None
    distance: int | None = None

    @property
    def is_reference(self) -> bool:
        return self.role == "reference"


@dataclass
class LookupTelemetry:
    """What the query had to do, so a slow library can explain itself."""

    buckets_queried: int = 0
    candidates_examined: int = 0
    candidates_returned: int = 0
    degraded: bool = False
    degraded_reason: str | None = None
    notes: list[str] = field(default_factory=list)


class CatalogDuplicateIndex:
    """Exact and perceptual lookup over the persistent catalog."""

    def __init__(self, catalog: MediaCatalog, *, page_size: int = DEFAULT_PAGE_SIZE) -> None:
        self.catalog = catalog
        self.page_size = page_size
        self._ensure_indexes()

    def _ensure_indexes(self) -> None:
        with self.catalog.transaction() as connection:
            for statement in _BAND_INDEXES:
                connection.execute(statement)
            connection.execute(
                "CREATE INDEX IF NOT EXISTS idx_signatures_kind ON signatures(kind, file_id)"
            )

    # ------------------------------------------------------------------ #
    # Exact                                                               #
    # ------------------------------------------------------------------ #

    def exact_matches(
        self,
        sha256: str,
        *,
        roles: Sequence[RootRole] = ("destination", "reference"),
        limit: int | None = None,
    ) -> list[DuplicateCandidate]:
        """Every present file with this content, in the roles asked for.

        The hash is compared against the fingerprint it was computed from, so a
        file that changed since it was hashed simply does not match — a stale
        row can never make two different files look identical.
        """
        placeholders = ",".join("?" for _ in roles) or "''"
        rows = self.catalog._connection.execute(  # noqa: SLF001 - same package boundary
            f"""
            SELECT f.*, r.role, h.sha256
              FROM files f
              JOIN file_hashes h ON h.file_id = f.file_id
              JOIN roots r ON r.root_id = f.root_id
             WHERE h.sha256 = ?
               AND h.fingerprint = f.fingerprint
               AND f.missing_since_generation IS NULL
               AND (f.unit_id IS NULL OR f.unit_primary = 1)
               AND r.role IN ({placeholders})
             ORDER BY f.file_id
             LIMIT ?
            """,
            (sha256, *roles, limit or self.page_size),
        ).fetchall()
        return [_candidate(row) for row in rows]

    def has_exact_match(self, sha256: str, *, roles: Sequence[RootRole] = ("destination",)) -> bool:
        return bool(self.exact_matches(sha256, roles=roles, limit=1))

    def iter_exact_groups(
        self,
        *,
        roles: Sequence[RootRole] = ("input", "destination", "reference"),
        minimum_size: int = 2,
    ) -> Iterator[tuple[str, list[DuplicateCandidate]]]:
        """Walk content-identical groups without materializing the library.

        Groups are produced one at a time by an indexed scan of the hash table;
        only the members of the current group are ever resident.
        """
        placeholders = ",".join("?" for _ in roles) or "''"
        cursor = self.catalog._connection.execute(  # noqa: SLF001
            f"""
            SELECT f.*, r.role, h.sha256
              FROM file_hashes h
              JOIN files f ON f.file_id = h.file_id
              JOIN roots r ON r.root_id = f.root_id
             WHERE h.fingerprint = f.fingerprint
               AND f.missing_since_generation IS NULL
               AND (f.unit_id IS NULL OR f.unit_primary = 1)
               AND r.role IN ({placeholders})
             ORDER BY h.sha256, f.file_id
            """,
            tuple(roles),
        )
        current_hash: str | None = None
        members: list[DuplicateCandidate] = []
        for row in cursor:
            row_hash = str(row["sha256"])
            if row_hash != current_hash:
                if current_hash is not None and len(members) >= minimum_size:
                    yield current_hash, members
                current_hash, members = row_hash, []
            members.append(_candidate(row))
        if current_hash is not None and len(members) >= minimum_size:
            yield current_hash, members

    # ------------------------------------------------------------------ #
    # Perceptual                                                          #
    # ------------------------------------------------------------------ #

    def perceptual_candidates(
        self,
        signature: str,
        *,
        max_distance: int,
        kind: str = "phash",
        roles: Sequence[RootRole] = ("destination", "reference"),
        limit: int | None = None,
        telemetry: LookupTelemetry | None = None,
    ) -> list[DuplicateCandidate]:
        """Signatures within *max_distance*, found by band lookup where possible.

        Every returned candidate has had its full distance recomputed, so the
        band query only ever decides what to *examine* — never what matches.
        """
        telemetry = telemetry or LookupTelemetry()
        limit = limit or self.page_size
        bands = _bands(signature)
        if len(bands) != SIGNATURE_BANDS or max_distance >= SIGNATURE_BANDS:
            # Beyond this the pigeonhole guarantee no longer holds, so the only
            # honest options are a full scan or a wrong answer.
            telemetry.degraded = True
            telemetry.degraded_reason = (
                "threshold too loose for band lookup; every signature was examined"
            )
            rows = self._scan_signatures(kind, roles)
        else:
            telemetry.buckets_queried = SIGNATURE_BANDS
            rows = self._band_rows(bands, kind, roles)

        results: list[DuplicateCandidate] = []
        seen: set[int] = set()
        for row in rows:
            telemetry.candidates_examined += 1
            candidate_signature = str(row["value"])
            distance = hamming(signature, candidate_signature)
            if distance is None or distance > max_distance:
                continue
            record = _to_record(row)
            if record.file_id in seen:
                continue
            seen.add(record.file_id)
            results.append(
                DuplicateCandidate(
                    record=record,
                    role=str(row["role"]),  # type: ignore[arg-type]
                    signature=candidate_signature,
                    distance=distance,
                )
            )
            if len(results) >= limit:
                telemetry.notes.append("result page was filled before the scan finished")
                break
        results.sort(key=lambda item: (item.distance or 0, item.record.file_id))
        telemetry.candidates_returned = len(results)
        return results

    def _band_rows(
        self,
        bands: Sequence[str],
        kind: str,
        roles: Sequence[RootRole],
    ) -> list[sqlite3.Row]:
        placeholders = ",".join("?" for _ in roles) or "''"
        rows: list[sqlite3.Row] = []
        for index, band in enumerate(bands):
            rows.extend(
                self.catalog._connection.execute(  # noqa: SLF001
                    f"""
                    SELECT f.*, r.role, s.value
                      FROM signatures s
                      JOIN files f ON f.file_id = s.file_id
                      JOIN roots r ON r.root_id = f.root_id
                     WHERE s.kind = ?
                       AND substr(s.value, {index * 4 + 1}, 4) = ?
                       AND s.fingerprint = f.fingerprint
                       AND f.missing_since_generation IS NULL
                       AND (f.unit_id IS NULL OR f.unit_primary = 1)
                       AND r.role IN ({placeholders})
                    """,
                    (kind, band, *roles),
                ).fetchall()
            )
        return rows

    def _scan_signatures(self, kind: str, roles: Sequence[RootRole]) -> list[sqlite3.Row]:
        placeholders = ",".join("?" for _ in roles) or "''"
        return self.catalog._connection.execute(  # noqa: SLF001
            f"""
            SELECT f.*, r.role, s.value
              FROM signatures s
              JOIN files f ON f.file_id = s.file_id
              JOIN roots r ON r.root_id = f.root_id
             WHERE s.kind = ?
               AND s.fingerprint = f.fingerprint
               AND f.missing_since_generation IS NULL
               AND (f.unit_id IS NULL OR f.unit_primary = 1)
               AND r.role IN ({placeholders})
             ORDER BY f.file_id
            """,
            (kind, *roles),
        ).fetchall()


# ---------------------------------------------------------------------- #
# Helpers                                                                 #
# ---------------------------------------------------------------------- #


def _candidate(row: sqlite3.Row) -> DuplicateCandidate:
    keys = row.keys()
    return DuplicateCandidate(
        record=_to_record(row),
        role=str(row["role"]),  # type: ignore[arg-type]
        sha256=str(row["sha256"]) if "sha256" in keys else None,
    )


def _bands(signature: str) -> tuple[str, ...]:
    """Split a 16-character signature into four 4-character bands."""
    if len(signature) != SIGNATURE_BANDS * 4:
        return ()
    return tuple(signature[index * 4 : index * 4 + 4] for index in range(SIGNATURE_BANDS))


def hamming(left: str, right: str) -> int | None:
    """Bit distance between two hex signatures, or ``None`` if incomparable."""
    if len(left) != len(right):
        return None
    try:
        return bin(int(left, 16) ^ int(right, 16)).count("1")
    except ValueError:
        return None


def catalog_backed_registry(
    index: CatalogDuplicateIndex,
    *,
    roles: Sequence[RootRole] = ("destination", "reference"),
) -> DuplicateRegistry:
    """A destination registry that answers from disk instead of from memory.

    The returned registry is API-compatible with the materialized one, so the
    duplicate service does not know or care which it was handed — but this one
    never loads a two-million-row index into the process to answer one question.
    """
    from app.services.duplicate_service import DuplicateRegistry

    def lookup(sha256: str) -> str | None:
        matches = index.exact_matches(sha256, roles=roles, limit=1)
        if not matches:
            return None
        record = matches[0].record
        return f"{record.root_id}/{record.relative_path}"

    return DuplicateRegistry(exact_lookup=lookup)
