"""Shared, presentation-oriented grouping of the flat :class:`~app.core.config.Config`.

``Config`` stays a single flat dataclass. This module layers a *grouping*
descriptor on top so the configure screen's rail/detail panes and the per-section
help all read one shared definition, exposed via ``GET /api/config/sections``.

The frontend's section list (``CONFIG_SECTIONS`` in ``ConfigPanel.tsx``) is kept
aligned with this — same ids, labels, and descriptions — while supplying the
presentation-only pieces the backend can't express (an icon and the JSX control
body per section).
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ConfigSection:
    """One settings group: a stable ``id``, display ``label`` + one-line
    ``description``, and the flat ``Config`` field names it contains."""

    id: str
    label: str
    description: str
    fields: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "label": self.label,
            "description": self.description,
            "fields": list(self.fields),
        }


SECTIONS: tuple[ConfigSection, ...] = (
    ConfigSection(
        "essentials",
        "Essentials",
        "Set your source and destination folders, choose how files are dated, "
        "and whether they're copied or moved.",
        (
            "source_directory",
            "target_directory",
            "sort",
            "sort_criteria",
            "copy_instead_of_move",
        ),
    ),
    ConfigSection(
        "folders",
        "Folder structure",
        "How your sorted files are nested beneath each date folder.",
        (
            "camera_subfolder_enabled",
            "preserve_subfolders",
            "categorize_enabled",
            "categorize_categories",
            "categorize_confidence_threshold",
            "categorize_min_margin",
        ),
    ),
    ConfigSection(
        "duplicates",
        "Duplicate detection",
        "Find duplicate photos and videos and set the lesser copies aside.",
        (
            "remove_duplicates",
            "duplicate_exact_enabled",
            "duplicate_perceptual_enabled",
            "duplicate_perceptual_threshold",
        ),
    ),
    ConfigSection(
        "rename",
        "Rename files",
        "Give sorted files consistent, date-based names.",
        ("rename", "rename_pattern"),
    ),
    ConfigSection(
        "conversion",
        "Convert formats",
        "Standardize everything to one image and/or video format.",
        ("convert_images", "image_format", "convert_videos", "video_format"),
    ),
    ConfigSection(
        "filters",
        "Scan & filters",
        "Which files and folders to scan — and which to skip.",
        (
            "recursive_scan",
            "max_recursion_depth",
            "min_file_size_kb",
            "max_file_size_mb",
            "exclude_patterns",
            "junk_filter_enabled",
            "junk_min_file_size_kb",
            "junk_min_image_dimension",
            "junk_filename_patterns",
        ),
    ),
    ConfigSection(
        "rules",
        "Tagging rules",
        "Tag files automatically by extension, size, resolution, or filename.",
        ("rules_enabled", "rules"),
    ),
    ConfigSection(
        "ai",
        "AI content tagging",
        "Describe photos and videos with content keywords — independent of folder placement.",
        (
            "ai_tagging_enabled",
            "ai_tagging_provider",
            "ai_tagging_confidence_threshold",
            "ai_tagging_api_key",
            "ai_tagging_api_secret",
            "ai_tagging_endpoint",
            "ai_tagging_max_tags",
            "ai_tagging_embed_in_files",
            "ai_tagging_labels",
            "ai_model_tier",
            "ai_allow_gpu",
        ),
    ),
    ConfigSection(
        "other",
        "Other options",
        "Metadata fixes, corruption repair, and update settings.",
        ("override_metadata", "repair_enabled", "update_check_enabled"),
    ),
)

# Config fields intentionally *not* surfaced as a settings section: the source /
# target directories have their own selector, and these are internal or advanced
# flags without a dedicated control. Listed so the alignment test stays honest.
UNGROUPED_FIELDS: frozenset[str] = frozenset(
    {
        "analyze",
        "exif_sanity_check_enabled",
        # Advanced override without a dedicated control; the default (inside
        # the destination) is right for almost everyone.
        "dedup_index_path",
    }
)
