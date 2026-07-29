"""Fault injection at every boundary where an interruption could lose media.

Each test kills the process at one specific point and then asserts the same
invariant: at least one verified copy of the content is still addressable, and
nothing partial is visible at a final destination path.
"""

from __future__ import annotations

import errno
import hashlib
import os
import stat
from pathlib import Path
from typing import Any

import pytest

from app.core.action_journal import DurableActionJournal, read_journal
from app.core.exceptions import IntegrityTransferError
from app.core.integrity import (
    FilesystemMetadataSnapshot,
    MutationEffects,
    MutationManifest,
    MutationManifestAction,
    SourceEffect,
    SourceIdentity,
)
from app.services import verified_transfer
from app.services.reconciliation import apply_safe_recovery, reconcile_pending_operations
from app.services.verified_transfer import execute_transfer

CONTENT = b"irreplaceable family media" * 500


class Interruption(BaseException):
    """A power loss, not an exception the pipeline is meant to handle."""


def _action(
    source: Path,
    destination: Path,
    *,
    move: bool = True,
) -> MutationManifestAction:
    observed = source.stat()
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    effect: SourceEffect = "remove_after_verification" if move else "retained"
    return MutationManifestAction(
        action_id="act_fault",
        kind="move" if move else "copy",
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
        effects=MutationEffects(source=effect),
        preservation_profile_id="organize-only",
        preservation_profile_version=1,
        authorization_origin="default",
    )


def _journal(root: Path, action: MutationManifestAction) -> DurableActionJournal:
    return DurableActionJournal.open(
        root,
        MutationManifest(
            manifest_id="manifest_fault",
            operation_id="op_fault",
            plan_id="plan_fault",
            profile_id="organize-only",
            effective_config_sha256=hashlib.sha256(b"config").hexdigest(),
            actions=(action,),
        ),
    )


@pytest.fixture()
def scenario(tmp_path: Path) -> dict[str, Any]:
    source = tmp_path / "library" / "irreplaceable.bin"
    source.parent.mkdir(parents=True)
    source.write_bytes(CONTENT)
    return {
        "root": tmp_path / "state",
        "source": source,
        "destination": tmp_path / "sorted" / "2024" / "irreplaceable.bin",
        "tmp": tmp_path,
    }


def _assert_content_survives(scenario: dict[str, Any]) -> None:
    """At least one addressable copy must still hold the exact original bytes."""
    candidates = [scenario["source"], scenario["destination"]]
    candidates.extend(scenario["tmp"].rglob(".*ms-stage-*.tmp"))
    surviving = [path for path in candidates if path.is_file() and path.read_bytes() == CONTENT]
    assert surviving, "every verified copy of the content was lost"


def _assert_no_partial_destination(scenario: dict[str, Any]) -> None:
    destination = scenario["destination"]
    if destination.exists():
        assert destination.read_bytes() == CONTENT, "a partial file is visible at the final path"


# ------------------------------------------------------------------ #
# Interruption inside the transfer                                     #
# ------------------------------------------------------------------ #


@pytest.mark.parametrize(
    "target",
    ["_publish_same_volume", "_remove_verified_source", "_fsync_directory"],
)
def test_interruption_at_each_same_volume_boundary_keeps_a_verified_copy(
    scenario: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    target: str,
) -> None:
    action = _action(scenario["source"], scenario["destination"])

    def interrupt(*_args: object, **_kwargs: object) -> None:
        raise Interruption(f"power loss during {target}")

    monkeypatch.setattr(verified_transfer, target, interrupt)
    journal = _journal(scenario["root"], action)

    with pytest.raises(Interruption):
        execute_transfer(action, journal=journal)
    journal.close()

    _assert_content_survives(scenario)
    _assert_no_partial_destination(scenario)


@pytest.mark.parametrize(
    "target",
    ["_stage_copy", "commit_staged", "_remove_verified_source"],
)
def test_interruption_at_each_staged_boundary_keeps_a_verified_copy(
    scenario: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    target: str,
) -> None:
    action = _action(scenario["source"], scenario["destination"])
    monkeypatch.setattr(verified_transfer, "_same_volume", lambda *_: False)

    def interrupt(*_args: object, **_kwargs: object) -> None:
        raise Interruption(f"power loss during {target}")

    monkeypatch.setattr(verified_transfer, target, interrupt)
    journal = _journal(scenario["root"], action)

    with pytest.raises(Interruption):
        execute_transfer(action, journal=journal)
    journal.close()

    _assert_content_survives(scenario)
    _assert_no_partial_destination(scenario)


def test_interruption_mid_copy_leaves_nothing_at_the_destination(
    scenario: dict[str, Any],
) -> None:
    action = _action(scenario["source"], scenario["destination"], move=False)

    def interrupt(copied: int, _total: int) -> None:
        if copied > 0:
            raise Interruption("power loss mid-copy")

    with pytest.raises(Interruption):
        execute_transfer(action, on_progress=interrupt)

    assert scenario["destination"].exists() is False
    assert scenario["source"].read_bytes() == CONTENT
    assert list(scenario["tmp"].rglob(".*ms-stage-*.tmp")) == []


