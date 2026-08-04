"""Tests for manifest-bound staged copy, atomic commit, and move protocols."""

from __future__ import annotations

import errno
import hashlib
import os
import shutil
import stat
from pathlib import Path
from typing import Any

import pytest

from app.core.action_journal import DurableActionJournal, read_journal
from app.core.exceptions import IntegrityTransferError
from app.core.integrity import (
    ActionStage,
    FilesystemMetadataSnapshot,
    MutationEffects,
    MutationManifest,
    MutationManifestAction,
    SourceEffect,
    SourceIdentity,
)
from app.services import verified_transfer
from app.services.verified_transfer import (
    commit_staged_no_replace,
    execute_transfer,
    stage_verified_copy,
)


def _action(
    source: Path,
    destination: Path,
    *,
    kind: str = "copy",
    source_effect: SourceEffect = "retained",
) -> MutationManifestAction:
    observed = source.stat()
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    return MutationManifestAction(
        action_id="transfer-1",
        kind=kind,  # type: ignore[arg-type]
        source=SourceIdentity(
            root_id="input-1",
            relative_path=source.name,
            observed_path=str(source),
            file_id=str(observed.st_ino),
            sha256=digest,
            metadata=FilesystemMetadataSnapshot(
                size_bytes=observed.st_size,
                mtime_ns=observed.st_mtime_ns,
                atime_ns=observed.st_atime_ns,
                mode=stat.S_IMODE(observed.st_mode),
            ),
        ),
        destination_path=str(destination),
        expected_sha256=digest,
        expected_size_bytes=observed.st_size,
        effects=MutationEffects(source=source_effect),
        preservation_profile_id="organize-only",
        preservation_profile_version=1,
        authorization_origin="default",
    )


def _move_action(source: Path, destination: Path) -> MutationManifestAction:
    return _action(
        source,
        destination,
        kind="move",
        source_effect="remove_after_verification",
    )


def _journal(root: Path, action: MutationManifestAction) -> DurableActionJournal:
    manifest = MutationManifest(
        manifest_id="manifest-1",
        operation_id="operation-1",
        plan_id="plan-1",
        profile_id="organize-only",
        effective_config_sha256=hashlib.sha256(b"config").hexdigest(),
        actions=(action,),
    )
    return DurableActionJournal.open(root, manifest)


def _stages(root: Path) -> list[ActionStage]:
    journals = sorted((root / "journals").glob("*.journal.jsonl"))
    return [entry.stage for entry in read_journal(journals[0]).entries]


