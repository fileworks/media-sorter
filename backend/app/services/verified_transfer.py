"""Content-verified staged copy, atomic commit, and move protocols.

Two entry points share one contract. :func:`execute_transfer` runs an authorized
:class:`MutationManifestAction` and additionally proves that the bytes on disk
still match the hash the plan was built from. :func:`transfer_path` serves
callers that have no manifest yet; it proves the weaker but still cryptographic
statement that the destination holds exactly the bytes read from a source that
did not change while it was read. Neither entry point accepts size equality as
evidence, and neither removes a source before the destination is verified and
the commit is durably journalled.
"""

from __future__ import annotations

import errno
import hashlib
import os
import shutil
import stat
import uuid
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Literal

from app.core.action_journal import DurableActionJournal
from app.core.exceptions import IntegrityTransferError
from app.core.integrity import (
    ActionStage,
    FilesystemMetadataSnapshot,
    IntegrityEvidence,
    MutationManifestAction,
    SourceSafetyState,
    utc_now,
)
from app.core.paths import paths_refer_to_same_file

TRANSFER_CHUNK_BYTES = 1024 * 1024
ProgressCallback = Callable[[int, int], None]

CommitMethod = Literal["atomic_rename", "staged_atomic_promote", "recoverable_non_atomic"]
TransferProtocol = Literal[
    "same_volume_link",
    "same_volume_rename",
    "staged_atomic_promote",
    "staged_recoverable",
]
IntegritySource = Literal["measured", "revalidated_identity", "same_inode"]
STAGED_TRANSFER_KINDS = frozenset({"copy", "move", "quarantine", "restore", "replace"})
REDUCED_ATOMICITY = "atomic_no_clobber_publication_unavailable"

#: Errno values that mean "this filesystem cannot publish atomically without
#: clobbering", as opposed to a genuine I/O failure that must propagate.
_ATOMIC_UNAVAILABLE_ERRNOS = frozenset(
    value
    for value in (
        errno.EXDEV,
        errno.EPERM,
        errno.EACCES,
        getattr(errno, "ENOTSUP", None),
        getattr(errno, "EOPNOTSUPP", None),
        getattr(errno, "EMLINK", None),
    )
    if value is not None
)

#: Environment failures a user can act on, mapped to stable diagnostic reasons.
#: Anything unmapped stays ``transfer_io_error`` rather than being guessed at.
_OS_ERROR_REASONS: dict[int, str] = {
    value: reason
    for value, reason in (
        (errno.ENOSPC, "insufficient_space"),
        (getattr(errno, "EDQUOT", None), "quota_exceeded"),
        (errno.EACCES, "permission_denied"),
        (errno.EPERM, "permission_denied"),
        (errno.EROFS, "destination_read_only"),
        (errno.ENAMETOOLONG, "path_too_long"),
        (errno.ELOOP, "unsafe_path_link"),
        (errno.EBUSY, "resource_locked"),
        (getattr(errno, "ETXTBSY", None), "resource_locked"),
        (errno.EAGAIN, "resource_locked"),
        (errno.EIO, "volume_unavailable"),
        (errno.ENODEV, "volume_unavailable"),
        (errno.ENXIO, "volume_unavailable"),
        (getattr(errno, "ESTALE", None), "volume_unavailable"),
        (getattr(errno, "EREMOTEIO", None), "volume_unavailable"),
        (errno.ENOENT, "path_disappeared"),
        (errno.ENOTDIR, "destination_parent_unusable"),
        (errno.EISDIR, "destination_parent_unusable"),
        (errno.EMFILE, "resource_exhausted"),
        (errno.ENFILE, "resource_exhausted"),
    )
    if value is not None
}

#: Windows reports antivirus and backup-agent locks through ``winerror`` rather
#: than a distinctive errno: sharing violation, lock violation, and delete
#: pending on a handle another process still holds.
_WINDOWS_LOCK_ERRORS = frozenset({32, 33, 1224})
_WINDOWS_PATH_LENGTH_ERRORS = frozenset({206, 3})


