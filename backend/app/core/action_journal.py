"""Durable operation records: immutable mutation manifests and action journals.

The manifest states what an operation was authorized to do; the journal states
how far it got. Together they are the only evidence that survives a power loss,
so the manifest is stored before the journal opens and each journal record is
flushed and fsynced before the caller takes the next irreversible filesystem
step. Records are never rewritten: a crash leaves a prefix of the timeline, and
reconciliation classifies the trailing state from that prefix.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from types import TracebackType
from typing import IO, Any

from app.core.integrity import (
    JOURNAL_SCHEMA_VERSION,
    ActionJournal,
    ActionStage,
    IntegrityEvidence,
    JournalEntry,
    JournalState,
    MutationManifest,
    MutationManifestAction,
    SourceSafetyState,
    utc_now,
)
from app.core.logging_config import get_logger

logger = get_logger(__name__)

JOURNAL_SUFFIX = ".journal.jsonl"
JOURNAL_DIRECTORY_NAME = "journals"
MANIFEST_SUFFIX = ".manifest.json"
ACTION_LOG_SUFFIX = ".actions.jsonl"
MANIFEST_DIRECTORY_NAME = "manifests"
TERMINAL_STATES: frozenset[JournalState] = frozenset(
    {"completed", "cancelled", "failed", "reconciliation_required"}
)


class JournalDurabilityError(RuntimeError):
    """The journal could not be made durable, so execution must not continue."""


class DurableActionJournal:
    """Append-only, fsynced record of one manifest's execution timeline."""

    def __init__(
        self,
        path: Path,
        *,
        journal_id: str,
        manifest_id: str,
        operation_id: str,
        root: Path | None = None,
    ) -> None:
        self.path = path
        self.journal_id = journal_id
        self.manifest_id = manifest_id
        self.operation_id = operation_id
        self._root = root
        self._entries: list[JournalEntry] = []
        self._state: JournalState = "active"
        self._handle: IO[str] | None = None

    def _open_handle(self) -> None:
        try:
            self._handle = self.path.open("a", encoding="utf-8")
        except OSError as exc:
            raise JournalDurabilityError(f"Cannot open action journal {self.path}: {exc}") from exc

    # ---------------------------------------------------------------- #
    # Lifecycle                                                          #
    # ---------------------------------------------------------------- #

    @classmethod
    def open(cls, root: Path, manifest: MutationManifest) -> DurableActionJournal:
        """Store the manifest, then create its journal and write the header.

        The manifest lands first so no journal can ever reference authorization
        that reconciliation cannot read back.
        """
        store_manifest(root, manifest)
        directory = root / JOURNAL_DIRECTORY_NAME
        directory.mkdir(parents=True, exist_ok=True)
        journal = cls(
            directory / f"{_safe_name(manifest.manifest_id)}{JOURNAL_SUFFIX}",
            journal_id=manifest.manifest_id,
            manifest_id=manifest.manifest_id,
            operation_id=manifest.operation_id,
            root=root,
        )
        journal._open_handle()
        _fsync_directory(directory)
        journal._append(
            {
                "record": "header",
                "schema_version": JOURNAL_SCHEMA_VERSION,
                "journal_id": journal.journal_id,
                "manifest_id": journal.manifest_id,
                "operation_id": journal.operation_id,
                "plan_id": manifest.plan_id,
                "profile_id": manifest.profile_id,
                "effective_config_sha256": manifest.effective_config_sha256,
                "action_ids": [action.action_id for action in manifest.actions],
                "created_at": utc_now().isoformat(),
            }
        )
        return journal

    @classmethod
    def open_operation(
        cls,
        root: Path,
        *,
        operation_id: str,
        plan_id: str,
        profile_id: str,
        effective_config_sha256: str,
    ) -> DurableActionJournal:
        """Open a journal for an operation whose actions are authorized as it runs.

        A streaming sort cannot enumerate every action before it starts, so the
        manifest is built by appending one immutable action record per file
        through :meth:`authorize`. Each action is durable before the filesystem
        is touched, which is the property reconciliation depends on.
        """
        directory = root / JOURNAL_DIRECTORY_NAME
        directory.mkdir(parents=True, exist_ok=True)
        journal = cls(
            directory / f"{_safe_name(operation_id)}{JOURNAL_SUFFIX}",
            journal_id=operation_id,
            manifest_id=operation_id,
            operation_id=operation_id,
            root=root,
        )
        journal._open_handle()
        _fsync_directory(directory)
        journal._append(
            {
                "record": "header",
                "schema_version": JOURNAL_SCHEMA_VERSION,
                "journal_id": operation_id,
                "manifest_id": operation_id,
                "operation_id": operation_id,
                "plan_id": plan_id,
                "profile_id": profile_id,
                "effective_config_sha256": effective_config_sha256,
                "streaming_manifest": True,
                "created_at": utc_now().isoformat(),
            }
        )
        return journal

    def authorize(self, action: MutationManifestAction) -> MutationManifestAction:
        """Durably record one action's authorization before it is executed."""
        if self._root is None:
            raise JournalDurabilityError(
                f"Journal {self.journal_id} was not opened with a manifest root"
            )
        store_manifest_action(self._root, self.operation_id, action)
        self.record(
            action.action_id,
            "planned",
            source_safety="source_retained",
            diagnostic_code=action.kind,
        )
        return action

    @classmethod
    def reopen(cls, path: Path) -> DurableActionJournal:
        """Continue an interrupted journal so recovery extends the same timeline.

        A crash-truncated trailing record is dropped from the file first, so an
        appended reconciliation record can never be glued onto half of an
        earlier one.
        """
        stored = read_journal(path)
        if stored.state != "active":
            raise JournalDurabilityError(f"Journal {path} is already {stored.state}")
        _truncate_to_last_complete_record(path)
        journal = cls(
            path,
            journal_id=stored.journal_id,
            manifest_id=stored.manifest_id,
            operation_id=stored.operation_id,
            root=path.parent.parent,
        )
        journal._entries = list(stored.entries)
        journal._open_handle()
        return journal

    def __enter__(self) -> DurableActionJournal:
        return self

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        if self._state == "active":
            self.finish("failed" if exc_type is not None else "completed")
        self.close()

    def close(self) -> None:
        if self._handle is not None:
            self._handle.close()
            self._handle = None

    # ---------------------------------------------------------------- #
    # Recording                                                          #
    # ---------------------------------------------------------------- #

    def record(
        self,
        action_id: str,
        stage: ActionStage,
        *,
        source_safety: SourceSafetyState,
        staged_path: Path | str | None = None,
        integrity: IntegrityEvidence | None = None,
        diagnostic_code: str | None = None,
    ) -> JournalEntry:
        """Durably append one stage transition and return the stored entry."""
        if self._state != "active":
            raise JournalDurabilityError(
                f"Journal {self.journal_id} is {self._state} and accepts no further entries"
            )
        entry = JournalEntry(
            sequence=len(self._entries) + 1,
            action_id=action_id,
            stage=stage,
            staged_path=None if staged_path is None else str(staged_path),
            integrity=integrity,
            source_safety=source_safety,
            diagnostic_code=diagnostic_code,
        )
        payload = json.loads(entry.model_dump_json())
        payload["record"] = "entry"
        self._append(payload)
        self._entries.append(entry)
        return entry

    def finish(self, state: JournalState) -> None:
        """Durably close the timeline with a terminal state."""
        if state not in TERMINAL_STATES:
            raise ValueError(f"{state!r} is not a terminal journal state")
        if self._state != "active":
            return
        self._append(
            {"record": "state", "state": state, "recorded_at": utc_now().isoformat()},
        )
        self._state = state

    # ---------------------------------------------------------------- #
    # Inspection                                                         #
    # ---------------------------------------------------------------- #

    @property
    def state(self) -> JournalState:
        return self._state

    @property
    def entries(self) -> tuple[JournalEntry, ...]:
        return tuple(self._entries)

    def snapshot(self) -> ActionJournal:
        return ActionJournal(
            journal_id=self.journal_id,
            manifest_id=self.manifest_id,
            operation_id=self.operation_id,
            state=self._state,
            entries=tuple(self._entries),
        )

    def last_stage(self, action_id: str) -> ActionStage | None:
        for entry in reversed(self._entries):
            if entry.action_id == action_id:
                return entry.stage
        return None

    # ---------------------------------------------------------------- #
    # Internals                                                          #
    # ---------------------------------------------------------------- #

    def _append(self, payload: dict[str, Any]) -> None:
        handle = self._handle
        if handle is None:
            raise JournalDurabilityError(f"Journal {self.journal_id} is closed")
        try:
            handle.write(json.dumps(payload, separators=(",", ":")) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        except OSError as exc:
            raise JournalDurabilityError(
                f"Cannot make action journal {self.path} durable: {exc}"
            ) from exc


def read_journal(path: Path) -> ActionJournal:
    """Reconstruct a journal from disk, discarding a crash-truncated last line.

    A journal without a terminal record describes an interrupted operation and
    is returned as ``active`` so reconciliation, not this reader, decides what
    the surviving artifacts mean.
    """
    lines = path.read_text(encoding="utf-8").splitlines()
    header: dict[str, Any] | None = None
    entries: list[JournalEntry] = []
    state: JournalState = "active"
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            payload = json.loads(line)
        except json.JSONDecodeError:
            if index != len(lines) - 1:
                raise ValueError(f"Corrupt action journal record at {path}:{index + 1}") from None
            logger.warning(
                "Discarded crash-truncated journal record",
                journal=str(path),
                line=index + 1,
            )
            break
        record = payload.pop("record", None)
        if record == "header":
            header = payload
        elif record == "entry":
            entries.append(JournalEntry.model_validate(payload))
        elif record == "state":
            state = payload["state"]
    if header is None:
        raise ValueError(f"Action journal has no header: {path}")
    return ActionJournal(
        journal_id=header["journal_id"],
        manifest_id=header["manifest_id"],
        operation_id=header["operation_id"],
        state=state,
        created_at=header["created_at"],
        entries=tuple(entries),
    )


def list_journals(root: Path) -> tuple[Path, ...]:
    """Return every journal file below ``root`` in stable order."""
    directory = root / JOURNAL_DIRECTORY_NAME
    if not directory.is_dir():
        return ()
    return tuple(sorted(directory.glob(f"*{JOURNAL_SUFFIX}")))


def unresolved_journals(root: Path) -> tuple[ActionJournal, ...]:
    """Return journals whose operations never reached a terminal state."""
    unresolved: list[ActionJournal] = []
    for path in list_journals(root):
        try:
            journal = read_journal(path)
        except (OSError, ValueError) as exc:
            logger.warning("Unreadable action journal", journal=str(path), error=str(exc))
            continue
        if journal.state == "active":
            unresolved.append(journal)
    return tuple(unresolved)


def journal_path(root: Path, manifest_id: str) -> Path:
    return root / JOURNAL_DIRECTORY_NAME / f"{_safe_name(manifest_id)}{JOURNAL_SUFFIX}"


def manifest_path(root: Path, manifest_id: str) -> Path:
    return root / MANIFEST_DIRECTORY_NAME / f"{_safe_name(manifest_id)}{MANIFEST_SUFFIX}"


def store_manifest(root: Path, manifest: MutationManifest) -> Path:
    """Write the authorization record immutably and durably.

    An existing manifest is never rewritten: the manifest is what makes a
    replayed or reconciled action provable, so a second run with the same id
    must reuse it rather than redefine it.
    """
    path = manifest_path(root, manifest.manifest_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        return path
    temporary = path.with_name(f".{path.name}.tmp")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            handle.write(manifest.model_dump_json())
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    except OSError as exc:
        temporary.unlink(missing_ok=True)
        raise JournalDurabilityError(f"Cannot store mutation manifest {path}: {exc}") from exc
    return path


def read_manifest(root: Path, manifest_id: str) -> MutationManifest | None:
    """Return the stored authorization for ``manifest_id``, if it survived."""
    path = manifest_path(root, manifest_id)
    try:
        return MutationManifest.model_validate_json(path.read_text(encoding="utf-8"))
    except OSError:
        return None
    except ValueError as exc:
        logger.warning("Unreadable mutation manifest", manifest=str(path), error=str(exc))
        return None


def action_log_path(root: Path, operation_id: str) -> Path:
    return root / MANIFEST_DIRECTORY_NAME / f"{_safe_name(operation_id)}{ACTION_LOG_SUFFIX}"


def store_manifest_action(root: Path, operation_id: str, action: MutationManifestAction) -> None:
    """Append one immutable action authorization and make it durable."""
    path = action_log_path(root, operation_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(action.model_dump_json() + "\n")
            handle.flush()
            os.fsync(handle.fileno())
    except OSError as exc:
        raise JournalDurabilityError(f"Cannot record manifest action in {path}: {exc}") from exc


def read_manifest_actions(root: Path, operation_id: str) -> tuple[MutationManifestAction, ...]:
    """Return every durably authorized action of a streaming operation.

    A crash-truncated final line is discarded: an action that never became
    durable also never reached the filesystem.
    """
    path = action_log_path(root, operation_id)
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ()
    actions: list[MutationManifestAction] = []
    for index, line in enumerate(lines):
        if not line.strip():
            continue
        try:
            actions.append(MutationManifestAction.model_validate_json(line))
        except ValueError:
            if index != len(lines) - 1:
                logger.warning("Corrupt manifest action record", log=str(path), line=index + 1)
            break
    return tuple(actions)


def _truncate_to_last_complete_record(path: Path) -> None:
    """Drop a partially written trailing line so appends stay parseable."""
    raw = path.read_text(encoding="utf-8")
    if raw.endswith("\n") or not raw:
        return
    keep = raw.rfind("\n")
    with path.open("a", encoding="utf-8") as handle:
        handle.truncate(keep + 1)
        handle.flush()
        os.fsync(handle.fileno())


def _safe_name(identifier: str) -> str:
    safe = "".join(
        character if character.isalnum() or character in {"-", "_"} else "-"
        for character in identifier
    )
    return safe[:128] or "journal"


def _fsync_directory(directory: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
