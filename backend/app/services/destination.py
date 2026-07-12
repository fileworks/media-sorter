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
from app.services.conversion_service import predicted_image_suffix, predicted_video_suffix
from app.utils.media_utils import is_image, is_video
from app.utils.path_utils import sanitize_path_segment

# A single-pass re.sub is used so a token value that happens to contain
# another token name is never double-substituted.
_RENAME_TOKEN_RE = re.compile(r"YYYY|MM|DD|NAME|TYPE")

# Folders for files that cannot be placed in the normal date structure.
# Shared by SortingService (placement) and PreviewService (prediction).
QUARANTINE_FOLDERS: dict[str, str] = {
    "unknown": "_unknown_dates",
    "future": "_future_dates",
    "duplicate": "_duplicates",
    "failed": "_failed",
    "corrupted": "_corrupted",
    "junk": "_junk",
    "already_in_destination": "_already_in_destination",
}


def quarantine_dir(dest_root: Path, reason: str, file_path: Path, source_root: Path) -> Path:
    """Quarantine directory for *file_path*, preserving its source-relative
    subfolders (``_unknown_dates/2019-holiday/…``) so a large quarantine stays
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


def build_dest_dir(
    file_path: Path,
    extracted_date: date,
    source_root: Path,
    dest_root: Path,
    config: Config,
    category: str | None = None,
    camera: str = "",
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

    return dest_dir


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