@dataclass(frozen=True)
class StagedTransfer:
    action_id: str
    source_path: Path
    stage_path: Path
    destination_path: Path
    integrity: IntegrityEvidence
    requested_metadata: FilesystemMetadataSnapshot
    observed_metadata: FilesystemMetadataSnapshot
    metadata_warnings: tuple[str, ...]


@dataclass(frozen=True)
class CommittedTransfer:
    staged: StagedTransfer
    destination_path: Path
    commit_method: CommitMethod = "staged_atomic_promote"


@dataclass(frozen=True)
class TransferResult:
    """The auditable outcome of one completed transfer."""

    action_id: str
    source_path: Path
    destination_path: Path
    protocol: TransferProtocol
    commit_method: CommitMethod
    integrity: IntegrityEvidence | None
    integrity_source: IntegritySource
    source_safety: SourceSafetyState
    source_removed: bool
    requested_metadata: FilesystemMetadataSnapshot
    observed_metadata: FilesystemMetadataSnapshot
    warnings: tuple[str, ...] = ()
    reduced_guarantee: str | None = None


@dataclass(frozen=True)
class _TransferRequest:
    """What both entry points agree on before any byte is touched."""

    action_id: str
    source: Path
    destination: Path
    removes_source: bool
    expected_sha256: str | None = None
    expected_size_bytes: int | None = None
    expected_metadata: FilesystemMetadataSnapshot | None = None
    expected_file_id: str | None = None

    @property
    def is_authorized(self) -> bool:
        return self.expected_sha256 is not None


# ---------------------------------------------------------------------- #
# Hashing and staging                                                      #
# ---------------------------------------------------------------------- #


def stream_sha256(path: Path, *, chunk_bytes: int = TRANSFER_CHUNK_BYTES) -> tuple[str, int]:
    """Hash a regular file with bounded memory."""
    if chunk_bytes < 4096:
        raise ValueError("hash chunk size must be at least 4096 bytes")
    digest = hashlib.sha256()
    size = 0
    with _open_regular_source(path) as handle:
        while chunk := handle.read(chunk_bytes):
            digest.update(chunk)
            size += len(chunk)
    return digest.hexdigest(), size


def stage_verified_copy(
    action: MutationManifestAction,
    *,
    on_progress: ProgressCallback | None = None,
) -> StagedTransfer:
    """Copy an authorized source to a private destination-directory stage.

    The source is hashed while copying, the staged file is flushed and fsynced,
    and the closed stage is hashed independently. The visible final path is not
    created by this function.
    """
    return _stage_copy(_request_from_action(action), on_progress=on_progress)


def stage_measured_copy(
    source: Path,
    destination: Path,
    *,
    action_id: str,
    on_progress: ProgressCallback | None = None,
) -> StagedTransfer:
    """Stage a copy whose integrity contract is measured rather than authorized.

    Used by callers that have no plan-time hash. The staged bytes are still
    hashed twice — once while reading the source, once by rereading the closed
    stage — and the source must be unchanged across the whole read.
    """
    return _stage_copy(
        _TransferRequest(
            action_id=action_id,
            source=source,
            destination=destination,
            removes_source=False,
        ),
        on_progress=on_progress,
    )


