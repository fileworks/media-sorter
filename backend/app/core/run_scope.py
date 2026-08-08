"""Derive one operation's root scope without changing the saved profile."""

from __future__ import annotations

import os
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from app.core.exceptions import LibraryProfileError
from app.core.library_profiles import LibraryProfile, LibraryRoot
from app.utils.path_utils import path_relationship

if TYPE_CHECKING:
    from app.core.config import Config


@dataclass(frozen=True)
class AppliedRunScope:
    """A copied config plus the roots deliberately omitted from this run."""

    config: Config
    excluded_root_ids: tuple[str, ...]
    excluded_paths: tuple[str, ...]


def apply_run_scope(config: Config, excluded_roots: Iterable[str] = ()) -> AppliedRunScope:
    """Return a run-local config with selected input/reference roots removed.

    The public transport accepts stable root ids. Existing clients and tests may
    also send a root path; aliases are resolved through the same canonical,
    component-aware relationship check used by profile validation. A root-id
    match never probes the folder, which is important when an unavailable drive
    is precisely what the user chose to leave out.
    """
    # Local import avoids making Config's module import its own scope adapter.
    from app.core.config import Config

    snapshot = Config.from_dict(config.to_dict())
    profile = snapshot.library_profile or LibraryProfile.from_legacy(
        source_directory=snapshot.source_directory,
        target_directory=snapshot.target_directory,
        copy_instead_of_move=snapshot.copy_instead_of_move,
    )
    requested = tuple(dict.fromkeys(value.strip() for value in excluded_roots if value.strip()))
    if not requested:
        return AppliedRunScope(snapshot, (), ())

    excluded: list[LibraryRoot] = []
    matched: set[str] = set()
    by_id = {root.root_id: root for root in profile.roots}
    for value in requested:
        root = by_id.get(value)
        if root is None:
            root = next(
                (
                    candidate
                    for candidate in profile.roots
                    if _same_root_path(value, candidate.path)
                ),
                None,
            )
        if root is None:
            raise LibraryProfileError(
                f"Run exclusion does not name a configured folder: {value}",
                reason="unknown_run_exclusion",
                exclusion=value,
            )
        if root.role == "destination":
            raise LibraryProfileError(
                "The destination cannot be excluded from a run.",
                root_id=root.root_id,
                role=root.role,
                path=root.path,
                reason="destination_run_exclusion",
            )
        if root.root_id not in matched:
            matched.add(root.root_id)
            excluded.append(root)

    active = [root for root in profile.roots if root.root_id not in matched]
    snapshot.library_profile = profile.model_copy(update={"roots": active})
    inputs = snapshot.library_profile.inputs
    snapshot.source_directory = inputs[0].path if inputs else ""
    destination = snapshot.library_profile.destination
    snapshot.target_directory = destination.path if destination is not None else ""
    return AppliedRunScope(
        snapshot,
        tuple(root.root_id for root in excluded),
        tuple(root.path for root in excluded),
    )


def _same_root_path(requested: str, configured: str) -> bool:
    """Compare two root spellings without prefix-based false positives."""
    requested_path = Path(requested).expanduser()
    configured_path = Path(configured).expanduser()
    try:
        requested_path = requested_path.resolve(strict=False)
        configured_path = configured_path.resolve(strict=False)
    except OSError:
        # An unavailable path can still match its configured spelling. On
        # Windows normcase also handles drive-letter and path-case variants.
        pass
    if os.path.normcase(str(requested_path)) == os.path.normcase(str(configured_path)):
        return True
    return path_relationship(requested_path, configured_path) == "equal"
