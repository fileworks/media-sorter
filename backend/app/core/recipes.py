"""Saved configuration recipes.

A recipe is a named snapshot of the settings that decide *how a run behaves* —
transfer posture, duplicate detection, renaming, conversion, tagging — and
nothing else. Folders, credentials, vocabularies and resource preferences are
excluded on purpose: a recipe is meant to be reusable across libraries, and a
snapshot that carried a path or an API key would not be.

The captured fields are an explicit model rather than a free-form mapping so
the round trip stays typed, a recipe written by an older build loads with the
current defaults filled in, and a recipe can never smuggle in a setting that
the user did not see when they saved it.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

SortCriterion = Literal["year", "month", "day"]

RECIPE_SCHEMA_VERSION: Literal[1] = 1

#: A user may keep this many recipes. The limit exists so a configuration file
#: cannot grow without bound through the UI; it is generous for the use case.
MAX_SAVED_RECIPES = 50

MAX_RECIPE_NAME_LENGTH = 60

_BUILT_IN_IDS = frozenset({"safe_sort", "clean_sweep", "archive_convert", "scratch"})


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class RecipeSettings(BaseModel):
    """The exact slice of a configuration that a recipe restores."""

    model_config = ConfigDict(extra="ignore")

    run_mode: Literal["organize", "deduplicate_only"] = "organize"
    sort: bool = True
    # Spelled out rather than inferred: a bare `["year"]` literal widens to
    # `list[str]`, which does not satisfy the annotated element type.
    sort_criteria: list[SortCriterion] = Field(
        default_factory=lambda: list[SortCriterion](["year"])
    )
    recursive_scan: bool = True
    max_recursion_depth: int | None = None
    preserve_subfolders: bool = False
    override_metadata: bool = False
    copy_instead_of_move: bool = False
    companion_handling: Literal["keep_with_primary", "leave_in_place", "ignore"] = (
        "keep_with_primary"
    )
    rename: bool = False
    rename_pattern: str = "TYPE_YYYY-MM-DD"
    remove_duplicates: bool = True
    duplicate_exact_enabled: bool = True
    duplicate_perceptual_enabled: bool = True
    duplicate_perceptual_threshold: int = 95
    duplicate_keeper_policy: Literal[
        "best_quality",
        "newest",
        "oldest",
        "largest",
        "smallest",
        "highest_resolution",
        "longest_filename",
        "shortest_filename",
        "manual",
    ] = "newest"
    burst_detection_enabled: bool = False
    burst_time_window_seconds: float = 3.0
    burst_perceptual_distance: int = 4
    burst_require_camera_identity: bool = True
    junk_filter_enabled: bool = False
    junk_min_file_size_kb: int = 8
    junk_min_image_dimension: int = 200
    junk_filename_patterns: list[str] = Field(
        default_factory=lambda: [
            "Thumbs.db",
            "ehthumbs.db",
            "desktop.ini",
            "._*",
            "*-thumb.*",
            "*_thumb.*",
            ".thumbnails",
            ".thumbs",
        ]
    )
    categorize_enabled: bool = False
    categorize_confidence_threshold: float = 0.55
    categorize_min_margin: float = 0.15
    convert_images: bool = False
    image_format: Literal["jpeg", "png", "webp", "tiff"] = "jpeg"
    image_quality: int = 90
    convert_videos: bool = False
    video_format: Literal["mp4", "mkv", "mov", "webm", "avi"] = "mp4"
    video_quality: Literal["low", "medium", "high"] = "medium"
    repair_enabled: bool = False
    rules_enabled: bool = True
    ai_tagging_enabled: bool = False
    ai_tagging_confidence_threshold: float = 0.5
    ai_tagging_max_tags: int = 10
    embed_tags_in_files: bool = False
    exclude_patterns: list[str] = Field(
        default_factory=lambda: [
            "@eaDir",
            ".@__thumb",
            "@Recycle",
            "Thumbs.db",
            "desktop.ini",
            ".DS_Store",
            ".Spotlight-V100",
            "eaRecycle",
        ]
    )
    min_file_size_kb: int | None = None
    max_file_size_mb: int | None = None
    camera_subfolder_enabled: bool = False
    exif_sanity_check_enabled: bool = True
    ai_model_tier: Literal["auto", "off", "lite", "standard", "max"] = "auto"

    @field_validator("sort_criteria")
    @classmethod
    def at_least_one_criterion(cls, value: list[str]) -> list[str]:
        if not value:
            raise ValueError("A recipe needs at least one sort criterion")
        return value


def normalized_recipe_name(value: str) -> str:
    """Collapse whitespace and enforce the length bound, or say why it fails.

    Shared by the model below and the request body that feeds it, so the rule
    is stated once and a bad name is rejected at the boundary rather than deep
    inside a handler.
    """
    cleaned = re.sub(r"\s+", " ", value).strip()
    if not cleaned:
        raise ValueError("A recipe needs a name")
    if len(cleaned) > MAX_RECIPE_NAME_LENGTH:
        raise ValueError(f"A recipe name may be at most {MAX_RECIPE_NAME_LENGTH} characters")
    return cleaned


class SavedRecipe(BaseModel):
    """One named recipe, as persisted in the configuration file."""

    model_config = ConfigDict(extra="ignore")

    schema_version: Literal[1] = RECIPE_SCHEMA_VERSION
    recipe_id: str
    name: str
    created_at: str = Field(default_factory=utc_now_iso)
    settings: RecipeSettings = Field(default_factory=RecipeSettings)

    @field_validator("name")
    @classmethod
    def name_is_a_label(cls, value: str) -> str:
        return normalized_recipe_name(value)

    @field_validator("recipe_id")
    @classmethod
    def id_does_not_shadow_a_built_in(cls, value: str) -> str:
        if value in _BUILT_IN_IDS:
            raise ValueError(f"{value!r} is the id of a built-in recipe")
        if not value:
            raise ValueError("A recipe needs an id")
        return value


def new_recipe_id() -> str:
    return f"custom-{uuid.uuid4().hex[:12]}"


def is_built_in(recipe_id: str) -> bool:
    return recipe_id in _BUILT_IN_IDS
