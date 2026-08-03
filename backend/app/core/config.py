"""Application configuration management."""

import hashlib
import json
import logging
import os
import re
import tempfile
import time
import types
import typing
from dataclasses import dataclass, field, fields
from pathlib import Path
from typing import Any, Literal, Union, get_args, get_origin

from pydantic import BaseModel, TypeAdapter, ValidationError, field_validator

from app.core.concepts import Locale, bundled_labels
from app.core.integrity import OptimizationProfile, PreservationProfile, utc_now
from app.core.library_profiles import LibraryProfile
from app.core.paths import resolve_app_paths
from app.core.recipes import MAX_SAVED_RECIPES, SavedRecipe
from app.core.rules import RuleSet, migrate_legacy_rules, normalized_key


class UnsupportedRuleSetVersionError(RuntimeError):
    """Persisted rules require a newer application and must not be rewritten."""


class SortCriteria(BaseModel):
    """Validation model for sort criteria."""

    criteria: list[Literal["year", "month", "day"]]

    @field_validator("criteria")
    @classmethod
    def at_least_one(cls, v: list[str]) -> list[str]:
        if not v:
            raise ValueError("At least one sort criterion required")
        return v


@dataclass
class Config:
    """Application configuration."""

    language: Locale = "en"

    # Directories
    source_directory: str = ""
    target_directory: str = ""
    # Versioned multi-root contract.  The legacy path fields remain during the
    # compatibility window and mirror this profile's primary input/destination.
    library_profile: LibraryProfile | None = None
    # Media mutation is authorized separately from location/sorting settings.
    # New and safely migrated configurations use strict Organize Only.
    preservation_profile: PreservationProfile = field(default_factory=PreservationProfile)
    optimization_profile: OptimizationProfile = field(default_factory=OptimizationProfile)
    # The user's own named starting points, alongside the four built-in ones the
    # UI ships. Ordered most-recently-saved first.
    saved_recipes: list[SavedRecipe] = field(default_factory=list)

    # Sorting
    sort: bool = True
    sort_criteria: list[str] = field(default_factory=lambda: ["year"])
    # When True, recreate the source subfolder structure under each date folder
    # (e.g. 2024/vacation/img.jpg). When False (default), files go straight into
    # the date folder and the original subfolders are dropped.
    preserve_subfolders: bool = False

    # Recursive scanning
    recursive_scan: bool = True
    max_recursion_depth: int | None = None

    # Metadata
    override_metadata: bool = False

    # File operations
    copy_instead_of_move: bool = False
    companion_handling: Literal["keep_with_primary", "leave_in_place", "ignore"] = (
        "keep_with_primary"
    )
    thumbnail_cache_enabled: bool = True
    thumbnail_cache_budget_bytes: int = 512 * 1024 * 1024

    # Renaming
    rename: bool = False
    rename_pattern: str = "TYPE_YYYY-MM-DD"

    # Duplicates — always quarantined to _duplicates/, never deleted. (The old
    # duplicate_action="delete" option was removed 2026-07-11; legacy config
    # files carrying that key load fine because from_dict drops unknown keys.)
    remove_duplicates: bool = True

    # Conversion
    convert_videos: bool = False
    video_format: Literal["mp4", "mkv", "mov", "webm", "avi"] = "mp4"
    # Re-encode quality for video conversion, mapped to a CRF by the converter.
    video_quality: Literal["low", "medium", "high"] = "medium"
    convert_images: bool = False
    image_format: Literal["jpeg", "png", "webp", "tiff"] = "jpeg"
    # Encoder quality for lossy image formats (JPEG/WebP). Ignored by PNG and
    # TIFF, which are lossless. Bounded by IMAGE_QUALITY_MIN/MAX.
    image_quality: int = 90

    # Repair / validation
    repair_enabled: bool = False

    # Rule-based tagging
    rules_enabled: bool = True
    rule_set: RuleSet = field(default_factory=RuleSet)
    # Read-only constructor/file compatibility. This is converted to ``rule_set``
    # and never returned by the API or persisted again.
    rules: list[dict[str, Any]] = field(default_factory=list)

    # ── AI content tagging (descriptive keywords) ────────────────────────────
    # Writes descriptive tags INTO files / the report. This group is *metadata*
    # only — it never changes where a file is placed. (Smart Categorization,
    # below, is the independent *folder routing* feature.)
    # provider ∈ {"local", "azure_vision", "imagga", "google_cloud_vision"}.
    # "local" is the offline, no-key default (CLIP zero-shot via fastembed).
    ai_tagging_enabled: bool = False
    ai_tagging_provider: str = "local"
    # For the local CLIP tagger this is a per-label probability: how much more the
    # label fits the image than a generic "a photo" background (0.5 = the natural
    # midpoint). Cloud providers reuse it as their own confidence cut-off.
    ai_tagging_confidence_threshold: float = 0.5
    # Cloud credentials (one simple shape across providers):
    #   - api_key:      Azure subscription key / Imagga key / Google API key
    #   - api_secret:   Imagga secret (unused by the others)
    #   - endpoint:     Azure resource endpoint, e.g. https://<name>.cognitiveservices.azure.com
    ai_tagging_api_key: str | None = None
    ai_tagging_api_secret: str | None = None
    ai_tagging_endpoint: str | None = None
    # Max tags written per file; whether to embed tags into the media files.
    ai_tagging_max_tags: int = 10
    embed_tags_in_files: bool = False
    # Compatibility input for configurations saved before the common setting.
    # ``None`` means the canonical setting was used.
    ai_tagging_embed_in_files: bool | None = None
    # Editable label vocabulary scored by the local CLIP zero-shot tagger.
    ai_tagging_labels: list[str] = field(
        default_factory=lambda: [
            # Places & environments
            "beach",
            "mountain",
            "forest",
            "city",
            "landscape",
            "sunset",
            "sunrise",
            "sky",
            "snow",
            "water",
            "night",
            "indoor",
            "outdoor",
            # People
            "portrait",
            "selfie",
            "group photo",
            # Events & activities
            "wedding",
            "birthday",
            "party",
            "concert",
            "sport",
            "hiking",
            "camping",
            # Food & drink
            "food",
            "drink",
            # Animals
            "pet",
            "dog",
            "cat",
            "bird",
            "wildlife",
            "flower",
            # Vehicles
            "car",
            "boat",
            "airplane",
            # Urban
            "building",
            "street",
            # Travel
            "travel",
            "landmark",
            # Documents & screen
            "document",
            "screenshot",
            "receipt",
            "whiteboard",
            "text",
            # Art & media
            "artwork",
            "meme",
            "graph",
            "map",
        ]
    )
    ai_tagging_labels_provenance: Literal["bundled", "custom"] | None = None

    # ── Smart Categorization (local CLIP routing into topic folders) ──────────
    # Independent of the ai_tagging_* group above: this decides WHERE a file is
    # placed — it nests each file under its date folder in a user-named topic
    # subfolder (…/Y/M/D/<category>/), exactly like the camera subfolder. Files
    # the classifier is not confident about go to …/Y/M/D/_uncategorized/.
    # Local-CLIP only (no cloud taxonomy can match the user's folder names).
    categorize_enabled: bool = False
    categorize_categories: list[str] = field(
        default_factory=lambda: [
            "screenshots",
            "documents",
            "receipts",
            "food",
            "nature",
            "people",
            "pets",
            "travel",
            "events",
            "sports",
            "memes",
        ]
    )
    categorize_categories_provenance: Literal["bundled", "custom"] | None = None
    # Top-1 softmax probability floor. The softmax is now computed over the
    # categories *plus* background anchors at an un-saturated temperature (see
    # CategoryClassifierService), so this is a genuinely discriminating bar — a
    # mid-range default rather than the old, effectively-disabled 0.85.
    categorize_confidence_threshold: float = 0.55
    categorize_min_margin: float = 0.15  # required top1 - top2 separation

    # Analysis
    analyze: bool = False

    # Folder exclusion (glob patterns relative to source root)
    exclude_patterns: list[str] = field(
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

    # File size filter
    min_file_size_kb: int | None = None  # None = no limit
    max_file_size_mb: int | None = None  # None = no limit

    # Camera model subfolder
    camera_subfolder_enabled: bool = False

    # Duplicate detection flags
    duplicate_exact_enabled: bool = True
    duplicate_perceptual_enabled: bool = True
    duplicate_perceptual_threshold: int = 95
    # Which copy a duplicate group keeps when nobody has chosen one by hand.
    # A *default*, not a decision: Review can override it per group, in bulk, or
    # not at all — an undecided group is quarantined for nothing, it just stays
    # undecided. A protected reference member always wins regardless.
    duplicate_keeper_policy: Literal[
        "best_quality",
        "newest",
        "oldest",
        "largest",
        "smallest",
        "highest_resolution",
        "longest_filename",
        "shortest_filename",
    ] = "best_quality"
    burst_detection_enabled: bool = False
    burst_time_window_seconds: float = 3.0
    burst_perceptual_distance: int = 4
    burst_require_camera_identity: bool = True

    # Destination media are always indexed when duplicate removal is enabled.
    # Legacy persisted ``dedup_against_destination`` keys are ignored by
    # ``from_dict`` now that the unsafe opt-out has been removed.
    # Where the index database lives. None → "<target>/.mediasort-dedup-index.sqlite3"
    # (hidden inside the destination, so the index travels with the library).
    dedup_index_path: str | None = None

    # ── Junk / thumbnail filter ───────────────────────────────────────────────
    # Tiny previews and cache debris are quarantined to _junk/ (never deleted).
    # Off by default (a behaviour change must be opted into); recommended for
    # messy phone/HDD dumps.
    junk_filter_enabled: bool = False
    junk_min_file_size_kb: int = 8  # 0 disables the size floor
    junk_min_image_dimension: int = 200  # shorter side, px; 0 disables
    junk_filename_patterns: list[str] = field(
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

    # EXIF sanity check
    exif_sanity_check_enabled: bool = True

    # Update checker — set False to disable the GitHub Releases network call.
    update_check_enabled: bool = True

    # ── AI engine settings ────────────────────────────────────────────────────
    # Model tier used for local CLIP/SigLIP inference.
    # "auto" → let HardwareProfile.probe() choose based on CPU/RAM/EP detection.
    # Explicit values: "off" | "lite" | "standard" | "max".
    ai_model_tier: str = "auto"
    # When True, allow GPU execution providers (CUDA, CoreML, DirectML…).
    # Set False to force CPU-only inference (useful for shared machines or
    # reproducibility).
    ai_allow_gpu: bool = True

    # Ephemeral load metadata used to surface migration warnings and decide
    # whether ConfigLoader must create a pre-migration backup. Never persisted.
    migration_warnings: list[str] = field(default_factory=list, repr=False, compare=False)
    migrated_legacy_rules: bool = field(default=False, repr=False, compare=False)

    def __post_init__(self) -> None:
        if isinstance(self.library_profile, dict):
            self.library_profile = LibraryProfile.model_validate(self.library_profile)
        if isinstance(self.preservation_profile, dict):
            self.preservation_profile = PreservationProfile.model_validate(
                self.preservation_profile
            )
        if isinstance(self.optimization_profile, dict):
            self.optimization_profile = OptimizationProfile.model_validate(
                self.optimization_profile
            )
        if self.library_profile is None:
            self.library_profile = LibraryProfile.from_legacy(
                source_directory=self.source_directory,
                target_directory=self.target_directory,
                copy_instead_of_move=self.copy_instead_of_move,
            )
        else:
            primary_input = self.library_profile.inputs[0] if self.library_profile.inputs else None
            destination = self.library_profile.destination
            self.source_directory = primary_input.path if primary_input is not None else ""
            self.target_directory = destination.path if destination is not None else ""
            self.copy_instead_of_move = self.library_profile.transfer_mode == "copy"
        self.saved_recipes = [
            recipe if isinstance(recipe, SavedRecipe) else SavedRecipe.model_validate(recipe)
            for recipe in self.saved_recipes
        ][:MAX_SAVED_RECIPES]
        if isinstance(self.rule_set, dict):
            self.rule_set = RuleSet.model_validate(self.rule_set)
        if self.rules and not self.rule_set.tag_rules and not self.rule_set.route_rules:
            migrated, warnings = migrate_legacy_rules(self.rules)
            self.rule_set = migrated
            self.migration_warnings.extend(warnings)
            self.migrated_legacy_rules = True
        if self.ai_tagging_embed_in_files is not None:
            self.embed_tags_in_files = self.ai_tagging_embed_in_files
        self.ai_tagging_embed_in_files = self.embed_tags_in_files
        if self.preservation_profile.requires_review:
            self.migration_warnings.append(
                "Previously enabled media-modifying settings require review before execution."
            )
        if self.ai_tagging_labels_provenance is None:
            self.ai_tagging_labels_provenance = (
                "bundled"
                if _same_vocabulary(self.ai_tagging_labels, bundled_labels("tag", "en"))
                else "custom"
            )
        if self.categorize_categories_provenance is None:
            self.categorize_categories_provenance = (
                "bundled"
                if _same_vocabulary(self.categorize_categories, bundled_labels("category", "en"))
                else "custom"
            )

    @classmethod
    def defaults(cls) -> "Config":
        return cls()

    def to_dict(self) -> dict[str, Any]:
        omitted = {
            "rules",
            "ai_tagging_embed_in_files",
            "migration_warnings",
            "migrated_legacy_rules",
        }
        result: dict[str, Any] = {}
        for config_field in fields(self):
            if config_field.name in omitted:
                continue
            value = getattr(self, config_field.name)
            if isinstance(value, BaseModel):
                value = value.model_dump(mode="json")
            elif isinstance(value, list) and any(isinstance(item, BaseModel) for item in value):
                value = [
                    item.model_dump(mode="json") if isinstance(item, BaseModel) else item
                    for item in value
                ]
            result[config_field.name] = value
        if self.ai_tagging_labels_provenance == "bundled":
            result["ai_tagging_labels"] = self.resolved_ai_tagging_labels()
        if self.categorize_categories_provenance == "bundled":
            result["categorize_categories"] = self.resolved_categories()
        return result

    def resolved_ai_tagging_labels(self) -> list[str]:
        if self.ai_tagging_labels_provenance == "bundled":
            return bundled_labels("tag", self.language)
        return list(self.ai_tagging_labels)

    def resolved_categories(self) -> list[str]:
        if self.categorize_categories_provenance == "bundled":
            return bundled_labels("category", self.language)
        return list(self.categorize_categories)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Config":
        # Drop unknown keys (the "$schema" marker, or fields written by a newer
        # build) so a stray key never raises a TypeError in the constructor.
        source = dict(data)
        migrated = "rule_set" not in source and "rules" in source
        warnings: list[str] = []
        if migrated:
            source["rule_set"], warnings = migrate_legacy_rules(source.get("rules"))
        if "rule_set" in source and not isinstance(source["rule_set"], RuleSet):
            source["rule_set"] = RuleSet.model_validate(source["rule_set"])

        if "embed_tags_in_files" not in source and "ai_tagging_embed_in_files" in source:
            source["embed_tags_in_files"] = source["ai_tagging_embed_in_files"]

        english_tags = bundled_labels("tag", "en")
        english_categories = bundled_labels("category", "en")
        if "ai_tagging_labels_provenance" not in source:
            source["ai_tagging_labels_provenance"] = (
                "bundled"
                if _same_vocabulary(source.get("ai_tagging_labels"), english_tags)
                else "custom"
            )
        if "categorize_categories_provenance" not in source:
            source["categorize_categories_provenance"] = (
                "bundled"
                if _same_vocabulary(source.get("categorize_categories"), english_categories)
                else "custom"
            )

        if "preservation_profile" not in source:
            source["preservation_profile"] = _migrated_preservation_profile(source)

        known = {f.name for f in fields(cls)}
        filtered = {
            k: v for k, v in source.items() if k in known and k != "dedup_against_destination"
        }
        filtered["migration_warnings"] = warnings
        filtered["migrated_legacy_rules"] = migrated
        filtered["rules"] = []
        return cls(**filtered)


def _migrated_preservation_profile(source: dict[str, Any]) -> PreservationProfile:
    """Carry a pre-profile configuration forward without changing what it does.

    A configuration saved before mutation profiles existed keeps whatever it had
    switched on, but it is marked for review: the settings are retained, and the
    next execution is blocked until someone confirms they are still wanted.
    Nothing is silently enabled and nothing is silently turned off.
    """
    embedded = bool(source.get("override_metadata")) or (
        bool(source.get("ai_tagging_enabled"))
        and bool(source.get("embed_tags_in_files", source.get("ai_tagging_embed_in_files")))
    )
    repair = bool(source.get("repair_enabled"))
    conversion = bool(source.get("convert_images")) or bool(source.get("convert_videos"))
    if not (embedded or repair or conversion):
        return PreservationProfile()
    return PreservationProfile(
        profile_id="migrated-mutation",
        name="Carried over from a previous configuration",
        mode="explicit_mutation",
        allow_embedded_metadata_edits=embedded,
        allow_repair=repair,
        allow_conversion=conversion,
        allow_compression=conversion,
        authorization_origin="migration",
        requires_review=True,
    )


def reset_to_organize_only(config: "Config") -> "Config":
    """Roll a configuration back to the strict byte-identical default.

    This is the rollback path: it can only remove authorization, never grant it,
    so it cannot weaken the default guarantee no matter what it is applied to.
    """
    config.preservation_profile = PreservationProfile()
    config.optimization_profile = OptimizationProfile()
    config.override_metadata = False
    config.embed_tags_in_files = False
    config.ai_tagging_embed_in_files = False
    config.repair_enabled = False
    config.convert_images = False
    config.convert_videos = False
    return config


def acknowledge_migrated_profile(config: "Config") -> "Config":
    """Confirm carried-over mutating settings so execution may proceed."""
    profile = config.preservation_profile
    if not profile.requires_review:
        return config
    config.preservation_profile = profile.model_copy(
        update={"requires_review": False, "acknowledged_at": utc_now()}
    )
    return config


def _same_vocabulary(raw: object, expected: list[str]) -> bool:
    if raw is None:
        return True
    if not isinstance(raw, list) or not all(isinstance(value, str) for value in raw):
        return False
    return [normalized_key(value) for value in raw] == [normalized_key(value) for value in expected]


def coerce_config_update(body: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    """Validate a partial ``POST /config`` body against the Config field types.

    Returns ``(coerced, errors)``. ``coerced`` holds the recognised keys with
    their values coerced to the declared field type (so an int sent for a float
    field is stored as a float, a numeric string for an int field as an int).
    ``errors`` lists unknown keys (likely typos that would otherwise be silently
    dropped) and values whose type can't be coerced to the field's type (e.g. a
    ``Literal`` outside its allowed set, or a string for a list field) — which
    would otherwise be stored and explode at sort time. The ``$schema`` marker
    is silently ignored (it is written into the on-disk config for editor
    support). Callers turn a non-empty ``errors`` into a 422.

    Only the keys *present in the body* are validated, never the whole merged
    config: a pre-existing stored value must never block an unrelated update.
    """
    hints = typing.get_type_hints(Config)
    coerced: dict[str, Any] = {}
    errors: list[str] = []
    for key, value in body.items():
        if key == "$schema":
            continue
        if key == "rules":
            errors.append("config.rules.legacy_payload_rejected")
            continue
        if key == "ai_tagging_embed_in_files":
            key = "embed_tags_in_files"
        if key not in hints:
            errors.append(f"Unknown config field: {key!r}")
            continue
        try:
            coerced[key] = TypeAdapter(hints[key]).validate_python(value)
        except ValidationError:
            errors.append(f"Invalid value for {key!r}")
    return coerced, errors


# Tokens recognised in ``rename_pattern`` and substituted by SortingService.
RENAME_TOKENS: frozenset[str] = frozenset({"YYYY", "MM", "DD", "NAME", "TYPE"})

# Inclusive bounds for ``duplicate_perceptual_threshold`` (matches the UI slider).
PERCEPTUAL_THRESHOLD_MIN = 85
PERCEPTUAL_THRESHOLD_MAX = 100

# Inclusive bounds for ``image_quality``. The floor is not 1: below roughly 60
# the artefacts are visible on any photograph, and offering a setting that only
# produces bad output is not a choice, it is a trap.
IMAGE_QUALITY_MIN = 60
IMAGE_QUALITY_MAX = 100

# Smart Categorization limits.
# There is no user-facing cap on the number of categories — more categories are
# technically fine (each adds one cheap, cached CLIP text embedding). This is a
# purely defensive sanity ceiling to reject a pathological payload, not a limit
# users are expected to hit.
CATEGORIZE_SANITY_MAX = 1000
UNCATEGORIZED_FOLDER = "_uncategorized"  # fixed, path-safe low-confidence bucket
# Inclusive bounds for ``categorize_confidence_threshold`` (matches the UI slider).
CATEGORIZE_THRESHOLD_MIN = 0.50
CATEGORIZE_THRESHOLD_MAX = 0.99
# Inclusive bounds for ``categorize_min_margin`` (0 = disable margin gate; <1 always).
CATEGORIZE_MIN_MARGIN_MIN = 0.0
CATEGORIZE_MIN_MARGIN_MAX = 0.50


def validate_categories(names: list[str]) -> str | None:
    """Return an error message if *names* is an invalid category list, else ``None``.

    Enforces the Smart Categorization rules: every name must survive
    path-sanitization to a non-empty segment, and the sanitized names must be
    unique (case-insensitively). There is no user-facing count limit — only a
    defensive :data:`CATEGORIZE_SANITY_MAX` ceiling that rejects a pathological
    payload. Mirrors :func:`validate_rename_pattern` and is wired into
    ``POST /api/config/validate``.
    """
    from app.utils.path_utils import sanitize_path_segment

    if len(names) > CATEGORIZE_SANITY_MAX:
        return f"Too many categories: {len(names)} (limit {CATEGORIZE_SANITY_MAX})"
    seen: set[str] = set()
    for raw in names:
        safe = sanitize_path_segment(raw)
        if not safe:
            return f"Category {raw!r} is empty or unsafe as a folder name"
        key = safe.lower()
        if key in seen:
            return f"Duplicate category folder name: {safe!r}"
        seen.add(key)
    return None


def validate_rename_pattern(pattern: str) -> str | None:
    """Return an error message if *pattern* uses unknown tokens, else ``None``.

    Known tokens (YYYY/MM/DD/NAME/TYPE) are stripped first; any uppercase run of
    two or more letters left behind is reported as an unknown/typo'd token (e.g.
    ``"YYY"`` or ``"MONTH"``). This mirrors the anywhere-substitution that
    ``SortingService._apply_rename`` performs, so a pattern such as
    ``"TYPE_YYYY-MM-DD"`` validates cleanly.
    """
    stripped = re.sub("|".join(sorted(RENAME_TOKENS, key=len, reverse=True)), "", pattern)
    unknown = sorted(set(re.findall(r"[A-Z]{2,}", stripped)))
    if unknown:
        return "Unknown tokens in rename pattern: " + ", ".join(unknown)
    return None


CURRENT_CONFIG_SCHEMA = 3
CONFIG_SCHEMA_PREFIX = "mediasort-config-v"


class UnsupportedConfigVersion(ValueError):
    """Raised when a config was written by a newer MediaSorter."""


class ConfigLoader:
    """Load and save configuration with validation."""

    def __init__(self) -> None:
        paths = resolve_app_paths()
        self.config_dir = paths.config_dir
        self.config_file = paths.config_file
        self.backup_file = self.config_dir / "config.json.bak"
        self.config_dir.mkdir(parents=True, exist_ok=True)

    def load(self) -> Config:
        """Load config from disk, then apply env-var overrides."""
        if not hasattr(self, "backup_file"):
            self.backup_file = self.config_dir / "config.json.bak"
        if not self.config_file.exists():
            config = Config.defaults()
            self._write_document(self._document_for(config), rotate_backup=False)
            return self._apply_env_overrides(config)
        try:
            config, migrated = self._load_config_path(self.config_file)
            if migrated:
                self._write_document(self._document_for(config), rotate_backup=True)
        except UnsupportedConfigVersion:
            raise
        except ValueError as exc:
            primary_preserved = self._preserve_corrupt(self.config_file)
            try:
                config, _ = self._load_config_path(self.backup_file)
                self._write_document(self._document_for(config), rotate_backup=False)
                logging.getLogger(__name__).error(
                    "Recovered malformed config from last-known-good backup",
                    extra={
                        "config": str(self.config_file),
                        "preserved": str(primary_preserved),
                        "backup": str(self.backup_file),
                    },
                )
            except UnsupportedConfigVersion:
                raise
            except ValueError as backup_exc:
                backup_preserved = self._preserve_corrupt(self.backup_file)
                logging.getLogger(__name__).error(
                    "No recoverable config copy; using defaults. primary=%s preserved=%s "
                    "backup=%s backup_preserved=%s primary_error=%s backup_error=%s",
                    self.config_file,
                    primary_preserved,
                    self.backup_file,
                    backup_preserved,
                    exc,
                    backup_exc,
                )
                config = Config.defaults()
        config = self._apply_env_overrides(config)
        return config

    def save(self, config: Config) -> None:
        """Validate and atomically persist config with a last-known-good backup."""
        if not hasattr(self, "backup_file"):
            self.backup_file = self.config_dir / "config.json.bak"
        document = self._document_for(config)
        self._validate_values(document)
        try:
            self._write_document(document, rotate_backup=True)
        except OSError as e:
            raise OSError(f"Failed to save config to {self.config_file}: {e}") from e

    def _load_from_file(self) -> Config:
        config, _ = self._load_config_path(self.config_file)
        return config

    def _load_config_path(self, path: Path) -> tuple[Config, bool]:
        if not path.exists():
            raise ValueError(f"Config file does not exist: {path}")
        try:
            with path.open(encoding="utf-8") as f:
                data = json.load(f)
            if not isinstance(data, dict):
                raise ValueError("configuration root must be an object")
            rule_set = data.get("rule_set")
            if isinstance(rule_set, dict) and rule_set.get("version", 1) != 1:
                raise UnsupportedRuleSetVersionError(
                    f"Unsupported rule-set version: {rule_set.get('version')!r}"
                )
            migrated_data, schema_migrated = self._migrate_document(data)
            validated = self._validate_values(migrated_data)
            config = Config.from_dict(validated)
            rules_migrated = config.migrated_legacy_rules
            if rules_migrated and path == self.config_file:
                self._backup_before_rule_migration()
            return config, schema_migrated or rules_migrated
        except (
            OSError,
            json.JSONDecodeError,
            ValidationError,
            TypeError,
            ValueError,
        ) as e:
            if isinstance(e, UnsupportedConfigVersion):
                raise
            raise ValueError(f"Invalid config file: {e}") from e

    def _backup_before_rule_migration(self) -> Path:
        """Retain the exact pre-migration file before writing RuleSet v1."""
        backup = self.config_file.with_name("config.pre-rules-v1.json")
        if backup.exists():
            if backup.read_bytes() == self.config_file.read_bytes():
                return backup
            index = 1
            while True:
                candidate = self.config_file.with_name(f"config.pre-rules-v1-{index}.json")
                if not candidate.exists():
                    backup = candidate
                    break
                index += 1
        self._atomic_copy(self.config_file, backup)
        return backup

    def _migrate_document(self, data: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        raw_schema = data.get("$schema")
        if raw_schema is None:
            version = 0
        elif isinstance(raw_schema, str) and raw_schema.startswith(CONFIG_SCHEMA_PREFIX):
            raw_version = raw_schema.removeprefix(CONFIG_SCHEMA_PREFIX)
            try:
                version = int(raw_version)
            except ValueError as exc:
                raise ValueError(f"Invalid config schema marker: {raw_schema!r}") from exc
        else:
            raise ValueError(f"Invalid config schema marker: {raw_schema!r}")

        if version > CURRENT_CONFIG_SCHEMA:
            raise UnsupportedConfigVersion(
                f"Config schema v{version} is newer than supported v{CURRENT_CONFIG_SCHEMA}; "
                f"upgrade MediaSorter or restore {self.backup_file}"
            )

        migrated = version != CURRENT_CONFIG_SCHEMA
        document = dict(data)
        while version < CURRENT_CONFIG_SCHEMA:
            if version == 0:
                version = 1
                document["$schema"] = f"{CONFIG_SCHEMA_PREFIX}{version}"
            elif version == 1:
                profile = LibraryProfile.from_legacy(
                    source_directory=str(document.get("source_directory") or ""),
                    target_directory=str(document.get("target_directory") or ""),
                    copy_instead_of_move=bool(document.get("copy_instead_of_move", False)),
                )
                document["library_profile"] = profile.model_dump(mode="json")
                version = 2
                document["$schema"] = f"{CONFIG_SCHEMA_PREFIX}{version}"
            elif version == 2:
                tag_embedding_requested = bool(document.get("ai_tagging_enabled", False)) and bool(
                    document.get(
                        "embed_tags_in_files",
                        document.get("ai_tagging_embed_in_files", False),
                    )
                )
                embedded_requested = (
                    bool(document.get("override_metadata", False)) or tag_embedding_requested
                )
                conversion_requested = bool(document.get("convert_images", False)) or bool(
                    document.get("convert_videos", False)
                )

                # Historical repair/tag-embedding defaults were modifying. They
                # cannot be distinguished from an explicit user choice in the
                # flat v2 file, so migration chooses the safe interpretation.
                document["repair_enabled"] = False
                document["embed_tags_in_files"] = tag_embedding_requested
                document["ai_tagging_embed_in_files"] = tag_embedding_requested

                if embedded_requested or conversion_requested:
                    preservation = PreservationProfile(
                        profile_id="legacy-mutation-review",
                        name="Review previous modifying settings",
                        mode="explicit_mutation",
                        allow_embedded_metadata_edits=embedded_requested,
                        allow_conversion=conversion_requested,
                        allow_compression=conversion_requested,
                        authorization_origin="migration",
                        requires_review=True,
                    )
                else:
                    preservation = PreservationProfile()
                document["preservation_profile"] = preservation.model_dump(mode="json")
                document["optimization_profile"] = OptimizationProfile().model_dump(mode="json")
                version = 3
                document["$schema"] = f"{CONFIG_SCHEMA_PREFIX}{version}"
            else:  # pragma: no cover - registry guard for future additions
                raise ValueError(f"No config migration registered from v{version}")
            self._validate_values(document)
        return document, migrated

    @staticmethod
    def _validate_values(document: dict[str, Any]) -> dict[str, Any]:
        hints = typing.get_type_hints(Config)
        validated = dict(document)
        for key, target_type in hints.items():
            if key in document:
                validated[key] = TypeAdapter(target_type).validate_python(document[key])
        return validated

    @staticmethod
    def _document_for(config: Config) -> dict[str, Any]:
        return {
            "$schema": f"{CONFIG_SCHEMA_PREFIX}{CURRENT_CONFIG_SCHEMA}",
            **config.to_dict(),
        }

    def _write_document(self, document: dict[str, Any], *, rotate_backup: bool) -> None:
        self.config_dir.mkdir(parents=True, exist_ok=True)
        if rotate_backup and self.config_file.exists():
            try:
                self._load_config_path(self.config_file)
            except (ValueError, UnsupportedConfigVersion):
                pass
            else:
                self._atomic_copy(self.config_file, self.backup_file)

        descriptor, raw_temp = tempfile.mkstemp(
            prefix=".config-",
            suffix=".tmp",
            dir=self.config_dir,
        )
        temp_path = Path(raw_temp)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
                json.dump(document, handle, indent=2, default=str)
                handle.write("\n")
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_path, self.config_file)
            self._fsync_parent(self.config_file)
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise

    def _atomic_copy(self, source: Path, destination: Path) -> None:
        descriptor, raw_temp = tempfile.mkstemp(
            prefix=".config-backup-",
            suffix=".tmp",
            dir=self.config_dir,
        )
        temp_path = Path(raw_temp)
        try:
            with os.fdopen(descriptor, "wb") as target, source.open("rb") as source_handle:
                for chunk in iter(lambda: source_handle.read(1024 * 1024), b""):
                    target.write(chunk)
                target.flush()
                os.fsync(target.fileno())
            os.replace(temp_path, destination)
            self._fsync_parent(destination)
        except Exception:
            temp_path.unlink(missing_ok=True)
            raise

    @staticmethod
    def _fsync_parent(path: Path) -> None:
        try:
            descriptor = os.open(path.parent, os.O_RDONLY)
        except OSError:
            return
        try:
            os.fsync(descriptor)
        finally:
            os.close(descriptor)

    def _preserve_corrupt(self, path: Path) -> Path | None:
        if not path.exists():
            return None
        try:
            content = path.read_bytes()
        except OSError:
            content = str(path).encode()
        digest = hashlib.sha256(content).hexdigest()[:12]
        stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
        candidate = self.config_dir / f"corrupt-{path.stem}-{stamp}-{digest}{path.suffix}"
        counter = 1
        while candidate.exists():
            candidate = (
                self.config_dir / f"corrupt-{path.stem}-{stamp}-{digest}-{counter}{path.suffix}"
            )
            counter += 1
        try:
            self._atomic_copy(path, candidate)
        except OSError:
            return None
        return candidate

    def _apply_env_overrides(self, config: Config) -> Config:
        """Apply MEDIASORT_* environment variables over loaded config.

        Resolves the target type from the dataclass type hints rather than the
        current value's runtime type. This means Optional[int] fields whose
        current value is None are still coerced to int, not left as str.
        Invalid values log a warning and are skipped (no startup crash).
        """
        type_hints = typing.get_type_hints(Config)
        log = logging.getLogger(__name__)
        for key, value in os.environ.items():
            if not key.startswith("MEDIASORT_"):
                continue
            config_key = key[len("MEDIASORT_") :].lower()
            if config_key not in type_hints:
                continue
            try:
                coerced = _coerce_env_value(value, type_hints[config_key])
            except (ValueError, TypeError) as exc:
                # The only failures _coerce_env_value can raise for a bad value
                # are int()/float() parse errors (ValueError) or a malformed
                # type hint (TypeError). Catch exactly those so a genuinely
                # unexpected bug surfaces instead of being silently swallowed.
                log.warning("Ignoring bad env override %s=%r: %s", key, value, exc)
                continue
            setattr(config, config_key, coerced)
        if any(
            key in os.environ
            for key in (
                "MEDIASORT_SOURCE_DIRECTORY",
                "MEDIASORT_TARGET_DIRECTORY",
                "MEDIASORT_COPY_INSTEAD_OF_MOVE",
            )
        ):
            profile = config.library_profile or LibraryProfile.from_legacy(
                source_directory=config.source_directory,
                target_directory=config.target_directory,
                copy_instead_of_move=config.copy_instead_of_move,
            )
            config.library_profile = profile.with_legacy_directories(
                source_directory=config.source_directory,
                target_directory=config.target_directory,
                copy_instead_of_move=config.copy_instead_of_move,
            )
        return config


def _coerce_env_value(value: str, target_type: Any) -> Any:
    """Coerce a string env-var to the declared dataclass field type.

    Handles ``Optional[X]`` (a.k.a. ``Union[X, None]``) by unwrapping to X.
    Empty string for Optional fields → ``None``.
    """
    origin = get_origin(target_type)
    # PEP 604 unions (`int | None`) report `types.UnionType` as their origin on
    # Python ≤ 3.13, not `typing.Union` — both must unwrap, or an Optional[int]
    # override would be stored as a string and blow up at sort time.
    if origin is Union or origin is types.UnionType:
        args = [a for a in get_args(target_type) if a is not type(None)]
        if value == "":
            return None
        # Take the first non-None member (Optional[int] → int).
        target_type = args[0] if args else str
        origin = get_origin(target_type)

    if target_type is bool:
        return value.lower() in ("true", "1", "yes", "on")
    if target_type is int:
        return int(value)
    if target_type is float:
        return float(value)
    if origin is list:
        # Comma-separated values for List[...] fields.
        return [v.strip() for v in value.split(",") if v.strip()]
    # str, Literal[...], and any other → keep as string.
    return value