def _stage_copy(
    request: _TransferRequest,
    *,
    on_progress: ProgressCallback | None,
) -> StagedTransfer:
    source = request.source
    destination = request.destination
    _prepare_destination_directory(request)
    if destination.exists() or destination.is_symlink():
        raise _error(request, "destination_exists", "Destination already exists.")

    before = _snapshot_source(request, source)
    requested_metadata = request.expected_metadata or _metadata_snapshot_of(before)
    _require_free_space(request, before.st_size)
    stage = _stage_path(destination)
    copied_digest = hashlib.sha256()
    copied_bytes = 0
    try:
        with (
            _guard(request, "staging"),
            _open_regular_source(source) as source_handle,
            stage.open("xb") as stage_handle,
        ):
            copied_bytes = _copy_and_hash(
                source_handle,
                stage_handle,
                request.expected_size_bytes if request.expected_size_bytes is not None else 0,
                copied_digest,
                on_progress,
            )
            stage_handle.flush()
            os.fsync(stage_handle.fileno())

        source_digest = copied_digest.hexdigest()
        if request.is_authorized and (
            copied_bytes != request.expected_size_bytes or source_digest != request.expected_sha256
        ):
            raise _error(
                request,
                "source_drift",
                "Source content no longer matches the authorized manifest.",
                observed_size=copied_bytes,
                observed_sha256=source_digest,
            )
        _assert_source_unchanged(request, source, before)

        with _guard(request, "integrity_verifying"):
            stage_digest, stage_size = stream_sha256(stage)
        if stage_digest != source_digest or stage_size != copied_bytes:
            raise _error(
                request,
                "stage_hash_mismatch",
                "Staged content failed independent integrity verification.",
                observed_size=stage_size,
                observed_sha256=stage_digest,
            )

        warnings = _apply_supported_metadata(stage, requested_metadata)
        with _guard(request, "metadata_applying"):
            observed_metadata = _metadata_snapshot(stage)
        integrity = IntegrityEvidence(
            expected_sha256=request.expected_sha256 or source_digest,
            observed_source_sha256=source_digest,
            observed_result_sha256=stage_digest,
            expected_size_bytes=(
                request.expected_size_bytes
                if request.expected_size_bytes is not None
                else copied_bytes
            ),
            observed_source_size_bytes=copied_bytes,
            observed_result_size_bytes=stage_size,
            verified=True,
            verified_at=utc_now(),
        )
        return StagedTransfer(
            action_id=request.action_id,
            source_path=source,
            stage_path=stage,
            destination_path=destination,
            integrity=integrity,
            requested_metadata=requested_metadata,
            observed_metadata=observed_metadata,
            metadata_warnings=warnings,
        )
    except BaseException:
        # BaseException, not Exception: a KeyboardInterrupt or SystemExit during
        # the copy must not leave an unverified stage behind either. The stage
        # was never published and the source is untouched, so removing it loses
        # nothing.
        stage.unlink(missing_ok=True)
        raise


# ---------------------------------------------------------------------- #
# Committing                                                               #
# ---------------------------------------------------------------------- #


def commit_staged_no_replace(staged: StagedTransfer) -> CommittedTransfer:
    """Atomically publish a verified stage without replacing an existing path.

    A same-directory hard link is an atomic no-clobber publication on supported
    filesystems. Unsupported filesystems remain staged for the recoverable
    non-atomic protocol implemented separately.
    """
    stage = staged.stage_path
    destination = staged.destination_path
    _require_intact_stage(staged)
    if destination.exists() or destination.is_symlink():
        raise IntegrityTransferError(
            "Destination changed after staging; nothing was replaced.",
            reason="destination_changed",
            action_id=staged.action_id,
            destination_path=str(destination),
            source_safety="source_retained",
        )
    try:
        os.link(stage, destination, follow_symlinks=False)
    except FileExistsError as exc:
        raise IntegrityTransferError(
            "Destination appeared during commit; nothing was replaced.",
            reason="destination_changed",
            action_id=staged.action_id,
            destination_path=str(destination),
            source_safety="source_retained",
        ) from exc
    except OSError as exc:
        if exc.errno in _ATOMIC_UNAVAILABLE_ERRNOS:
            raise IntegrityTransferError(
                "Atomic no-replace publication is unavailable on this filesystem.",
                reason="atomic_commit_unavailable",
                action_id=staged.action_id,
                stage_path=str(stage),
                source_safety="source_retained",
                os_error=exc.errno,
            ) from exc
        raise

    stage.unlink()
    _fsync_directory(destination.parent)
    return CommittedTransfer(staged=staged, destination_path=destination)


