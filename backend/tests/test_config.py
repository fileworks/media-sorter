"""Tests for configuration loading, saving, and env-var overrides."""

import json
from pathlib import Path

import pytest

from app.core.config import (
    CATEGORIZE_SANITY_MAX,
    Config,
    ConfigLoader,
    validate_categories,
    validate_rename_pattern,
)
from app.core.integrity import PreservationProfile
from app.core.library_profiles import LibraryProfile, LibraryRoot


@pytest.fixture
def tmp_config_loader(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> ConfigLoader:
    loader = ConfigLoader.__new__(ConfigLoader)
    loader.config_dir = tmp_path
    loader.config_file = tmp_path / "config.json"
    return loader


def test_defaults_are_valid() -> None:
    cfg = Config.defaults()
    assert cfg.sort is True
    assert cfg.sort_criteria == ["year"]
    assert cfg.recursive_scan is True
    assert cfg.preservation_profile == PreservationProfile()
    assert cfg.repair_enabled is False
    assert cfg.embed_tags_in_files is False


def test_round_trip(tmp_config_loader: ConfigLoader) -> None:
    cfg = Config(source_directory="/src", target_directory="/dst")
    tmp_config_loader.save(cfg)
    loaded = tmp_config_loader.load()
    assert loaded.source_directory == "/src"
    assert loaded.target_directory == "/dst"
    assert loaded.library_profile is not None
    assert [root.path for root in loaded.library_profile.inputs] == ["/src"]
    assert loaded.library_profile.destination is not None
    assert loaded.library_profile.destination.path == "/dst"


def test_profile_round_trip_preserves_multiple_roots_and_reference(
    tmp_config_loader: ConfigLoader,
) -> None:
    profile = LibraryProfile(
        profile_id="family-library",
        name="Family library",
        roots=[
            LibraryRoot(root_id="phone", role="input", path="/phone", priority=0),
            LibraryRoot(root_id="camera", role="input", path="/camera", priority=1),
            LibraryRoot(root_id="archive", role="reference", path="/archive"),
            LibraryRoot(root_id="organized", role="destination", path="/organized"),
        ],
        transfer_mode="copy",
    )
    tmp_config_loader.save(Config(library_profile=profile, rename=True))

    loaded = tmp_config_loader.load()

    assert loaded.library_profile == profile
    assert loaded.source_directory == "/phone"
    assert loaded.target_directory == "/organized"
    assert loaded.copy_instead_of_move is True
    assert loaded.rename is True


def test_v1_config_migrates_to_default_application_data_profile(
    tmp_config_loader: ConfigLoader,
) -> None:
    original = {
        "$schema": "mediasort-config-v1",
        "source_directory": "/legacy-source",
        "target_directory": "/legacy-target",
        "copy_instead_of_move": True,
        "rename": True,
        "rename_pattern": "YYYY_NAME",
        "remove_duplicates": False,
    }
    tmp_config_loader.config_file.write_text(json.dumps(original), encoding="utf-8")

    loaded = tmp_config_loader.load()
    persisted = json.loads(tmp_config_loader.config_file.read_text(encoding="utf-8"))
    backup = json.loads(tmp_config_loader.backup_file.read_text(encoding="utf-8"))

    assert persisted["$schema"] == "mediasort-config-v3"
    assert persisted["library_profile"]["profile_id"] == "default-library"
    assert persisted["library_profile"]["catalog"] == {
        "mode": "application_data",
        "relative_path": None,
    }
    assert [root["role"] for root in persisted["library_profile"]["roots"]] == [
        "input",
        "destination",
    ]
    assert loaded.rename is True
    assert loaded.rename_pattern == "YYYY_NAME"
    assert loaded.remove_duplicates is False
    assert loaded.preservation_profile.mode == "organize_only"
    assert loaded.optimization_profile.mode == "disabled"
    assert backup == original


def test_v2_modifying_config_migrates_to_blocked_review_profile(
    tmp_config_loader: ConfigLoader,
) -> None:
    original = {
        "$schema": "mediasort-config-v2",
        "source_directory": "/legacy-source",
        "target_directory": "/legacy-target",
        "library_profile": LibraryProfile.from_legacy(
            source_directory="/legacy-source",
            target_directory="/legacy-target",
            copy_instead_of_move=True,
        ).model_dump(mode="json"),
        "copy_instead_of_move": True,
        "override_metadata": True,
        "convert_images": True,
        "image_format": "jpeg",
        "repair_enabled": True,
        "embed_tags_in_files": True,
        "ai_tagging_enabled": False,
    }
    tmp_config_loader.config_file.write_text(json.dumps(original), encoding="utf-8")

    loaded = tmp_config_loader.load()
    persisted = json.loads(tmp_config_loader.config_file.read_text(encoding="utf-8"))

    assert persisted["$schema"] == "mediasort-config-v3"
    assert loaded.override_metadata is True
    assert loaded.convert_images is True
    assert loaded.repair_enabled is False
    assert loaded.embed_tags_in_files is False
    assert loaded.preservation_profile.mode == "explicit_mutation"
    assert loaded.preservation_profile.requires_review is True
    assert loaded.preservation_profile.allow_embedded_metadata_edits is True
    assert loaded.preservation_profile.allow_conversion is True
    assert loaded.optimization_profile.mode == "disabled"
    assert loaded.migration_warnings


def test_ai_tagging_defaults() -> None:
    cfg = Config.defaults()
    assert cfg.ai_tagging_enabled is False
    assert cfg.ai_tagging_provider == "local"  # offline, no-key default
    assert cfg.ai_tagging_embed_in_files is False
    assert cfg.ai_tagging_max_tags == 10
    assert cfg.ai_tagging_api_key is None
    assert isinstance(cfg.ai_tagging_labels, list) and cfg.ai_tagging_labels


def test_ai_tagging_round_trip(tmp_config_loader: ConfigLoader) -> None:
    cfg = Config(
        ai_tagging_enabled=True,
        ai_tagging_provider="azure_vision",
        ai_tagging_endpoint="https://x.cognitiveservices.azure.com",
        ai_tagging_api_key="secret-key",
        ai_tagging_labels=["beach", "city"],
        ai_tagging_max_tags=5,
    )
    tmp_config_loader.save(cfg)
    loaded = tmp_config_loader.load()
    assert loaded.ai_tagging_provider == "azure_vision"
    assert loaded.ai_tagging_endpoint == "https://x.cognitiveservices.azure.com"
    assert loaded.ai_tagging_api_key == "secret-key"
    assert loaded.ai_tagging_labels == ["beach", "city"]
    assert loaded.ai_tagging_max_tags == 5


def test_load_missing_file_returns_defaults(tmp_config_loader: ConfigLoader) -> None:
    cfg = tmp_config_loader.load()
    assert cfg == Config.defaults()


def test_env_override(tmp_config_loader: ConfigLoader, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MEDIASORT_SOURCE_DIRECTORY", "/env_src")
    monkeypatch.setenv("MEDIASORT_COPY_INSTEAD_OF_MOVE", "true")
    cfg = tmp_config_loader.load()
    assert cfg.source_directory == "/env_src"
    assert cfg.copy_instead_of_move is True
    assert cfg.library_profile is not None
    assert cfg.library_profile.inputs[0].path == "/env_src"
    assert cfg.library_profile.transfer_mode == "copy"


def test_env_override_optional_int_coerced(
    tmp_config_loader: ConfigLoader, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`int | None` fields must coerce to int, not str (P2-1 regression).

    PEP 604 unions report ``types.UnionType`` (not ``typing.Union``) as their
    origin on Python ≤ 3.13; an unwrap that only checks ``typing.Union`` stored
    these as strings, crashing the directory walk with a TypeError at sort time.
    """
    monkeypatch.setenv("MEDIASORT_MAX_RECURSION_DEPTH", "5")
    monkeypatch.setenv("MEDIASORT_MIN_FILE_SIZE_KB", "100")
    monkeypatch.setenv("MEDIASORT_MAX_FILE_SIZE_MB", "500")
    cfg = tmp_config_loader.load()
    assert cfg.max_recursion_depth == 5
    assert cfg.min_file_size_kb == 100
    assert cfg.max_file_size_mb == 500


def test_env_override_optional_int_empty_is_none(
    tmp_config_loader: ConfigLoader, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MEDIASORT_MAX_RECURSION_DEPTH", "")
    cfg = tmp_config_loader.load()
    assert cfg.max_recursion_depth is None


def test_load_ignores_unknown_keys(tmp_config_loader: ConfigLoader) -> None:
    tmp_config_loader.config_file.write_text(
        json.dumps({"source_directory": "/x", "unknown_future_key": 42})
    )
    cfg = tmp_config_loader.load()
    assert cfg.source_directory == "/x"


# ------------------------------------------------------------------ #
# validate_rename_pattern (Bug M5)                                       #
# ------------------------------------------------------------------ #


@pytest.mark.parametrize(
    "pattern",
    [
        "TYPE_YYYY-MM-DD",  # the default
        "YYYY/MM/DD",  # slashes are not tokens; ignored here
        "NAME",
        "YYYY-MM-DD_NAME_TYPE",
        "photo_YYYY",  # lowercase literal + known token
        "",  # empty: no unknown tokens
    ],
)
def test_validate_rename_pattern_accepts_known_tokens(pattern: str) -> None:
    assert validate_rename_pattern(pattern) is None


@pytest.mark.parametrize(
    "pattern, needle",
    [
        ("YYYY-MM-DD-FOO", "FOO"),
        ("YYY-MM-DD", "YYY"),
        ("MONTH_DD", "MONTH"),
        ("NAME_TYPE_XX", "XX"),
    ],
)
def test_validate_rename_pattern_flags_unknown_tokens(pattern: str, needle: str) -> None:
    msg = validate_rename_pattern(pattern)
    assert msg is not None
    assert needle in msg


# ------------------------------------------------------------------ #
# Smart Categorization config                                           #
# ------------------------------------------------------------------ #


def test_categorize_defaults() -> None:
    cfg = Config.defaults()
    assert cfg.categorize_enabled is False
    assert isinstance(cfg.categorize_categories, list) and cfg.categorize_categories
    assert cfg.categorize_confidence_threshold == 0.55
    assert cfg.categorize_min_margin == 0.15


def test_categorize_round_trip(tmp_config_loader: ConfigLoader) -> None:
    cfg = Config(
        categorize_enabled=True,
        categorize_categories=["baking", "screenshots"],
        categorize_confidence_threshold=0.9,
    )
    tmp_config_loader.save(cfg)
    loaded = tmp_config_loader.load()
    assert loaded.categorize_enabled is True
    assert loaded.categorize_categories == ["baking", "screenshots"]
    assert loaded.categorize_confidence_threshold == 0.9


def test_legacy_api_key_path_is_dropped_on_load(tmp_config_loader: ConfigLoader) -> None:
    """A config.json from an older build still loads; the retired key is ignored."""
    tmp_config_loader.config_file.write_text(
        json.dumps(
            {
                "source_directory": "/x",
                "ai_tagging_api_key_path": "/legacy/service-account.json",
            }
        )
    )
    cfg = tmp_config_loader.load()
    assert cfg.source_directory == "/x"
    assert not hasattr(cfg, "ai_tagging_api_key_path")


def test_categorize_env_override(
    tmp_config_loader: ConfigLoader, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MEDIASORT_CATEGORIZE_ENABLED", "true")
    monkeypatch.setenv("MEDIASORT_CATEGORIZE_CATEGORIES", "food, nature , pets")
    monkeypatch.setenv("MEDIASORT_CATEGORIZE_CONFIDENCE_THRESHOLD", "0.7")
    cfg = tmp_config_loader.load()
    assert cfg.categorize_enabled is True
    assert cfg.categorize_categories == ["food", "nature", "pets"]
    assert cfg.categorize_confidence_threshold == 0.7


# ------------------------------------------------------------------ #
# validate_categories                                                   #
# ------------------------------------------------------------------ #


def test_validate_categories_accepts_valid_list() -> None:
    assert validate_categories(["food", "nature", "my receipts"]) is None
    assert validate_categories([]) is None  # empty is allowed (warned about elsewhere)


def test_validate_categories_allows_more_than_twenty() -> None:
    # The old 20-category cap was removed; a large-but-sane list is accepted.
    assert validate_categories([f"c{i}" for i in range(50)]) is None


def test_validate_categories_rejects_pathological_count() -> None:
    # Only a defensive sanity ceiling remains, well above any real use.
    msg = validate_categories([f"c{i}" for i in range(CATEGORIZE_SANITY_MAX + 1)])
    assert msg is not None and "too many" in msg.lower()


def test_validate_categories_rejects_unsafe_name() -> None:
    msg = validate_categories(["food", ".."])
    assert msg is not None and "unsafe" in msg.lower()


def test_validate_categories_rejects_duplicate_after_sanitization() -> None:
    # "Food" and "food" collapse to the same folder name.
    msg = validate_categories(["Food", "food"])
    assert msg is not None and "duplicate" in msg.lower()


# ------------------------------------------------------------------ #
# config_sections — grouping descriptor stays aligned with Config       #
# ------------------------------------------------------------------ #


def test_config_sections_partition_all_fields() -> None:
    """Every Config field is in exactly one section or the ungrouped set."""
    from app.core.config_sections import SECTIONS, UNGROUPED_FIELDS

    all_fields = set(Config.defaults().to_dict().keys())
    grouped = [field for section in SECTIONS for field in section.fields]

    # No field appears in two sections, and all are real Config fields.
    assert len(grouped) == len(set(grouped)), "a field is grouped into two sections"
    grouped_set = set(grouped)
    assert grouped_set <= all_fields, grouped_set - all_fields

    # Sections + the explicitly-ungrouped set partition the whole config exactly.
    assert grouped_set.isdisjoint(UNGROUPED_FIELDS)
    missing_or_extra = all_fields ^ (grouped_set | UNGROUPED_FIELDS)
    assert grouped_set | UNGROUPED_FIELDS == all_fields, missing_or_extra


def test_config_sections_have_unique_ids_and_copy() -> None:
    from app.core.config_sections import SECTIONS

    ids = [s.id for s in SECTIONS]
    assert len(ids) == len(set(ids))
    assert all(s.label and s.description for s in SECTIONS)


def test_a_retired_field_neither_loads_nor_rejects_an_update() -> None:
    """`analyze` was persisted since the first release and read by nothing.

    Removing a field has to be safe in both directions: a stored config still
    carrying it must load, and a client that has not caught up must not have its
    whole update rejected because of it.
    """
    from app.core.config import coerce_config_update

    loaded = Config.from_dict({"analyze": True, "rename": True})
    assert loaded.rename is True
    assert not hasattr(loaded, "analyze")

    coerced, errors = coerce_config_update({"analyze": True, "rename": True})
    assert errors == []
    assert coerced == {"rename": True}

    _unknown, real_errors = coerce_config_update({"definitely_not_a_field": 1})
    assert real_errors  # a genuine typo is still reported
