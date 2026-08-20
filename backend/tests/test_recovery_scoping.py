"""C-08: recovery must re-measure, and must only touch its own artifacts.

Two defects, both reachable from `bootstrap`, which applies recovery
*unattended at startup* from a report that may be arbitrarily old.

**The report was the only evidence.** `apply_safe_recovery` removed a source
because the stored report said the destination was verified. Nothing re-read the
destination, so anything that changed it in between — a sync client, a restore,
a user — left the recommendation standing while the copy it rested on no longer
existed. Removing the source then destroyed the last good copy.

**Stage globs were unscoped.** `_classify_stages` globbed `.*.ms-stage-*.tmp`,
which matches *every* action's stage in that directory. A verified action then
discarded them all, including another action's leftover — and that leftover may
be the only surviving copy of an action whose source was already removed.
"""

from __future__ import annotations

import hashlib
import stat
from pathlib import Path

from app.core.action_journal import DurableActionJournal
from app.core.integrity import (
    ActionStage,
    FilesystemMetadataSnapshot,
    MutationEffects,
    MutationManifest,
    MutationManifestAction,
    SourceEffect,
    SourceIdentity,
)
from app.services.reconciliation import (
    apply_safe_recovery,
    reconcile_pending_operations,
)
from app.services.verified_transfer import stage_token