def commit_staged_recoverable(staged: StagedTransfer) -> CommittedTransfer:
    """Publish a verified stage on a filesystem without atomic no-clobber support.

    The reduced guarantee is explicit: the destination is checked immediately
    before an atomic rename, so an interruption never publishes partial content,
    but a concurrent writer that wins the gap between check and rename would be
    replaced. Callers must surface ``recoverable_non_atomic`` to the user.
    """
    stage = staged.stage_path
    destination = staged.destination_path
    _require_intact_stage(staged)
    if destination.exists() or destination.is_symlink():
        raise IntegrityTransferError(
            "Destination changed after staging; nothing was replaced.",
            reason="destination_changed",
            action_id=staged.action_id,
            destination_path=str(destination),
            source_safety="source_retained",
        )
    os.rename(stage, destination)
    _fsync_directory(destination.parent)
    return CommittedTransfer(
        staged=staged,
        destination_path=destination,
        commit_method="recoverable_non_atomic",
    )


def commit_staged(staged: StagedTransfer) -> CommittedTransfer:
    """Publish a verified stage atomically, degrading only when unsupported."""
    try:
        return commit_staged_no_replace(staged)
    except IntegrityTransferError as exc:
        if exc.details.get("reason") != "atomic_commit_unavailable":
            raise
    return commit_staged_recoverable(staged)


# ---------------------------------------------------------------------- #
# Whole transfers                                                          #
# ---------------------------------------------------------------------- #


def execute_transfer(
    action: MutationManifestAction,
    *,
    journal: DurableActionJournal | None = None,
    on_progress: ProgressCallback | None = None,
    rehash_source: bool = False,
) -> TransferResult:
    """Run an authorized manifest action through the protocol its volumes support.

    A move whose destination shares the source volume is published by adding a
    second name for the same content, which needs no byte copy and no re-read.
    Every other transfer stages, verifies, and commits a copy. In both cases the
    source is removed only after the destination is verified and the commit is
    durably journalled.
    """
    return _run(
        _request_from_action(action),
        journal=journal,
        on_progress=on_progress,
        rehash_source=rehash_source,
    )


def transfer_path(
    source: Path,
    destination: Path,
    *,
    move: bool,
    action_id: str | None = None,
    journal: DurableActionJournal | None = None,
    on_progress: ProgressCallback | None = None,
) -> TransferResult:
    """Copy or move a file under the measured content-integrity contract."""
    return _run(
        _TransferRequest(
            action_id=action_id or uuid.uuid4().hex,
            source=source,
            destination=destination,
            removes_source=move,
        ),
        journal=journal,
        on_progress=on_progress,
        rehash_source=False,
    )


def _run(
    request: _TransferRequest,
    *,
    journal: DurableActionJournal | None,
    on_progress: ProgressCallback | None,
    rehash_source: bool,
) -> TransferResult:
    _validate_request_paths(request)
    _record(journal, request, "authorized", "source_retained")
    _prepare_destination_directory(request)

    if request.removes_source and _same_volume(request.source, request.destination.parent):
        return _transfer_same_volume(request, journal=journal, rehash_source=rehash_source)
    return _transfer_staged(request, journal=journal, on_progress=on_progress)


def _transfer_same_volume(
    request: _TransferRequest,
    *,
    journal: DurableActionJournal | None,
    rehash_source: bool,
) -> TransferResult:
    source = request.source
    destination = request.destination
    if destination.exists() or destination.is_symlink():
        raise _error(request, "destination_exists", "Destination already exists.")
    before = _snapshot_source(request, source)
    requested_metadata = request.expected_metadata or _metadata_snapshot_of(before)

    integrity_source: IntegritySource = (
        "revalidated_identity" if request.is_authorized else "same_inode"
    )
    if rehash_source:
        observed_hash, observed_size = stream_sha256(source)
        if request.is_authorized and (
            observed_hash != request.expected_sha256 or observed_size != request.expected_size_bytes
        ):
            raise _error(
                request,
                "source_drift",
                "Source content no longer matches the authorized manifest.",
                observed_size=observed_size,
                observed_sha256=observed_hash,
            )
        integrity_source = "measured"
    integrity = _identity_evidence(request)
    _record(journal, request, "integrity_verified", "source_verified", integrity=integrity)

    _record(journal, request, "committing", "source_verified")
    with _guard(request, "committing"):
        protocol, commit_method, reduced = _publish_same_volume(request)
    after = destination.stat()
    if after.st_size != before.st_size or (
        before.st_ino and after.st_ino and after.st_ino != before.st_ino
    ):
        raise _error(
            request,
            "destination_identity_mismatch",
            "Published destination does not match the verified source identity.",
        )
    _fsync_directory(destination.parent)
    _record(
        journal,
        request,
        "committed",
        "redundant_verified_copies" if protocol == "same_volume_link" else "destination_verified",
        integrity=integrity,
    )
    _record(journal, request, "journal_durable", "destination_verified", integrity=integrity)

    warnings: list[str] = []
    if reduced is not None:
        warnings.append(reduced)
    if protocol == "same_volume_link":
        _record(journal, request, "source_removing", "redundant_verified_copies")
        _remove_verified_source(request, journal=journal, warnings=warnings)
    _record(journal, request, "source_removed", "destination_verified", integrity=integrity)
    _record(journal, request, "terminal", "destination_verified", integrity=integrity)
    return TransferResult(
        action_id=request.action_id,
        source_path=source,
        destination_path=destination,
        protocol=protocol,
        commit_method=commit_method,
        integrity=integrity,
        integrity_source=integrity_source,
        source_safety="destination_verified",
        source_removed=True,
        requested_metadata=requested_metadata,
        observed_metadata=_metadata_snapshot(destination),
        warnings=tuple(warnings),
        reduced_guarantee=reduced,
    )


