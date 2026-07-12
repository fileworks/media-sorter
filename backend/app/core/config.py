"""Application configuration management."""

import json
import logging
import os
import re
import types
import typing
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal, Union, get_args, get_origin

from platformdirs import user_config_dir
from pydantic import BaseModel, TypeAdapter, ValidationError, field_validator


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

    # Directories
    source_directory: str = ""
    target_directory: str = ""

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
    convert_images: bool = False
    image_format: Literal["jpeg", "png", "webp", "tiff"] = "jpeg"

    # Repair / validation
    repair_enabled: bool = (
        True  # validate sorted files; attempt safe repair; quarantine if unrepairable
    )

    # Rule-based tagging
    rules_enabled: bool = True
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
    ai_tagging_embed_in_files: bool = True
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

    # ── Destination-aware / cross-run duplicate detection (opt-in) ───────────
    # When enabled, the destination's existing media are indexed into a small
    # SQLite file (persisted across runs) and every source file is first checked
    # against it: a file already present in the destination is quarantined to
    # _already_in_destination/ instead of being re-added. Off by default — the
    # classic per-run in-memory
    # behaviour is unchanged until the user opts in.
    dedup_against_destination: bool = False
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

    @classmethod
    def defaults(cls) -> "Config":
        return cls()

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "Config":
        # Drop unknown keys (the "$schema" marker, or fields written by a newer
        # build) so a stray key never raises a TypeError in the constructor.
        known = {f.name for f in cls.__dataclass_fields__.values()}
        filtered = {k: v for k, v in data.items() if k in known}
        return cls(**filtered)


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


class ConfigLoader:
    """Load and save configuration with validation."""

    def __init__(self) -> None:
        # Allow Docker / headless deployments to redirect config via env var.
        base = os.environ.get("MEDIASORT_CONFIG_DIR") or user_config_dir("mediasort", "mediasort")
        self.config_dir = Path(base)
        self.config_file = self.config_dir / "config.json"
        self.config_dir.mkdir(parents=True, exist_ok=True)

    def load(self) -> Config:
        """Load config from disk, then apply env-var overrides."""
        try:
            config = self._load_from_file()
        except ValueError as exc:
            import logging

            logging.getLogger(__name__).warning("Malformed config.json, using defaults: %s", exc)
            config = Config.defaults()
        config = self._apply_env_overrides(config)
        return config

    def save(self, config: Config) -> None:
        """Persist config to disk."""
        try:
            with open(self.config_file, "w") as f:
                # "$schema" is a conventional, parser-ignored marker key.
                json.dump(
                    {"$schema": "mediasort-config-v1", **config.to_dict()},
                    f,
                    indent=2,
                    default=str,
                )
        except OSError as e:
            raise OSError(f"Failed to save config to {self.config_file}: {e}") from e

    def _load_from_file(self) -> Config:
        if not self.config_file.exists():
            return Config.defaults()
        try:
            with open(self.config_file) as f:
                data = json.load(f)
            # from_dict drops unknown keys, so the "$schema" marker we write on
            # save (and any stray keys) are filtered out without special-casing.
            return Config.from_dict(data)
        except (json.JSONDecodeError, ValueError) as e:
            raise ValueError(f"Invalid config file: {e}") from e

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
