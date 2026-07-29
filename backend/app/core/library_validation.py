"""Shared validation for role-aware MediaSorter library profiles."""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING

from app.core.exceptions import LibraryProfileError, SourceUnavailableError
from app.core.library_profiles import LibraryProfile, LibraryRoot, RootIdentity
from app.core.root_identity import probe_root_identity
from app.utils.path_utils import (
    canonicalize_target,
    path_relationship,
    validate_source_root,
)

if TYPE_CHECKING:
    from app.core.config import Config


@dataclass(frozen=True)
class ValidatedRoot:
    root: LibraryRoot
    canonical_path: Path
    identity: RootIdentity
    exclusions: tuple[Path, ...]


@dataclass(frozen=True)
class ValidatedLibraryProfile:
    profile: LibraryProfile
    inputs: tuple[ValidatedRoot, ...]
    references: tuple[ValidatedRoot, ...]
    destination: ValidatedRoot | None


def validate_library_profile(
    profile: LibraryProfile,
    *,
    require_destination: bool = True,
) -> ValidatedLibraryProfile:
    """Resolve and validate every enabled root through one shared contract."""
    if not profile.inputs:
        raise LibraryProfileError(
            "Add at least one input folder before continuing.",
            reason="input_required",
        )
    if require_destination and profile.destination is None:
        raise LibraryProfileError(
            "Choose one destination folder before continuing.",
            reason="destination_required",
        )

    validated: list[ValidatedRoot] = []
    for root in profile.roots:
        if root.role == "destination":
            canonical = canonicalize_target(root.path)
            identity_probe = probe_root_identity(canonical)
            identity = identity_probe.identity
            if identity_probe.availability == "not_directory":
                raise _root_error(
                    root, "Destination path is a file, not a folder.", "not_directory"
                )
        else:
            try:
                canonical = validate_source_root(root.path)
            except SourceUnavailableError as exc:
                if (
                    profile.profile_id == "default-library"
                    and root.root_id == "input-1"
                    and len(profile.inputs) == 1
                    and not profile.references
                ):
                    raise
                raise LibraryProfileError(
                    f"{_role_label(root)} is unavailable: {exc.message}",
                    root_id=root.root_id,
                    role=root.role,
                    path=root.path,
                    reason=exc.details.get("reason", "unavailable"),
                ) from exc
            identity_probe = probe_root_identity(canonical)
            identity = identity_probe.identity

        exclusions = _validated_exclusions(root, canonical)
        validated.append(
            ValidatedRoot(
                root=root,
                canonical_path=canonical,
                identity=identity,
                exclusions=exclusions,
            )
        )

    _validate_pairwise_separation(validated)
    inputs = tuple(item for item in validated if item.root.role == "input")
    references = tuple(item for item in validated if item.root.role == "reference")
    destination = next(
        (item for item in validated if item.root.role == "destination"),
        None,
    )
    return ValidatedLibraryProfile(
        profile=profile,
        inputs=inputs,
        references=references,
        destination=destination,
    )


def validate_configured_library(
    config: Config,
    *,
    require_destination: bool = True,
) -> ValidatedLibraryProfile:
    """Validate every typed root attached to Config through one shared contract."""
    profile = config.library_profile or LibraryProfile.from_legacy(
        source_directory=config.source_directory,
        target_directory=config.target_directory,
        copy_instead_of_move=config.copy_instead_of_move,
    )
    if profile.profile_id == "default-library" and not profile.inputs:
        validate_source_root(config.source_directory)
    return validate_library_profile(profile, require_destination=require_destination)


def _validated_exclusions(root: LibraryRoot, canonical_root: Path) -> tuple[Path, ...]:
    exclusions: list[Path] = []
    for raw in root.exclusions:
        candidate = Path(raw)
        if candidate.is_absolute() or any(part == os.pardir for part in candidate.parts):
            raise _root_error(
                root,
                f"Exclusion must be a relative child of its root: {raw}",
                "invalid_exclusion",
                exclusion=raw,
            )
        canonical = (canonical_root / candidate).resolve(strict=False)
        relationship = path_relationship(canonical_root, canonical)
        if relationship != "left_contains_right":
            raise _root_error(
                root,
                f"Exclusion must be below its configured root: {raw}",
                "invalid_exclusion",
                exclusion=raw,
            )
        exclusions.append(canonical)
    return tuple(exclusions)


def _validate_pairwise_separation(roots: list[ValidatedRoot]) -> None:
    for index, left in enumerate(roots):
        for right in roots[index + 1 :]:
            relationship = path_relationship(left.canonical_path, right.canonical_path)
            if relationship is None:
                continue
            raise LibraryProfileError(
                "Library locations must be different and separate; neither may contain another.",
                reason="root_overlap",
                relationship=relationship,
                left_root_id=left.root.root_id,
                left_role=left.root.role,
                left_path=str(left.canonical_path),
                right_root_id=right.root.root_id,
                right_role=right.root.role,
                right_path=str(right.canonical_path),
            )


def _role_label(root: LibraryRoot) -> str:
    return f"{root.role.capitalize()} {root.display_name or root.root_id!r}"


def _root_error(
    root: LibraryRoot,
    message: str,
    reason: str,
    **details: str,
) -> LibraryProfileError:
    return LibraryProfileError(
        message,
        root_id=root.root_id,
        role=root.role,
        path=root.path,
        reason=reason,
        **details,
    )
