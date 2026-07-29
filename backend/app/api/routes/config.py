"""Configuration routes."""

import asyncio
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.api.deps import ConfigDep, ContainerDep
from app.core.config import (
    CATEGORIZE_MIN_MARGIN_MAX,
    CATEGORIZE_MIN_MARGIN_MIN,
    CATEGORIZE_THRESHOLD_MAX,
    CATEGORIZE_THRESHOLD_MIN,
    PERCEPTUAL_THRESHOLD_MAX,
    PERCEPTUAL_THRESHOLD_MIN,
    Config,
    ConfigLoader,
    coerce_config_update,
    validate_categories,
    validate_rename_pattern,
)
from app.core.config_sections import SECTIONS
from app.core.exceptions import ConfigValidationError, MediaSortException
from app.core.integrity_policy import authorize_config_mutations
from app.core.library_validation import validate_configured_library

router = APIRouter()


class ConfigIssue(BaseModel):
    """One validation problem, tied to the config field that caused it.

    ``field`` is the flat :class:`~app.core.config.Config` field name, so the UI
    can flag the exact input *and* the section that owns it (resolved client-side
    via ``GET /config/sections``). It is ``None`` only for a problem that isn't
    tied to a single field. ``message`` is already user-facing — the frontend
    renders it verbatim.
    """

    field: str | None
    message: str
    message_key: str
    params: dict[str, str | int | float] = Field(default_factory=dict)


class ValidateConfigResponse(BaseModel):
    valid: bool
    errors: list[ConfigIssue]
    warnings: list[ConfigIssue]


@router.get("/config/sections")
async def get_config_sections() -> dict[str, Any]:
    """Shared, presentation-oriented grouping of the config fields.

    Drives the configure screen's section rail + per-section help so the
    grouping lives in one place. Returns a presentation blob (``dict``) by
    design — it is layout metadata, not a typed domain entity.
    """
    return {"sections": [s.to_dict() for s in SECTIONS]}


@router.get("/config")
async def get_config_route(config: ConfigDep) -> dict[str, Any]:
    # Returns the full mutable config blob. This is intentionally a ``dict``
    # rather than a mirror Pydantic model: the config is a stdlib dataclass (a
    # deliberate project choice) and duplicating its ~50 fields in a response
    # model would be a maintenance trap that drifts on every new field.
    return config.to_dict()


@router.get("/config/defaults")
async def get_config_defaults() -> dict[str, Any]:
    """Return the factory-default config blob.

    The single source of truth for "which settings deviate from the defaults":
    the UI diffs the live config against this rather than re-encoding the
    backend's defaults client-side (which would silently drift on every new
    field). Excludes the two path fields, which have no meaningful default.
    """
    defaults = Config.defaults().to_dict()
    defaults.pop("source_directory", None)
    defaults.pop("target_directory", None)
    return defaults


@router.post("/config")
async def save_config(
    body: dict[str, Any], container: ContainerDep, config: ConfigDep
) -> dict[str, Any]:
    """Persist a partial config update.

    The body is type-checked against the Config fields first: unknown keys
    (likely typos that would be silently dropped) and incoercible values (a
    ``Literal`` outside its set, a string for a list field, …) are rejected with
    a 422 so a bad value can never be stored and explode at sort time. Semantic
    range checks stay in ``/config/validate`` so the UI's save-then-validate flow
    is unchanged.
    """
    coerced, errors = coerce_config_update(body)
    if errors:
        issues: list[dict[str, Any]] = []
        for message in errors:
            field = next(
                (
                    key
                    for key in body
                    if key != "$schema" and (repr(key) in message or key == "rules")
                ),
                None,
            )
            issues.append(
                {
                    "field": field,
                    "message": message,
                    "message_key": (
                        "config.update.legacy_rules"
                        if field == "rules"
                        else "config.update.invalid_value"
                        if message.startswith("Invalid value")
                        else "config.update.unknown_field"
                    ),
                    "params": {"field": field or ""},
                }
            )
        raise ConfigValidationError(errors, issues)

    if "ai_tagging_labels" in coerced and "ai_tagging_labels_provenance" not in coerced:
        coerced["ai_tagging_labels_provenance"] = "custom"
    if "categorize_categories" in coerced and "categorize_categories_provenance" not in coerced:
        coerced["categorize_categories_provenance"] = "custom"

    merged = {**config.to_dict(), **coerced}
    legacy_directory_fields = {
        "source_directory",
        "target_directory",
        "copy_instead_of_move",
    }
    if legacy_directory_fields.intersection(coerced) and "library_profile" not in coerced:
        profile = config.library_profile
        if profile is None:  # defensive compatibility for hand-built Config instances
            profile = Config.from_dict(merged).library_profile
        assert profile is not None
        merged["library_profile"] = profile.with_legacy_directories(
            source_directory=str(merged.get("source_directory") or ""),
            target_directory=str(merged.get("target_directory") or ""),
            copy_instead_of_move=bool(merged.get("copy_instead_of_move", False)),
        ).model_dump(mode="json")
    new_config = Config.from_dict(merged)
    # Disk write is blocking — keep it off the event loop.
    await asyncio.to_thread(ConfigLoader().save, new_config)

    # One public call propagates the new config to every live service.
    container.set_config(new_config)
    return new_config.to_dict()


