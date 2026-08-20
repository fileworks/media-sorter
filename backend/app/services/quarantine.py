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
INTENTS_FILE = "intents.jsonl"
REMOVALS_FILE = "removals.jsonl"
QUARANTINE_DIRECTORY_NAME = "quarantine"
#: Private, inside the store, so a tombstoned object is out of the browsable
#: tree but still on the same filesystem — the move is a rename, not a copy.
TOMBSTONE_DIRECTORY_NAME = ".tombstone"

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
#: An intent is *declared* before the file moves and *committed* after the
#: record exists. Anything still ``pending`` after a crash is an original whose
#: fate is unknown — reported as pending, never as removed.
IntentState = Literal["pending", "committed", "abandoned"]


class QuarantineError(RuntimeError):
    """A quarantine operation could not be completed safely."""


@dataclass(frozen=True)
class RemovalIntent:
    """A durable "I am about to destroy this" note, and how far it got.

    Permanent removal is the one action in the product that cannot be undone,
    and it used to be a bare `unlink(missing_ok=True)`: no hash check, no
    identity check, and an absent path counted as a successful deletion. A crash
    between the unlink and the record append left the record claiming
    ``retained`` for a file that no longer existed.

    The states are the protocol. ``pending`` means the object may be in the
    tombstone and its fate is open; ``committed`` means the verified object was
    unlinked and the record says so; ``abandoned`` means nothing was destroyed.
    Recovery reports the first as pending and the last as retained — never as
    removed.
    """

    intent_id: str
    record_id: str
    operation: str
    original_quarantine_path: str
    tombstone_path: str
    expected_sha256: str
    declared_at: str
    state: IntentState = "pending"
    abandoned_reason: str | None = None