def _transfer_staged(
    request: _TransferRequest,
    *,
    journal: DurableActionJournal | None,
    on_progress: ProgressCallback | None,
) -> TransferResult:
    _record(journal, request, "staging", "source_retained")
    staged = _stage_copy(request, on_progress=on_progress)
    staged_stages: tuple[ActionStage, ...] = ("staged", "integrity_verified")
    for stage in staged_stages:
        _record(
            journal,
            request,
            stage,
            "source_retained",
            staged_path=staged.stage_path,
            integrity=staged.integrity,
        )
    _record(journal, request, "committing", "source_retained", staged_path=staged.stage_path)
    try:
        with _guard(request, "committing"):
            committed = commit_staged(staged)
    except BaseException:
        staged.stage_path.unlink(missing_ok=True)
        raise
    atomic = committed.commit_method == "staged_atomic_promote"
    protocol: TransferProtocol = "staged_atomic_promote" if atomic else "staged_recoverable"
    reduced = None if atomic else REDUCED_ATOMICITY
    _record(journal, request, "committed", "redundant_verified_copies", integrity=staged.integrity)
    _record(
        journal,
        request,
        "journal_durable",
        "redundant_verified_copies",
        integrity=staged.integrity,
    )

    warnings = list(staged.metadata_warnings)
    if reduced is not None:
        warnings.append(reduced)
    if not request.removes_source:
        _record(
            journal,
            request,
            "terminal",
            "redundant_verified_copies",
            integrity=staged.integrity,
        )
        return TransferResult(
            action_id=request.action_id,
            source_path=request.source,
            destination_path=committed.destination_path,
            protocol=protocol,
            commit_method=committed.commit_method,
            integrity=staged.integrity,
            integrity_source="measured",
            source_safety="redundant_verified_copies",
            source_removed=False,
            requested_metadata=staged.requested_metadata,
            observed_metadata=staged.observed_metadata,
            warnings=tuple(warnings),
            reduced_guarantee=reduced,
        )

    _record(journal, request, "source_removing", "redundant_verified_copies")
    _remove_verified_source(request, journal=journal, warnings=warnings)
    _record(journal, request, "source_removed", "destination_verified", integrity=staged.integrity)
    _record(journal, request, "terminal", "destination_verified", integrity=staged.integrity)
    return TransferResult(
        action_id=request.action_id,
        source_path=request.source,
        destination_path=committed.destination_path,
        protocol=protocol,
        commit_method=committed.commit_method,
        integrity=staged.integrity,
        integrity_source="measured",
        source_safety="destination_verified",
        source_removed=True,
        requested_metadata=staged.requested_metadata,
        observed_metadata=staged.observed_metadata,
        warnings=tuple(warnings),
        reduced_guarantee=reduced,
    )