def _action(
    action_id: str,
    source: Path,
    destination: Path,
    *,
    source_effect: SourceEffect = "remove_after_verification",
) -> MutationManifestAction:
    observed = source.stat()
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    return MutationManifestAction(
        action_id=action_id,
        kind="move" if source_effect == "remove_after_verification" else "copy",
        source=SourceIdentity(
            root_id="input-1",
            relative_path=source.name,
            observed_path=str(source),
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


def _manifest(*actions: MutationManifestAction) -> MutationManifest:
    return MutationManifest(
        manifest_id="manifest-1",
        operation_id="operation-1",
        plan_id="plan-1",
        profile_id="organize-only",
        effective_config_sha256=hashlib.sha256(b"config").hexdigest(),
        actions=actions,
    )


#: The journal path of an action that committed but never reached a terminal
#: record — the state a crash after commit leaves behind.
_COMMITTED: tuple[ActionStage, ...] = ("staging", "staged", "committed", "journal_durable")


def _interrupt(
    root: Path, manifest: MutationManifest, stages: dict[str, tuple[ActionStage, ...]]
) -> None:
    journal = DurableActionJournal.open(root, manifest)
    for action_id, recorded in stages.items():
        for stage in recorded:
            journal.record(action_id, stage, source_safety="source_retained")
    journal.close()


class TestTheDestinationIsReMeasuredBeforeTheSourceGoes:
    def _committed_move(self, tmp_path: Path) -> tuple[Path, Path, Path]:
        root = tmp_path / "state"
        source = tmp_path / "source.bin"
        destination = tmp_path / "sorted" / "source.bin"
        source.write_bytes(b"the only copy that matters")
        destination.parent.mkdir(parents=True)
        destination.write_bytes(source.read_bytes())
        _interrupt(
            root, _manifest(_action("action-1", source, destination)), {"action-1": _COMMITTED}
        )
        return root, source, destination

    def test_a_destination_changed_after_the_report_keeps_the_source(self, tmp_path: Path) -> None:
        """The data-loss path: the report is stale and says 'verified'."""
        root, source, destination = self._committed_move(tmp_path)
        (report,) = reconcile_pending_operations(root)
        assert report.actions[0].recommended == "remove_verified_source"

        # Between reconciling and applying, something else rewrites the
        # destination. `bootstrap` applies recovery unattended, so this window
        # is real and can be long.
        destination.write_bytes(b"something else entirely")

        outcome = apply_safe_recovery(root, report)

        assert source.is_file(), "the source was removed against an unverified destination"
        assert source.read_bytes() == b"the only copy that matters"
        assert outcome.removed_sources == []
        assert "action-1" in outcome.unresolved_actions

    def test_a_destination_deleted_after_the_report_keeps_the_source(self, tmp_path: Path) -> None:
        root, source, destination = self._committed_move(tmp_path)
        (report,) = reconcile_pending_operations(root)

        destination.unlink()

        outcome = apply_safe_recovery(root, report)

        assert source.is_file()
        assert outcome.removed_sources == []

    def test_an_unchanged_destination_still_removes_the_source(self, tmp_path: Path) -> None:
        """The guard against 'fixing' this by never completing a recovery."""
        root, source, _destination = self._committed_move(tmp_path)
        (report,) = reconcile_pending_operations(root)

        outcome = apply_safe_recovery(root, report)

        assert not source.exists(), "a genuinely verified destination must still finish the move"
        assert outcome.removed_sources == [source]
        assert outcome.unresolved_actions == []


class TestStagesBelongToOneAction:
    def test_one_actions_recovery_does_not_discard_anothers_stage(self, tmp_path: Path) -> None:
        """Both destinations share a directory, which is the normal case."""
        root = tmp_path / "state"
        sorted_dir = tmp_path / "sorted"
        sorted_dir.mkdir(parents=True)

        source_a = tmp_path / "a.bin"
        source_a.write_bytes(b"action A content")
        destination_a = sorted_dir / "a.bin"
        destination_a.write_bytes(source_a.read_bytes())

        source_b = tmp_path / "b.bin"
        source_b.write_bytes(b"action B content, quite different")
        destination_b = sorted_dir / "b.bin"

        # B crashed mid-stage: its stage file is the work in progress, and B's
        # destination was never published.
        stage_b = sorted_dir / f".b.ms-stage-{stage_token('action-2')}-abcd1234.tmp"
        stage_b.write_bytes(source_b.read_bytes())

        manifest = _manifest(
            _action("action-1", source_a, destination_a),
            _action("action-2", source_b, destination_b),
        )
        _interrupt(root, manifest, {"action-1": _COMMITTED, "action-2": ("staging",)})

        (report,) = reconcile_pending_operations(root)
        apply_safe_recovery(root, report)

        assert stage_b.is_file(), "action A's recovery deleted action B's stage"
        assert stage_b.read_bytes() == b"action B content, quite different"

    def test_an_actions_own_stage_is_still_discarded_once_published(self, tmp_path: Path) -> None:
        """The guard against scoping so tightly that nothing is ever cleaned."""
        root = tmp_path / "state"
        sorted_dir = tmp_path / "sorted"
        sorted_dir.mkdir(parents=True)

        source = tmp_path / "a.bin"
        source.write_bytes(b"action A content")
        destination = sorted_dir / "a.bin"
        destination.write_bytes(source.read_bytes())

        own_stage = sorted_dir / f".a.ms-stage-{stage_token('action-1')}-0000ffff.tmp"
        own_stage.write_bytes(source.read_bytes())

        _interrupt(
            root, _manifest(_action("action-1", source, destination)), {"action-1": _COMMITTED}
        )

        (report,) = reconcile_pending_operations(root)
        outcome = apply_safe_recovery(root, report)

        assert not own_stage.exists(), "a published action must still clean up after itself"
        assert own_stage in outcome.discarded_stages

    def test_a_legacy_stage_is_adopted_only_when_its_content_matches(self, tmp_path: Path) -> None:
        """Stages written before names carried an owner have only content as evidence.

        One that hashes to this action's authorized content is ours and is
        cleaned up. One that does not is somebody else's and is left alone —
        which is the whole point of the fix, applied to the names that cannot
        be attributed any other way.
        """
        root = tmp_path / "state"
        sorted_dir = tmp_path / "sorted"
        sorted_dir.mkdir(parents=True)

        source = tmp_path / "a.bin"
        source.write_bytes(b"action A content")
        destination = sorted_dir / "a.bin"
        destination.write_bytes(source.read_bytes())

        mine = sorted_dir / ".a.ms-stage-0123456789abcdef.tmp"
        mine.write_bytes(source.read_bytes())
        someone_elses = sorted_dir / ".z.ms-stage-fedcba9876543210.tmp"
        someone_elses.write_bytes(b"a different action's work in progress")

        _interrupt(
            root, _manifest(_action("action-1", source, destination)), {"action-1": _COMMITTED}
        )

        (report,) = reconcile_pending_operations(root)
        apply_safe_recovery(root, report)

        assert not mine.exists(), "our own legacy stage should still be cleaned up"
        assert someone_elses.is_file(), "an unattributable stage was deleted on a guess"