def test_a_failed_flush_never_publishes_the_stage(
    scenario: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    action = _action(scenario["source"], scenario["destination"], move=False)
    real_fsync = os.fsync

    def failing_fsync(descriptor: int) -> None:
        raise OSError(errno.EIO, "device error during flush")

    monkeypatch.setattr(os, "fsync", failing_fsync)

    with pytest.raises(IntegrityTransferError) as error:
        execute_transfer(action)

    monkeypatch.setattr(os, "fsync", real_fsync)
    assert error.value.details["reason"] == "volume_unavailable"
    assert scenario["destination"].exists() is False
    _assert_content_survives(scenario)


def test_a_journal_that_cannot_be_written_stops_before_the_filesystem_changes(
    scenario: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core.action_journal import JournalDurabilityError

    action = _action(scenario["source"], scenario["destination"])
    journal = _journal(scenario["root"], action)

    def refuse(*_args: object, **_kwargs: object) -> None:
        raise JournalDurabilityError("journal volume is full")

    monkeypatch.setattr(journal, "record", refuse)

    with pytest.raises(JournalDurabilityError):
        execute_transfer(action, journal=journal)

    assert scenario["destination"].exists() is False
    assert scenario["source"].read_bytes() == CONTENT


# ------------------------------------------------------------------ #
# Interruption plus restart                                            #
# ------------------------------------------------------------------ #


@pytest.mark.parametrize("target", ["commit_staged", "_remove_verified_source"])
def test_restart_after_an_interruption_never_destroys_content(
    scenario: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
    target: str,
) -> None:
    action = _action(scenario["source"], scenario["destination"])
    monkeypatch.setattr(verified_transfer, "_same_volume", lambda *_: False)

    def interrupt(*_args: object, **_kwargs: object) -> None:
        raise Interruption(f"power loss during {target}")

    monkeypatch.setattr(verified_transfer, target, interrupt)
    journal = _journal(scenario["root"], action)
    with pytest.raises(Interruption):
        execute_transfer(action, journal=journal)
    journal.close()
    monkeypatch.undo()

    reports = reconcile_pending_operations(scenario["root"])
    for report in reports:
        apply_safe_recovery(scenario["root"], report)

    _assert_content_survives(scenario)
    _assert_no_partial_destination(scenario)


def test_a_second_restart_is_a_no_op(
    scenario: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    action = _action(scenario["source"], scenario["destination"])
    monkeypatch.setattr(verified_transfer, "_same_volume", lambda *_: False)

    def interrupt(*_args: object, **_kwargs: object) -> None:
        raise Interruption("power loss")

    monkeypatch.setattr(verified_transfer, "_remove_verified_source", interrupt)
    journal = _journal(scenario["root"], action)
    with pytest.raises(Interruption):
        execute_transfer(action, journal=journal)
    journal.close()
    monkeypatch.undo()

    for report in reconcile_pending_operations(scenario["root"]):
        apply_safe_recovery(scenario["root"], report)
    first = scenario["destination"].read_bytes()

    assert reconcile_pending_operations(scenario["root"]) == ()
    assert scenario["destination"].read_bytes() == first
    assert read_journal(_journal_path(scenario["root"])).state == "completed"


def test_a_crash_truncated_journal_still_reconciles(
    scenario: dict[str, Any],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    action = _action(scenario["source"], scenario["destination"])
    monkeypatch.setattr(verified_transfer, "_same_volume", lambda *_: False)

    def interrupt(*_args: object, **_kwargs: object) -> None:
        raise Interruption("power loss")

    monkeypatch.setattr(verified_transfer, "_remove_verified_source", interrupt)
    journal = _journal(scenario["root"], action)
    with pytest.raises(Interruption):
        execute_transfer(action, journal=journal)
    journal.close()
    monkeypatch.undo()
    with _journal_path(scenario["root"]).open("a", encoding="utf-8") as handle:
        handle.write('{"record":"entry","sequence":99,"trunc')

    for report in reconcile_pending_operations(scenario["root"]):
        apply_safe_recovery(scenario["root"], report)

    _assert_content_survives(scenario)
    assert read_journal(_journal_path(scenario["root"])).state in {
        "completed",
        "reconciliation_required",
    }


def test_cancellation_between_files_leaves_completed_work_intact(
    scenario: dict[str, Any],
) -> None:
    first = scenario["source"]
    second = first.parent / "second.bin"
    second.write_bytes(CONTENT)
    action = _action(first, scenario["destination"], move=False)
    journal = _journal(scenario["root"], action)

    execute_transfer(action, journal=journal)
    journal.finish("cancelled")
    journal.close()

    assert scenario["destination"].read_bytes() == CONTENT
    assert first.read_bytes() == CONTENT
    assert reconcile_pending_operations(scenario["root"]) == ()


def _journal_path(root: Path) -> Path:
    return next(iter(sorted((root / "journals").glob("*.journal.jsonl"))))