def _publish_same_volume(
    request: _TransferRequest,
) -> tuple[TransferProtocol, CommitMethod, str | None]:
    source = request.source
    destination = request.destination
    try:
        os.link(source, destination, follow_symlinks=False)
    except FileExistsError as exc:
        raise _error(
            request,
            "destination_changed",
            "Destination appeared during commit; nothing was replaced.",
        ) from exc
    except OSError as exc:
        if exc.errno not in _ATOMIC_UNAVAILABLE_ERRNOS:
            raise
    else:
        return "same_volume_link", "atomic_rename", None

    if destination.exists() or destination.is_symlink():
        raise _error(
            request,
            "destination_changed",
            "Destination appeared during commit; nothing was replaced.",
        )
    os.rename(source, destination)
    return "same_volume_rename", "recoverable_non_atomic", REDUCED_ATOMICITY


def _remove_verified_source(
    request: _TransferRequest,
    *,
    journal: DurableActionJournal | None,
    warnings: list[str],
) -> None:
    """Remove the source only after the destination is verified and journalled."""
    try:
        request.source.unlink()
    except FileNotFoundError:
        warnings.append("source_already_absent")
    except OSError as exc:
        _record(
            journal,
            request,
            "terminal",
            "redundant_verified_copies",
            diagnostic_code="source_removal_failed",
        )
        raise IntegrityTransferError(
            "The destination is verified but the source could not be removed.",
            reason="source_removal_failed",
            action_id=request.action_id,
            source_path=str(request.source),
            destination_path=str(request.destination),
            source_safety="redundant_verified_copies",
            os_error=exc.errno,
        ) from exc


def _identity_evidence(request: _TransferRequest) -> IntegrityEvidence | None:
    """Evidence for content published without a byte copy.

    The destination is a second name for the revalidated source inode, so an
    authorized manifest hash describes both sides and no separate read can
    disagree with it. Without a manifest there is no hash to attest, and the
    inode identity is reported through ``integrity_source`` instead.
    """
    if request.expected_sha256 is None or request.expected_size_bytes is None:
        return None
    return IntegrityEvidence(
        expected_sha256=request.expected_sha256,
        observed_source_sha256=request.expected_sha256,
        observed_result_sha256=request.expected_sha256,
        expected_size_bytes=request.expected_size_bytes,
        observed_source_size_bytes=request.expected_size_bytes,
        observed_result_size_bytes=request.expected_size_bytes,
        verified=True,
        verified_at=utc_now(),
    )


# ---------------------------------------------------------------------- #
# Internals                                                                #
# ---------------------------------------------------------------------- #


def _request_from_action(action: MutationManifestAction) -> _TransferRequest:
    if action.kind not in STAGED_TRANSFER_KINDS:
        raise IntegrityTransferError(
            "Action is not a staged content transfer.",
            reason="unsupported_action",
            action_id=action.action_id,
            source_path=action.source.observed_path,
            destination_path=action.destination_path,
            source_safety="source_retained",
        )
    return _TransferRequest(
        action_id=action.action_id,
        source=Path(action.source.observed_path),
        destination=Path(action.destination_path),
        removes_source=action.effects.source == "remove_after_verification",
        expected_sha256=action.expected_sha256,
        expected_size_bytes=action.expected_size_bytes,
        expected_metadata=action.source.metadata,
        expected_file_id=action.source.file_id,
    )


def _validate_request_paths(request: _TransferRequest) -> None:
    """Reject a transfer whose endpoints are the same file under another name.

    Case-insensitive volumes, hard links, and resolved aliases all make two
    different strings address one file; treating that as a transfer would
    destroy the only copy.
    """
    if paths_refer_to_same_file(request.source, request.destination):
        raise _error(request, "same_path", "Source and destination must be different.")


def _prepare_destination_directory(request: _TransferRequest) -> None:
    """Ensure the destination folder exists without mistaking a file for one."""
    parent = request.destination.parent
    with _guard(request, "preflight"):
        if not parent.exists():
            parent.mkdir(parents=True, exist_ok=True)
    if not parent.is_dir():
        raise _error(
            request,
            "destination_parent_unusable",
            "The destination folder is not a usable directory.",
            phase="preflight",
        )


