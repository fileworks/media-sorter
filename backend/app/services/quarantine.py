"""Managed quarantine: where originals go instead of where deletions go.

Quarantine is the reason optimization and deduplication are safe to run at all.
A file that leaves its place is recorded here with everything needed to put it
back — original path, identity, hash, why it moved, what replaced it, and which
operation did it — and nothing in normal execution ever removes it.

The records are an append-only JSON Lines file. A crash mid-write costs the last
line, never the ones before it, and a damaged line is reported and skipped
rather than making the whole store unreadable.
"""

from __future__ import annotations

import json
import os
import shutil
import uuid
from collections.abc import Callable, Iterator, Sequence
from dataclasses import asdict, dataclass, field, replace
from datetime import datetime
from pathlib import Path
from typing import Literal

from app.core.integrity import utc_now
from app.core.logging_config import get_logger
from app.services.verified_transfer import stream_sha256, transfer_path

logger = get_logger(__name__)

RECORDS_FILE = "records.jsonl"
QUARANTINE_DIRECTORY_NAME = "quarantine"

QuarantineReason = Literal[
    "duplicate",
    "optimization_original",
    "replaced",
    "junk",
    "unknown_date",
    "corrupt",
    "user_request",
]
RetentionState = Literal["retained", "restored", "removed"]


class QuarantineError(RuntimeError):
    """A quarantine operation could not be completed safely."""


@dataclass(frozen=True)
class QuarantineRecord:
    """One original, where it came from, and how to get it back."""

    record_id: str
    operation_id: str
    reason: QuarantineReason
    original_path: str
    quarantine_path: str
    sha256: str
    size_bytes: int
    quarantined_at: str
    #: The file that took this one's place, when there is one. This is what
    #: makes a restore a decision rather than a guess.
    keeper_path: str | None = None
    root_id: str | None = None
    retention: RetentionState = "retained"
    restored_to: str | None = None
    restored_at: str | None = None
    notes: tuple[str, ...] = field(default_factory=tuple)

    @property
    def age_days(self) -> float:
        try:
            recorded = datetime.fromisoformat(self.quarantined_at)
        except ValueError:  # pragma: no cover - defensive
            return 0.0
        return max((utc_now() - recorded).total_seconds() / 86_400, 0.0)


@dataclass(frozen=True)
class RestorePreview:
    """What restoring one record would do, before anything is touched."""

    record: QuarantineRecord
    target_path: Path
    conflict: bool
    conflict_is_identical: bool
    quarantined_file_present: bool
    hash_matches: bool | None
    blocked_reason: str | None = None

    @property
    def restorable(self) -> bool:
        return self.blocked_reason is None


