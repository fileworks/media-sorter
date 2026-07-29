"""Builds the immutable authorization record for one media placement.

Every default Copy or Move is expressed as a byte-identical manifest action
before anything is written, so the executor has a hash to prove the placement
against and reconciliation has a record to classify leftovers with.
"""

from __future__ import annotations

import os
import stat
import uuid
from pathlib import Path

from app.core.integrity import (
    FilesystemMetadataSnapshot,
    MutationActionKind,
    MutationEffects,
    MutationManifestAction,
    PreservationProfile,
    SidecarEffect,
    SourceEffect,
    SourceIdentity,
)
from app.core.media_units import CompanionRole
from app.core.provenance import OutcomeProvenance
from app.services.verified_transfer import stream_sha256


def build_placement_action(
    source: Path,
    destination: Path,
    *,
    kind: MutationActionKind,
    move: bool,
    preservation: PreservationProfile,
    root_id: str,
    relative_path: str,
    known_sha256: str | None = None,
    sidecar: SidecarEffect = "none",
    rule_version: str | None = None,
    action_id: str | None = None,
    unit_id: str | None = None,
    companion_role: CompanionRole | None = None,
    unit_primary_path: str | None = None,
    provenance: OutcomeProvenance | None = None,
) -> MutationManifestAction:
    """Authorize one byte-identical placement of ``source`` at ``destination``.

    ``known_sha256`` lets a caller that already hashed the file (duplicate
    detection does) skip a second full read. It is trusted only together with
    the identity snapshot taken here; the executor re-measures the content while
    it copies and refuses to publish anything that disagrees.
    """
    observed = source.stat()
    digest = known_sha256 or stream_sha256(source)[0]
    source_effect: SourceEffect = "remove_after_verification" if move else "retained"
    return MutationManifestAction(
        action_id=action_id or f"act_{uuid.uuid4().hex[:16]}",
        kind=kind,
        source=SourceIdentity(
            root_id=root_id,
            relative_path=relative_path,
            observed_path=str(source),
            file_id=str(observed.st_ino) if observed.st_ino else None,
            sha256=digest,
            metadata=_snapshot(observed),
        ),
        destination_path=str(destination),
        expected_sha256=digest,
        expected_size_bytes=observed.st_size,
        effects=MutationEffects(
            content="unchanged",
            embedded_metadata="preserved",
            sidecar=sidecar,
            filesystem_timestamps=(
                "preserve" if preservation.preserve_filesystem_timestamps else "change"
            ),
            source=source_effect,
        ),
        preservation_profile_id=preservation.profile_id,
        preservation_profile_version=preservation.schema_version,
        rule_version=rule_version,
        authorization_origin=preservation.authorization_origin,
        unit_id=unit_id,
        companion_role=companion_role,
        unit_primary_path=unit_primary_path,
        provenance=provenance,
    )


def _snapshot(observed: os.stat_result) -> FilesystemMetadataSnapshot:
    return FilesystemMetadataSnapshot(
        size_bytes=observed.st_size,
        mtime_ns=observed.st_mtime_ns,
        atime_ns=observed.st_atime_ns,
        mode=stat.S_IMODE(observed.st_mode),
    )