def _require_free_space(request: _TransferRequest, needed_bytes: int) -> None:
    """Fail before writing when the destination volume cannot hold the content."""
    try:
        available = shutil.disk_usage(request.destination.parent).free
    except OSError:
        return  # An unmeasurable volume is reported by the write itself.
    if available < needed_bytes:
        raise _error(
            request,
            "insufficient_space",
            f"Not enough space in {request.destination.parent}: "
            f"need {needed_bytes} B, have {available} B",
            available_bytes=available,
            required_bytes=needed_bytes,
        )


@contextmanager
def _guard(
    request: _TransferRequest,
    phase: str,
    *,
    source_safety: SourceSafetyState = "source_retained",
) -> Iterator[None]:
    """Translate environment failures into stable, actionable diagnostics."""
    try:
        yield
    except IntegrityTransferError:
        raise
    except OSError as exc:
        raise _error(
            request,
            _os_error_reason(exc),
            _os_error_message(exc),
            phase=phase,
            os_error=exc.errno,
            os_error_name=errno.errorcode.get(exc.errno or 0, "UNKNOWN"),
            source_safety=source_safety,
        ) from exc


def _os_error_reason(exc: OSError) -> str:
    winerror = getattr(exc, "winerror", None)
    if winerror in _WINDOWS_LOCK_ERRORS:
        return "resource_locked"
    if winerror in _WINDOWS_PATH_LENGTH_ERRORS:
        return "path_too_long"
    return _OS_ERROR_REASONS.get(exc.errno or 0, "transfer_io_error")


def _os_error_message(exc: OSError) -> str:
    return {
        "insufficient_space": "The destination volume ran out of space.",
        "quota_exceeded": "The destination quota was exceeded.",
        "permission_denied": "The transfer was not permitted by the filesystem.",
        "destination_read_only": "The destination is read-only.",
        "path_too_long": "The destination path is too long for this filesystem.",
        "unsafe_path_link": "The path resolves through too many links.",
        "resource_locked": "Another process is holding the file open.",
        "volume_unavailable": "The volume became unavailable during the transfer.",
        "path_disappeared": "A path involved in the transfer disappeared.",
        "destination_parent_unusable": "The destination folder is not a usable directory.",
        "resource_exhausted": "The process ran out of file handles.",
    }.get(_os_error_reason(exc), "The transfer failed with a filesystem error.")


def _copy_and_hash(
    source: BinaryIO,
    destination: BinaryIO,
    expected_size: int,
    digest: hashlib._Hash,
    progress: ProgressCallback | None,
) -> int:
    copied = 0
    while chunk := source.read(TRANSFER_CHUNK_BYTES):
        destination.write(chunk)
        digest.update(chunk)
        copied += len(chunk)
        if progress is not None:
            progress(copied, expected_size or copied)
    return copied


def _open_regular_source(path: Path) -> BinaryIO:
    try:
        source_stat = path.lstat()
    except OSError as exc:
        raise IntegrityTransferError(
            "Source cannot be inspected.",
            reason="source_unavailable",
            source_path=str(path),
            source_safety="ambiguous",
        ) from exc
    if not stat.S_ISREG(source_stat.st_mode) or stat.S_ISLNK(source_stat.st_mode):
        raise IntegrityTransferError(
            "Source must be a regular file and cannot be a symbolic link.",
            reason="unsafe_source_type",
            source_path=str(path),
            source_safety="source_retained",
        )
    return path.open("rb")


def _snapshot_source(request: _TransferRequest, source: Path) -> os.stat_result:
    observed = source.lstat()
    if not stat.S_ISREG(observed.st_mode) or stat.S_ISLNK(observed.st_mode):
        raise IntegrityTransferError(
            "Source must be a regular file and cannot be a symbolic link.",
            reason="unsafe_source_type",
            source_path=str(source),
            source_safety="source_retained",
        )
    expected = request.expected_metadata
    if expected is not None and (
        observed.st_size != expected.size_bytes or observed.st_mtime_ns != expected.mtime_ns
    ):
        raise _error(request, "source_drift", "Source metadata changed after authorization.")
    if request.expected_file_id is not None and str(observed.st_ino) != request.expected_file_id:
        raise _error(request, "source_identity_changed", "Source file identity changed.")
    return observed


