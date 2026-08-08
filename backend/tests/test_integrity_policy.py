"""Tests for strict Organize Only defaults and centralized mutation authorization."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.background_tasks.task_manager import Task
from app.core.config import Config
from app.core.exceptions import MutationPolicyError
from app.core.integrity import OptimizationProfile, PreservationProfile
from app.core.integrity_policy import authorize_config_mutations
from app.services.config_service import ConfigService
from app.services.conversion_service import ConversionService
from app.services.duplicate_service import DuplicateService
from app.services.extraction_service import DateExtractionService
from app.services.filesystem_service import FileSystemService
from app.services.metadata_service import MetadataService
from app.services.preview_service import PreviewService
from app.services.repair_service import RepairService
from app.services.sorting_service import SortingService

NOW = datetime.now(timezone.utc)


def _explicit_profile(
    *,
    allow_embedded_metadata_edits: bool = False,
    allow_repair: bool = False,
    allow_conversion: bool = False,
    allow_compression: bool = False,
) -> PreservationProfile:
    """Named rather than `**permissions`: a `**dict[str, bool]` splat switches
    keyword checking off for the whole call, so a misspelt permission would have
    been accepted here and silently granted nothing."""
    return PreservationProfile(
        profile_id="reviewed-mutations",
        name="Reviewed mutations",
        mode="explicit_mutation",
        authorization_origin="saved_profile",
        acknowledged_at=NOW,
        allow_embedded_metadata_edits=allow_embedded_metadata_edits,
        allow_repair=allow_repair,
        allow_conversion=allow_conversion,
        allow_compression=allow_compression,
    )


def _visual_profile() -> OptimizationProfile:
    return OptimizationProfile(
        profile_id="visual-v1",
        name="Visually lossless",
        mode="visually_lossless",
        acknowledged_at=NOW,
        tool="test-encoder",
        tool_version="1.0",
        parameters={"quality": 95},
        validation_contract="test-visual-v1",
    )


def test_defaults_are_strict_organize_only() -> None:
    config = Config.defaults()

    authorization = authorize_config_mutations(config)

    assert authorization.is_organize_only is True
    assert config.override_metadata is False
    assert config.embed_tags_in_files is False
    assert config.repair_enabled is False
    assert config.convert_images is False
    assert config.convert_videos is False


@pytest.mark.parametrize(
    ("field", "value", "capability"),
    [
        ("override_metadata", True, "embedded_metadata"),
        ("repair_enabled", True, "repair"),
        ("convert_images", True, "conversion"),
        ("convert_videos", True, "conversion"),
    ],
)
def test_organize_only_rejects_every_media_mutation(
    field: str,
    value: bool,
    capability: str,
) -> None:
    # The field name is the parameter under test, so this construction is
    # dynamic by design and cannot be keyword-checked.
    config = Config(**{field: value})  # type: ignore[arg-type]

    with pytest.raises(MutationPolicyError) as error:
        authorize_config_mutations(config)

    assert error.value.code == "MUTATION_NOT_AUTHORIZED"
    assert capability in error.value.details["requested"]
    assert error.value.details["source_safety"] == "source_retained"


def test_report_only_ai_tags_do_not_request_embedded_mutation() -> None:
    config = Config(ai_tagging_enabled=True, embed_tags_in_files=False)

    authorization = authorize_config_mutations(config)

    assert authorization.is_organize_only is True


def test_embedded_tags_require_reviewed_embedded_metadata_permission() -> None:
    config = Config(
        ai_tagging_enabled=True,
        embed_tags_in_files=True,
        preservation_profile=_explicit_profile(allow_embedded_metadata_edits=True),
    )

    authorization = authorize_config_mutations(config)

    assert authorization.requested == frozenset({"embedded_metadata"})


def test_repair_requires_reviewed_repair_permission() -> None:
    config = Config(
        repair_enabled=True,
        preservation_profile=_explicit_profile(allow_repair=True),
    )

    authorization = authorize_config_mutations(config)

    assert authorization.requested == frozenset({"repair"})


def test_conversion_requires_preservation_and_optimization_authorization() -> None:
    config = Config(
        convert_images=True,
        preservation_profile=_explicit_profile(
            allow_conversion=True,
            allow_compression=True,
        ),
    )
    with pytest.raises(MutationPolicyError) as missing_optimizer:
        authorize_config_mutations(config)
    assert missing_optimizer.value.details["reason"] == "optimization_profile_required"

    config.optimization_profile = _visual_profile()
    authorization = authorize_config_mutations(config)
    assert authorization.requested == frozenset({"conversion", "compression"})


def test_pending_migration_profile_blocks_before_media_work() -> None:
    config = Config(
        override_metadata=True,
        preservation_profile=PreservationProfile(
            profile_id="legacy-mutation-review",
            name="Review previous modifying settings",
            mode="explicit_mutation",
            allow_embedded_metadata_edits=True,
            authorization_origin="migration",
            requires_review=True,
        ),
    )

    with pytest.raises(MutationPolicyError) as error:
        authorize_config_mutations(config)

    assert error.value.details["reason"] == "migration_review_required"


@pytest.mark.asyncio
async def test_sorting_guard_runs_before_source_validation() -> None:
    config = Config(repair_enabled=True)
    service = SortingService(
        config=config,
        config_service=ConfigService(config),
        filesystem_service=FileSystemService(),
        extraction_service=DateExtractionService(),
        duplicate_service=DuplicateService(),
        metadata_service=MetadataService(),
        conversion_service=ConversionService(),
        repair_service=RepairService(),
    )

    with pytest.raises(MutationPolicyError) as error:
        await service.run(Task(id="policy-sort", operation_kind="sort"))

    assert error.value.details["reason"] == "explicit_profile_required"


@pytest.mark.asyncio
async def test_preview_guard_runs_before_source_validation() -> None:
    service = PreviewService(
        filesystem_service=FileSystemService(),
        extraction_service=DateExtractionService(),
        rule_engine_service=None,
        duplicate_service=DuplicateService(),
    )

    with pytest.raises(MutationPolicyError) as error:
        await service.preview(Config(convert_images=True))

    assert error.value.details["reason"] == "explicit_profile_required"
