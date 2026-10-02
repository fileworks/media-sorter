"""Execute an already-reviewed immutable manifest without re-planning it."""

from __future__ import annotations

from pathlib import Path

from app.core.action_journal import DurableActionJournal
from app.core.integrity import MutationManifest
from app.services.verified_transfer import TransferResult, execute_transfer


def execute_manifest(
    manifest: MutationManifest,
    *,
    state_root: Path,
) -> tuple[TransferResult, ...]:
    """Journal and verify every frozen action in order."""
    results: list[TransferResult] = []
    with DurableActionJournal.open(state_root, manifest) as journal:
        for action in manifest.actions:
            results.append(execute_transfer(action, journal=journal))
    return tuple(results)