@dataclass(frozen=True)
class QuarantineIntent:
    """A durable "I am about to move this original" note.

    `quarantine()` transfers the file and *then* appends its record. That order
    is right — a record must never describe a file that does not exist — but it
    leaves a window: a crash between the transfer and the append puts a file in
    the store that no record mentions. Recovery could not tell that from a file
    that was never touched.

    The intent closes the window from the other side. It is written and fsynced
    *before* the transfer, so every original that might have moved is named on
    disk beforehand. After the record lands the intent is committed; if the
    transfer fails it is abandoned. A ``pending`` intent found at startup is
    exactly the crash window, and `pending_intents()` reports it.
    """

    intent_id: str
    operation_id: str
    reason: QuarantineReason
    original_path: str
    declared_at: str
    state: IntentState = "pending"
    expected_sha256: str | None = None
    keeper_path: str | None = None
    #: Set when the intent is committed, so an auditor can walk intent → record.
    record_id: str | None = None
    #: Set when the intent is abandoned, so "nothing happened" is also evidence.
    abandoned_reason: str | None = None


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
        self.intents_path = root / INTENTS_FILE
        self.removals_path = root / REMOVALS_FILE
        self.tombstone_root = root / TOMBSTONE_DIRECTORY_NAME

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

    # -------------------------------------------------------------- #
    # Durable intent: declared before the move, resolved after it       #
    # -------------------------------------------------------------- #

    def declare_intent(
        self,
        source: Path,
        *,
        operation_id: str,
        reason: QuarantineReason,
        expected_sha256: str | None = None,
        keeper_path: Path | None = None,
    ) -> QuarantineIntent:
        """Record, durably, that *source* is about to be quarantined.

        Returns only after the note is on disk and fsynced. A caller that moves
        the file before this returns has reopened the very window this closes.
        """
        intent = QuarantineIntent(
            intent_id=f"qti_{uuid.uuid4().hex[:16]}",
            operation_id=operation_id,
            reason=reason,
            original_path=str(source),
            declared_at=utc_now().isoformat(),
            expected_sha256=expected_sha256,
            keeper_path=None if keeper_path is None else str(keeper_path),
        )
        return self._append_intent(intent)

    def commit_intent(self, intent: QuarantineIntent, record: QuarantineRecord) -> QuarantineIntent:
        """Resolve an intent against the record that fulfilled it."""
        return self._append_intent(replace(intent, state="committed", record_id=record.record_id))

    def abandon_intent(self, intent: QuarantineIntent, reason: str) -> QuarantineIntent:
        """Resolve an intent that never happened, so silence is not the record."""
        return self._append_intent(replace(intent, state="abandoned", abandoned_reason=reason))

    def intents(self) -> tuple[QuarantineIntent, ...]:
        return tuple(self._iter_intents())

    def pending_intents(self) -> tuple[QuarantineIntent, ...]:
        """Originals whose fate a crash left unknown.

        An intent is pending when its latest state says so *and* no record
        claims it. Both halves matter: a committed intent whose record line was
        lost to a torn write is still unresolved, and must not read as done.
        """
        claimed = {record.record_id for record in self._iter_records()}
        return tuple(
            intent
            for intent in self._iter_intents()
            if intent.state == "pending"
            or (intent.state == "committed" and intent.record_id not in claimed)
        )

    # -------------------------------------------------------------- #
    # Durable removal intent: the tombstone protocol                    #
    # -------------------------------------------------------------- #

    def declare_removal(self, record: QuarantineRecord, *, operation: str) -> RemovalIntent:
        """Name the object about to be destroyed, durably, before touching it."""
        intent = RemovalIntent(
            intent_id=f"rmi_{uuid.uuid4().hex[:16]}",
            record_id=record.record_id,
            operation=operation,
            original_quarantine_path=record.quarantine_path,
            tombstone_path=str(self.tombstone_root / f"{record.record_id}"),
            expected_sha256=record.sha256,
            declared_at=utc_now().isoformat(),
        )
        return self._append_removal(intent)

    def commit_removal(self, intent: RemovalIntent) -> RemovalIntent:
        return self._append_removal(replace(intent, state="committed"))

    def abandon_removal(self, intent: RemovalIntent, reason: str) -> RemovalIntent:
        return self._append_removal(replace(intent, state="abandoned", abandoned_reason=reason))

    def removals(self) -> tuple[RemovalIntent, ...]:
        return tuple(self._iter_removals())

    def pending_removals(self) -> tuple[RemovalIntent, ...]:
        """Objects a crash left mid-destruction. Never reported as removed."""
        return tuple(intent for intent in self._iter_removals() if intent.state == "pending")

    def _append_removal(self, intent: RemovalIntent) -> RemovalIntent:
        self.root.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(asdict(intent), ensure_ascii=False)
        try:
            with self.removals_path.open("a", encoding="utf-8") as handle:
                handle.write(payload + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        except OSError as exc:
            raise QuarantineError(f"Could not record removal intent: {exc}") from exc
        return intent

    def _iter_removals(self) -> Iterator[RemovalIntent]:
        if not self.removals_path.is_file():
            return
        latest: dict[str, RemovalIntent] = {}
        order: list[str] = []
        damaged = 0
        try:
            with self.removals_path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        intent = RemovalIntent(**json.loads(line))
                    except (json.JSONDecodeError, KeyError, TypeError):
                        damaged += 1
                        continue
                    if intent.intent_id not in latest:
                        order.append(intent.intent_id)
                    latest[intent.intent_id] = intent
        except OSError as exc:
            raise QuarantineError(f"Could not read removal intents: {exc}") from exc
        if damaged:
            logger.warning("quarantine.damaged_removal_lines", count=damaged)
        for intent_id in order:
            yield latest[intent_id]

    def _append_intent(self, intent: QuarantineIntent) -> QuarantineIntent:
        self.root.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(asdict(intent), ensure_ascii=False)
        try:
            with self.intents_path.open("a", encoding="utf-8") as handle:
                handle.write(payload + "\n")
                handle.flush()
                os.fsync(handle.fileno())
        except OSError as exc:
            raise QuarantineError(f"Could not record quarantine intent: {exc}") from exc
        return intent

    def _iter_intents(self) -> Iterator[QuarantineIntent]:
        """Yield the newest state of every intent, skipping damaged lines."""
        if not self.intents_path.is_file():
            return
        latest: dict[str, QuarantineIntent] = {}
        order: list[str] = []
        damaged = 0
        try:
            with self.intents_path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        intent = QuarantineIntent(**json.loads(line))
                    except (json.JSONDecodeError, KeyError, TypeError):
                        damaged += 1
                        continue
                    if intent.intent_id not in latest:
                        order.append(intent.intent_id)
                    latest[intent.intent_id] = intent
        except OSError as exc:
            raise QuarantineError(f"Could not read quarantine intents: {exc}") from exc
        if damaged:
            logger.warning("quarantine.damaged_intent_lines", count=damaged)
        for intent_id in order:
            yield latest[intent_id]

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

    def summary(
        self,
        *,
        budget_bytes: int | None = None,
        warning_age_days: int | None = None,
    ) -> dict[str, object]:
        """Counts, bytes and ages the quarantine manager renders, without paths.

        With a budget and an age threshold this also reports whether the store
        has outgrown either, and recommends a cleanup. It **never deletes**:
        quarantine is the reason optimization and deduplication are safe to run,
        and a store that prunes itself is not a safety net. The recommendation
        is the whole output — acting on it is `permanently_remove`'s job, behind
        its own acknowledgement.
        """
        records = self.records()
        retained = [record for record in records if record.retention == "retained"]
        by_reason: dict[str, int] = {}
        for record in retained:
            by_reason[record.reason] = by_reason.get(record.reason, 0) + 1
        retained_bytes = sum(record.size_bytes for record in retained)
        oldest_age_days = max((record.age_days for record in retained), default=0.0)

        result: dict[str, object] = {
            "record_count": len(records),
            "retained_count": len(retained),
            "restored_count": sum(1 for r in records if r.retention == "restored"),
            "retained_bytes": retained_bytes,
            "oldest_age_days": oldest_age_days,
            "by_reason": by_reason,
        }
        if budget_bytes is None or warning_age_days is None:
            return result

        if budget_bytes <= 0:
            raise ValueError("quarantine_budget_bytes must be a positive number of bytes")
        if warning_age_days <= 0:
            raise ValueError("quarantine_warning_age_days must be a positive number of days")

        over_budget = retained_bytes > budget_bytes
        over_age = oldest_age_days > warning_age_days
        recommendations: list[str] = []
        if over_budget:
            recommendations.append("over_budget")
        if over_age:
            recommendations.append("older_than_warning_age")

        result.update(
            {
                "budget_bytes": budget_bytes,
                "warning_age_days": warning_age_days,
                "over_budget": over_budget,
                "over_warning_age": over_age,
                # Advisory only. Nothing in this product acts on it by itself.
                "cleanup_recommended": bool(recommendations),
                "cleanup_reasons": tuple(recommendations),
            }
        )
        return result


def store_for_state_root(state_root: Path) -> QuarantineStore:
    return QuarantineStore(state_root / QUARANTINE_DIRECTORY_NAME)


# --------------------------------------------------------------------------- #
# Execution preflight                                                          #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class VolumeRequirement:
    """One filesystem volume and what this run needs from it.

    Volumes are identified by `st_dev`, not by path, because two roots that
    look unrelated are one budget when they sit on the same device — and one
    root's free space says nothing about another's when they do not.
    """

    path: Path
    required_bytes: int
    available_bytes: int

    @property
    def satisfied(self) -> bool:
        return self.available_bytes >= self.required_bytes


@dataclass(frozen=True)
class PreflightResult:
    """What must be true before any planned action touches the filesystem."""

    ready: bool
    blocked_reasons: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    required_bytes: int = 0
    available_bytes: int = 0
    quarantine_available: bool = True
    #: One entry per distinct volume this run would write to.
    volumes: tuple[VolumeRequirement, ...] = ()

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

    # Each demand is charged to the root that actually receives those bytes.
    # `quarantine_root` is the app-data store that holds conversion originals,
    # which is routinely on a different device from a NAS or external-drive
    # destination — summing both against one root would pass a run that cannot
    # finish, and checking each in isolation would double-count when they share
    # a device.
    demands: list[tuple[Path, int]] = []
    destination_target = destination or quarantine_root
    if destination_target is not None:
        demands.append((destination_target, destination_bytes))
    quarantine_target = quarantine_root or destination
    if quarantine_target is not None:
        demands.append((quarantine_target, quarantine_bytes))

    volumes, volume_errors = _volume_requirements(demands)
    blocked.extend(volume_errors)
    for volume in volumes:
        if not volume.satisfied:
            blocked.append(
                f"not enough free space on {volume.path}: "
                f"{volume.required_bytes:,} bytes needed, {volume.available_bytes:,} available"
            )
    available = min((volume.available_bytes for volume in volumes), default=0)

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
        volumes=volumes,
    )