@router.post("/config/validate", response_model=ValidateConfigResponse)
async def validate_config(config: ConfigDep) -> ValidateConfigResponse:
    errors: list[ConfigIssue] = []
    warnings: list[ConfigIssue] = []

    def err(
        field: str | None,
        message: str,
        message_key: str = "config.validation.invalid",
        params: dict[str, str | int | float] | None = None,
    ) -> None:
        errors.append(
            ConfigIssue(
                field=field,
                message=message,
                message_key=message_key,
                params=params or {},
            )
        )

    def warn(
        field: str | None,
        message: str,
        message_key: str = "config.validation.warning",
        params: dict[str, str | int | float] | None = None,
    ) -> None:
        warnings.append(
            ConfigIssue(
                field=field,
                message=message,
                message_key=message_key,
                params=params or {},
            )
        )

    # ── Typed library roots ────────────────────────────────────────────────────
    profile = config.library_profile
    if profile is None or not profile.inputs:
        err(
            "source_directory",
            "Add at least one input folder before continuing.",
            "config.source.required",
        )
    if profile is None or profile.destination is None:
        err(
            "target_directory",
            "Pick where your sorted files should go.",
            "config.target.required",
        )

    if profile is not None and profile.inputs and profile.destination is not None:
        try:
            await asyncio.to_thread(
                validate_configured_library,
                config,
                require_destination=True,
            )
        except MediaSortException as exc:
            reason = str(exc.details.get("reason", ""))
            role = str(exc.details.get("role", ""))
            root_id = str(exc.details.get("root_id", ""))
            compatibility_profile = len(profile.inputs) == 1 and not profile.references
            if exc.code == "SOURCE_UNAVAILABLE" or (
                role == "input" and compatibility_profile and root_id == profile.inputs[0].root_id
            ):
                field = "source_directory"
                message_key = {
                    "missing": "config.source.not_found",
                    "not_directory": "config.source.not_directory",
                    "root_inaccessible": "config.source.unavailable",
                }.get(reason, "config.source.unavailable")
            elif role == "destination" and compatibility_profile:
                field = "target_directory"
                message_key = "config.target.required"
            elif reason == "root_overlap" and compatibility_profile:
                field = "target_directory"
                message_key = "config.target.overlap"
            else:
                field = "library_profile"
                message_key = "config.profile.invalid"
            err(
                field,
                exc.message,
                message_key,
                {
                    key: value
                    for key, raw_value in exc.details.items()
                    if isinstance(raw_value, (str, int, float))
                    for value in [raw_value]
                },
            )

    # ── Media mutation authorization ───────────────────────────────────────────
    try:
        authorize_config_mutations(config)
    except MediaSortException as exc:
        err(
            "preservation_profile",
            exc.message,
            "config.integrity.authorization_required",
            {
                "reason": str(exc.details.get("reason", "")),
                "profile": str(exc.details.get("preservation_profile_id", "")),
            },
        )

    # Rename pattern: surface unknown/typo'd tokens as a *warning*, not an error.
    # SortingService._apply_rename substitutes only the known tokens and leaves
    # everything else as a literal, so a pattern like "IMG_YYYY" is perfectly
    # valid — "IMG" is just a literal prefix. Blocking the save would stop a
    # legitimate pattern; warning still flags a likely typo (e.g. "YYY").
    if config.rename:
        pattern_warning = validate_rename_pattern(config.rename_pattern)
        if pattern_warning:
            warn(
                "rename_pattern",
                pattern_warning,
                "config.rename.unknown_tokens",
                {"pattern": config.rename_pattern},
            )

    # File-size filters can't be negative. The HTML min=0 on the inputs is
    # advisory (bypassable via DevTools / a direct API call / a stale config),
    # and a negative value is meaningless: a negative min is a no-op while a
    # negative max would exclude every file. Reject both server-side.
    if config.min_file_size_kb is not None and config.min_file_size_kb < 0:
        err(
            "min_file_size_kb",
            "Minimum file size can't be negative.",
            "config.filters.minimum_negative",
        )
    if config.max_file_size_mb is not None and config.max_file_size_mb < 0:
        err(
            "max_file_size_mb",
            "Maximum file size can't be negative.",
            "config.filters.maximum_negative",
        )

    # Perceptual duplicate threshold must stay within the supported range — but
    # only when perceptual matching is actually enabled. The value is ignored
    # otherwise, so a stale/out-of-range leftover shouldn't block an unrelated
    # save, mirroring the file-size guard above.
    if config.duplicate_perceptual_enabled and not (
        PERCEPTUAL_THRESHOLD_MIN
        <= config.duplicate_perceptual_threshold
        <= PERCEPTUAL_THRESHOLD_MAX
    ):
        err(
            "duplicate_perceptual_threshold",
            f"Similarity threshold must be between {PERCEPTUAL_THRESHOLD_MIN} "
            f"and {PERCEPTUAL_THRESHOLD_MAX}.",
            "config.duplicates.threshold_range",
            {"minimum": PERCEPTUAL_THRESHOLD_MIN, "maximum": PERCEPTUAL_THRESHOLD_MAX},
        )

    # Smart Categorization — validate the category list and confidence bar, but
    # only when the feature is enabled (a stale/invalid leftover shouldn't block
    # an unrelated save, mirroring the perceptual-threshold guard above).
    if config.categorize_enabled:
        category_error = validate_categories(config.categorize_categories)
        if category_error:
            err(
                "categorize_categories",
                category_error,
                "config.categories.invalid",
            )
        elif not config.categorize_categories:
            warn(
                "categorize_categories",
                "Smart Categorization is on but no categories are set; "
                "every file will go to _uncategorized/.",
                "config.categories.empty",
            )
        if not (
            CATEGORIZE_THRESHOLD_MIN
            <= config.categorize_confidence_threshold
            <= CATEGORIZE_THRESHOLD_MAX
        ):
            err(
                "categorize_confidence_threshold",
                f"Confidence threshold must be between {CATEGORIZE_THRESHOLD_MIN} "
                f"and {CATEGORIZE_THRESHOLD_MAX}.",
                "config.categories.confidence_range",
                {"minimum": CATEGORIZE_THRESHOLD_MIN, "maximum": CATEGORIZE_THRESHOLD_MAX},
            )
        if not (
            CATEGORIZE_MIN_MARGIN_MIN <= config.categorize_min_margin <= CATEGORIZE_MIN_MARGIN_MAX
        ):
            err(
                "categorize_min_margin",
                f"Decision margin must be between {CATEGORIZE_MIN_MARGIN_MIN} "
                f"and {CATEGORIZE_MIN_MARGIN_MAX}.",
                "config.categories.margin_range",
                {"minimum": CATEGORIZE_MIN_MARGIN_MIN, "maximum": CATEGORIZE_MIN_MARGIN_MAX},
            )

    for migration_warning in config.migration_warnings:
        warn(
            "rule_set",
            migration_warning,
            "config.rules.migration_warning",
            {"detail": migration_warning},
        )

    return ValidateConfigResponse(valid=len(errors) == 0, errors=errors, warnings=warnings)