def test_stage_copy_is_private_verified_flushed_and_metadata_preserving(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "nested" / "destination.bin"
    source.write_bytes(b"verified transfer" * 100_000)
    timestamp = 1_650_000_000_123_456_789
    os.utime(source, ns=(timestamp, timestamp))
    action = _action(source, destination)
    fsync_calls: list[int] = []
    real_fsync = os.fsync

    def observe_fsync(descriptor: int) -> None:
        fsync_calls.append(descriptor)
        real_fsync(descriptor)

    monkeypatch.setattr(os, "fsync", observe_fsync)
    progress: list[tuple[int, int]] = []

    staged = stage_verified_copy(
        action,
        on_progress=lambda done, total: progress.append((done, total)),
    )

    assert source.exists()
    assert destination.exists() is False
    assert staged.stage_path.parent == destination.parent
    assert staged.stage_path.name.startswith(".destination.ms-stage-")
    assert len(staged.stage_path.name) < len(destination.name) + 40
    assert staged.integrity.verified is True
    assert staged.stage_path.read_bytes() == source.read_bytes()
    assert staged.observed_metadata.mtime_ns == action.source.metadata.mtime_ns
    assert progress[-1] == (source.stat().st_size, source.stat().st_size)
    assert fsync_calls


def test_commit_publishes_verified_stage_without_removing_source(tmp_path: Path) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "destination.bin"
    source.write_bytes(b"commit")
    staged = stage_verified_copy(_action(source, destination))

    committed = commit_staged_no_replace(staged)

    assert committed.destination_path == destination
    assert destination.read_bytes() == source.read_bytes()
    assert source.exists()
    assert staged.stage_path.exists() is False


def test_destination_race_is_blocked_without_overwrite(tmp_path: Path) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "destination.bin"
    source.write_bytes(b"source")
    staged = stage_verified_copy(_action(source, destination))
    destination.write_bytes(b"someone else")

    with pytest.raises(IntegrityTransferError) as error:
        commit_staged_no_replace(staged)

    assert error.value.details["reason"] == "destination_changed"
    assert destination.read_bytes() == b"someone else"
    assert staged.stage_path.exists()
    assert source.exists()


def test_source_drift_is_blocked_and_stage_is_removed(tmp_path: Path) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "destination.bin"
    source.write_bytes(b"before")
    action = _action(source, destination)
    source.write_bytes(b"after!")

    with pytest.raises(IntegrityTransferError) as error:
        stage_verified_copy(action)

    assert error.value.details["reason"] == "source_drift"
    assert not list(tmp_path.glob(".*.ms-stage-*.tmp"))
    assert destination.exists() is False
    assert source.read_bytes() == b"after!"


def test_symbolic_link_source_is_rejected(tmp_path: Path) -> None:
    target = tmp_path / "target.bin"
    source = tmp_path / "source-link.bin"
    destination = tmp_path / "destination.bin"
    target.write_bytes(b"target")
    try:
        source.symlink_to(target)
    except OSError:
        pytest.skip("symlinks unavailable")
    action = _action(target, destination).model_copy(
        update={
            "source": _action(target, destination).source.model_copy(
                update={"observed_path": str(source)}
            )
        }
    )

    with pytest.raises(IntegrityTransferError) as error:
        stage_verified_copy(action)

    assert error.value.details["reason"] == "unsafe_source_type"


def test_same_volume_move_publishes_without_copying_after_full_revalidation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = tmp_path / "state"
    source = tmp_path / "library" / "source.bin"
    destination = tmp_path / "sorted" / "2024" / "destination.bin"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"same volume" * 10_000)
    action = _move_action(source, destination)

    def fail_on_copy(*_args: object, **_kwargs: object) -> None:
        raise AssertionError("a same-volume move must not copy bytes")

    monkeypatch.setattr(verified_transfer, "stage_verified_copy", fail_on_copy)
    hashed: list[Path] = []
    real_hash = verified_transfer.stream_sha256

    def observe_hash(path: Path, **kwargs: object) -> tuple[str, int]:
        hashed.append(path)
        return real_hash(path, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(verified_transfer, "stream_sha256", observe_hash)

    with _journal(state, action) as journal:
        result = execute_transfer(action, journal=journal)

    assert result.protocol == "same_volume_link"
    assert result.commit_method == "atomic_rename"
    assert result.integrity_source == "measured"
    assert result.integrity.verified is True
    assert hashed == [source]
    assert result.source_removed is True
    assert result.source_safety == "destination_verified"
    assert result.reduced_guarantee is None
    assert destination.read_bytes() == b"same volume" * 10_000
    assert source.exists() is False


def test_same_volume_move_removes_the_source_only_after_a_durable_commit(
    tmp_path: Path,
) -> None:
    state = tmp_path / "state"
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "destination.bin"
    source.write_bytes(b"ordering")
    action = _move_action(source, destination)

    with _journal(state, action) as journal:
        execute_transfer(action, journal=journal)

    stages = _stages(state)
    assert stages.index("journal_durable") < stages.index("source_removing")
    assert stages.index("source_removing") < stages.index("source_removed")
    assert stages[-1] == "terminal"


def test_same_volume_move_falls_back_to_a_labelled_recoverable_rename(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "destination.bin"
    source.write_bytes(b"no hard links here")
    action = _move_action(source, destination)

    def unsupported_link(*_args: object, **_kwargs: object) -> None:
        raise OSError(errno.EPERM, "hard links are not supported")

    monkeypatch.setattr(os, "link", unsupported_link)

    result = execute_transfer(action)

    assert result.protocol == "same_volume_rename"
    assert result.commit_method == "recoverable_non_atomic"
    assert result.reduced_guarantee == "atomic_no_clobber_publication_unavailable"
    assert result.warnings == ("atomic_no_clobber_publication_unavailable",)
    assert destination.read_bytes() == b"no hard links here"
    assert source.exists() is False


def test_same_volume_move_never_replaces_an_existing_destination(tmp_path: Path) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "destination.bin"
    source.write_bytes(b"mine")
    destination.write_bytes(b"someone else")
    action = _move_action(source, destination)

    with pytest.raises(IntegrityTransferError) as error:
        execute_transfer(action)

    assert error.value.details["reason"] == "destination_exists"
    assert destination.read_bytes() == b"someone else"
    assert source.read_bytes() == b"mine"


def test_same_volume_move_rehashes_the_source_when_asked(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "destination.bin"
    source.write_bytes(b"rehash me")
    action = _move_action(source, destination)
    hashed: list[Path] = []
    real_hash = verified_transfer.stream_sha256

    def observe(path: Path, **kwargs: object) -> tuple[str, int]:
        hashed.append(path)
        return real_hash(path, **kwargs)  # type: ignore[arg-type]

    monkeypatch.setattr(verified_transfer, "stream_sha256", observe)

    result = execute_transfer(action, rehash_source=True)

    assert hashed == [source]
    assert result.integrity_source == "measured"
    assert destination.read_bytes() == b"rehash me"


def test_unplanned_move_records_measured_content_evidence(tmp_path: Path) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "destination.bin"
    source.write_bytes(b"measure before deleting")
    digest = hashlib.sha256(source.read_bytes()).hexdigest()

    result = verified_transfer.transfer_path(source, destination, move=True)

    assert result.integrity_source == "measured"
    assert result.integrity is not None
    assert result.integrity.expected_sha256 == digest
    assert result.integrity.observed_source_sha256 == digest
    assert result.integrity.observed_result_sha256 == digest
    assert result.integrity.verified is True


def test_move_blocks_if_source_changes_while_being_revalidated(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "destination.bin"
    source.write_bytes(b"before")
    action = _move_action(source, destination)
    real_hash = verified_transfer.stream_sha256

    def mutate_after_hash(path: Path, **kwargs: object) -> tuple[str, int]:
        result = real_hash(path, **kwargs)  # type: ignore[arg-type]
        path.write_bytes(b"after!")
        return result

    monkeypatch.setattr(verified_transfer, "stream_sha256", mutate_after_hash)

    with pytest.raises(IntegrityTransferError) as error:
        execute_transfer(action)

    assert error.value.details["reason"] == "source_changed_during_copy"
    assert source.read_bytes() == b"after!"
    assert destination.exists() is False


def test_same_volume_move_blocks_when_the_source_drifted_before_rehashing(
    tmp_path: Path,
) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "destination.bin"
    source.write_bytes(b"authorized")
    action = _move_action(source, destination)
    os.utime(source, ns=(action.source.metadata.atime_ns, action.source.metadata.mtime_ns))
    source.write_bytes(b"tamper!!!!")
    os.utime(source, ns=(action.source.metadata.atime_ns, action.source.metadata.mtime_ns))

    with pytest.raises(IntegrityTransferError) as error:
        execute_transfer(action, rehash_source=True)

    assert error.value.details["reason"] == "source_drift"
    assert destination.exists() is False
    assert source.read_bytes() == b"tamper!!!!"


def test_cross_volume_move_stages_verifies_and_then_removes_the_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = tmp_path / "state"
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "destination.bin"
    source.write_bytes(b"cross volume" * 5_000)
    action = _move_action(source, destination)
    monkeypatch.setattr(verified_transfer, "_same_volume", lambda *_: False)
    progress: list[tuple[int, int]] = []

    with _journal(state, action) as journal:
        result = execute_transfer(
            action,
            journal=journal,
            on_progress=lambda done, total: progress.append((done, total)),
        )

    assert result.protocol == "staged_atomic_promote"
    assert result.commit_method == "staged_atomic_promote"
    assert result.integrity_source == "measured"
    assert result.source_removed is True
    assert result.source_safety == "destination_verified"
    assert destination.read_bytes() == b"cross volume" * 5_000
    assert source.exists() is False
    assert progress[-1] == (action.expected_size_bytes, action.expected_size_bytes)

    stages = _stages(state)
    assert stages.index("staged") < stages.index("integrity_verified")
    assert stages.index("integrity_verified") < stages.index("committed")
    assert stages.index("committed") < stages.index("journal_durable")
    assert stages.index("journal_durable") < stages.index("source_removing")


def test_cross_volume_copy_keeps_both_verified_copies(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "destination.bin"
    source.write_bytes(b"retained")
    action = _action(source, destination)
    monkeypatch.setattr(verified_transfer, "_same_volume", lambda *_: False)

    result = execute_transfer(action)

    assert result.source_removed is False
    assert result.source_safety == "redundant_verified_copies"
    assert source.read_bytes() == b"retained"
    assert destination.read_bytes() == b"retained"


def test_staged_commit_degrades_to_a_labelled_recoverable_protocol(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "destination.bin"
    source.write_bytes(b"no links")
    action = _action(source, destination)

    def unsupported_link(*_args: object, **_kwargs: object) -> None:
        raise OSError(errno.EOPNOTSUPP, "hard links are not supported")

    monkeypatch.setattr(os, "link", unsupported_link)

    result = execute_transfer(action)

    assert result.protocol == "staged_recoverable"
    assert result.commit_method == "recoverable_non_atomic"
    assert result.reduced_guarantee == "atomic_no_clobber_publication_unavailable"
    assert destination.read_bytes() == b"no links"
    assert list(destination.parent.glob(".*ms-stage-*")) == []


def test_failed_staged_commit_leaves_no_stage_and_keeps_the_source(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "destination.bin"
    source.write_bytes(b"keep me")
    action = _move_action(source, destination)
    monkeypatch.setattr(verified_transfer, "_same_volume", lambda *_: False)

    def refuse_commit(_staged: object) -> None:
        raise IntegrityTransferError("commit refused", reason="destination_changed")

    monkeypatch.setattr(verified_transfer, "commit_staged", refuse_commit)

    with pytest.raises(IntegrityTransferError):
        execute_transfer(action)

    assert source.read_bytes() == b"keep me"
    assert destination.exists() is False
    assert list(destination.parent.glob(".*ms-stage-*")) == []


def test_unremovable_source_reports_redundant_verified_copies(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = tmp_path / "state"
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "destination.bin"
    source.write_bytes(b"undeletable")
    action = _move_action(source, destination)

    def refuse_unlink(_self: Path, **_kwargs: object) -> None:
        raise OSError(errno.EACCES, "source is locked")

    monkeypatch.setattr(Path, "unlink", refuse_unlink)

    with _journal(state, action) as journal:
        with pytest.raises(IntegrityTransferError) as error:
            execute_transfer(action, journal=journal)

    assert error.value.details["reason"] == "source_removal_failed"
    assert error.value.details["source_safety"] == "redundant_verified_copies"
    assert destination.read_bytes() == b"undeletable"
    assert source.read_bytes() == b"undeletable"
    assert _stages(state)[-1] == "terminal"


def test_interrupted_move_leaves_a_recoverable_journal_and_both_copies(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = tmp_path / "state"
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "destination.bin"
    source.write_bytes(b"power loss")
    action = _move_action(source, destination)

    def crash(*_args: object, **_kwargs: object) -> None:
        raise KeyboardInterrupt("power loss after commit")

    journal = _journal(state, action)
    monkeypatch.setattr(verified_transfer, "_remove_verified_source", crash)
    with pytest.raises(KeyboardInterrupt):
        execute_transfer(action, journal=journal)
    journal.close()  # the process died before any terminal record

    stored = read_journal(journal.path)
    assert stored.state == "active"
    assert [entry.stage for entry in stored.entries][-1] == "source_removing"
    assert source.read_bytes() == b"power loss"
    assert destination.read_bytes() == b"power loss"


# ------------------------------------------------------------------ #
# Environment defenses                                                 #
# ------------------------------------------------------------------ #


def test_case_aliased_endpoints_are_refused_as_the_same_file(tmp_path: Path) -> None:
    source = tmp_path / "Photo.JPG"
    source.write_bytes(b"one copy only")
    alias = tmp_path / "photo.jpg"
    if not alias.exists():
        pytest.skip("case-insensitive filesystem required")

    with pytest.raises(IntegrityTransferError) as error:
        execute_transfer(_move_action(source, alias))

    assert error.value.details["reason"] == "same_path"
    assert source.read_bytes() == b"one copy only"


def test_hard_linked_alias_is_refused_as_the_same_file(tmp_path: Path) -> None:
    source = tmp_path / "source.bin"
    alias = tmp_path / "alias.bin"
    source.write_bytes(b"one inode")
    os.link(source, alias)

    with pytest.raises(IntegrityTransferError) as error:
        execute_transfer(_move_action(source, alias))

    assert error.value.details["reason"] == "same_path"
    assert source.read_bytes() == b"one inode"


def test_full_destination_volume_is_refused_before_writing(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "destination.bin"
    source.write_bytes(b"too big for this volume")
    action = _action(source, destination)
    usage = shutil.disk_usage(tmp_path)
    monkeypatch.setattr(
        verified_transfer.shutil,  # type: ignore[attr-defined]  # monkeypatching a module attribute the module imported but does not re-export
        "disk_usage",
        lambda _path: shutil._ntuple_diskusage(usage.total, usage.used, 1),
    )

    with pytest.raises(IntegrityTransferError) as error:
        execute_transfer(action)

    assert error.value.details["reason"] == "insufficient_space"
    assert error.value.details["required_bytes"] == action.expected_size_bytes
    assert destination.exists() is False
    assert list(tmp_path.glob("sorted/.*ms-stage-*")) == []


@pytest.mark.parametrize(
    "error_number,expected_reason",
    [
        (errno.ENOSPC, "insufficient_space"),
        (errno.EACCES, "permission_denied"),
        (errno.EROFS, "destination_read_only"),
        (errno.ENAMETOOLONG, "path_too_long"),
        (errno.EBUSY, "resource_locked"),
        (errno.EIO, "volume_unavailable"),
        (errno.ELOOP, "unsafe_path_link"),
    ],
)
def test_environment_failures_get_stable_diagnostic_reasons(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    error_number: int,
    expected_reason: str,
) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "destination.bin"
    source.write_bytes(b"environment failure")
    action = _action(source, destination)
    real_open = Path.open

    def failing_open(path: Path, mode: str = "r", *args: object, **kwargs: object) -> Any:
        if mode == "xb":
            raise OSError(error_number, os.strerror(error_number))
        return real_open(path, mode, *args, **kwargs)

    monkeypatch.setattr(Path, "open", failing_open)

    with pytest.raises(IntegrityTransferError) as error:
        execute_transfer(action)

    assert error.value.details["reason"] == expected_reason
    assert error.value.details["phase"] == "staging"
    assert error.value.details["source_safety"] == "source_retained"
    assert source.read_bytes() == b"environment failure"
    assert destination.exists() is False


def test_windows_sharing_violation_is_reported_as_a_lock(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / "sorted" / "destination.bin"
    source.write_bytes(b"antivirus holds this open")
    real_open = Path.open

    def locked_open(path: Path, mode: str = "r", *args: object, **kwargs: object) -> Any:
        if mode == "xb":
            locked = OSError(errno.EACCES, "sharing violation")
            locked.winerror = 32  # type: ignore[attr-defined]
            raise locked
        return real_open(path, mode, *args, **kwargs)

    monkeypatch.setattr(Path, "open", locked_open)

    with pytest.raises(IntegrityTransferError) as error:
        execute_transfer(_action(source, destination))

    assert error.value.details["reason"] == "resource_locked"


def test_stage_name_stays_short_for_long_destination_names(tmp_path: Path) -> None:
    source = tmp_path / "source.bin"
    destination = tmp_path / ("a" * 180 + ".bin")
    source.write_bytes(b"long name")

    staged = stage_verified_copy(_action(source, destination))

    assert len(staged.stage_path.name) < 48
    assert len(staged.stage_path.name) < len(destination.name)
    staged.stage_path.unlink()


def test_unusable_destination_parent_is_reported_before_staging(tmp_path: Path) -> None:
    source = tmp_path / "source.bin"
    blocker = tmp_path / "not-a-directory"
    source.write_bytes(b"blocked")
    blocker.write_bytes(b"I am a file")

    with pytest.raises(IntegrityTransferError) as error:
        execute_transfer(_action(source, blocker / "destination.bin"))

    assert error.value.details["reason"] == "destination_parent_unusable"
    assert source.read_bytes() == b"blocked"