class QuarantineStore:
    """Append-only record store beside the media it protects."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.records_path = root / RECORDS_FILE

    # -------------------------------------------------------------- #
    # Reading                                                          #
    # -------------------------------------------------------------- #

    def records(self) -> tuple[QuarantineRecord, ...]:
        return tuple(self._iter_records())

    def find(self, record_id: str) -> QuarantineRecord | None:
        latest: QuarantineRecord | None = None
        for record in self._iter_records():
            if record.record_id == record_id:
                latest = record
        return latest

    def _iter_records(self) -> Iterator[QuarantineRecord]:
        """Yield the newest state of every record, skipping damaged lines."""
        if not self.records_path.is_file():
            return
        latest: dict[str, QuarantineRecord] = {}
        order: list[str] = []
        damaged = 0
        try:
            with self.records_path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        payload = json.loads(line)
                        record = QuarantineRecord(**{**payload, "notes": tuple(payload["notes"])})
                    except (json.JSONDecodeError, KeyError, TypeError):
                        damaged += 1
                        continue
                    if record.record_id not in latest:
                        order.append(record.record_id)
                    latest[record.record_id] = record
        except OSError as exc:
            logger.warning("Quarantine records unreadable", error=str(exc))
            return
        if damaged:
            logger.warning("Skipped damaged quarantine records", count=damaged)
        for record_id in order:
            yield latest[record_id]

    # -------------------------------------------------------------- #
    # Writing                                                          #
    # -------------------------------------------------------------- #

    def _append(self, record: QuarantineRecord) -> QuarantineRecord:
        self.root.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(asdict(record), ensure_ascii=False)
        try:
            with self.records_path.open("a", encoding="utf-8") as handle:
                handle.write(payload + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        except OSError as exc:
            raise QuarantineError(f"Could not record quarantine entry: {exc}") from exc
        return record

    def quarantine(
        self,
        source: Path,
        *,
        operation_id: str,
        reason: QuarantineReason,
        keeper_path: Path | None = None,
        root_id: str | None = None,
        move: bool = True,
        known_sha256: str | None = None,
        notes: tuple[str, ...] = (),
    ) -> QuarantineRecord:
        """Move (or copy) one file into quarantine and record how to undo it.

        The record is written *after* the transfer verified the destination, so
        a record always describes a file that exists — never a promise.
        """
        destination = self._destination_for(source, reason)
        result = transfer_path(source, destination, move=move)
        # A same-volume move is published by linking rather than copying, so it
        # may carry identity evidence instead of a hash. The record needs a real
        # digest either way — it is what a later restore is checked against.
        sha256 = known_sha256 or (
            result.integrity.observed_source_sha256 if result.integrity else None
        )
        if not sha256:
            sha256 = stream_sha256(result.destination_path)[0]
        record = QuarantineRecord(
            record_id=f"qtn_{uuid.uuid4().hex[:16]}",
            operation_id=operation_id,
            reason=reason,
            original_path=str(source),
            quarantine_path=str(result.destination_path),
            sha256=sha256,
            size_bytes=result.observed_metadata.size_bytes,
            quarantined_at=utc_now().isoformat(),
            keeper_path=None if keeper_path is None else str(keeper_path),
            root_id=root_id,
            notes=notes,
        )
        return self._append(record)

    def _destination_for(self, source: Path, reason: QuarantineReason) -> Path:
        """A stable, collision-free location grouped by why the file is here."""
        directory = self.root / reason
        candidate = directory / source.name
        if not candidate.exists():
            return candidate
        stem, suffix = source.stem, source.suffix
        for attempt in range(1, 1000):
            candidate = directory / f"{stem}_{attempt}{suffix}"
            if not candidate.exists():
                return candidate
        return directory / f"{stem}_{uuid.uuid4().hex[:8]}{suffix}"

    # -------------------------------------------------------------- #
    # Restore                                                          #
    # -------------------------------------------------------------- #

    def preview_restore(
        self,
        record: QuarantineRecord,
        *,
        target: Path | None = None,
    ) -> RestorePreview:
        """Describe a restore without performing any part of it."""
        quarantined = Path(record.quarantine_path)
        destination = target or Path(record.original_path)
        present = quarantined.is_file()
        hash_matches: bool | None = None
        if present and record.sha256:
            hash_matches = stream_sha256(quarantined)[0] == record.sha256

        blocked: str | None = None
        if not present:
            blocked = "the quarantined file is no longer present"
        elif hash_matches is False:
            blocked = "the quarantined file no longer matches its recorded hash"
        elif record.retention == "restored":
            blocked = "this record was already restored"

        conflict = destination.exists()
        conflict_identical = False
        if conflict and present and blocked is None and destination.is_file():
            conflict_identical = stream_sha256(destination)[0] == record.sha256
        return RestorePreview(
            record=record,
            target_path=destination,
            conflict=conflict,
            conflict_is_identical=conflict_identical,
            quarantined_file_present=present,
            hash_matches=hash_matches,
            blocked_reason=blocked,
        )

    def restore(
        self,
        record: QuarantineRecord,
        *,
        target: Path | None = None,
        on_conflict: Literal["block", "alternate_path", "skip"] = "block",
    ) -> QuarantineRecord:
        """Put one quarantined original back, verifying it on the way.

        A conflict at the original path is never resolved by overwriting: the
        caller either picks an alternate path or skips, because the file already
        sitting there is somebody's data too.
        """
        preview = self.preview_restore(record, target=target)
        if preview.blocked_reason is not None:
            raise QuarantineError(preview.blocked_reason)

        destination = preview.target_path
        if preview.conflict:
            if preview.conflict_is_identical:
                return self._mark_restored(record, destination, note="target already identical")
            if on_conflict == "skip":
                return record
            if on_conflict == "block":
                raise QuarantineError(f"{destination} already holds different content")
            destination = self._alternate(destination)

        transfer_path(Path(record.quarantine_path), destination, move=True)
        return self._mark_restored(record, destination)

    def _mark_restored(
        self,
        record: QuarantineRecord,
        destination: Path,
        *,
        note: str | None = None,
    ) -> QuarantineRecord:
        updated = replace(
            record,
            retention="restored",
            restored_to=str(destination),
            restored_at=utc_now().isoformat(),
            notes=record.notes + ((note,) if note else ()),
        )
        return self._append(updated)

    @staticmethod
    def _alternate(destination: Path) -> Path:
        for attempt in range(1, 1000):
            candidate = destination.with_name(
                f"{destination.stem}_restored_{attempt}{destination.suffix}"
            )
            if not candidate.exists():
                return candidate
        return destination.with_name(
            f"{destination.stem}_restored_{uuid.uuid4().hex[:8]}{destination.suffix}"
        )

    # -------------------------------------------------------------- #
    # Reporting                                                        #
    # -------------------------------------------------------------- #

    def summary(self) -> dict[str, object]:
        """Counts and bytes the quarantine manager renders, without paths."""
        records = self.records()
        retained = [record for record in records if record.retention == "retained"]
        by_reason: dict[str, int] = {}
        for record in retained:
            by_reason[record.reason] = by_reason.get(record.reason, 0) + 1
        return {
            "record_count": len(records),
            "retained_count": len(retained),
            "restored_count": sum(1 for r in records if r.retention == "restored"),
            "retained_bytes": sum(record.size_bytes for record in retained),
            "oldest_age_days": max((record.age_days for record in retained), default=0.0),
            "by_reason": by_reason,
        }


def store_for_state_root(state_root: Path) -> QuarantineStore:
    return QuarantineStore(state_root / QUARANTINE_DIRECTORY_NAME)


# --------------------------------------------------------------------------- #
# Execution preflight                                                          #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class PreflightResult:
    """What must be true before any planned action touches the filesystem."""

    ready: bool
    blocked_reasons: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    required_bytes: int = 0
    available_bytes: int = 0
    quarantine_available: bool = True

    @property
    def headline(self) -> str:
        if self.ready:
            return "Ready to run"
        return self.blocked_reasons[0] if self.blocked_reasons else "Not ready"


#: Free space is required with a margin, because a destination that fills
#: exactly at the last file leaves no room for the staging copy that verifies it.
FREE_SPACE_MARGIN = 1.25


def preflight(
    *,
    quarantine_bytes: int,
    destination_bytes: int = 0,
    destination: Path | None = None,
    quarantine_root: Path | None = None,
    plan_is_fresh: bool = True,
    conflicts: Sequence[str] = (),
) -> PreflightResult:
    """Check freshness, permissions, conflicts, and space before executing.

    Conservative on purpose: the required figure includes a margin and counts
    the quarantine copy, because "it fit exactly" is how a run ends half-done.
    """
    blocked: list[str] = []
    warnings: list[str] = []

    if not plan_is_fresh:
        blocked.append("the plan changed since it was reviewed; review the affected groups again")
    for conflict in conflicts:
        blocked.append(conflict)

    required = int((quarantine_bytes + destination_bytes) * FREE_SPACE_MARGIN)
    available = 0
    target = destination or quarantine_root
    if target is not None:
        try:
            target.mkdir(parents=True, exist_ok=True)
            available = shutil.disk_usage(target).free
        except OSError as exc:
            blocked.append(f"the destination could not be prepared: {exc}")
        else:
            if available < required:
                blocked.append(
                    f"not enough free space: {required:,} bytes needed, {available:,} available"
                )

    quarantine_ready = True
    if quarantine_root is not None:
        try:
            quarantine_root.mkdir(parents=True, exist_ok=True)
            probe = quarantine_root / ".mediasort-write-test"
            probe.write_bytes(b"")
            probe.unlink()
        except OSError as exc:
            quarantine_ready = False
            blocked.append(f"quarantine is not writable: {exc}")

    if quarantine_bytes and not warnings:
        warnings.append(
            "Quarantined originals keep using disk space; nothing is deleted by this run."
        )

    return PreflightResult(
        ready=not blocked,
        blocked_reasons=tuple(blocked),
        warnings=tuple(warnings),
        required_bytes=required,
        available_bytes=available,
        quarantine_available=quarantine_ready,
    )


# --------------------------------------------------------------------------- #
# Permanent removal — a separate task, never part of ordinary execution        #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class CleanupImpact:
    """A frozen preview of what permanent removal would destroy."""

    record_ids: tuple[str, ...]
    item_count: int
    total_bytes: int
    excluded_references: int = 0
    excluded_reasons: tuple[str, ...] = ()

    @property
    def acknowledgement_text(self) -> str:
        return (
            f"Permanently delete {self.item_count} quarantined file(s), "
            f"{self.total_bytes:,} bytes. This cannot be undone."
        )


@dataclass(frozen=True)
class CleanupOutcome:
    """The terminal report of a cleanup task."""

    removed: tuple[str, ...] = ()
    failed: tuple[tuple[str, str], ...] = ()
    cancelled: bool = False
    bytes_removed: int = 0

    @property
    def code(self) -> str:
        if self.cancelled:
            return "cancelled"
        if self.failed and self.removed:
            return "partial"
        if self.failed:
            return "failed"
        return "completed"


class CleanupRefused(QuarantineError):
    """A permanent removal was attempted without meeting its conditions."""


def preview_cleanup(
    store: QuarantineStore,
    record_ids: Sequence[str],
) -> CleanupImpact:
    """Freeze exactly what would be destroyed, before anything is asked."""
    wanted = set(record_ids)
    selected = [record for record in store.records() if record.record_id in wanted]
    eligible = [record for record in selected if record.retention == "retained"]
    skipped = [
        f"{record.record_id}: already {record.retention}"
        for record in selected
        if record.retention != "retained"
    ]
    return CleanupImpact(
        record_ids=tuple(record.record_id for record in eligible),
        item_count=len(eligible),
        total_bytes=sum(record.size_bytes for record in eligible),
        excluded_reasons=tuple(skipped),
    )


def permanently_remove(
    store: QuarantineStore,
    impact: CleanupImpact,
    *,
    acknowledged: bool,
    cancel: Callable[[], bool] | None = None,
) -> CleanupOutcome:
    """Delete quarantined files for good — the only path that ever does.

    It is deliberately separate from duplicate execution, it works from a frozen
    impact preview, and it refuses without an explicit acknowledgement, because
    this is the one action in the application that cannot be undone.
    """
    if not acknowledged:
        raise CleanupRefused(
            "Permanent removal needs an explicit acknowledgement; nothing was deleted."
        )
    removed: list[str] = []
    failed: list[tuple[str, str]] = []
    bytes_removed = 0

    for record_id in impact.record_ids:
        if cancel is not None and cancel():
            return CleanupOutcome(
                removed=tuple(removed),
                failed=tuple(failed),
                cancelled=True,
                bytes_removed=bytes_removed,
            )
        record = store.find(record_id)
        if record is None or record.retention != "retained":
            failed.append((record_id, "no longer eligible"))
            continue
        try:
            Path(record.quarantine_path).unlink(missing_ok=True)
        except OSError as exc:
            failed.append((record_id, f"{type(exc).__name__}: {exc}"))
            continue
        store._append(  # noqa: SLF001 - the store owns its own journal format
            replace(
                record,
                retention="removed",
                notes=record.notes + ("permanently removed",),
            )
        )
        removed.append(record_id)
        bytes_removed += record.size_bytes

    return CleanupOutcome(
        removed=tuple(removed),
        failed=tuple(failed),
        bytes_removed=bytes_removed,
    )