def _assert_source_unchanged(
    request: _TransferRequest,
    source: Path,
    before: os.stat_result,
) -> None:
    after = source.stat()
    if (
        after.st_size != before.st_size
        or after.st_mtime_ns != before.st_mtime_ns
        or after.st_ino != before.st_ino
    ):
        raise _error(request, "source_changed_during_copy", "Source changed while it was copied.")


def _apply_supported_metadata(
    stage: Path,
    requested: FilesystemMetadataSnapshot,
) -> tuple[str, ...]:
    warnings: list[str] = []
    try:
        os.utime(stage, ns=(requested.atime_ns, requested.mtime_ns), follow_symlinks=False)
    except OSError as exc:
        warnings.append(f"timestamps:{type(exc).__name__}:{exc.errno}")
    if requested.mode is not None:
        try:
            stage.chmod(stat.S_IMODE(requested.mode), follow_symlinks=False)
        except (NotImplementedError, OSError) as exc:
            warnings.append(f"mode:{type(exc).__name__}")
    return tuple(warnings)


def _metadata_snapshot(path: Path) -> FilesystemMetadataSnapshot:
    return _metadata_snapshot_of(path.stat())


def _metadata_snapshot_of(observed: os.stat_result) -> FilesystemMetadataSnapshot:
    return FilesystemMetadataSnapshot(
        size_bytes=observed.st_size,
        mtime_ns=observed.st_mtime_ns,
        atime_ns=observed.st_atime_ns,
        mode=stat.S_IMODE(observed.st_mode),
    )


def _same_volume(source: Path, destination_parent: Path) -> bool:
    try:
        return source.stat().st_dev == destination_parent.stat().st_dev
    except OSError:
        return False


def _stage_path(destination: Path) -> Path:
    """Return a hidden, collision-free stage name in the destination directory.

    The name is deliberately short and bounded: a stage that inherited the full
    destination name would push long paths past the limit on the very
    filesystems where staging matters most. The journal, not the file name,
    relates a leftover stage to its action.
    """
    prefix = "".join(character for character in destination.stem if character.isalnum())[:12]
    return destination.parent / f".{prefix}.ms-stage-{uuid.uuid4().hex[:16]}.tmp"


def _fsync_directory(directory: Path) -> None:
    if os.name == "nt":
        return
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _record(
    journal: DurableActionJournal | None,
    request: _TransferRequest,
    stage: ActionStage,
    source_safety: SourceSafetyState,
    *,
    staged_path: Path | None = None,
    integrity: IntegrityEvidence | None = None,
    diagnostic_code: str | None = None,
) -> None:
    if journal is None:
        return
    journal.record(
        request.action_id,
        stage,
        source_safety=source_safety,
        staged_path=staged_path,
        integrity=integrity,
        diagnostic_code=diagnostic_code,
    )


def _require_intact_stage(staged: StagedTransfer) -> None:
    stage = staged.stage_path
    if not stage.is_file() or stage.is_symlink():
        raise IntegrityTransferError(
            "Verified stage is missing or no longer a regular file.",
            reason="stage_missing",
            action_id=staged.action_id,
            stage_path=str(stage),
            source_safety="source_retained",
        )
    observed_hash, observed_size = stream_sha256(stage)
    if (
        observed_hash != staged.integrity.observed_result_sha256
        or observed_size != staged.integrity.observed_result_size_bytes
    ):
        raise IntegrityTransferError(
            "Stage changed after verification; commit was blocked.",
            reason="stage_drift",
            action_id=staged.action_id,
            source_safety="source_retained",
        )


def _error(
    request: _TransferRequest,
    reason: str,
    message: str,
    **details: Any,
) -> IntegrityTransferError:
    return IntegrityTransferError(
        message,
        reason=reason,
        action_id=request.action_id,
        source_path=str(request.source),
        destination_path=str(request.destination),
        source_safety=details.pop("source_safety", "source_retained"),
        **details,
    )
