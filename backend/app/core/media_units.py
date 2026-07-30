"""Typed media-unit discovery.

A media unit is one primary media file plus files that only make sense beside
it.  Pairing is deliberately conservative: a matching stem is necessary but
never sufficient, and members must live in the same directory.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from app.utils.media_utils import IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, is_media

CompanionRole = Literal[
    "edit_sidecar",
    "motion_part",
    "raw_sibling",
    "thumbnail_part",
    "audio_note",
]
CompanionHandling = Literal["keep_with_primary", "leave_in_place", "ignore"]

RAW_EXTENSIONS = frozenset(
    {
        ".raw",
        ".arw",
        ".cr2",
        ".cr3",
        ".crw",
        ".dng",
        ".erf",
        ".kdc",
        ".mef",
        ".mrw",
        ".nef",
        ".nrw",
        ".orf",
        ".pef",
        ".ptx",
        ".r3d",
        ".raf",
        ".rw2",
        ".rwl",
        ".sr2",
        ".srf",
        ".srw",
        ".x3f",
    }
)
HEIC_EXTENSIONS = frozenset({".heic", ".heif"})
JPEG_EXTENSIONS = frozenset({".jpg", ".jpeg", ".jpe", ".jfif"})
EDIT_SIDECAR_EXTENSIONS = frozenset({".xmp", ".aae", ".pp3", ".dop", ".on1", ".reastore"})
ROLE_BEARING_EXTENSIONS = EDIT_SIDECAR_EXTENSIONS | {".thm", ".wav"}


@dataclass(frozen=True)
class MediaUnitMember:
    path: Path
    companion_role: CompanionRole | None
    is_primary: bool = False


@dataclass(frozen=True)
class MediaUnit:
    unit_id: str
    primary: Path
    members: tuple[MediaUnitMember, ...]

    @property
    def companions(self) -> tuple[MediaUnitMember, ...]:
        return tuple(member for member in self.members if not member.is_primary)


@dataclass(frozen=True)
class UnmatchedCompanion:
    path: Path
    companion_role: CompanionRole
    reason: str = "no_primary_in_same_directory"


def _key(path: Path, *, case_sensitive: bool) -> tuple[str, str]:
    parent = str(path.parent)
    stem = path.stem
    return (parent, stem) if case_sensitive else (parent.casefold(), stem.casefold())


def _primary_rank(path: Path) -> tuple[int, str]:
    suffix = path.suffix.lower()
    if suffix in RAW_EXTENSIONS:
        rank = 0
    elif suffix in HEIC_EXTENSIONS:
        rank = 1
    elif suffix in JPEG_EXTENSIONS:
        rank = 2
    elif suffix in IMAGE_EXTENSIONS:
        rank = 3
    elif suffix in VIDEO_EXTENSIONS:
        rank = 4
    else:
        rank = 5
    return rank, path.name.casefold()


def _unit_id(root: Path, primary: Path) -> str:
    try:
        relative = primary.relative_to(root)
    except ValueError:
        relative = primary
    identity = f"{relative.parent.as_posix().casefold()}/{relative.stem.casefold()}"
    return f"unit_{hashlib.sha256(identity.encode('utf-8')).hexdigest()[:20]}"


def _non_media_role(path: Path, primary: Path) -> CompanionRole | None:
    suffix = path.suffix.lower()
    primary_suffix = primary.suffix.lower()
    if suffix in EDIT_SIDECAR_EXTENSIONS:
        return "edit_sidecar"
    if suffix == ".thm" and primary_suffix in VIDEO_EXTENSIONS:
        return "thumbnail_part"
    if suffix == ".wav" and primary_suffix in IMAGE_EXTENSIONS:
        return "audio_note"
    return None


def _media_role(path: Path, primary: Path) -> CompanionRole | None:
    suffix = path.suffix.lower()
    primary_suffix = primary.suffix.lower()
    if suffix == ".mov" and primary_suffix in HEIC_EXTENSIONS | JPEG_EXTENSIONS:
        return "motion_part"
    if primary_suffix in RAW_EXTENSIONS and suffix in JPEG_EXTENSIONS | HEIC_EXTENSIONS:
        return "raw_sibling"
    return None


def bind_media_units(
    paths: list[Path],
    root: Path,
    *,
    handling: CompanionHandling = "keep_with_primary",
    case_sensitive: bool = False,
) -> tuple[list[MediaUnit], list[UnmatchedCompanion]]:
    """Bind eligible media and role-bearing files into deterministic units."""
    media = [path for path in paths if is_media(path)]
    if handling == "ignore":
        return [
            MediaUnit(
                _unit_id(root, path),
                path,
                (MediaUnitMember(path=path, companion_role=None, is_primary=True),),
            )
            for path in sorted(media)
        ], []

    grouped_media: dict[tuple[str, str], list[Path]] = {}
    grouped_candidates: dict[tuple[str, str], list[Path]] = {}
    for path in paths:
        key = _key(path, case_sensitive=case_sensitive)
        if is_media(path):
            grouped_media.setdefault(key, []).append(path)
        elif path.suffix.lower() in ROLE_BEARING_EXTENSIONS:
            grouped_candidates.setdefault(key, []).append(path)

    units: list[MediaUnit] = []
    unmatched: list[UnmatchedCompanion] = []
    all_keys = set(grouped_media) | set(grouped_candidates)
    for key in sorted(all_keys):
        media_group = sorted(grouped_media.get(key, []))
        candidates = sorted(grouped_candidates.get(key, []))
        if not media_group:
            for path in candidates:
                unmatched_role: CompanionRole = "edit_sidecar"
                if path.suffix.lower() == ".thm":
                    unmatched_role = "thumbnail_part"
                elif path.suffix.lower() == ".wav":
                    unmatched_role = "audio_note"
                unmatched.append(UnmatchedCompanion(path, unmatched_role))
            continue

        primary = min(media_group, key=_primary_rank)
        members = [MediaUnitMember(primary, None, True)]
        consumed_media = {primary}
        for path in media_group:
            if path == primary:
                continue
            media_role = _media_role(path, primary)
            if media_role is not None:
                members.append(MediaUnitMember(path, media_role))
                consumed_media.add(path)
        for path in candidates:
            non_media_role = _non_media_role(path, primary)
            if non_media_role is None:
                # It bears a known role, but not for this kind of primary.
                fallback: CompanionRole = (
                    "thumbnail_part" if path.suffix.lower() == ".thm" else "audio_note"
                )
                unmatched.append(UnmatchedCompanion(path, fallback, "pairing_precondition_failed"))
            else:
                members.append(MediaUnitMember(path, non_media_role))

        units.append(MediaUnit(_unit_id(root, primary), primary, tuple(members)))
        for path in media_group:
            if path not in consumed_media:
                units.append(
                    MediaUnit(
                        _unit_id(root, path),
                        path,
                        (MediaUnitMember(path, None, True),),
                    )
                )
    return sorted(units, key=lambda unit: str(unit.primary)), sorted(
        unmatched, key=lambda item: str(item.path)
    )
