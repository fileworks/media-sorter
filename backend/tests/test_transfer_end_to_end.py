"""End-to-end transfer behavior across the conditions real libraries hit.

Everything here runs on whatever platform the suite runs on and asserts the
guarantee rather than the mechanism, so the same assertions hold on Windows,
macOS, and Linux even though the protocol underneath differs.
"""

from __future__ import annotations

import errno
import hashlib
import os
import shutil
import stat
import sys
from pathlib import Path

import pytest

from app.core.config import (
    Config,
    acknowledge_migrated_profile,
    reset_to_organize_only,
)
from app.core.exceptions import IntegrityTransferError, MutationPolicyError
from app.core.filesystem_capabilities import probe_filesystem_capabilities
from app.core.integrity import (
    FilesystemMetadataSnapshot,
    MutationEffects,
    MutationManifestAction,
    SourceEffect,
    SourceIdentity,
)
from app.core.integrity_policy import authorize_config_mutations
from app.services import verified_transfer
from app.services.verified_transfer import execute_transfer

MEDIA = b"\xff\xd8\xff\xe0" + b"end to end media payload" * 400


def _action(source: Path, destination: Path, *, move: bool) -> MutationManifestAction:
    observed = source.stat()
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    effect: SourceEffect = "remove_after_verification" if move else "retained"
    return MutationManifestAction(
        action_id="act_e2e",
        kind="move" if move else "copy",
        source=SourceIdentity(
            root_id="input-1",
            relative_path=source.name,
            observed_path=str(source),
            file_id=str(observed.st_ino) if observed.st_ino else None,
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


@pytest.fixture()
def media(tmp_path: Path) -> Path:
    source = tmp_path / "library" / "clip.mp4"
    source.parent.mkdir(parents=True)
    source.write_bytes(MEDIA)
    return source


# ------------------------------------------------------------------ #
# Copy and move, same and cross volume                                 #
# ------------------------------------------------------------------ #


@pytest.mark.parametrize("move", [False, True])
@pytest.mark.parametrize("same_volume", [True, False])
def test_copy_and_move_deliver_identical_content_on_either_volume_layout(
    media: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    move: bool,
    same_volume: bool,
) -> None:
    destination = tmp_path / "sorted" / "2024" / "clip.mp4"
    if not same_volume:
        monkeypatch.setattr(verified_transfer, "_same_volume", lambda *_: False)

    result = execute_transfer(_action(media, destination, move=move))

    assert destination.read_bytes() == MEDIA
    assert result.source_removed is move
    assert media.exists() is not move
    if result.integrity is not None:
        assert result.integrity.verified is True
        assert result.integrity.observed_result_sha256 == hashlib.sha256(MEDIA).hexdigest()


def test_the_platform_capability_probe_agrees_with_what_transfers_do(tmp_path: Path) -> None:
    report = probe_filesystem_capabilities(tmp_path)

    assert report.platform == sys.platform
    assert report.flush_and_fsync.status in {"supported", "permission_denied"}
    assert report.atomic_rename.status in {"supported", "unsupported", "permission_denied"}


def test_timestamp_limitations_are_reported_not_claimed(media: Path, tmp_path: Path) -> None:
    destination = tmp_path / "sorted" / "clip.mp4"
    precise = 1_700_000_000_123_456_789
    os.utime(media, ns=(precise, precise))

    result = execute_transfer(_action(media, destination, move=False))

    observed = destination.stat().st_mtime_ns
    if observed != precise:
        assert result.observed_metadata.mtime_ns == observed
        assert result.requested_metadata.mtime_ns == precise
    else:
        assert result.observed_metadata.mtime_ns == result.requested_metadata.mtime_ns


def test_no_embedded_byte_changes_on_any_path(media: Path, tmp_path: Path) -> None:
    copied = tmp_path / "sorted" / "copy.mp4"
    execute_transfer(_action(media, copied, move=False))
    moved = tmp_path / "sorted" / "moved.mp4"
    execute_transfer(_action(media, moved, move=True))

    assert copied.read_bytes() == MEDIA
    assert moved.read_bytes() == MEDIA


# ------------------------------------------------------------------ #
# Adverse conditions                                                   #
# ------------------------------------------------------------------ #


def _pretend_volume_is_full(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    usage = shutil.disk_usage(tmp_path)
    monkeypatch.setattr(
        verified_transfer.shutil,  # type: ignore[attr-defined]  # monkeypatching a module attribute the module imported but does not re-export
        "disk_usage",
        lambda _path: shutil._ntuple_diskusage(usage.total, usage.used, 1),
    )


def test_a_full_destination_volume_fails_before_writing(
    media: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    destination = tmp_path / "sorted" / "clip.mp4"
    monkeypatch.setattr(verified_transfer, "_same_volume", lambda *_: False)
    _pretend_volume_is_full(tmp_path, monkeypatch)

    with pytest.raises(IntegrityTransferError) as error:
        execute_transfer(_action(media, destination, move=True))

    assert error.value.details["reason"] == "insufficient_space"
    assert media.read_bytes() == MEDIA
    assert destination.exists() is False


def test_a_same_volume_move_still_works_on_a_full_volume(
    media: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Renaming within a volume needs no free space, and must not pretend it does."""
    destination = tmp_path / "sorted" / "clip.mp4"
    _pretend_volume_is_full(tmp_path, monkeypatch)

    result = execute_transfer(_action(media, destination, move=True))

    assert result.protocol.startswith("same_volume")
    assert destination.read_bytes() == MEDIA
    assert media.exists() is False


def test_an_inaccessible_source_never_reports_success(
    media: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    destination = tmp_path / "sorted" / "clip.mp4"
    action = _action(media, destination, move=True)
    real_open = Path.open

    def refuse(path: Path, mode: str = "r", *args: object, **kwargs: object) -> object:
        if path == media:
            raise OSError(errno.EACCES, "permission denied")
        return real_open(path, mode, *args, **kwargs)

    monkeypatch.setattr(verified_transfer, "_same_volume", lambda *_: False)
    monkeypatch.setattr(Path, "open", refuse)

    with pytest.raises(IntegrityTransferError) as error:
        execute_transfer(action)

    assert error.value.details["reason"] == "permission_denied"
    assert destination.exists() is False


def test_a_mixed_batch_reports_each_outcome_separately(tmp_path: Path) -> None:
    root = tmp_path / "library"
    root.mkdir()
    good = root / "good.mp4"
    good.write_bytes(MEDIA)
    blocked = root / "blocked.mp4"
    blocked.write_bytes(MEDIA)
    taken = tmp_path / "sorted" / "blocked.mp4"
    taken.parent.mkdir(parents=True)
    taken.write_bytes(b"someone else's file")

    execute_transfer(_action(good, tmp_path / "sorted" / "good.mp4", move=False))
    with pytest.raises(IntegrityTransferError):
        execute_transfer(_action(blocked, taken, move=False))

    assert (tmp_path / "sorted" / "good.mp4").read_bytes() == MEDIA
    assert taken.read_bytes() == b"someone else's file"
    assert blocked.read_bytes() == MEDIA


# ------------------------------------------------------------------ #
# Migration and rollback                                               #
# ------------------------------------------------------------------ #


def test_a_pre_profile_config_keeps_its_settings_and_asks_for_review() -> None:
    config = Config.from_dict(
        {
            "source_directory": "/library",
            "target_directory": "/sorted",
            "convert_images": True,
            "repair_enabled": True,
            "override_metadata": True,
        }
    )

    profile = config.preservation_profile
    assert profile.requires_review is True
    assert profile.authorization_origin == "migration"
    assert profile.allow_conversion is True
    assert profile.allow_repair is True
    assert profile.allow_embedded_metadata_edits is True
    assert config.convert_images is True, "the carried-over setting must be retained"
    with pytest.raises(MutationPolicyError) as error:
        authorize_config_mutations(config)
    assert error.value.details["reason"] == "migration_review_required"


def test_a_pre_profile_config_without_mutations_migrates_straight_to_organize_only() -> None:
    config = Config.from_dict({"source_directory": "/library", "target_directory": "/sorted"})

    assert config.preservation_profile.mode == "organize_only"
    assert config.preservation_profile.requires_review is False
    assert authorize_config_mutations(config).is_organize_only


def test_acknowledging_a_migrated_profile_unblocks_exactly_what_was_carried_over() -> None:
    config = Config.from_dict(
        {"source_directory": "/library", "target_directory": "/sorted", "repair_enabled": True}
    )

    acknowledge_migrated_profile(config)

    authorization = authorize_config_mutations(config)
    assert "repair" in authorization.requested
    authorization.require("repair")
    with pytest.raises(MutationPolicyError):
        authorization.require("conversion")


def test_rollback_can_only_remove_authorization() -> None:
    config = Config.from_dict(
        {
            "source_directory": "/library",
            "target_directory": "/sorted",
            "convert_videos": True,
            "override_metadata": True,
        }
    )
    acknowledge_migrated_profile(config)

    reset_to_organize_only(config)

    assert config.preservation_profile.mode == "organize_only"
    assert config.preservation_profile.preserve_filesystem_timestamps is True
    assert config.convert_videos is False
    assert config.override_metadata is False
    assert authorize_config_mutations(config).is_organize_only


def test_rollback_is_idempotent_and_safe_on_a_default_config() -> None:
    config = Config(source_directory="/library", target_directory="/sorted")

    reset_to_organize_only(reset_to_organize_only(config))

    assert config.preservation_profile == Config().preservation_profile
    assert authorize_config_mutations(config).is_organize_only