def _device_of(path: Path) -> int:
    """The device a path lives on.

    A named seam rather than an inline `path.stat().st_dev`: a test cannot mount
    a second filesystem, and patching `pathlib.Path.stat` to fake one corrupts
    pathlib's internal caches on some interpreters. This is the one fact the
    grouping needs, so it is the one thing worth overriding.
    """
    return path.stat().st_dev


def _volume_requirements(
    demands: Sequence[tuple[Path, int]],
) -> tuple[tuple[VolumeRequirement, ...], list[str]]:
    """Group byte demands by the device that would receive them.

    Two roots on one device share its free space, so their demands add up. Two
    roots on different devices are independent budgets, and a run needs both.
    """
    errors: list[str] = []
    #: device id -> (first path seen on it, summed requirement)
    grouped: dict[int, tuple[Path, int]] = {}
    for path, wanted in demands:
        try:
            path.mkdir(parents=True, exist_ok=True)
            device = _device_of(path)
        except OSError as exc:
            errors.append(f"{path} could not be prepared: {exc}")
            continue
        existing = grouped.get(device)
        if existing is None:
            grouped[device] = (path, wanted)
        else:
            grouped[device] = (existing[0], existing[1] + wanted)

    volumes: list[VolumeRequirement] = []
    for path, wanted in grouped.values():
        required = int(wanted * FREE_SPACE_MARGIN)
        try:
            free = shutil.disk_usage(path).free
        except OSError as exc:
            errors.append(f"{path} could not be measured: {exc}")
            continue
        volumes.append(VolumeRequirement(path=path, required_bytes=required, available_bytes=free))
    return tuple(volumes), errors


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


