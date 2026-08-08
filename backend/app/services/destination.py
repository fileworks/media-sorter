"""Pure destination prediction shared by SortingService and PreviewService.

Both services must agree on where a file will land — the preview is a promise
the sort has to keep. Keeping the path math here, as side-effect-free
functions, guarantees the two can never drift (the historical bug was each
service re-implementing this by hand) and lets a dry run compute paths without
touching the filesystem: directories are created only by the actual copy/move
(``FileSystemService.safe_copy`` mkdirs the parent itself).
"""

import re
from datetime import date
from pathlib import Path

from app.core.config import UNCATEGORIZED_FOLDER, Config
from app.core.rules import append_contained_route
from app.services.conversion_service import predicted_image_suffix, predicted_video_suffix
from app.utils.media_utils import is_image, is_video
from app.utils.path_utils import sanitize_path_segment

# A single-pass re.sub is used so a token value that happens to contain
# another token name is never double-substituted.
_RENAME_TOKEN_RE = re.compile(r"YYYY|MM|DD|NAME|TYPE")

# Folders for files that have no meaningful place in the normal library.
# Duplicate copies are deliberately absent: `copy_destination` places those
# beside their keeper. A destination match is absent too because no second file
# is written when identical content is already present.
QUARANTINE_FOLDERS: dict[str, str] = {
    "unknown": "_undated",
    "future": "_undated",
    "failed": "_corrupted",
    "corrupted": "_corrupted",
    "junk": "_junk",
}

CONTEXTUAL_COPY_FOLDER = "_copies"

# Read-only recognition for destinations created by older versions. New runs
# never choose these names, but indexing their contents as ordinary library
# media would make old set-aside copies become keepers on the next run.
RETIRED_QUARANTINE_FOLDERS = frozenset(
    {
        "_unknown_dates",
        "_future_dates",
        "_duplicates",
        "_failed",
        "_already_in_destination",
    }
)
RECOGNIZED_SET_ASIDE_FOLDERS = frozenset(
    {*QUARANTINE_FOLDERS.values(), *RETIRED_QUARANTINE_FOLDERS, CONTEXTUAL_COPY_FOLDER}
)


def quarantine_dir(dest_root: Path, reason: str, file_path: Path, source_root: Path) -> Path:
    """Quarantine directory for *file_path*, preserving its source-relative
    subfolders (``_undated/2019-holiday/…``) so a large set-aside folder stays
    navigable and filename hints survive. Pure — never mkdirs. Files outside
    *source_root* (e.g. an already-placed destination file being quarantined as
    corrupted) fall back to the flat quarantine root.
    """
    base = dest_root / QUARANTINE_FOLDERS[reason]
    try:
        rel = file_path.parent.relative_to(source_root)
    except ValueError:
        return base
    return base / rel if str(rel) != "." else base


def copy_destination(
    keeper_destination: Path,
    keeper_source: Path,
    copy_source: Path,
    source_root: Path,
) -> Path:
    """Return the contextual, unreserved destination for a duplicate copy.

    The caller applies the shared collision reservation, exactly as for every
    other planned path. The leaf name makes both relationships readable on
    disk: which file won and which input root supplied this copy.
    """
    if keeper_destination.parent.name == CONTEXTUAL_COPY_FOLDER:
        raise ValueError("a duplicate keeper cannot itself be inside _copies")

    root_label = sanitize_path_segment(source_root.name) or "source"
    keeper_label = sanitize_path_segment(keeper_source.stem) or "keeper"
    filename = f"{keeper_label} — from {root_label}{copy_source.suffix}"
    return keeper_destination.parent / CONTEXTUAL_COPY_FOLDER / filename


def build_dest_dir(
    file_path: Path,
    extracted_date: date,
    source_root: Path,
    dest_root: Path,
    config: Config,
    category: str | None = None,
    camera: str = "",
    route_suffix: str | None = None,
) -> Path:
    """Compute the destination *directory* for a file. Pure — never mkdirs.

    Layout: date parts (per ``sort_criteria``), then either the topic folder or
    the preserved source subfolders, then the camera-model folder.
    """
    parts: list[str] = []
    if "year" in config.sort_criteria:
        parts.append(str(extracted_date.year))
    if "month" in config.sort_criteria:
        parts.append(f"{extracted_date.month:02d}")
    if "day" in config.sort_criteria:
        parts.append(f"{extracted_date.day:02d}")
    dest_dir = dest_root.joinpath(*parts) if parts else dest_root

    # Topic vs. source-subfolder are mutually exclusive organizing schemes:
    # Smart Categorization wins when enabled (the precedence is enforced here
    # regardless of config, so a hand-edited config.json stays deterministic).
    if config.categorize_enabled:
        seg = sanitize_path_segment(category) if category else ""
        dest_dir = dest_dir / (seg or UNCATEGORIZED_FOLDER)
    elif config.preserve_subfolders:
        # Recreate the source subfolder structure under the date folder.
        try:
            rel_parent = file_path.parent.relative_to(source_root)
            if str(rel_parent) != ".":
                dest_dir = dest_dir / rel_parent
        except ValueError:
            pass

    # Camera model subfolder (orthogonal — may stack under the topic folder).
    if config.camera_subfolder_enabled and camera:
        dest_dir = dest_dir / camera

    if route_suffix:
        dest_dir = append_contained_route(dest_dir, route_suffix)

    return dest_dir


def reserve_destination(path: Path, reserved: set[Path]) -> Path:
    """Return and reserve the first collision-free deterministic path."""
    candidate = path
    stem, suffix = path.stem, path.suffix
    counter = 0
    while candidate.exists() or candidate.resolve(strict=False) in reserved:
        counter += 1
        candidate = path.parent / f"{stem}_{counter:03d}{suffix}"
    reserved.add(candidate.resolve(strict=False))
    return candidate


def rename_stem(pattern: str, d: date, stem: str, file_type: str) -> str:
    """Substitute the rename tokens (YYYY, MM, DD, NAME, TYPE) into *pattern*."""
    tokens = {
        "YYYY": str(d.year),
        "MM": f"{d.month:02d}",
        "DD": f"{d.day:02d}",
        "NAME": stem,
        "TYPE": file_type,
    }
    return _RENAME_TOKEN_RE.sub(lambda m: tokens[m.group(0)], pattern)


def predicted_filename(file_path: Path, extracted_date: date, config: Config) -> str:
    """Predict the final filename the sort will produce for *file_path*.

    Mirrors the sort pipeline's post-placement steps in order: format
    conversion changes the suffix (a no-op when already in the target format),
    then the rename pattern rewrites the stem. Collision suffixes (``_001``)
    depend on the destination disk state and are deliberately not predicted.
    """
    suffix = file_path.suffix
    if config.convert_images and is_image(file_path):
        suffix = predicted_image_suffix(suffix, config.image_format)
    elif config.convert_videos and is_video(file_path):
        suffix = predicted_video_suffix(suffix, config.video_format)

    stem = file_path.stem
    if config.rename:
        file_type = "VID" if is_video(file_path) else "IMG"
        stem = rename_stem(config.rename_pattern, extracted_date, stem, file_type)
    return stem + suffix


def companion_destination(primary_destination: Path, companion: Path) -> Path:
    """Place a member beside its primary, inheriting its final collision stem."""
    return primary_destination.with_name(primary_destination.stem + companion.suffix)