def _destroy_one(store: QuarantineStore, record: QuarantineRecord, *, operation: str) -> str | None:
    """Destroy one verified object, or return why it was refused.

    Returns `None` on success. Every early return leaves the file exactly where
    it was: this function either destroys the object it proved, or nothing.

    The order is the guarantee:

    1. the path is a **regular file**, not a symlink and not a directory;
    2. its **content still hashes to the recorded digest** — a tampered or
       replaced file is refused, not deleted;
    3. the **intent is durable** before anything moves;
    4. the object is **renamed into a private tombstone**, which is atomic on
       the same filesystem and takes it out of the browsable tree;
    5. the tombstone is **re-identified** before the unlink, so the thing
       destroyed is the thing that was proved;
    6. the record is appended as ``removed``, and only then is the intent
       committed.

    A crash anywhere leaves a ``pending`` removal intent, which
    `pending_removals()` reports. Nothing is ever silently removed.
    """
    path = Path(record.quarantine_path)

    if path.is_symlink():
        return "refused: quarantine path is a symlink"
    if not path.exists():
        # `missing_ok=True` used to count this as a successful deletion, adding
        # its bytes to the freed total. An absent file is a discrepancy to
        # report, not a job well done.
        return "refused: quarantine path no longer exists"
    if not path.is_file():
        return "refused: quarantine path is not a regular file"

    try:
        observed_sha256, observed_size = stream_sha256(path)
    except OSError as exc:
        return f"{type(exc).__name__}: {exc}"
    if observed_sha256 != record.sha256:
        return "hash_drift"
    if observed_size != record.size_bytes:
        return "hash_drift"

    intent = store.declare_removal(record, operation=operation)
    tombstone = Path(intent.tombstone_path)
    try:
        tombstone.parent.mkdir(parents=True, exist_ok=True)
        os.replace(path, tombstone)
    except OSError as exc:
        store.abandon_removal(intent, f"{type(exc).__name__}: {exc}")
        return f"{type(exc).__name__}: {exc}"

    try:
        tombstone_sha256, _ = stream_sha256(tombstone)
    except OSError as exc:
        # The object is in the tombstone and the intent stays pending, so
        # recovery can still see it. It is not reported as removed.
        return f"{type(exc).__name__}: {exc}"
    if tombstone_sha256 != record.sha256:
        return "hash_drift"

    try:
        tombstone.unlink()
    except OSError as exc:
        return f"{type(exc).__name__}: {exc}"

    try:
        store._append(  # noqa: SLF001 - the store owns its own journal format
            replace(
                record,
                retention="removed",
                notes=record.notes + ("permanently removed",),
            )
        )
    except QuarantineError:
        # The object is gone but the record could not be updated. The intent
        # stays pending so this is reported rather than lost, and the caller
        # sees a failure rather than a false success.
        return "removed but the record could not be appended"

    store.commit_removal(intent)
    return None


def permanently_remove(
    store: QuarantineStore,
    impact: CleanupImpact,
    *,
    acknowledged: bool,
    cancel: Callable[[], bool] | None = None,
    operation_id: str | None = None,
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
    operation = operation_id or f"cleanup_{uuid.uuid4().hex[:16]}"

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

        outcome = _destroy_one(store, record, operation=operation)
        if outcome is not None:
            failed.append((record_id, outcome))
            continue

        removed.append(record_id)
        bytes_removed += record.size_bytes

    return CleanupOutcome(
        removed=tuple(removed),
        failed=tuple(failed),
        bytes_removed=bytes_removed,
    )
